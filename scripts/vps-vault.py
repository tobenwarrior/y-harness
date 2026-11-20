#!/usr/bin/python3 -I
"""Manage write-only, encrypted credentials for dedicated Linux services."""

import argparse
import base64
import fcntl
import getpass
import grp
import hashlib
import ipaddress
import json
import math
import os
import pwd
import re
import secrets
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import time
import warnings
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit


ROOT = Path('/var/lib/yharness-vault')
UNITS = Path('/etc/systemd/system')
DROPIN = '90-yharness-vault.conf'
PREFIX = 'yharness'
UNIT = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:@-]{0,220}\.service')
NAME = re.compile(r'[A-Za-z_][A-Za-z0-9_]{0,63}')
BOT = re.compile(r'bot-[A-Za-z0-9][A-Za-z0-9-]{0,245}')
REQUEST_ID = re.compile(r'[0-9a-f]{32}')
USER = re.compile(r'[A-Za-z_][A-Za-z0-9_-]{0,30}')
SECRET_LIMIT = 8192
DESKTOP_REQUEST_LIMIT = 64 * 1024
DESKTOP_SERVICE_LIMIT = 16
DESKTOP_NAME_LIMIT = 100
DESKTOP_RESPONSE_LIMIT = 160 * 1024
BROWSER_SOCKET = Path('/run/yharness-browser/vault.sock')
BROWSER_ACCOUNT = 'yharness-browser'
BROWSER_CONFIG = Path('/etc') / BROWSER_ACCOUNT
BROWSER_GRANTS = BROWSER_CONFIG / 'grants.json'
BROWSER_SHARED_GRANTS = BROWSER_CONFIG / 'shared-grants.json'
BROWSER_OWNER_ROSTER = Path('/var/lib/yharness-browser-roster/cloud/active.json')
BROWSER_GRANT_LIMIT = 64
BROWSER_FILE_LIMIT = 32 * 1024
BROWSER_SESSION = re.compile(
    r'bot-session-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z'
)
BROWSER_REVISION = re.compile(r'[0-9a-f]{32}\Z')
BROWSER_REQUEST_LIMIT = 24 * 1024
BROWSER_RESPONSE_LIMIT = 64 * 1024
BROWSER_TIMEOUT = 25
CLOUD_REQUEST_LIMIT = 4 * 1024
REQUEST_RECORD_LIMIT = 64
REQUEST_TTL = 10 * 60
REQUEST_LEASE = 20
REQUEST_APPROVAL_WINDOW = 8
REQUEST_APPROVAL_POLL = 0.05
DESKTOP_SOCKET = Path('/run/yharness-vault/desktop.sock')
DESKTOP_LISTENER = 'yharness-vault-desktop.socket'
DESKTOP_WORKER = 'yharness-vault-desktop@.service'
CLOUD_SOCKET = Path('/run/yharness-vault/cloud-requests.sock')
CLOUD_LISTENER = 'yharness-vault-cloud-requests.socket'
CLOUD_WORKER = 'yharness-vault-cloud-requests@.service'
CLOUD_REQUESTS_FILE = 'cloud-requests.json'
CLOUD_REQUESTS_ENABLED = 'cloud-requests-enabled'
INSTALLED_VAULT = Path('/usr/local/sbin/yharness-vault')
SYSTEMCTL = ['/usr/bin/systemctl', '--system', '--no-pager', '--no-ask-password']
COMMAND_ENV = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}
REQUEST_UNAVAILABLE = 'The Vault request is unavailable.'
BROWSER_UNAVAILABLE = 'The browser Vault is unavailable.'
WEBSITE_LOGIN_DIRECTORY = 'website-logins'
BOT_WEBSITE_LOGIN_DIRECTORY = 'bot-website-logins'
WEBSITE_LOGIN_AUTOMATION = 'website-login-automation.json'
WEBSITE_LOGIN_LIMIT = 64
WEBSITE_LOGIN_FILE_LIMIT = 64 * 1024
WEBSITE_LOGIN_ID = re.compile(r'[0-9a-f]{32}')
WEBSITE_LOGIN_LABEL_LIMIT = 80
WEBSITE_LOGIN_USERNAME_LIMIT = 512
WEBSITE_LOGIN_PASSWORD_LIMIT = 8192
WEBSITE_LOGIN_UNAVAILABLE = 'The website login is unavailable.'
WEBSITE_LOGIN_GENERATION = re.compile(r'[0-9a-f]{64}')
WEBSITE_LOGIN_DESTINATION_LIMIT = 4096
WEBSITE_LOGIN_HOST_LABEL = r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
WEBSITE_LOGIN_LOCAL_SUFFIXES = ('localhost', 'local', 'localdomain')
WEBSITE_LOGIN_ORIGIN = re.compile(
    rf'https://(?P<host>{WEBSITE_LOGIN_HOST_LABEL}(?:\.{WEBSITE_LOGIN_HOST_LABEL})*)'
    r'(?::(?P<port>[1-9][0-9]{0,4}))?\Z'
)


class VaultError(Exception):
    """Vault failure that can be displayed to the owner without a value."""


def directory(path, create=False, private=True, uid=None):
    """Check an owner-controlled directory without following a symbolic link."""
    if create:
        path.mkdir(mode=0o700 if private else 0o755, exist_ok=True)
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    expected = os.geteuid() if uid is None else uid
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != expected or info.st_mode & (0o077 if private else 0o022):
        raise VaultError('The Vault directory must be controlled by the administrator.')
    return True


def file_exists(path, private=True, uid=None):
    """Admit an owner-controlled regular file with exactly one directory entry."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    expected = os.geteuid() if uid is None else uid
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != expected or info.st_nlink != 1
            or info.st_mode & (0o077 if private else 0o022)):
        raise VaultError('The Vault found a file with unexpected ownership or permissions.')
    return True


def sync_directory(path):
    """Commit a renamed or removed entry in its parent directory."""
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def replace_file(path, payload, temporary_directory, mode):
    """Commit bytes atomically, staging outside the systemd credential loader's directory."""
    descriptor, name = tempfile.mkstemp(prefix='.vault-', dir=temporary_directory)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            os.fchmod(output.fileno(), mode)
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(path)
        sync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def credential_name(name):
    """Accept the name used for an API key in its dedicated service."""
    if not NAME.fullmatch(name):
        raise VaultError('Use a credential name such as EXAMPLE_API_KEY.')
    return name


def exact_object(pairs):
    """Reject duplicate fields at a JSON input boundary."""
    result = dict(pairs)
    if len(result) != len(pairs):
        raise VaultError('The Vault request contains duplicate fields.')
    return result


def desktop_body(stream):
    """Read only one bounded request from the caller's standard input."""
    payload = stream.read(DESKTOP_REQUEST_LIMIT + 1)
    if len(payload) > DESKTOP_REQUEST_LIMIT:
        raise VaultError('The Vault request is too large.')
    return payload


def cloud_body(stream):
    """Read one bounded metadata request from the Cloud service socket."""
    payload = stream.read(CLOUD_REQUEST_LIMIT + 1)
    if len(payload) > CLOUD_REQUEST_LIMIT:
        raise VaultError('The Vault request is too large.')
    return payload


def valid_unit(unit):
    """Accept an exact system service, including instances of templates."""
    return type(unit) is str and UNIT.fullmatch(unit) is not None and not unit.endswith('@.service')


def valid_request_id(value):
    """Accept the opaque identifier generated by the Cloud request owner."""
    return type(value) is str and REQUEST_ID.fullmatch(value) is not None


def valid_bot(value):
    """Accept an exact Cloud roster identity."""
    return type(value) is str and BOT.fullmatch(value) is not None


def valid_browser_session(value):
    """Accept the canonical owner Bot Session assigned by the browser installer."""
    return type(value) is str and BROWSER_SESSION.fullmatch(value) is not None


def valid_browser_revision(value):
    """Accept one lower-case revision for a durable shared-browser decision."""
    return type(value) is str and BROWSER_REVISION.fullmatch(value) is not None


def valid_login_id(value):
    """Accept the opaque identifier generated for one website login."""
    return type(value) is str and WEBSITE_LOGIN_ID.fullmatch(value) is not None


def valid_login_generation(value):
    """Accept the opaque digest returned with one inspected website login."""
    return type(value) is str and WEBSITE_LOGIN_GENERATION.fullmatch(value) is not None


def website_login_generation(record):
    """Bind one owner selection to the current encrypted record bytes."""
    return hashlib.sha256(record['credential'].encode('ascii')).hexdigest()


def website_login_credential_name(record):
    """Bind a Bot credential to its exact Bot, origin, and record id."""
    if 'bot' not in record:
        return f'{PREFIX}_website_login_{record["id"]}'
    scope = hashlib.sha256(f'{record["bot"]}\0{record["origin"]}'.encode('ascii')).hexdigest()
    return f'{PREFIX}_bot_website_login_{scope}_{record["id"]}'


def valid_login_origin(value):
    """Accept one canonical, lower-case HTTPS DNS origin without a path."""
    if type(value) is not str or not value.isascii():
        return False
    match = WEBSITE_LOGIN_ORIGIN.fullmatch(value)
    if match is None:
        return False
    host = match['host']
    labels = host.split('.')
    if len(labels) < 2 or len(host) > 253 or labels[-1].isdecimal():
        return False
    if any(host == suffix or host.endswith(f'.{suffix}') for suffix in WEBSITE_LOGIN_LOCAL_SUFFIXES):
        return False
    if all(label.isdecimal() for label in labels):
        return False
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        return False
    port = match['port']
    return port is None or int(port) <= 65535 and int(port) != 443


def valid_login_destination(origin, destination):
    """Accept one canonical HTTPS POST destination on the exact saved origin."""
    if (type(origin) is not str or type(destination) is not str or not valid_login_origin(origin)
            or not destination.isascii() or not 0 < len(destination.encode('ascii')) <= WEBSITE_LOGIN_DESTINATION_LIMIT
            or not destination.startswith(origin + '/') or '?' in destination or '#' in destination
            or any(ord(character) <= 0x20 or ord(character) == 0x7f or character == '\\' for character in destination)):
        return False
    try:
        parsed = urlsplit(destination)
    except ValueError:
        return False
    authority = origin.removeprefix('https://')
    return (parsed.scheme == 'https' and parsed.netloc == authority and parsed.path.startswith('/')
            and parsed.username is None and parsed.password is None and parsed.query == '' and parsed.fragment == '')


def login_text(value, limit, *, trim=False):
    """Validate one single-line website-login field and return its stored text."""
    if type(value) is not str or any(ord(character) < 0x20 or 0x7f <= ord(character) <= 0x9f
                                    for character in value) or any(character in value for character in '\u2028\u2029'):
        raise VaultError('Invalid website login request.')
    stored = value.strip() if trim else value
    try:
        size = len(stored.encode('utf-8'))
    except UnicodeError:
        raise VaultError('Invalid website login request.') from None
    if not 0 < size <= limit:
        raise VaultError('Invalid website login request.')
    return stored


def website_login_request(request):
    """Validate one exact Desktop website-login request and normalize its label."""
    action = request.get('action')
    if action in ('list-logins', 'list-bot-logins'):
        if set(request) != {'action'}:
            raise VaultError('Invalid website login request.')
        return request
    if action == 'inspect-login-import':
        if set(request) != {'action', 'salt'} or not valid_login_generation(request.get('salt')):
            raise VaultError('Invalid website login request.')
        return request
    scope = {'bot'} if 'bot' in request else set()
    if scope and (action == 'import-login' or not valid_bot(request['bot'])):
        raise VaultError('Invalid website login request.')
    if action in ('add-login', 'import-login'):
        fields = {'action', 'origin', 'label', 'username', 'password'}
    elif action == 'replace-login':
        fields = {'action', 'id', 'label', 'username', 'password'}
    elif action == 'remove-login':
        if set(request) != {'action', 'id'} | scope or not valid_login_id(request.get('id')):
            raise VaultError('Invalid website login request.')
        return request
    else:
        raise VaultError('Invalid website login request.')
    if set(request) != fields | scope:
        raise VaultError('Invalid website login request.')
    if action == 'replace-login' and not valid_login_id(request.get('id')):
        raise VaultError('Invalid website login request.')
    if action in ('add-login', 'import-login') and not valid_login_origin(request.get('origin')):
        raise VaultError('Invalid website login request.')
    return {
        **request,
        'label': login_text(request.get('label'), WEBSITE_LOGIN_LABEL_LIMIT, trim=True),
        'username': login_text(request.get('username'), WEBSITE_LOGIN_USERNAME_LIMIT),
        'password': login_text(request.get('password'), WEBSITE_LOGIN_PASSWORD_LIMIT),
    }


def entered_website_login_request(request):
    """Validate a login entered for the reviewed browser request."""
    fields = {'action', 'id', 'origin', 'destination', 'username', 'password'}
    if (set(request) not in (fields, fields | {'saveLabel'})
            or not valid_request_id(request.get('id'))
            or not valid_login_destination(request.get('origin'), request.get('destination'))):
        raise VaultError('Invalid website login request.')
    validated = {
        **request,
        'username': login_text(request.get('username'), WEBSITE_LOGIN_USERNAME_LIMIT),
        'password': login_text(request.get('password'), WEBSITE_LOGIN_PASSWORD_LIMIT),
    }
    if 'saveLabel' in request:
        validated['saveLabel'] = login_text(request['saveLabel'], WEBSITE_LOGIN_LABEL_LIMIT, trim=True)
    return validated


def website_signup_request(request):
    """Validate owner consent to save a generated credential for a reviewed signup."""
    if (set(request) != {'action', 'id', 'origin', 'destination', 'username', 'saveLabel'}
            or not valid_request_id(request.get('id'))
            or not valid_login_destination(request.get('origin'), request.get('destination'))):
        raise VaultError('Invalid website signup request.')
    return {
        **request,
        'username': login_text(request.get('username'), WEBSITE_LOGIN_USERNAME_LIMIT, trim=True),
        'saveLabel': login_text(request.get('saveLabel'), WEBSITE_LOGIN_LABEL_LIMIT, trim=True),
    }


def website_verification_request(request):
    """Validate a one-time code for an exact owner-reviewed POST form."""
    if (set(request) != {'action', 'id', 'origin', 'destination', 'code'}
            or not valid_request_id(request.get('id'))
            or not valid_login_destination(request.get('origin'), request.get('destination'))):
        raise VaultError('Invalid website verification request.')
    return {**request, 'code': login_text(request['code'], 64)}


def browser_login_inspection(payload, expected_id, *, automatic=False):
    """Decode one bounded browser inspection without returning browser diagnostics."""
    try:
        if len(payload) > BROWSER_RESPONSE_LIMIT:
            raise VaultError(BROWSER_UNAVAILABLE)
        reply = json.loads(payload.decode('utf-8'), object_pairs_hook=exact_object)
        if type(reply) is not dict:
            raise VaultError(BROWSER_UNAVAILABLE)
        if set(reply) == {'error'} and reply['error'] == 'unavailable':
            raise VaultError(BROWSER_UNAVAILABLE)
        fields = {'id', 'origin', 'destination', 'state'}
        shared = set(reply) == fields | {'scope', 'bot'} and reply['scope'] == 'shared' and valid_bot(reply['bot'])
        if automatic:
            permitted = (set(reply) == fields | {'bot', 'session'} and valid_bot(reply['bot'])
                         and valid_browser_session(reply['session']))
        else:
            owner_form = (set(reply) == fields | {'purpose', 'bot', 'session'}
                          and reply['purpose'] in ('signup', 'verification')
                          and valid_bot(reply['bot']) and valid_browser_session(reply['session']))
            permitted = set(reply) == fields or shared or owner_form
        if (not permitted
                or reply.get('id') != expected_id or not valid_request_id(reply.get('id'))
                or reply.get('state') != 'pending' or not valid_login_origin(reply.get('origin'))
                or not valid_login_destination(reply['origin'], reply.get('destination'))):
            raise VaultError(BROWSER_UNAVAILABLE)
        return reply
    except VaultError:
        raise
    except (UnicodeError, ValueError, RecursionError, TypeError):
        raise VaultError(BROWSER_UNAVAILABLE) from None


def browser_login_state(payload):
    """Decode the browser's fixed login-delivery state without exposing its reply."""
    try:
        if len(payload) > BROWSER_RESPONSE_LIMIT:
            raise VaultError(BROWSER_UNAVAILABLE)
        reply = json.loads(payload.decode('utf-8'), object_pairs_hook=exact_object)
        if type(reply) is not dict or set(reply) != {'state'} or reply['state'] not in (
                'submitted', 'needs-owner', 'unavailable'):
            raise VaultError(BROWSER_UNAVAILABLE)
        return {'state': reply['state']}
    except VaultError:
        raise
    except (UnicodeError, ValueError, RecursionError, TypeError):
        raise VaultError(BROWSER_UNAVAILABLE) from None


def valid_request_grant(grant):
    """Validate a service/key pair and its optional Bot and shared permission."""
    return (type(grant) in (tuple, list) and len(grant) in (2, 3, 4)
            and (len(grant) == 2 or valid_bot(grant[-3]))
            and (len(grant) != 4 or grant[0] == 'shared')
            and valid_unit(grant[-2]) and type(grant[-1]) is str and NAME.fullmatch(grant[-1]) is not None)


def request_grant(value):
    """Decode exact service, private Bot, and shared Bot grants."""
    target, _, name = value.partition('=')
    grant = (*target.split('/'), name)
    if not valid_request_grant(grant):
        raise argparse.ArgumentTypeError('Use [shared/]BOT/UNIT.service=KEY_NAME or UNIT.service=KEY_NAME.')
    return grant


def request_granted(grants, unit, name, bot=None, scope=None):
    """Shared turns require an explicit shared grant for their Bot and key."""
    if bot is None:
        return scope is None and (unit, name) in grants
    if ('shared', bot, unit, name) in grants:
        return True
    return scope is None and (bot, unit, name) in grants


def finish_request(record, state):
    """Discard the owner approval challenge when a request settles."""
    record['state'] = state
    record.pop('approval', None)


def login_automation_request(request):
    """Validate the exact owner controls for automatic sign-in."""
    if request.get('action') == 'list-login-automation' and set(request) == {'action'}:
        return request
    if (request.get('action') == 'set-login-automatic' and set(request) == {'action', 'id', 'bot', 'enabled'}
            and valid_login_id(request.get('id')) and valid_bot(request.get('bot'))
            and type(request.get('enabled')) is bool):
        return request
    raise VaultError('Invalid automatic sign-in request.')


def valid_automatic_login(request):
    """Accept only the server-owned coordinates of a pending private browser request."""
    return (set(request) == {'action', 'id', 'bot', 'session'} and request.get('action') == 'automatic-login'
            and valid_request_id(request.get('id')) and valid_bot(request.get('bot'))
            and valid_browser_session(request.get('session')))


def desktop_request(payload):
    """Decode one bounded management request with no secret read operation."""
    try:
        if len(payload) > DESKTOP_REQUEST_LIMIT:
            raise VaultError('The Vault request is too large.')
        request = json.loads(payload.decode('utf-8'), object_pairs_hook=exact_object)
        if type(request) is not dict:
            raise VaultError('Invalid Vault request.')
        action = request.get('action')
        if action in ('list', 'list-grants', 'list-scoped-grants') and set(request) == {'action'}:
            return request
        grant_fields = {'action', 'bot', 'unit', 'name'}
        if action == 'add-grant':
            if (set(request) not in (grant_fields, grant_fields | {'scope'})
                    or ('scope' in request and request['scope'] != 'shared')
                    or not valid_request_grant((request['bot'], request['unit'], request['name']))):
                raise VaultError('Invalid Vault request.')
            return request
        if action == 'remove-grant':
            if (set(request) != grant_fields
                    or not valid_request_grant((request['bot'], request['unit'], request['name']))):
                raise VaultError('Invalid Vault request.')
            return request
        if action == 'set-grant-scope':
            if (set(request) != grant_fields | {'scope'}
                    or request['scope'] not in ('owner', 'shared')
                    or not valid_request_grant((request['bot'], request['unit'], request['name']))):
                raise VaultError('Invalid Vault request.')
            return request
        if action == 'set-browser-access':
            if (set(request) != {'action', 'bot', 'session', 'enabled'}
                    or not valid_bot(request.get('bot'))
                    or not valid_browser_session(request.get('session'))
                    or type(request.get('enabled')) is not bool):
                raise VaultError('Invalid Vault request.')
            return request
        if action in ('list-logins', 'list-bot-logins', 'add-login', 'replace-login', 'remove-login',
                      'inspect-login-import', 'import-login'):
            return website_login_request(request)
        if action in ('list-login-automation', 'set-login-automatic'):
            return login_automation_request(request)
        if action == 'enter-login-use':
            return entered_website_login_request(request)
        if action == 'create-login-use':
            return website_signup_request(request)
        if action == 'enter-verification-code':
            return website_verification_request(request)
        if action == 'inspect-login-use' and set(request) == {'action', 'id', 'form'}:
            if not valid_request_id(request.get('id')) or request['form'] != 'entry':
                raise VaultError('Invalid Vault request.')
            return request
        if action in ('inspect-login-use', 'decline-login-use'):
            if set(request) != {'action', 'id'} or not valid_request_id(request.get('id')):
                raise VaultError('Invalid Vault request.')
            return request
        if action == 'approve-login-use':
            if (set(request) != {'action', 'id', 'loginId', 'generation'}
                    or not valid_request_id(request.get('id'))
                    or not valid_login_id(request.get('loginId'))
                    or not valid_login_generation(request.get('generation'))):
                raise VaultError('Invalid Vault request.')
            return request
        if action in ('inspect-request', 'dismiss-request'):
            if set(request) != {'action', 'id'} or not valid_request_id(request.get('id')):
                raise VaultError('Invalid Vault request.')
            return request
        fields = {'action', 'unit', 'name'}
        if action == 'save-request':
            fields = {'action', 'id', 'value'}
            value = request.get('value')
            if (set(request) != fields or not valid_request_id(request.get('id')) or type(value) is not str
                    or not valid_secret(value.encode())):
                raise VaultError('Enter a non-empty credential of at most 8 KiB.')
        elif action in ('add', 'replace'):
            fields.add('value')
            value = request.get('value')
            if type(value) is not str or not valid_secret(value.encode()):
                raise VaultError('Enter a non-empty credential of at most 8 KiB.')
        elif action != 'revoke':
            raise VaultError('Invalid Vault request.')
        if action == 'save-request':
            return request
        if (set(request) != fields or not valid_unit(request['unit'])
                or type(request['name']) is not str or not NAME.fullmatch(request['name'])):
            raise VaultError('Invalid Vault request.')
        return request
    except (UnicodeError, ValueError, RecursionError):
        raise VaultError('Invalid Vault request.') from None


def cloud_request(payload):
    """Decode one bounded Cloud metadata request with no credential value."""
    try:
        if len(payload) > CLOUD_REQUEST_LIMIT:
            raise VaultError('The Vault request is too large.')
        request = json.loads(payload.decode('utf-8'), object_pairs_hook=exact_object)
        if type(request) is not dict:
            raise VaultError('Invalid Vault request.')
        action = request.get('action')
        if valid_automatic_login(request):
            return request
        fields = set(request)
        if 'bot' in fields:
            if not valid_bot(request['bot']):
                raise VaultError('Invalid Vault request.')
            fields.remove('bot')
        if 'scope' in fields:
            if request['scope'] != 'shared' or 'bot' not in request:
                raise VaultError('Invalid Vault request.')
            fields.remove('scope')
        if action == 'list' and fields == {'action'} and 'bot' in request:
            return request
        if action == 'create':
            if (fields != {'action', 'id', 'unit', 'name'}
                    or not valid_request_id(request.get('id'))
                    or not valid_unit(request.get('unit'))
                    or type(request.get('name')) is not str
                    or not NAME.fullmatch(request['name'])):
                raise VaultError('Invalid Vault request.')
            return request
        if action in ('status', 'cancel'):
            if fields != {'action', 'id'} or not valid_request_id(request.get('id')):
                raise VaultError('Invalid Vault request.')
            return request
        if (action == 'authorize' and request.get('scope') == 'shared' and fields == {'action', 'id', 'challenge'}
                and valid_request_id(request.get('id')) and valid_request_id(request.get('challenge'))):
            return request
        raise VaultError('Invalid Vault request.')
    except (UnicodeError, ValueError, RecursionError):
        raise VaultError('Invalid Vault request.') from None


def valid_secret(value):
    """Accept the byte representation used by both entry paths."""
    return 0 < len(value) <= SECRET_LIMIT and b'\0' not in value


def desktop_socket_unit(owner_uid):
    """Bind the local Vault management socket to the authorized SSH account."""
    return f"""[Unit]
Description=Y Harness Vault management socket

[Socket]
ListenStream={DESKTOP_SOCKET}
SocketUser={owner_uid}
SocketGroup=root
SocketMode=0600
DirectoryMode=0755
Accept=yes
MaxConnections=4
RemoveOnStop=yes

[Install]
WantedBy=sockets.target
""".encode()


def desktop_worker_unit():
    """Run one short-lived root Vault operation on its accepted local socket."""
    return f"""[Unit]
Description=Y Harness Vault management request

[Service]
Type=exec
ExecStart=/usr/bin/python3 -I {INSTALLED_VAULT} desktop-worker
StandardInput=socket
StandardOutput=socket
StandardError=null
NoNewPrivileges=yes
PrivateNetwork=yes
PrivateTmp=yes
LimitCORE=0
UMask=0077
RuntimeMaxSec=25s
""".encode()


def cloud_socket_unit(cloud_uid):
    """Bind the root broker socket to the configured Cloud Linux account."""
    if type(cloud_uid) is not int or cloud_uid <= 0:
        raise VaultError('The Cloud account could not be resolved.')
    return f"""[Unit]
Description=Y Harness Cloud Vault request socket

[Socket]
ListenStream={CLOUD_SOCKET}
SocketUser={cloud_uid}
SocketGroup=root
SocketMode=0600
DirectoryMode=0755
Accept=yes
MaxConnections=4
RemoveOnStop=yes

[Install]
WantedBy=sockets.target
""".encode()


def cloud_worker_unit():
    """Run one short-lived root broker operation on its accepted socket."""
    return f"""[Unit]
Description=Y Harness Cloud Vault request
PartOf={CLOUD_LISTENER}

[Service]
Type=exec
User=root
ExecStart=/usr/bin/python3 -I {INSTALLED_VAULT} cloud-request-worker
StandardInput=socket
StandardOutput=socket
StandardError=null
NoNewPrivileges=yes
PrivateNetwork=yes
PrivateTmp=yes
LimitCORE=0
UMask=0077
RuntimeMaxSec=25s
""".encode()


def desktop_peer(connection):
    """Read the Linux account of the process that opened the socket."""
    size = struct.calcsize('iII')
    _pid, uid, _gid = struct.unpack('iII', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, size))
    return uid


def trusted_file(path):
    """Verify the installed root-controlled executable and every directory leading to it."""
    for parent in path.parents:
        if not directory(parent, private=False, uid=0):
            raise VaultError('The Vault installation directory is unavailable.')
    if not file_exists(path, private=False, uid=0):
        raise VaultError('Install the Vault in /usr/local/sbin first.')


def desktop_client(payload, endpoint=DESKTOP_SOCKET):
    """Exchange one request with the owner-only socket without a privileged SSH command."""
    trusted_file(INSTALLED_VAULT)
    if not directory(endpoint.parent, private=False, uid=0):
        raise VaultError('Desktop Vault access is unavailable.')
    info = endpoint.lstat()
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise VaultError('Desktop Vault access is unavailable for this SSH account.')
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(25)
        connection.connect(str(endpoint))
        if desktop_peer(connection) != 0:
            raise VaultError('Could not verify the Vault service.')
        connection.sendall(payload)
        connection.shutdown(socket.SHUT_WR)
        with connection.makefile('rb') as reply:
            result = reply.read(DESKTOP_RESPONSE_LIMIT + 1)
    if not result or len(result) > DESKTOP_RESPONSE_LIMIT:
        raise VaultError('Desktop Vault is unavailable.')
    return result


def browser_group_gid():
    """Resolve the private group that can read installed browser configuration."""
    if os.geteuid() != 0:
        # Unit tests use the current account as the fixture's administrator.
        return os.getegid()
    try:
        gid = grp.getgrnam(BROWSER_ACCOUNT).gr_gid
    except (AttributeError, KeyError, TypeError):
        raise VaultError(BROWSER_UNAVAILABLE) from None
    if type(gid) is not int or gid <= 0:
        raise VaultError(BROWSER_UNAVAILABLE)
    return gid


def browser_managed_file(path):
    """Require one fixed browser file with administrator/group ownership and mode 0640."""
    expected_uid = 0 if os.geteuid() == 0 else os.geteuid()
    try:
        if not directory(path.parent, private=False, uid=expected_uid):
            raise VaultError(BROWSER_UNAVAILABLE)
        info = path.lstat()
    except FileNotFoundError:
        raise VaultError(BROWSER_UNAVAILABLE) from None
    except (OSError, VaultError):
        raise VaultError(BROWSER_UNAVAILABLE) from None
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != expected_uid
            or info.st_gid != browser_group_gid() or stat.S_IMODE(info.st_mode) != 0o640):
        raise VaultError(BROWSER_UNAVAILABLE)
    return info


def read_browser_managed_json(path):
    """Read bounded JSON from one already-validated browser file."""
    browser_managed_file(path)
    try:
        with path.open('rb') as source:
            payload = source.read(BROWSER_FILE_LIMIT + 1)
        if len(payload) > BROWSER_FILE_LIMIT:
            raise VaultError(BROWSER_UNAVAILABLE)
        return json.loads(payload.decode('utf-8'), object_pairs_hook=exact_object)
    except VaultError:
        raise VaultError(BROWSER_UNAVAILABLE) from None
    except (OSError, OverflowError, UnicodeError, ValueError, RecursionError, TypeError):
        raise VaultError(BROWSER_UNAVAILABLE) from None


def browser_pairs(data, *, allow_shared=True):
    """Validate one bounded browser roster with unique Bot and Session identities."""
    if type(data) is not list or len(data) > BROWSER_GRANT_LIMIT:
        raise VaultError(BROWSER_UNAVAILABLE)
    pairs = set()
    bots = set()
    sessions = set()
    for record in data:
        if type(record) is not dict or set(record) not in ({'bot', 'session'}, {'bot', 'session', 'shared'}) \
                or not valid_bot(record.get('bot')) or not valid_browser_session(record.get('session')) \
                or ('shared' in record and (not allow_shared or record['shared'] is not True)):
            raise VaultError(BROWSER_UNAVAILABLE)
        pair = (record['bot'], record['session'])
        if pair in pairs or record['bot'] in bots or record['session'] in sessions:
            raise VaultError(BROWSER_UNAVAILABLE)
        pairs.add(pair)
        bots.add(record['bot'])
        sessions.add(record['session'])
    return pairs


def read_browser_owner_roster(cloud_uid):
    """Read exact active pairs from the Cloud-owned file under the installer-owned root."""
    path = BROWSER_OWNER_ROSTER
    root_uid = 0 if os.geteuid() == 0 else os.geteuid()
    group = browser_group_gid()
    try:
        administrator = path.parent.parent.lstat()
        publisher = path.parent.lstat()
        if (not stat.S_ISDIR(administrator.st_mode) or administrator.st_uid != root_uid
                or stat.S_IMODE(administrator.st_mode) != 0o755 or not stat.S_ISDIR(publisher.st_mode)
                or publisher.st_uid != cloud_uid or publisher.st_gid != group
                or stat.S_IMODE(publisher.st_mode) != 0o2750):
            raise VaultError(BROWSER_UNAVAILABLE)
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            return []
        with os.fdopen(fd, 'rb') as source:
            info = os.fstat(source.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != cloud_uid or info.st_gid != group
                    or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o640 or info.st_size > BROWSER_FILE_LIMIT):
                raise VaultError(BROWSER_UNAVAILABLE)
            payload = source.read(BROWSER_FILE_LIMIT + 1)
        if len(payload) > BROWSER_FILE_LIMIT:
            raise VaultError(BROWSER_UNAVAILABLE)
        rows = json.loads(payload.decode('ascii'), object_pairs_hook=exact_object)
        if (json.dumps(rows, separators=(',', ':'), ensure_ascii=True) + '\n').encode('ascii') != payload:
            raise VaultError(BROWSER_UNAVAILABLE)
        return rows
    except (OSError, UnicodeError, ValueError, RecursionError):
        raise VaultError(BROWSER_UNAVAILABLE) from None


def browser_grants():
    """Return active pairs and the publisher UID for an installer-managed roster."""
    data = read_browser_managed_json(BROWSER_GRANTS)
    if type(data) is dict:
        if (set(data) != {'version', 'cloudUid', 'grants'} or type(data['version']) is not int or data['version'] != 1
                or type(data['cloudUid']) is not int or data['cloudUid'] <= 0):
            raise VaultError(BROWSER_UNAVAILABLE)
        browser_pairs(data['grants'])
        return browser_pairs(read_browser_owner_roster(data['cloudUid']), allow_shared=False), data['cloudUid']
    return browser_pairs(data), None


def browser_grant_pairs():
    """Read the exact Bot and Session identities admitted by the installed browser."""
    return browser_grants()[0]


def browser_shared_policy():
    """Validate the durable shared-browser decision list without accepting unknown fields."""
    data = read_browser_managed_json(BROWSER_SHARED_GRANTS)
    if (type(data) is not dict or set(data) != {'version', 'bots'} or type(data['version']) is not int
            or data['version'] != 1 or type(data['bots']) is not list or len(data['bots']) > BROWSER_GRANT_LIMIT):
        raise VaultError(BROWSER_UNAVAILABLE)
    pairs = set()
    for record in data['bots']:
        if (type(record) is not dict or set(record) != {'bot', 'session', 'enabled', 'revision'}
                or not valid_bot(record.get('bot')) or not valid_browser_session(record.get('session'))
                or type(record.get('enabled')) is not bool or not valid_browser_revision(record.get('revision'))):
            raise VaultError(BROWSER_UNAVAILABLE)
        pair = (record['bot'], record['session'])
        if pair in pairs:
            raise VaultError(BROWSER_UNAVAILABLE)
        pairs.add(pair)
    return data['bots']


def replace_browser_policy(records):
    """Atomically publish the validated shared-browser policy with exact ownership."""
    gid = browser_group_gid()
    payload = (json.dumps({'version': 1, 'bots': records}, separators=(',', ':')) + '\n').encode('ascii')
    descriptor, name = tempfile.mkstemp(prefix='.yharness-browser-', dir=BROWSER_SHARED_GRANTS.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            os.fchmod(output.fileno(), 0o640)
            if os.geteuid() == 0:
                os.fchown(output.fileno(), 0, gid)
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(BROWSER_SHARED_GRANTS)
        sync_directory(BROWSER_SHARED_GRANTS.parent)
    finally:
        temporary.unlink(missing_ok=True)


def browser_refresh_acknowledged():
    """Ask the root browser worker to reload the durable policy and require its exact acknowledgment."""
    payload = b'{"action":"refresh-sharing"}'
    try:
        reply = json.loads(browser_client(payload).decode('utf-8'), object_pairs_hook=exact_object)
    except (VaultError, OSError, OverflowError, UnicodeError, ValueError, RecursionError, TypeError):
        raise VaultError(BROWSER_UNAVAILABLE) from None
    if type(reply) is not dict or set(reply) != {'ok'} or reply['ok'] is not True:
        raise VaultError(BROWSER_UNAVAILABLE)
    return {'ok': True}


def browser_peer_uid():
    """Resolve the dedicated browser worker account used by the root-only socket."""
    try:
        uid = pwd.getpwnam(BROWSER_ACCOUNT).pw_uid
    except (AttributeError, KeyError, TypeError):
        raise VaultError(BROWSER_UNAVAILABLE) from None
    if type(uid) is not int or uid <= 0:
        raise VaultError(BROWSER_UNAVAILABLE)
    return uid


def browser_client(payload):
    """Send one bounded request to the fixed root-owned browser socket."""
    if type(payload) is not bytes or len(payload) > BROWSER_REQUEST_LIMIT or os.geteuid() != 0:
        raise VaultError(BROWSER_UNAVAILABLE)
    endpoint = BROWSER_SOCKET
    try:
        if not directory(endpoint.parent, private=False, uid=0):
            raise VaultError(BROWSER_UNAVAILABLE)
        info = endpoint.lstat()
        if (not stat.S_ISSOCK(info.st_mode) or info.st_uid != 0
                or stat.S_IMODE(info.st_mode) != 0o600):
            raise VaultError(BROWSER_UNAVAILABLE)
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(BROWSER_TIMEOUT)
            connection.connect(str(endpoint))
            if desktop_peer(connection) != browser_peer_uid():
                raise VaultError(BROWSER_UNAVAILABLE)
            connection.sendall(payload)
            connection.shutdown(socket.SHUT_WR)
            with connection.makefile('rb') as reply:
                result = reply.read(BROWSER_RESPONSE_LIMIT + 1)
    except VaultError:
        raise
    except (OSError, ValueError):
        raise VaultError(BROWSER_UNAVAILABLE) from None
    if not result or len(result) > BROWSER_RESPONSE_LIMIT:
        raise VaultError(BROWSER_UNAVAILABLE)
    return result


def desktop_worker(vault, connection):
    """Check the peer and handle one request without logging or returning secret values."""
    uid = desktop_peer(connection)
    connection.settimeout(15)
    with connection.makefile('rb') as request:
        payload = desktop_body(request)
    answer = vault.desktop(desktop_request(payload), uid)
    connection.sendall((json.dumps(answer) + '\n').encode())


def cloud_worker(vault, connection):
    """Check the Cloud peer and handle one metadata-only broker request."""
    uid = desktop_peer(connection)
    connection.settimeout(15)
    with connection.makefile('rb') as request:
        payload = cloud_body(request)
    answer = vault.cloud(cloud_request(payload), uid)
    connection.sendall((json.dumps(answer) + '\n').encode())


def current_boot_id():
    """Return the kernel boot identifier used to scope persisted requests."""
    try:
        value = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    except (OSError, UnicodeError):
        value = ''
    return value or f'process:{os.getpid()}'


class Vault:
    """Owner-only encrypted storage for exact systemd service names."""

    def __init__(self, root=ROOT, units=UNITS, run=subprocess.run, clock=time.monotonic, boot_id=None):
        self.root = root
        self.units = units
        self.run = run
        self.clock = clock
        self.boot_id = current_boot_id() if boot_id is None else boot_id

    def paths(self, unit):
        """Resolve a service's credential directory and managed drop-in."""
        if not valid_unit(unit):
            raise VaultError('Use an exact system service name ending in .service.')
        return self.root / unit / 'credentials', self.units / (unit + '.d') / DROPIN

    @contextmanager
    def locked(self):
        """Serialize mutations across Vault invocations under a private directory."""
        path = self.root / '.lock'
        descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        with os.fdopen(descriptor, 'rb') as lock:
            info = os.fstat(lock.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1 or info.st_mode & 0o077:
                raise VaultError('The Vault lock has unexpected ownership or permissions.')
            fcntl.flock(lock, fcntl.LOCK_EX)
            yield

    def command(self, args, failure, **kwargs):
        """Run a fixed systemd operation with private diagnostics."""
        try:
            result = self.run(args, timeout=20, stderr=subprocess.DEVNULL, env=COMMAND_ENV, **kwargs)
        except (OSError, subprocess.SubprocessError):
            raise VaultError(failure) from None
        if result.returncode != 0:
            raise VaultError(failure)
        return result.stdout

    def service(self, unit, cloud_uid):
        """Verify that the system manager resolves an exact, separately owned workload."""
        if cloud_uid <= 0:
            raise VaultError('Select the regular Linux user that runs Y Harness Cloud.')
        result = self.command(
            [*SYSTEMCTL, 'show', '--property=Id,LoadState,User,DynamicUser,DropInPaths', '--', unit],
            'The target system service could not be inspected.', stdout=subprocess.PIPE, text=True,
        )
        fields = dict(line.split('=', 1) for line in result.splitlines() if '=' in line)
        if fields.get('Id') != unit or fields.get('LoadState') != 'loaded':
            raise VaultError('The exact target system service must exist.')
        user = fields.get('User', '')
        if user.isascii() and user.isdecimal() and len(user) <= 10:
            uid = int(user)
        elif USER.fullmatch(user):
            try:
                uid = pwd.getpwnam(user).pw_uid
            except KeyError:
                if fields.get('DynamicUser') == 'yes':
                    return fields
                raise VaultError('The service account could not be resolved.') from None
        else:
            raise VaultError('The system service needs an explicit dedicated User= account.')
        if uid == 0 or uid == cloud_uid:
            raise VaultError('The service account must be separate from root and the Y Harness Cloud user.')
        return fields

    def binding(self, credentials):
        """Render the exact credential directory imported by one service."""
        return f'[Service]\nLoadCredentialEncrypted={PREFIX}:{credentials}\n'.encode()

    def enabled_credentials(self, unit, cloud_uid):
        """Find a service's loaded Vault directory under the management lock."""
        credentials, dropin = self.paths(unit)
        fields = self.service(unit, cloud_uid)
        if (not directory(self.units, private=False) or not directory(dropin.parent, private=False)
                or not file_exists(dropin, private=False) or dropin.read_bytes() != self.binding(credentials)
                or str(dropin) not in fields.get('DropInPaths', '').split()
                or not directory(credentials.parent) or not directory(credentials)):
            raise VaultError('Enable the Vault for this service first.')
        return credentials

    def enable(self, unit, cloud_uid):
        """Attach one private scope and reload the system manager configuration."""
        credentials, dropin = self.paths(unit)
        self.service(unit, cloud_uid)
        if not directory(self.units, private=False):
            raise VaultError('The system service configuration directory is unavailable.')
        directory(self.root, create=True)
        with self.locked():
            directory(dropin.parent, create=True, private=False)
            expected = self.binding(credentials)
            present = file_exists(dropin, private=False)
            if present and dropin.read_bytes() != expected:
                raise VaultError('The service already has a different Vault configuration.')
            directory(credentials.parent, create=True)
            directory(credentials, create=True)
            if not present:
                replace_file(dropin, expected, dropin.parent, 0o644)
            self.command([*SYSTEMCTL, 'daemon-reload'], 'The system manager could not reload. Retry enabling the Vault.', stdout=subprocess.DEVNULL)

    def save(self, unit, name, value, cloud_uid):
        """Store or rotate one credential after validating its bound service."""
        credential_name(name)
        if not valid_secret(value):
            raise VaultError('Enter a non-empty credential of at most 8 KiB.')
        if not directory(self.root):
            raise VaultError('Enable the Vault for this service first.')
        with self.locked():
            credentials = self.enabled_credentials(unit, cloud_uid)
            self.write_value(credentials, name, value)

    def write_value(self, credentials, name, value, action=None):
        """Seal one value atomically after checking for a stale desktop action."""
        target = credentials / name
        exists = file_exists(target)
        if (action == 'add' and exists) or (action == 'replace' and not exists):
            raise VaultError('The Vault entry changed. Refresh and try again.')
        encrypted = self.command(
            ['/usr/bin/systemd-creds', '--with-key=host', f'--name={PREFIX}_{name}', 'encrypt', '-', '-'],
            'Systemd could not encrypt the credential.', input=value, stdout=subprocess.PIPE,
        )
        try:
            cipher = base64.b64decode(b''.join(encrypted.split()), validate=True)
        except ValueError:
            raise VaultError('Systemd returned an invalid encrypted credential.') from None
        if not cipher:
            raise VaultError('Systemd returned an empty encrypted credential.')
        replace_file(target, encrypted, credentials.parent, 0o600)

    def credential_names(self, credentials):
        """List only file names within a verified credential directory."""
        return sorted(credential_name(path.name) for path in credentials.iterdir() if file_exists(path))

    def names(self, unit):
        """Return saved names for one scope without reading the encrypted files."""
        credentials, _dropin = self.paths(unit)
        if not directory(self.root):
            return []
        with self.locked():
            if not directory(credentials.parent) or not directory(credentials):
                return []
            return self.credential_names(credentials)

    def revoke(self, unit, name):
        """Remove the credential from future activations of its service."""
        credentials, _dropin = self.paths(unit)
        target = credentials / credential_name(name)
        if not directory(self.root):
            return False
        with self.locked():
            if not directory(credentials.parent) or not directory(credentials):
                return False
            return self.remove_value(target)

    def remove_value(self, target):
        """Remove one exact credential under the management lock."""
        if not file_exists(target):
            return False
        target.unlink()
        sync_directory(target.parent)
        return True

    def website_login_directory(self, *, create=False, scoped=False):
        """Resolve the private root-owned directory for website-login records."""
        if not directory(self.root):
            raise VaultError('The Vault storage is unavailable.')
        path = self.root / (BOT_WEBSITE_LOGIN_DIRECTORY if scoped else WEBSITE_LOGIN_DIRECTORY)
        if create:
            directory(path, create=True)
        return path

    def read_website_login(self, path, expected_id=None, *, scoped=False):
        """Read one public website-login record without decrypting its credential."""
        try:
            if not directory(self.root) or not directory(path.parent):
                raise VaultError('The website login record is unavailable.')
            if not file_exists(path):
                raise VaultError('The website login record changed. Refresh and try again.')
            with path.open('rb') as source:
                payload = source.read(WEBSITE_LOGIN_FILE_LIMIT + 1)
            data = json.loads(payload.decode('utf-8'), object_pairs_hook=exact_object)
            credential = data.get('credential') if type(data) is dict else None
            fields = {'id', 'origin', 'label', 'credential'}
            if scoped:
                fields.add('bot')
            if (len(payload) > WEBSITE_LOGIN_FILE_LIMIT or type(data) is not dict
                    or set(data) != fields or (scoped and not valid_bot(data['bot']))
                    or not valid_login_id(data.get('id'))
                    or (expected_id is not None and data['id'] != expected_id)
                    or not valid_login_origin(data.get('origin'))
                    or type(data.get('label')) is not str
                    or login_text(data['label'], WEBSITE_LOGIN_LABEL_LIMIT) != data['label']
                    or type(credential) is not str):
                raise VaultError('The website login record is invalid.')
            encoded = credential.encode('ascii')
            cipher = base64.b64decode(encoded, validate=True)
            if not cipher or base64.b64encode(cipher) != encoded:
                raise VaultError('The website login record is invalid.')
            return data
        except VaultError:
            raise
        except (OSError, UnicodeError, ValueError, RecursionError):
            raise VaultError('The website login record is invalid.') from None

    def website_login_records(self, *, scoped=False):
        """List bounded public website-login metadata without exposing credentials."""
        path = self.website_login_directory(scoped=scoped)
        if not directory(path):
            return []
        entries = list(path.iterdir())
        if len(entries) > WEBSITE_LOGIN_LIMIT:
            raise VaultError('The Vault has too many website login records.')
        records = []
        for entry in entries:
            if not valid_login_id(entry.name):
                raise VaultError('The website login record is invalid.')
            records.append(self.read_website_login(entry, entry.name, scoped=scoped))
        return sorted(records, key=lambda record: record['id'])

    def website_login_cipher(self, record, username, password):
        """Encrypt exact website-login values under their record's credential name."""
        try:
            value = json.dumps(
                {'username': username, 'password': password}, ensure_ascii=False, separators=(',', ':'),
            ).encode('utf-8')
        except (UnicodeError, TypeError, ValueError):
            raise VaultError('The website login could not be encrypted.') from None
        encrypted = self.command(
            [
                '/usr/bin/systemd-creds', '--with-key=host',
                f'--name={website_login_credential_name(record)}', 'encrypt', '-', '-',
            ],
            'The website login could not be encrypted.', input=value, stdout=subprocess.PIPE,
        )
        try:
            cipher = base64.b64decode(b''.join(encrypted.split()), validate=True)
        except (AttributeError, ValueError):
            raise VaultError('Systemd returned an invalid encrypted website login.') from None
        if not cipher:
            raise VaultError('Systemd returned an empty encrypted website login.')
        return base64.b64encode(cipher).decode('ascii')

    def _website_login_values(self, payload):
        """Validate decrypted v1 values for the synchronous browser callback."""
        if type(payload) is not bytes or len(payload) > WEBSITE_LOGIN_FILE_LIMIT:
            raise VaultError(WEBSITE_LOGIN_UNAVAILABLE)
        try:
            data = json.loads(payload.decode('utf-8'), object_pairs_hook=exact_object)
            if type(data) is not dict or set(data) != {'username', 'password'}:
                raise VaultError(WEBSITE_LOGIN_UNAVAILABLE)
            username = login_text(data.get('username'), WEBSITE_LOGIN_USERNAME_LIMIT)
            password = login_text(data.get('password'), WEBSITE_LOGIN_PASSWORD_LIMIT)
            return username, password
        except VaultError:
            raise VaultError(WEBSITE_LOGIN_UNAVAILABLE) from None
        except (UnicodeError, ValueError, RecursionError, TypeError):
            raise VaultError(WEBSITE_LOGIN_UNAVAILABLE) from None

    def _use_website_login_locked(self, login_id, origin, deliver, *, bot=None):
        """Decrypt and deliver one login while the caller owns the Vault lock."""
        path = self.website_login_directory(scoped=bot is not None)
        record = self.read_website_login(path / login_id, login_id, scoped=bot is not None)
        if record['origin'] != origin or record.get('bot') != bot:
            raise VaultError(WEBSITE_LOGIN_UNAVAILABLE)
        decrypted = self.command(
            [
                '/usr/bin/systemd-creds', '--with-key=host',
                f'--name={website_login_credential_name(record)}', 'decrypt', '-', '-',
            ],
            WEBSITE_LOGIN_UNAVAILABLE,
            input=record['credential'].encode('ascii'), stdout=subprocess.PIPE,
        )
        username, password = self._website_login_values(decrypted)
        try:
            return deliver(username, password)
        except Exception:
            raise VaultError(WEBSITE_LOGIN_UNAVAILABLE) from None

    def use_website_login(self, login_id, origin, deliver):
        """Deliver a v1 login to an authorized browser callback under the Vault lock.

        The caller authenticates the browser and approves its exact login action.
        The callback must finish within the caller's deadline.
        """
        if not valid_login_id(login_id) or not valid_login_origin(origin) or not callable(deliver):
            raise VaultError(WEBSITE_LOGIN_UNAVAILABLE)
        try:
            with self.locked():
                self._use_website_login_locked(login_id, origin, deliver)
        except VaultError:
            raise VaultError(WEBSITE_LOGIN_UNAVAILABLE) from None
        except (AttributeError, OSError, OverflowError, TypeError, ValueError, RecursionError):
            raise VaultError(WEBSITE_LOGIN_UNAVAILABLE) from None

    def new_website_login_id(self, path):
        """Allocate a lower-case opaque id that is absent from the login directory."""
        for _attempt in range(32):
            login_id = secrets.token_hex(16)
            if not valid_login_id(login_id):
                continue
            if not file_exists(path / login_id):
                return login_id
        raise VaultError('The Vault could not allocate a website login id.')

    def write_website_login(self, path, record, username, password, action=None):
        """Encrypt and atomically commit one website-login record after stale checks."""
        target = path / record['id']
        exists = file_exists(target)
        if (action == 'add' and exists) or (action == 'replace' and not exists):
            raise VaultError('The website login changed. Refresh and try again.')
        credential = self.website_login_cipher(record, username, password)
        payload = (json.dumps(
            {**record, 'credential': credential}, ensure_ascii=False, separators=(',', ':')
        ) + '\n').encode('utf-8')
        replace_file(target, payload, path, 0o600)

    def add_website_login(self, request, *, login_id=None):
        """Encrypt a new account, optionally at its one-time signup request id."""
        scoped = 'bot' in request
        path = self.website_login_directory(create=True, scoped=scoped)
        if len(self.website_login_records(scoped=scoped)) >= WEBSITE_LOGIN_LIMIT:
            raise VaultError('The Vault has too many website login records.')
        if login_id is None:
            login_id = self.new_website_login_id(path)
        record = {'id': login_id, 'origin': request['origin'], 'label': request['label']}
        if scoped:
            record['bot'] = request['bot']
        self.write_website_login(path, record, request['username'], request['password'], 'add')

    def _desktop_login_import(self, request):
        """Review or add personal accounts while holding the owner-authorized Vault lock."""
        records = self.website_login_records()
        if request['action'] == 'inspect-login-import':
            salt = bytes.fromhex(request['salt'])
            fingerprints = []
            for record in records:
                origin = record['origin']
                prefix = salt + origin.encode('ascii') + b'\0'
                fingerprints.append(self._use_website_login_locked(
                    record['id'], origin, lambda username, _password: hashlib.sha256(
                        prefix + username.encode('utf-8')
                    ).hexdigest(),
                ))
            return {'importIndex': {
                'fingerprints': sorted(set(fingerprints)), 'remaining': WEBSITE_LOGIN_LIMIT - len(records),
            }}
        origin = request['origin']
        for record in records:
            if record['origin'] == origin and self._use_website_login_locked(
                    record['id'], origin, lambda username, _password: username == request['username']):
                return {'outcome': 'duplicate'}
        if len(records) >= WEBSITE_LOGIN_LIMIT:
            return {'outcome': 'full'}
        self.add_website_login(request)
        return {'outcome': 'imported'}

    def _website_login_for_edit(self, request):
        """Resolve a record only in the exact management scope supplied by the owner."""
        scoped = 'bot' in request
        path = self.website_login_directory(scoped=scoped)
        record = self.read_website_login(path / request['id'], request['id'], scoped=scoped)
        if record.get('bot') != request.get('bot'):
            raise VaultError('The website login changed. Refresh and try again.')
        return path, record

    def replace_website_login(self, request):
        """Encrypt and replace one existing owner-authorized website-login record."""
        path, record = self._website_login_for_edit(request)
        del record['credential']
        record['label'] = request['label']
        self.write_website_login(
            path, record, request['username'], request['password'], 'replace',
        )

    def remove_website_login(self, request):
        """Remove one existing website-login record without decrypting its credential."""
        path, _record = self._website_login_for_edit(request)
        if not self.remove_value(path / request['id']):
            raise VaultError('The website login changed. Refresh and try again.')

    def login_automation(self):
        """Read exact account generations and browser sessions from the owner policy."""
        path = self.root / WEBSITE_LOGIN_AUTOMATION
        if not file_exists(path):
            return {}
        invalid = 'The automatic sign-in settings are invalid.'
        try:
            with path.open('rb') as source:
                payload = source.read(BROWSER_FILE_LIMIT + 1)
            data = json.loads(payload.decode('ascii'), object_pairs_hook=exact_object)
            if (len(payload) > BROWSER_FILE_LIMIT or type(data) is not dict or set(data) != {'version', 'enabled'}
                    or type(data['version']) is not int or data['version'] != 1 or type(data['enabled']) is not dict
                    or len(data['enabled']) > WEBSITE_LOGIN_LIMIT):
                raise VaultError(invalid)
            for login_id, grant in data['enabled'].items():
                if (not valid_login_id(login_id) or type(grant) is not dict or set(grant) != {'session', 'generation'}
                        or not valid_browser_session(grant['session']) or not valid_login_generation(grant['generation'])):
                    raise VaultError(invalid)
            return data['enabled']
        except (OSError, UnicodeError, ValueError, RecursionError):
            raise VaultError(invalid) from None

    def current_automatic_logins(self, grants):
        """Match saved choices to the current encrypted generations of assigned accounts."""
        if not grants:
            return []
        return [(record, grants[record['id']]) for record in self.website_login_records(scoped=True)
                if record['id'] in grants and grants[record['id']]['generation'] == website_login_generation(record)]

    def manage_login_automation(self, policy, request):
        """Show or change exact owner sign-in permission under the Vault lock."""
        request = login_automation_request(request)
        grants = self.login_automation()
        if request['action'] == 'list-login-automation':
            try:
                self.require_requests(policy)
                available = bool(browser_grant_pairs())
            except VaultError:
                available = False
            return {'loginAutomation': {'available': available,
                    'enabled': [record['id'] for record, _grant in self.current_automatic_logins(grants)]}}

        _path, record = self._website_login_for_edit(request)
        login_id, bot = record['id'], record['bot']
        if request['enabled']:
            self.require_requests(policy)
            pairs = browser_grant_pairs()
            session = next((selected for candidate, selected in pairs if candidate == bot), None)
            if session is None:
                raise VaultError('Automatic sign-in requires a private browser for this Bot.')
            current = self.current_automatic_logins(grants)
            if any(account['id'] != login_id and account['bot'] == bot and account['origin'] == record['origin']
                   and grant['session'] == session for account, grant in current):
                raise VaultError('Turn off the other automatic sign-in for this website first.')
            updated = {account['id']: grant for account, grant in current}
            updated[login_id] = {'session': session, 'generation': website_login_generation(record)}
        else:
            updated = {key: grant for key, grant in grants.items() if key != login_id}
        target = self.root / WEBSITE_LOGIN_AUTOMATION
        if updated != grants:
            if updated:
                payload = (json.dumps({'version': 1, 'enabled': updated}, separators=(',', ':')) + '\n').encode('ascii')
                replace_file(target, payload, self.root, 0o600)
            else:
                self.remove_value(target)
        return {'ok': True}

    def allow_desktop(self, owner_uid, cloud_uid, units, *, start=False):
        """Authorize one SSH owner for an explicit list of enabled services."""
        if owner_uid <= 0 or cloud_uid <= 0 or owner_uid == cloud_uid:
            raise VaultError('Desktop Vault needs an SSH owner account separate from Cloud.')
        units = sorted(set(units))
        if len(units) > DESKTOP_SERVICE_LIMIT:
            raise VaultError('Select at most 16 services for Desktop Vault.')
        if not directory(self.root, create=not units):
            raise VaultError('Enable the Vault for each selected service first.')
        with self.locked():
            for unit in units:
                self.enabled_credentials(unit, cloud_uid)
            policy = self.root / 'desktop.json'
            previous = policy.read_bytes() if file_exists(policy) else None
            if previous is not None:
                self.desktop_policy(owner_uid)
            self.write_request_records([])
            prepared = self.prepare_desktop(owner_uid) if start else None
            data = {'owner': owner_uid, 'cloud': cloud_uid, 'services': units}
            try:
                replace_file(policy, (json.dumps(data) + '\n').encode(), self.root, 0o600)
                if prepared is not None:
                    self.activate_desktop(prepared)
            except (VaultError, OSError, KeyboardInterrupt):
                if previous is None:
                    self.remove_value(policy)
                    if prepared is not None:
                        self.stop_desktop()
                else:
                    replace_file(policy, previous, self.root, 0o600)
                raise

    def initialize_cloud(self, owner_uid, cloud_uid, *, start=False):
        """Open an empty managed Vault for one owner while preserving an existing policy."""
        if owner_uid <= 0 or cloud_uid <= 0 or owner_uid == cloud_uid:
            raise VaultError('Desktop Vault needs an SSH owner account separate from Cloud.')
        directory(self.root, create=True)
        with self.locked():
            destination = self.root / 'desktop.json'
            if file_exists(destination):
                if self.desktop_policy(owner_uid)['cloud'] != cloud_uid:
                    raise VaultError('The existing Vault belongs to a different Cloud account.')
                return
            _pairs, publisher_uid = browser_grants()
            if publisher_uid != cloud_uid:
                raise VaultError('Install the managed Browser roster for this Cloud account before opening its Vault.')
            policy = {'owner': owner_uid, 'cloud': cloud_uid, 'services': []}
            if self.require_requests(policy, allow_disabled=True):
                raise VaultError('Existing Vault broker grants require administrator review.')
            if start:
                desktop = self.prepare_desktop(owner_uid)
                broker = self.prepare_cloud_requests(cloud_uid)
                self.activate_desktop(desktop)
                self.activate_cloud_requests(broker)
            self.write_request_grants(policy, set())
            replace_file(destination, (json.dumps(policy) + '\n').encode(), self.root, 0o600)

    def desktop_units(self, owner_uid):
        """Resolve the exact managed systemd files for a Desktop Vault listener."""
        return {
            self.units / DESKTOP_LISTENER: desktop_socket_unit(owner_uid),
            self.units / DESKTOP_WORKER: desktop_worker_unit(),
        }

    def cloud_units(self, cloud_uid):
        """Resolve the exact managed systemd files for the Cloud broker."""
        return {
            self.units / CLOUD_LISTENER: cloud_socket_unit(cloud_uid),
            self.units / CLOUD_WORKER: cloud_worker_unit(),
        }

    def prepare_desktop(self, owner_uid):
        """Check both unit destinations before changing the authorization policy."""
        trusted_file(INSTALLED_VAULT)
        if not directory(self.units, private=False):
            raise VaultError('The system service configuration directory is unavailable.')
        units = self.desktop_units(owner_uid)
        for path, expected in units.items():
            if file_exists(path, private=False) and path.read_bytes() != expected:
                raise VaultError('Different Vault management units already exist. Review them before setup.')
        return units

    def activate_desktop(self, units):
        """Install and start the listener after its owner policy is durable."""
        for path, expected in units.items():
            if not path.exists():
                replace_file(path, expected, self.units, 0o644)
        for args in (['daemon-reload'], ['enable', '--now', '--', DESKTOP_LISTENER]):
            self.command([*SYSTEMCTL, *args], 'Could not enable the Desktop Vault socket.', stdout=subprocess.DEVNULL)

    def prepare_cloud_requests(self, cloud_uid):
        """Check both broker unit destinations before enabling the root listener."""
        trusted_file(INSTALLED_VAULT)
        if not directory(self.units, private=False):
            raise VaultError('The system service configuration directory is unavailable.')
        units = self.cloud_units(cloud_uid)
        for path, expected in units.items():
            if file_exists(path, private=False) and path.read_bytes() != expected:
                raise VaultError('Different Cloud Vault request units already exist. Review them before setup.')
        return units

    def activate_cloud_requests(self, units):
        """Install and start the root broker after its policy is durable."""
        for path, expected in units.items():
            if not path.exists():
                replace_file(path, expected, self.units, 0o644)
        for args in (['daemon-reload'], ['enable', '--now', '--', CLOUD_LISTENER]):
            self.command([*SYSTEMCTL, *args], 'Could not enable the Cloud Vault request socket.', stdout=subprocess.DEVNULL)

    def enable_requests(self, grants, *, start=False):
        """Enable the root broker using the current Desktop policy's Cloud UID."""
        if not directory(self.root):
            raise VaultError('Enable Desktop Vault access before enabling Cloud requests.')
        with self.locked():
            policy = self.root_policy()
            if not grants or len(grants) > REQUEST_RECORD_LIMIT:
                raise VaultError('Select 1 to 64 exact Cloud Vault request grants.')
            for grant in grants:
                if not valid_request_grant(grant) or grant[-2] not in policy['services']:
                    raise VaultError('Every request grant needs a key name and a service enabled for Desktop Vault.')
                self.enabled_credentials(grant[-2], policy['cloud'])
            self.write_request_grants(policy, set(map(tuple, grants)), start=start)

    def enable_login_automation(self, *, start=False):
        """Start the standard broker for website login without allocating service key grants."""
        if not directory(self.root):
            raise VaultError('Enable Desktop Vault access before enabling website login automation.')
        with self.locked():
            policy = self.root_policy()
            if not browser_grant_pairs():
                raise VaultError('Configure a private isolated browser before enabling website login automation.')
            grants = self.require_requests(policy, allow_disabled=True)
            self.write_request_grants(policy, grants, start=start)

    def set_shared_request_grant(self, grant, enabled):
        """Change an existing Bot credential grant without replacing unrelated grants."""
        if not directory(self.root) or not valid_request_grant(grant) or len(grant) != 3:
            raise VaultError('Select an existing exact Bot, service and key grant.')
        with self.locked():
            policy = self.root_policy()
            grants = self.require_requests(policy)
            self.set_request_grant_scope(policy, grants, grant, 'shared' if enabled else 'owner')

    def set_request_grant_scope(self, policy, grants, grant, scope):
        """Change one existing Bot grant while the caller owns the Vault lock."""
        if scope not in ('owner', 'shared'):
            raise VaultError('Select an owner or shared Bot credential grant.')
        bot, unit, name = grant
        self.request_credentials(policy, grants, unit, name, bot)
        shared = ('shared', *grant)
        grants.difference_update((grant, shared))
        grants.add(shared if scope == 'shared' else grant)
        self.write_request_grants(policy, grants)

    def write_request_grants(self, policy, grants, *, start=False):
        """Publish a grant set and discard withdrawn requests under the Vault lock."""
        if len(grants) > REQUEST_RECORD_LIMIT:
            raise VaultError('The Vault supports at most 64 request grants.')
        marker = self.root / CLOUD_REQUESTS_ENABLED
        configured = {'cloud': policy['cloud'], 'grants': sorted(grants)}
        payload = (json.dumps(configured, separators=(',', ':')) + '\n').encode()
        previous = marker.read_bytes() if file_exists(marker) else None
        prepared = self.prepare_cloud_requests(policy['cloud']) if start else None
        created = set() if prepared is None else {path for path in prepared if not path.exists()}
        try:
            if prepared is not None:
                self.activate_cloud_requests(prepared)
            if previous != payload:
                records, expired = self.clean_request_records(self.read_request_records() if previous is not None else [])
                kept = [record for record in records
                        if request_granted(grants, record['unit'], record['name'], record.get('bot'), record.get('scope'))]
                if previous is None or expired or len(kept) != len(records):
                    self.write_request_records(kept)
                replace_file(marker, payload, self.root, 0o600)
        except (VaultError, OSError, KeyboardInterrupt):
            if any(path.exists() for path in created):
                self.stop_cloud_requests()
            raise

    def stop_cloud_requests(self):
        """Stop and remove only Vault's exact generated Cloud broker units."""
        if not directory(self.units, private=False):
            raise VaultError('The system service configuration directory is unavailable.')
        listener = self.units / CLOUD_LISTENER
        worker = self.units / CLOUD_WORKER
        paths = []
        listener_present = file_exists(listener, private=False)
        worker_present = file_exists(worker, private=False)
        if listener_present:
            content = listener.read_bytes()
            cloud = re.search(rb'^SocketUser=([1-9][0-9]{0,9})$', content, re.MULTILINE)
            if cloud is None or content != cloud_socket_unit(int(cloud[1])):
                raise VaultError('A different Cloud Vault request socket exists. Review it before removal.')
            paths.append(listener)
        if worker_present:
            if worker.read_bytes() != cloud_worker_unit():
                raise VaultError('A different Cloud Vault request worker exists. Review it before removal.')
            paths.append(worker)
        if listener_present:
            self.command([*SYSTEMCTL, 'disable', '--now', '--', CLOUD_LISTENER],
                         'Could not stop the Cloud Vault request socket.', stdout=subprocess.DEVNULL)
        for path in paths:
            path.unlink()
        if paths:
            sync_directory(self.units)
            self.command([*SYSTEMCTL, 'daemon-reload'], 'Could not reload after disabling Cloud Vault requests.',
                         stdout=subprocess.DEVNULL)

    def disable_requests(self):
        """Disable and remove only the generated root broker units."""
        if directory(self.root):
            with self.locked():
                self.remove_value(self.root / CLOUD_REQUESTS_ENABLED)
                self.write_request_records([])
                self.stop_cloud_requests()

    def stop_desktop(self):
        """Stop and remove only Vault's generated systemd socket and worker."""
        if not directory(self.units, private=False):
            raise VaultError('The system service configuration directory is unavailable.')
        listener = self.units / DESKTOP_LISTENER
        worker = self.units / DESKTOP_WORKER
        paths = []
        if file_exists(listener, private=False):
            content = listener.read_bytes()
            owner = re.search(rb'^SocketUser=([1-9][0-9]{0,9})$', content, re.MULTILINE)
            if owner is None or content != desktop_socket_unit(int(owner[1])):
                raise VaultError('A different Vault management socket exists. Review it before removal.')
            self.command([*SYSTEMCTL, 'disable', '--now', '--', DESKTOP_LISTENER],
                         'Could not stop the Desktop Vault socket.', stdout=subprocess.DEVNULL)
            paths.append(listener)
        if file_exists(worker, private=False):
            if worker.read_bytes() != desktop_worker_unit():
                raise VaultError('A different Vault management worker exists. Review it before removal.')
            paths.append(worker)
        for path in paths:
            path.unlink()
        if paths:
            sync_directory(self.units)
            self.command([*SYSTEMCTL, 'daemon-reload'], 'Could not reload after disabling Desktop Vault.',
                         stdout=subprocess.DEVNULL)

    def deny_desktop(self):
        """Revoke the SSH owner's policy and disable the managed socket."""
        if directory(self.root):
            with self.locked():
                self.remove_value(self.root / 'desktop.json')
                self.remove_value(self.root / CLOUD_REQUESTS_ENABLED)
                self.remove_value(self.root / WEBSITE_LOGIN_AUTOMATION)
                self.write_request_records([])
                self.stop_cloud_requests()
                self.stop_desktop()

    def root_policy(self):
        """Resolve the current root-owned Desktop and Cloud authorization."""
        denied = 'Desktop Vault access is unavailable for this SSH account.'
        policy = self.root / 'desktop.json'
        if not file_exists(policy):
            raise VaultError(denied)
        try:
            with policy.open('rb') as source:
                payload = source.read(DESKTOP_REQUEST_LIMIT + 1)
            data = json.loads(payload.decode('utf-8'), object_pairs_hook=exact_object)
            services = data.get('services') if type(data) is dict else None
            if (len(payload) > DESKTOP_REQUEST_LIMIT or type(data) is not dict
                    or set(data) != {'owner', 'cloud', 'services'}
                    or type(data.get('owner')) is not int or data['owner'] <= 0
                    or type(data.get('cloud')) is not int or data['cloud'] <= 0
                    or data['owner'] == data['cloud']
                    or type(services) is not list or len(services) > DESKTOP_SERVICE_LIMIT
                    or any(not valid_unit(unit) for unit in services)
                    or len(set(services)) != len(services)):
                raise VaultError(denied)
            return data
        except (OSError, UnicodeError, ValueError, RecursionError):
            raise VaultError(denied) from None

    def desktop_policy(self, requester_uid):
        """Require the current root policy to authorize one Desktop owner."""
        data = self.root_policy()
        if data['owner'] != requester_uid:
            raise VaultError('Desktop Vault access is unavailable for this SSH account.')
        return data

    def request_file(self):
        """Resolve the root-owned metadata file for Cloud credential requests."""
        return self.root / CLOUD_REQUESTS_FILE

    def require_requests(self, policy, *, allow_disabled=False):
        """Resolve the root-approved exact service and key grants for the current Cloud account."""
        marker = self.root / CLOUD_REQUESTS_ENABLED
        if not file_exists(marker):
            if allow_disabled:
                return set()
            raise VaultError(REQUEST_UNAVAILABLE)
        try:
            with marker.open('rb') as source:
                payload = source.read(DESKTOP_REQUEST_LIMIT + 1)
            data = json.loads(payload.decode('utf-8'), object_pairs_hook=exact_object)
            if (len(payload) > DESKTOP_REQUEST_LIMIT or type(data) is not dict or set(data) != {'cloud', 'grants'}
                    or type(data['cloud']) is not int or data['cloud'] != policy['cloud']
                    or type(data['grants']) is not list or len(data['grants']) > REQUEST_RECORD_LIMIT
                    or any(not valid_request_grant(grant) for grant in data['grants'])):
                raise VaultError(REQUEST_UNAVAILABLE)
            return set(map(tuple, data['grants']))
        except (OSError, UnicodeError, ValueError, RecursionError):
            raise VaultError(REQUEST_UNAVAILABLE) from None

    def read_request_records(self):
        """Read and validate bounded, boot-scoped request metadata."""
        path = self.request_file()
        if not file_exists(path):
            return []
        try:
            payload = path.read_bytes()
            data = json.loads(payload.decode('utf-8'), object_pairs_hook=exact_object)
            records = data.get('requests') if type(data) is dict else None
            if (len(payload) > DESKTOP_REQUEST_LIMIT or type(data) is not dict
                    or set(data) != {'boot', 'requests'}):
                raise VaultError(REQUEST_UNAVAILABLE)
            if data.get('boot') != self.boot_id:
                return []
            if (type(records) is not list or len(records) > REQUEST_RECORD_LIMIT):
                raise VaultError(REQUEST_UNAVAILABLE)
            checked = []
            fields = {'id', 'unit', 'name', 'state', 'created', 'lease'}
            for record in records:
                if type(record) is not dict or set(record) - {'bot', 'scope', 'approval'} != fields:
                    raise VaultError(REQUEST_UNAVAILABLE)
                created = record.get('created')
                lease = record.get('lease')
                if (not valid_request_id(record.get('id')) or not valid_unit(record.get('unit'))
                        or ('bot' in record and not valid_bot(record['bot']))
                        or ('scope' in record and (record['scope'] != 'shared' or 'bot' not in record))
                        or type(record.get('name')) is not str or not NAME.fullmatch(record['name'])
                        or record.get('state') not in ('pending', 'saved', 'cancelled')
                        or type(created) not in (int, float) or type(lease) not in (int, float)
                        or not math.isfinite(created) or not math.isfinite(lease)
                        or created < 0 or lease < created):
                    raise VaultError(REQUEST_UNAVAILABLE)
                if 'approval' in record:
                    approval = record['approval']
                    if (record.get('scope') != 'shared' or record['state'] != 'pending'
                            or type(approval) is not dict or set(approval) != {'challenge', 'expires', 'admitted'}
                            or not valid_request_id(approval.get('challenge')) or type(approval.get('admitted')) is not bool
                            or type(approval.get('expires')) not in (int, float) or not math.isfinite(approval['expires'])
                            or not created < approval['expires'] <= lease):
                        raise VaultError(REQUEST_UNAVAILABLE)
                checked.append(record)
            if len({record['id'] for record in checked}) != len(checked):
                raise VaultError(REQUEST_UNAVAILABLE)
            return checked
        except (OSError, OverflowError, UnicodeError, ValueError, RecursionError):
            raise VaultError(REQUEST_UNAVAILABLE) from None

    def write_request_records(self, records):
        """Persist only bounded request metadata, never credential values."""
        if not records:
            self.remove_value(self.request_file())
            return
        replace_file(
            self.request_file(),
            (json.dumps({'boot': self.boot_id, 'requests': records}, separators=(',', ':')) + '\n').encode(),
            self.root,
            0o600,
        )

    def clean_request_records(self, records):
        """Discard metadata older than the fixed request lifetime."""
        now = self.clock()
        changed = False
        kept = []
        for record in records:
            if now - record['created'] >= REQUEST_TTL:
                changed = True
                continue
            kept.append(record)
        return kept, changed

    def request_record(self, records, request_id):
        """Find one request by its opaque id without exposing unrelated metadata."""
        return next((record for record in records if record['id'] == request_id), None)

    def request_credentials(self, policy, grants, unit, name, bot=None, scope=None):
        """Revalidate one request against the live root service allowlist."""
        if unit not in policy['services'] or not request_granted(grants, unit, name, bot, scope):
            raise VaultError(REQUEST_UNAVAILABLE)
        try:
            return self.enabled_credentials(unit, policy['cloud'])
        except VaultError:
            raise VaultError(REQUEST_UNAVAILABLE) from None

    def observe_request(self, record, credentials):
        """Count an existing encrypted key as a receipt without reading its value."""
        if record['state'] == 'pending' and file_exists(credentials / record['name']):
            finish_request(record, 'saved')
            return True
        return False

    def request_reply(self, record):
        """Render the owner-visible request metadata without a secret value."""
        return {'request': {key: record[key] for key in ('id', 'unit', 'name', 'state')}}

    def _browser_login_metadata(self, request_id):
        """Reinspect one pending browser request over the fixed root-only socket."""
        payload = json.dumps({'action': 'inspect-login', 'id': request_id}, separators=(',', ':')).encode('ascii')
        return browser_login_inspection(browser_client(payload), request_id)

    def _browser_login_records(self, inspected):
        """Choose accounts for the reviewed Bot and website."""
        if 'purpose' in inspected:
            return []
        origin = inspected['origin']
        assigned = [record for record in self.website_login_records(scoped=True) if record['origin'] == origin]
        if inspected.get('scope') == 'shared':
            return [record for record in assigned if record['bot'] == inspected['bot']]
        if assigned:
            query = json.dumps({'action': 'inspect-login-bot', 'id': inspected['id']},
                               separators=(',', ':')).encode('ascii')
            try:
                reply = json.loads(browser_client(query).decode('utf-8'), object_pairs_hook=exact_object)
            except (UnicodeError, ValueError, RecursionError):
                raise VaultError(BROWSER_UNAVAILABLE) from None
            if reply == {'error': 'unavailable'}:
                return []
            if type(reply) is not dict or set(reply) != {'bot'} or not valid_bot(reply['bot']):
                raise VaultError(BROWSER_UNAVAILABLE)
            scoped = [record for record in assigned if record['bot'] == reply['bot']]
            if scoped:
                return scoped
        return [record for record in self.website_login_records() if record['origin'] == origin]

    def _inspect_browser_login(self, request):
        """Return pending browser metadata and matching owner-visible login choices."""
        inspected = self._browser_login_metadata(request['id'])
        visible = {
            'id': inspected['id'], 'origin': inspected['origin'], 'destination': inspected['destination'],
            'logins': [
                {'id': record['id'], 'label': record['label'], 'generation': website_login_generation(record)}
                for record in self._browser_login_records(inspected)
            ],
        }
        if 'purpose' in inspected:
            visible['purpose'] = inspected['purpose']
        elif request.get('form') == 'entry' and inspected.get('scope') != 'shared':
            visible['acceptsCredentials'] = True
        return {'request': visible}

    def _deliver_browser_login(self, inspected, username, password, *, bot=None, session=None):
        """Send the values for one pending login to the dedicated browser worker."""
        payload = json.dumps({
            'action': 'use-signup' if inspected.get('purpose') == 'signup' else 'use-login',
            'id': inspected['id'], 'origin': inspected['origin'],
            'username': username, 'password': password,
            **({} if bot is None else {'bot': bot}),
            **({} if session is None else {'session': session}),
        }, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        return browser_login_state(browser_client(payload))

    def _automatic_browser_login(self, request):
        """Deliver one current account to its exact pending private browser and HTTPS origin."""
        try:
            bot, session = request['bot'], request['session']
            candidates = [record for record, grant in self.current_automatic_logins(self.login_automation())
                          if record['bot'] == bot and grant['session'] == session]
            if not candidates:
                return {'state': 'approval-required'}
            if (bot, session) not in browser_grant_pairs():
                return {'state': 'unavailable'}
            query = json.dumps({'action': 'inspect-login-automatic', 'id': request['id']},
                               separators=(',', ':')).encode('ascii')
            inspected = browser_login_inspection(browser_client(query), request['id'], automatic=True)
            if (inspected['bot'], inspected['session']) != (bot, session):
                return {'state': 'unavailable'}
            matching = [record for record in candidates if record['origin'] == inspected['origin']]
            if not matching:
                return {'state': 'approval-required'}
            if len(matching) != 1:
                return {'state': 'unavailable'}
            return self._use_website_login_locked(
                matching[0]['id'], inspected['origin'],
                lambda username, password: self._deliver_browser_login(
                    inspected, username, password, bot=bot, session=session,
                ), bot=bot,
            )
        except (VaultError, OSError, UnicodeError, ValueError, RecursionError, TypeError):
            return {'state': 'unavailable'}

    def _approve_browser_login(self, request):
        """Deliver an owner-selected login while policy, generation, and delivery share one lock."""
        try:
            inspected = self._browser_login_metadata(request['id'])
            record = next((candidate for candidate in self._browser_login_records(inspected)
                           if candidate['id'] == request['loginId']), None)
            if record is None or website_login_generation(record) != request['generation']:
                return {'state': 'unavailable'}
            bot = record.get('bot')
            return self._use_website_login_locked(
                record['id'], inspected['origin'],
                lambda username, password: self._deliver_browser_login(inspected, username, password, bot=bot),
                bot=bot,
            )
        except (AttributeError, VaultError, OSError, OverflowError, TypeError, ValueError, UnicodeError, RecursionError):
            return {'state': 'unavailable'}

    def _enter_browser_login(self, request):
        """Submit a one-time login and save it only after submission and explicit consent."""
        try:
            inspected = self._browser_login_metadata(request['id'])
            if (inspected.get('scope') == 'shared' or 'purpose' in inspected
                    or inspected['origin'] != request['origin'] or inspected['destination'] != request['destination']):
                return {'state': 'unavailable'}
            result = self._deliver_browser_login(inspected, request['username'], request['password'])
        except (VaultError, OSError):
            return {'state': 'unavailable'}
        if result['state'] == 'submitted' and 'saveLabel' in request:
            try:
                self.add_website_login({
                    'origin': inspected['origin'], 'label': request['saveLabel'],
                    'username': request['username'], 'password': request['password'],
                })
                result['saved'] = True
            except (VaultError, OSError):
                result['saved'] = False
        return result

    def _enter_browser_verification(self, request):
        """Send a code once to its current private browser without creating a Vault entry."""
        try:
            inspected = self._browser_login_metadata(request['id'])
            if (inspected.get('purpose') != 'verification' or inspected['origin'] != request['origin']
                    or inspected['destination'] != request['destination']
                    or (inspected['bot'], inspected['session']) not in browser_grant_pairs()):
                return {'state': 'unavailable'}
            payload = json.dumps({
                'action': 'use-verification', 'id': inspected['id'], 'origin': inspected['origin'],
                'destination': inspected['destination'], 'bot': inspected['bot'], 'session': inspected['session'],
                'code': request['code'],
            }, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
            return browser_login_state(browser_client(payload))
        except (VaultError, OSError):
            return {'state': 'unavailable'}

    def _create_browser_login(self, request):
        """Save a Bot's generated password before submitting it to the reviewed site."""
        try:
            inspected = self._browser_login_metadata(request['id'])
            if (inspected.get('purpose') != 'signup' or inspected['origin'] != request['origin']
                    or inspected['destination'] != request['destination']
                    or (inspected['bot'], inspected['session']) not in browser_grant_pairs()):
                return {'state': 'unavailable'}
            login_id = inspected['id']
            path = self.website_login_directory(scoped=True)
            if path is not None and file_exists(path / login_id):
                existing = self.read_website_login(path / login_id, login_id, scoped=True)
                if (existing['bot'], existing['origin']) != (inspected['bot'], inspected['origin']):
                    return {'state': 'unavailable'}
                return {'state': 'needs-owner', 'saved': True}
            password = secrets.token_urlsafe(16) + 'A1a!'
            self.add_website_login({
                'bot': inspected['bot'], 'origin': inspected['origin'], 'label': request['saveLabel'],
                'username': request['username'], 'password': password,
            }, login_id=login_id)
        except (VaultError, OSError):
            return {'state': 'unavailable'}
        try:
            delivered = self._deliver_browser_login(inspected, request['username'], password,
                                                   bot=inspected['bot'], session=inspected['session'])
        except (VaultError, OSError):
            delivered = {'state': 'unavailable'}
        return {'state': 'submitted' if delivered['state'] == 'submitted' else 'needs-owner', 'saved': True}

    def _decline_browser_login(self, request):
        """Release one pending browser request without returning browser diagnostics."""
        try:
            payload = json.dumps({'action': 'cancel-login', 'id': request['id']}, separators=(',', ':')).encode('ascii')
            browser_client(payload)
        except Exception:
            pass
        return {'state': 'unavailable'}

    def desktop_grants(self, policy, request):
        """Read or update Bot request permissions for the authenticated Desktop owner."""
        grants = self.require_requests(policy, allow_disabled=True)
        action = request['action']
        if action == 'list-grants':
            return {'access': {'services': policy['services'], 'grants': [
                {'bot': bot, 'unit': unit, 'name': name}
                for bot, unit, name in sorted({grant[-3:] for grant in grants if len(grant) >= 3})
            ]}}
        if action == 'list-scoped-grants':
            scoped = [
                {'bot': grant[-3], 'unit': grant[-2], 'name': grant[-1],
                 'scope': 'shared' if len(grant) == 4 else 'owner'}
                for grant in sorted(
                    (grant for grant in grants if len(grant) in (3, 4)),
                    key=lambda grant: (*grant[-3:], 'shared' if len(grant) == 4 else 'owner'),
                )
            ]
            return {'access': {'services': policy['services'], 'grants': scoped}}
        grant = (request['bot'], request['unit'], request['name'])
        shared_grant = ('shared', *grant)
        if action == 'remove-grant':
            if grant in grants or shared_grant in grants:
                grants.difference_update((grant, shared_grant))
                self.write_request_grants(policy, grants)
        elif action == 'set-grant-scope':
            self.set_request_grant_scope(policy, grants, grant, request['scope'])
        else:
            if grant[1] not in policy['services']:
                raise VaultError('This service is not enabled for Desktop Vault.')
            self.enabled_credentials(grant[1], policy['cloud'])
            if request.get('scope') == 'shared':
                grants.difference_update((grant, shared_grant))
                grants.add(shared_grant)
            elif shared_grant not in grants:
                grants.add(grant)
            self.write_request_grants(policy, grants, start=True)
        return {'ok': True}

    def set_browser_access(self, request):
        """Persist one owner-approved browser decision before asking the worker to reload it."""
        pair = (request['bot'], request['session'])
        grants, publisher_uid = browser_grants()
        if pair not in grants:
            raise VaultError(BROWSER_UNAVAILABLE)
        records = browser_shared_policy()
        active = [record for record in records if (record['bot'], record['session']) in grants]
        detached = len(active) != len(records)
        if detached and publisher_uid is None:
            raise VaultError(BROWSER_UNAVAILABLE)
        records = active
        current = next((record for record in records
                        if (record['bot'], record['session']) == pair), None)
        if current is None:
            if len(records) >= BROWSER_GRANT_LIMIT:
                raise VaultError(BROWSER_UNAVAILABLE)
            records.append({
                'bot': request['bot'], 'session': request['session'],
                'enabled': request['enabled'], 'revision': secrets.token_hex(16),
            })
            records.sort(key=lambda record: (record['bot'], record['session']))
            replace_browser_policy(records)
        else:
            changed = current['enabled'] != request['enabled']
            if changed:
                current['enabled'] = request['enabled']
                current['revision'] = secrets.token_hex(16)
            if changed or detached:
                replace_browser_policy(records)
        return browser_refresh_acknowledged()

    def desktop_credential_request(self, request, requester_uid):
        """Serve owner metadata and wait for live admission before a shared save."""
        action = request['action']
        value = request['value'].encode() if action == 'save-request' else None
        if value is not None and not valid_secret(value):
            raise VaultError('Enter a non-empty credential of at most 8 KiB.')
        with self.locked():
            policy = self.desktop_policy(requester_uid)
            grants = self.require_requests(policy)
            records, changed = self.clean_request_records(self.read_request_records())
            record = self.request_record(records, request['id'])
            if record is None:
                raise VaultError(REQUEST_UNAVAILABLE)
            scope = record.get('scope')
            credentials = self.request_credentials(policy, grants, record['unit'], record['name'], record.get('bot'), scope)
            changed = self.observe_request(record, credentials) or changed
            now = self.clock()
            if record['state'] == 'pending' and (now >= record['lease'] or action == 'dismiss-request'):
                finish_request(record, 'cancelled')
                changed = True
            if changed:
                self.write_request_records(records)
            if action == 'inspect-request':
                return self.request_reply(record)
            if action == 'dismiss-request':
                return {'state': record['state']}
            if record['state'] == 'saved':
                return {'ok': True}
            if record['state'] != 'pending':
                raise VaultError(REQUEST_UNAVAILABLE)
            if scope is None:
                self.write_value(credentials, record['name'], value, 'add')
                finish_request(record, 'saved')
                self.write_request_records(records)
                return {'ok': True}
            if record.get('approval') is not None and record['approval']['expires'] > now:
                raise VaultError(REQUEST_UNAVAILABLE)
            challenge = secrets.token_hex(16)
            record['approval'] = {'challenge': challenge, 'expires': min(now + REQUEST_APPROVAL_WINDOW, record['lease']),
                                  'admitted': False}
            self.write_request_records(records)
        return self.await_shared_credential_save(requester_uid, request['id'], challenge, value)

    def await_shared_credential_save(self, requester_uid, request_id, challenge, value):
        """Keep the key in the Desktop worker while awaiting its single-use approval."""
        deadline = time.monotonic() + REQUEST_APPROVAL_WINDOW
        while True:
            with self.locked():
                policy = self.desktop_policy(requester_uid)
                records, _ = self.clean_request_records(self.read_request_records())
                record = self.request_record(records, request_id)
                approval = record.get('approval') if record is not None else None
                if approval is None or approval['challenge'] != challenge:
                    raise VaultError(REQUEST_UNAVAILABLE)
                if self.clock() >= approval['expires'] or time.monotonic() >= deadline:
                    finish_request(record, 'cancelled')
                    self.write_request_records(records)
                    raise VaultError(REQUEST_UNAVAILABLE)
                if approval['admitted']:
                    grants = self.require_requests(policy)
                    credentials = self.request_credentials(policy, grants, record['unit'], record['name'],
                                                           record['bot'], record['scope'])
                    record.pop('approval')
                    try:
                        if not self.observe_request(record, credentials):
                            self.write_value(credentials, record['name'], value, 'add')
                            finish_request(record, 'saved')
                    finally:
                        self.write_request_records(records)
                    return {'ok': True}
            time.sleep(REQUEST_APPROVAL_POLL)

    def desktop(self, request, requester_uid):
        """Apply a validated Desktop request and return metadata or an acknowledgment."""
        if not directory(self.root):
            raise VaultError('Desktop Vault access is unavailable for this SSH account.')
        action = request['action']
        if action in ('inspect-request', 'save-request', 'dismiss-request'):
            return self.desktop_credential_request(request, requester_uid)
        with self.locked():
            policy = self.desktop_policy(requester_uid)
            if action in ('list-grants', 'list-scoped-grants', 'add-grant', 'remove-grant', 'set-grant-scope'):
                return self.desktop_grants(policy, request)
            if action == 'set-browser-access':
                return self.set_browser_access(request)
            if action in ('list-login-automation', 'set-login-automatic'):
                return self.manage_login_automation(policy, request)
            if action in ('inspect-login-import', 'import-login'):
                return self._desktop_login_import(website_login_request(request))
            if action in ('list-logins', 'list-bot-logins', 'add-login', 'replace-login', 'remove-login'):
                request = website_login_request(request)
                if action == 'list-logins':
                    return {'logins': [
                        {key: record[key] for key in ('id', 'origin', 'label')}
                        for record in self.website_login_records()
                    ]}
                if action == 'list-bot-logins':
                    return {'botLogins': [
                        {key: record[key] for key in ('id', 'origin', 'label', 'bot')}
                        for record in self.website_login_records(scoped=True)
                    ]}
                if action == 'add-login':
                    self.add_website_login(request)
                elif action == 'replace-login':
                    self.replace_website_login(request)
                else:
                    self.remove_website_login(request)
                return {'ok': True}
            if action == 'inspect-login-use':
                return self._inspect_browser_login(request)
            if action == 'approve-login-use':
                return self._approve_browser_login(request)
            if action == 'enter-login-use':
                return self._enter_browser_login(entered_website_login_request(request))
            if action == 'create-login-use':
                return self._create_browser_login(website_signup_request(request))
            if action == 'enter-verification-code':
                return self._enter_browser_verification(website_verification_request(request))
            if action == 'decline-login-use':
                return self._decline_browser_login(request)
            if action == 'list':
                services = []
                for unit in policy['services']:
                    names = self.credential_names(self.enabled_credentials(unit, policy['cloud']))
                    if len(names) > DESKTOP_NAME_LIMIT:
                        raise VaultError('This service has too many entries for Desktop Vault.')
                    services.append({'unit': unit, 'names': names})
                return {'services': services}
            unit = request['unit']
            if unit not in policy['services']:
                raise VaultError('This service is not enabled for Desktop Vault.')
            credentials = self.enabled_credentials(unit, policy['cloud'])
            if action == 'revoke':
                self.remove_value(credentials / request['name'])
            else:
                if action == 'add' and len(self.credential_names(credentials)) >= DESKTOP_NAME_LIMIT:
                    raise VaultError('This service has too many entries for Desktop Vault.')
                self.write_value(credentials, request['name'], request['value'].encode(), action)
            return {'ok': True}

    def cloud(self, request, requester_uid):
        """Create or settle one Cloud request after peer and policy validation."""
        if not directory(self.root):
            raise VaultError(REQUEST_UNAVAILABLE)
        with self.locked():
            try:
                policy = self.root_policy()
                if requester_uid != policy['cloud']:
                    raise VaultError(REQUEST_UNAVAILABLE)
                action = request.get('action')
                if action == 'automatic-login':
                    if not valid_automatic_login(request):
                        raise VaultError(REQUEST_UNAVAILABLE)
                    self.require_requests(policy)
                    return self._automatic_browser_login(request)
                bot = request.get('bot')
                scope = request.get('scope')
                if (action not in ('list', 'create', 'status', 'cancel', 'authorize')
                        or ('bot' in request and not valid_bot(bot))
                        or ('scope' in request and (scope != 'shared' or bot is None))
                        or (action == 'authorize' and scope != 'shared')):
                    raise VaultError(REQUEST_UNAVAILABLE)
                grants = self.require_requests(policy)
                if action == 'list':
                    if bot is None:
                        raise VaultError(REQUEST_UNAVAILABLE)
                    pairs = {grant[-2:] for grant in grants if len(grant) >= 3 and grant[-3] == bot
                             and (scope is None or len(grant) == 4) and grant[-2] in policy['services']}
                    return {'credentials': [{'unit': unit, 'name': name} for unit, name in sorted(pairs)]}
                records, changed = self.clean_request_records(self.read_request_records())
                if action == 'create':
                    credentials = self.request_credentials(policy, grants, request['unit'], request['name'], bot, scope)
                    record = self.request_record(records, request['id'])
                    if record is not None:
                        if (record.get('bot') != bot or record.get('scope') != scope
                                or record['unit'] != request['unit'] or record['name'] != request['name']):
                            raise VaultError(REQUEST_UNAVAILABLE)
                        changed = self.observe_request(record, credentials) or changed
                        if record['state'] == 'pending' and self.clock() >= record['lease']:
                            finish_request(record, 'cancelled')
                            changed = True
                    else:
                        if len(records) >= REQUEST_RECORD_LIMIT:
                            raise VaultError('The Vault request queue is full.')
                        now = self.clock()
                        record = {
                            'id': request['id'],
                            'unit': request['unit'],
                            'name': request['name'],
                            'state': 'saved' if file_exists(credentials / request['name']) else 'pending',
                            'created': now,
                            'lease': now + REQUEST_LEASE,
                        }
                        if bot is not None:
                            record['bot'] = bot
                        if scope is not None:
                            record['scope'] = scope
                        records.append(record)
                        changed = True
                    if changed:
                        self.write_request_records(records)
                    return {'state': record['state']}

                record = self.request_record(records, request['id'])
                if record is None or record.get('bot') != bot or record.get('scope') != scope:
                    raise VaultError(REQUEST_UNAVAILABLE)
                credentials = self.request_credentials(policy, grants, record['unit'], record['name'], bot, scope)
                changed = self.observe_request(record, credentials) or changed
                now = self.clock()
                approval = record.get('approval')
                if action == 'authorize':
                    if (approval is None or approval['admitted'] or approval['challenge'] != request.get('challenge')
                            or now >= approval['expires']):
                        raise VaultError(REQUEST_UNAVAILABLE)
                    approval['admitted'] = True
                    changed = True
                elif record['state'] == 'pending':
                    if action == 'cancel' or now >= record['lease']:
                        finish_request(record, 'cancelled')
                        changed = True
                    elif record['lease'] - now <= REQUEST_LEASE / 2:
                        record['lease'] = now + REQUEST_LEASE
                        changed = True
                if changed:
                    self.write_request_records(records)
                approval = record.get('approval')
                if action == 'status' and approval is not None and not approval['admitted'] and now < approval['expires']:
                    return {'state': 'awaiting-authorization', 'challenge': approval['challenge']}
                return {'state': record['state']}
            except VaultError:
                raise
            except (OSError, OverflowError, TypeError, ValueError):
                raise VaultError(REQUEST_UNAVAILABLE) from None


def user_uid(explicit):
    """Resolve an explicitly selected Linux account."""
    if explicit is None:
        raise VaultError('Supply --cloud-user with the Linux account that runs Y Harness Cloud.')
    try:
        return pwd.getpwnam(explicit).pw_uid
    except KeyError:
        raise VaultError('The specified Linux account was not found.') from None


def prompt_secret():
    """Read one line from a terminal where password echo can be disabled."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', getpass.GetPassWarning)
            return getpass.getpass('Credential value: ').encode()
    except (EOFError, getpass.GetPassWarning, OSError, UnicodeError):
        raise VaultError('Open an interactive terminal to enter the credential privately.') from None


def main():
    """Run the administrator's write-only Vault commands."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cloud-user', help='Linux user running Cloud, required for enable, set and allow-desktop')
    actions = parser.add_subparsers(dest='action', required=True)
    for action in ('enable', 'set', 'list', 'revoke'):
        command = actions.add_parser(action)
        command.add_argument('unit', help='exact systemd system service')
        if action in ('set', 'revoke'):
            command.add_argument('name', help='credential name such as EXAMPLE_API_KEY')
    allow = actions.add_parser('allow-desktop')
    allow.add_argument('--owner', required=True, help='SSH account used by Y Harness Desktop')
    allow.add_argument('units', nargs='*', help='exact enabled services that Desktop may manage')
    initialize = actions.add_parser('initialize-cloud', help=argparse.SUPPRESS)
    initialize.add_argument('--owner', required=True)
    actions.add_parser('deny-desktop')
    enable_requests = actions.add_parser('enable-requests', help='enable the root Cloud request broker')
    enable_requests.add_argument('grants', metavar='[[shared/]BOT/]UNIT.service=KEY_NAME', nargs='+', type=request_grant)
    actions.add_parser('enable-login-automation', help='enable the Cloud broker for automatic website sign-in')
    for action, help_text in (('share-request-grant', 'allow a Bot grant in shared chats'),
                              ('unshare-request-grant', 'limit a Bot grant to owner chats')):
        command = actions.add_parser(action, help=help_text)
        command.add_argument('grant', metavar='BOT/UNIT.service=KEY_NAME', type=request_grant)
    actions.add_parser('disable-requests', help='disable the root Cloud request broker')
    actions.add_parser('desktop-client', help='forward one Desktop request to the local Vault socket')
    actions.add_parser('desktop-worker', help=argparse.SUPPRESS)
    actions.add_parser('cloud-request-worker', help=argparse.SUPPRESS)
    args = parser.parse_args()
    try:
        if sys.platform != 'linux':
            raise VaultError('Run the Vault on the Linux VPS.')
        if args.action == 'desktop-client':
            if os.geteuid() == 0:
                raise VaultError('Use your regular SSH account for Desktop Vault.')
            sys.stdout.buffer.write(desktop_client(desktop_body(sys.stdin.buffer)))
            return
        if os.geteuid() != 0:
            raise VaultError('Run the Vault as an administrator on the Linux VPS.')
        os.umask(0o077)
        vault = Vault()
        if args.action == 'desktop-worker':
            with socket.fromfd(0, socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                desktop_worker(vault, connection)
        elif args.action == 'cloud-request-worker':
            with socket.fromfd(0, socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                cloud_worker(vault, connection)
        elif args.action == 'allow-desktop':
            owner_uid = user_uid(args.owner)
            vault.allow_desktop(owner_uid, user_uid(args.cloud_user), args.units, start=True)
            print('Desktop Vault access enabled.')
        elif args.action == 'initialize-cloud':
            vault.initialize_cloud(user_uid(args.owner), user_uid(args.cloud_user), start=True)
            print('Dedicated Cloud Vault ready.')
        elif args.action == 'deny-desktop':
            vault.deny_desktop()
            print('Desktop Vault access removed.')
        elif args.action in ('share-request-grant', 'unshare-request-grant'):
            vault.set_shared_request_grant(args.grant, args.action == 'share-request-grant')
            print('Vault request grant updated.')
        elif args.action == 'enable-requests':
            vault.enable_requests(args.grants, start=True)
            print('Cloud Vault request broker enabled.')
        elif args.action == 'enable-login-automation':
            vault.enable_login_automation(start=True)
            print('Cloud Vault website login broker enabled.')
        elif args.action == 'disable-requests':
            vault.disable_requests()
            print('Cloud Vault request broker disabled.')
        elif args.action == 'enable':
            vault.enable(args.unit, user_uid(args.cloud_user))
            print(f'Vault enabled for {args.unit}.')
        elif args.action == 'set':
            uid = user_uid(args.cloud_user)
            vault.save(args.unit, args.name, prompt_secret(), uid)
            print(f'{args.name} saved for the next start of {args.unit}.')
        elif args.action == 'list':
            for name in vault.names(args.unit):
                print(name)
        elif vault.revoke(args.unit, args.name):
            print(f'{args.name} revoked for future starts of {args.unit}.')
        else:
            print(f'{args.name} is already absent from {args.unit}.')
    except VaultError as error:
        parser.exit(1, f'Vault: {error}\n')
    except OSError:
        parser.exit(1, 'Vault: could not access its private storage or service configuration.\n')
    except KeyboardInterrupt:
        parser.exit(130, '\nVault: cancelled.\n')


if __name__ == '__main__':
    main()
