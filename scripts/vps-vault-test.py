"""Exercise Vault administration with a disposable filesystem and systemd adapter."""

import base64
import io
import importlib.util
import json
import os
import socket
import subprocess
import tempfile
import unittest
import warnings
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('vps_vault', Path(__file__).with_name('vps-vault.py'))
assert SPEC is not None and SPEC.loader is not None
vault = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(vault)

FIRST_UNIT = 'example-search.service'
SECOND_UNIT = 'example-report@batch.service'
REQUEST_KEYS = [(FIRST_UNIT, 'EXAMPLE_KEY')]
CLOUD_UID = 23000
OWNER_UID = 23002
FIRST_VALUE = b'example value before rotation'
SECOND_VALUE = b'example value after rotation'
BROWSER_BOT = 'bot-browser'
BROWSER_SESSION = 'bot-session-37888424-5b3d-4a8c-81f5-751ed2d24f96'


class VaultTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name) / 'vault'
        self.units = Path(temporary.name) / 'units'
        self.units.mkdir(mode=0o700)
        self.properties = {'LoadState': 'loaded', 'User': str(CLOUD_UID + 1), 'DynamicUser': 'no'}
        self.reloads = 0
        self.failed_reload = False
        self.failed_encryption = False
        self.failed_listener_start = False
        self.listener_active = False
        self.cloud_listener_active = False
        self.now = 1_000.0
        self.sealed = []
        self.sealed_names = []
        self.decrypt_calls = []
        self.decryptions = {}
        self.store = vault.Vault(self.root, self.units, self.run_systemd)
        self.store.clock = lambda: self.now

    def dropin(self, unit):
        return self.units / (unit + '.d') / '90-yharness-vault.conf'

    def run_systemd(self, args, **options):
        if args[0] == '/usr/bin/systemctl' and 'show' in args:
            unit = args[-1]
            properties = {'Id': unit, **self.properties, 'DropInPaths': (
                str(self.dropin(unit)) if self.reloads and self.dropin(unit).is_file() else ''
            )}
            return subprocess.CompletedProcess(args, 0, stdout=''.join(f'{k}={v}\n' for k, v in properties.items()))
        if args[0] == '/usr/bin/systemctl' and args[-1] == 'daemon-reload':
            self.reloads += 1
            return subprocess.CompletedProcess(args, int(self.failed_reload))
        if args[0] == '/usr/bin/systemctl' and args[-1] in (vault.DESKTOP_LISTENER, vault.CLOUD_LISTENER):
            active = 'enable' in args
            if args[-1] == vault.DESKTOP_LISTENER:
                self.listener_active = active
            else:
                self.cloud_listener_active = active
            return subprocess.CompletedProcess(args, int(active and self.failed_listener_start))
        self.assertIn(args[:2], [
            ['/usr/bin/systemd-creds', '--with-key=host'],
        ])
        self.assertTrue(args[2].startswith('--name=yharness_'))
        self.assertEqual(options['stderr'], subprocess.DEVNULL)
        if args[-3:] == ['decrypt', '-', '-']:
            self.decrypt_calls.append((args[2], options['input']))
            try:
                ciphertext = base64.b64decode(options['input'], validate=True)
            except (TypeError, ValueError):
                return subprocess.CompletedProcess(args, 1, stdout=b'')
            plaintext = self.decryptions.get(ciphertext)
            if plaintext is None:
                return subprocess.CompletedProcess(args, 1, stdout=b'')
            return subprocess.CompletedProcess(args, 0, stdout=plaintext)
        self.assertEqual(args[-3:], ['encrypt', '-', '-'])
        self.sealed_names.append(args[2])
        self.sealed.append(options['input'])
        if self.failed_encryption:
            return subprocess.CompletedProcess(args, 1, stdout=options['input'])
        ciphertext = f'sealed-{len(self.sealed)}'.encode()
        self.decryptions[ciphertext] = options['input']
        return subprocess.CompletedProcess(args, 0, stdout=base64.b64encode(ciphertext) + b'\n')

    def test_enables_an_exact_system_service_without_starting_it(self):
        self.store.enable(FIRST_UNIT, CLOUD_UID)
        directory = self.root / FIRST_UNIT / 'credentials'
        self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.dropin(FIRST_UNIT).read_text(), f'[Service]\nLoadCredentialEncrypted=yharness:{directory}\n')
        self.store.enable(FIRST_UNIT, CLOUD_UID)
        self.assertEqual(self.store.names(FIRST_UNIT), [])
        self.assertEqual(self.reloads, 2)

    def test_denies_aliases_default_root_and_the_cloud_account(self):
        for properties in [{'Id': SECOND_UNIT}, {'User': ''}, {'User': '0'}, {'User': str(CLOUD_UID)}]:
            with self.subTest(properties=properties), patch.dict(self.properties, properties):
                with self.assertRaises(vault.VaultError):
                    self.store.enable(FIRST_UNIT, CLOUD_UID)
        self.assertFalse(self.root.exists())

    def test_rotates_encrypted_entries_and_preserves_other_service_scopes(self):
        self.store.enable(FIRST_UNIT, CLOUD_UID)
        self.store.enable(SECOND_UNIT, CLOUD_UID)
        self.store.save(FIRST_UNIT, 'EXAMPLE_KEY', FIRST_VALUE, CLOUD_UID)
        first_file = self.root / FIRST_UNIT / 'credentials' / 'EXAMPLE_KEY'
        self.assertEqual(first_file.stat().st_mode & 0o777, 0o600)
        self.assertNotIn(FIRST_VALUE, first_file.read_bytes())
        self.store.save(SECOND_UNIT, 'EXAMPLE_KEY', SECOND_VALUE, CLOUD_UID)
        second_file = self.root / SECOND_UNIT / 'credentials' / 'EXAMPLE_KEY'
        second_ciphertext = second_file.read_bytes()
        self.store.save(FIRST_UNIT, 'EXAMPLE_KEY', SECOND_VALUE, CLOUD_UID)
        reopened = vault.Vault(self.root, self.units, self.run_systemd)
        self.assertEqual(reopened.names(FIRST_UNIT), ['EXAMPLE_KEY'])
        self.assertEqual(first_file.read_bytes(), base64.b64encode(b'sealed-3') + b'\n')
        self.assertEqual(second_file.read_bytes(), second_ciphertext)
        self.assertTrue(reopened.revoke(FIRST_UNIT, 'EXAMPLE_KEY'))
        self.assertFalse(reopened.revoke(FIRST_UNIT, 'EXAMPLE_KEY'))
        self.assertEqual(reopened.names(FIRST_UNIT), [])
        self.assertEqual(reopened.names(SECOND_UNIT), ['EXAMPLE_KEY'])

    def test_revalidates_the_service_account_before_accepting_a_secret(self):
        self.store.enable(FIRST_UNIT, CLOUD_UID)
        self.properties['User'] = str(CLOUD_UID)
        with self.assertRaises(vault.VaultError):
            self.store.save(FIRST_UNIT, 'EXAMPLE_KEY', FIRST_VALUE, CLOUD_UID)
        self.assertEqual(self.sealed, [])

    def test_failed_encryption_preserves_the_prior_value_and_hides_diagnostics(self):
        self.store.enable(FIRST_UNIT, CLOUD_UID)
        self.store.save(FIRST_UNIT, 'EXAMPLE_KEY', FIRST_VALUE, CLOUD_UID)
        first_file = self.root / FIRST_UNIT / 'credentials' / 'EXAMPLE_KEY'
        previous = first_file.read_bytes()
        self.failed_encryption = True
        with self.assertRaises(vault.VaultError) as failure:
            self.store.save(FIRST_UNIT, 'EXAMPLE_KEY', SECOND_VALUE, CLOUD_UID)
        self.assertNotIn(SECOND_VALUE.decode(), str(failure.exception))
        self.assertEqual(first_file.read_bytes(), previous)

    def test_prevents_traversal_and_refuses_a_symbolic_credential_file(self):
        with self.assertRaises(vault.VaultError):
            self.store.enable('../escape.service', CLOUD_UID)
        self.store.enable(FIRST_UNIT, CLOUD_UID)
        with self.assertRaises(vault.VaultError):
            self.store.save(FIRST_UNIT, '../EXAMPLE_KEY', FIRST_VALUE, CLOUD_UID)
        target = self.root / 'unrelated'
        target.write_text('untouched')
        link = self.root / FIRST_UNIT / 'credentials' / 'EXAMPLE_KEY'
        link.symlink_to(target)
        with self.assertRaises(vault.VaultError):
            self.store.revoke(FIRST_UNIT, 'EXAMPLE_KEY')
        self.assertEqual(target.read_text(), 'untouched')
        self.assertTrue(link.is_symlink())

    def test_reload_failure_can_be_retried_without_overwriting_owner_edits(self):
        self.failed_reload = True
        with self.assertRaises(vault.VaultError):
            self.store.enable(FIRST_UNIT, CLOUD_UID)
        self.failed_reload = False
        self.store.enable(FIRST_UNIT, CLOUD_UID)
        self.dropin(FIRST_UNIT).write_text('[Service]\n# Owner edits\n')
        with self.assertRaises(vault.VaultError):
            self.store.enable(FIRST_UNIT, CLOUD_UID)
        self.assertEqual(self.dropin(FIRST_UNIT).read_text(), '[Service]\n# Owner edits\n')

    def test_rejects_password_entry_if_terminal_echo_cannot_be_disabled(self):
        def echoed_input(_prompt):
            warnings.warn('Echo cannot be controlled.', vault.getpass.GetPassWarning)
            self.fail('The credential prompt read from an echoing terminal.')

        with patch.object(vault.getpass, 'getpass', side_effect=echoed_input):
            with self.assertRaisesRegex(vault.VaultError, 'interactive terminal'):
                vault.prompt_secret()

    def test_desktop_management_requires_the_owner_and_an_enabled_service(self):
        self.store.enable(FIRST_UNIT, CLOUD_UID)
        self.store.enable(SECOND_UNIT, CLOUD_UID)
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [FIRST_UNIT])
        self.assertEqual(self.store.desktop({'action': 'list'}, OWNER_UID), {'services': [{'unit': FIRST_UNIT, 'names': []}]})
        for requester in (0, CLOUD_UID, OWNER_UID + 1):
            with self.subTest(requester=requester), self.assertRaises(vault.VaultError):
                self.store.desktop({'action': 'list'}, requester)
        with self.assertRaises(vault.VaultError):
            self.store.desktop({'action': 'add', 'unit': SECOND_UNIT, 'name': 'EXAMPLE_KEY',
                                'value': FIRST_VALUE.decode()}, OWNER_UID)
        self.assertEqual(self.sealed, [])

    def test_desktop_can_start_without_granting_access_to_any_service(self):
        with patch.object(vault, 'trusted_file'):
            self.store.allow_desktop(OWNER_UID, CLOUD_UID, [], start=True)
        self.assertTrue(self.listener_active)
        self.assertEqual(self.store.desktop({'action': 'list'}, OWNER_UID), {'services': []})
        self.store.enable(FIRST_UNIT, CLOUD_UID)
        self.assertEqual(self.store.desktop({'action': 'list'}, OWNER_UID), {'services': []})
        with self.assertRaises(vault.VaultError):
            self.store.desktop({'action': 'add', 'unit': FIRST_UNIT, 'name': 'EXAMPLE_KEY',
                                'value': FIRST_VALUE.decode()}, OWNER_UID)
        with self.assertRaises(vault.VaultError):
            self.store.desktop({'action': 'list'}, CLOUD_UID)
        self.assertEqual(self.sealed, [])

    def test_desktop_can_add_replace_and_revoke_without_returning_any_secret_value(self):
        self.store.enable(FIRST_UNIT, CLOUD_UID)
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [FIRST_UNIT])
        request = {'unit': FIRST_UNIT, 'name': 'EXAMPLE_KEY'}
        def desktop(action, **extra):
            return self.store.desktop({'action': action, **request, **extra}, OWNER_UID)

        with self.assertRaises(vault.VaultError):
            desktop('replace', value=FIRST_VALUE.decode())
        self.assertEqual(desktop('add', value=FIRST_VALUE.decode()), {'ok': True})
        with self.assertRaises(vault.VaultError):
            desktop('add', value=SECOND_VALUE.decode())
        self.assertEqual(desktop('replace', value=SECOND_VALUE.decode()), {'ok': True})
        inventory = self.store.desktop({'action': 'list'}, OWNER_UID)
        self.assertEqual(inventory, {'services': [{'unit': FIRST_UNIT, 'names': ['EXAMPLE_KEY']}]})
        self.assertNotIn(SECOND_VALUE, json.dumps(inventory).encode())
        self.assertEqual(self.sealed, [FIRST_VALUE, SECOND_VALUE])
        self.assertEqual(desktop('revoke'), {'ok': True})
        self.assertEqual(self.store.names(FIRST_UNIT), [])

    def test_desktop_policy_cannot_grant_cloud_or_an_unconfigured_service(self):
        self.store.enable(FIRST_UNIT, CLOUD_UID)
        with self.assertRaises(vault.VaultError):
            self.store.allow_desktop(CLOUD_UID, CLOUD_UID, [FIRST_UNIT])
        with self.assertRaises(vault.VaultError):
            self.store.allow_desktop(OWNER_UID, CLOUD_UID, [SECOND_UNIT])
        with self.assertRaises(vault.VaultError):
            self.store.desktop({'action': 'list'}, OWNER_UID)
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [FIRST_UNIT])
        self.store.deny_desktop()
        with self.assertRaises(vault.VaultError):
            self.store.desktop({'action': 'list'}, OWNER_UID)
        self.assertTrue(self.dropin(FIRST_UNIT).is_file())

    def test_desktop_wire_accepts_only_bounded_exact_requests(self):
        valid = {'action': 'add', 'unit': FIRST_UNIT, 'name': 'EXAMPLE_KEY', 'value': '  a private value  '}
        self.assertEqual(vault.desktop_request(json.dumps(valid).encode()), valid)
        for malformed in (b'', b'null', b'{"action":"list","action":"revoke"}', b'{"action":"list","extra":1}',
                          b'{"action":"enable"}', b' ' * (64 * 1024 + 1), b'\xff'):
            with self.subTest(size=len(malformed)), self.assertRaises(vault.VaultError):
                vault.desktop_request(malformed)
        for overrides in ({'value': 'x' * 8193}, {'value': 'a\0b'}, {'value': 12}, {'name': '../key'},
                          {'unit': '../else.service'}, {'unit': 'fixture@.service'}, {'action': 'list'}):
            bad = {**valid, **overrides}
            with self.subTest(fields=list(overrides)), self.assertRaises(vault.VaultError):
                vault.desktop_request(json.dumps(bad).encode())
        with self.assertRaises(vault.VaultError):
            vault.desktop_body(io.BytesIO(b'a' * (vault.DESKTOP_REQUEST_LIMIT + 1)))

    def test_desktop_login_wire_is_exact_and_canonical(self):
        valid = {
            'action': 'add-login',
            'origin': 'https://example.com:8443',
            'label': 'Example account',
            'username': 'owner@example.com',
            'password': 'private-password',
        }
        self.assertEqual(vault.desktop_request(json.dumps(valid).encode()), valid)
        self.assertEqual(vault.desktop_request(b'{"action":"list-logins"}'), {'action': 'list-logins'})
        replace = {key: valid[key] for key in ('label', 'username', 'password')}
        replace.update({'action': 'replace-login', 'id': 'a' * 32})
        self.assertEqual(vault.desktop_request(json.dumps(replace).encode()), replace)
        remove = {'action': 'remove-login', 'id': 'a' * 32}
        self.assertEqual(vault.desktop_request(json.dumps(remove).encode()), remove)
        for origin in (
            'http://example.com', 'HTTPS://example.com', 'https://Example.com', 'https://example.com/',
            'https://example.com:443', 'https://example.com:0', 'https://example.com:65536',
            'https://user:password@example.com', 'https://example.com/path', 'https://example.com?x=1',
            'https://127.0.0.1', 'https://localhost', 'https://foo.localhost', 'https://foo.local',
            'https://foo.localdomain', 'https://example', 'https://example.123', 'https://0x7f.1',
            'https://例え.テスト',
        ):
            with self.subTest(origin=origin), self.assertRaises(vault.VaultError):
                vault.desktop_request(json.dumps({**valid, 'origin': origin}).encode())
        for overrides in (
            {'action': 'list-logins', 'extra': 1},
            {'label': ''}, {'label': ' '}, {'label': ' a\n'}, {'label': 'a\x00b'},
            {'username': ''}, {'username': 'a\n'}, {'username': 'a\x7f'},
            {'password': ''}, {'password': 'a\r'}, {'password': 'a\u2028b'},
            {'id': 'A' * 32}, {'id': 'a' * 31}, {'extra': True},
        ):
            bad = {**(remove if 'id' in overrides else valid), **overrides}
            with self.subTest(fields=list(overrides)), self.assertRaises(vault.VaultError):
                vault.desktop_request(json.dumps(bad).encode())
        duplicate = b'{"action":"list-logins","action":"add-login"}'
        with self.assertRaises(vault.VaultError):
            vault.desktop_request(duplicate)

    def test_cloud_wire_rejects_website_login_actions(self):
        for request in (
            {'action': 'list-logins'},
            {'action': 'add-login', 'origin': 'https://example.com', 'label': 'Example',
             'username': 'owner', 'password': 'private'},
            {'action': 'replace-login', 'id': 'a' * 32, 'label': 'Example',
             'username': 'owner', 'password': 'private'},
            {'action': 'remove-login', 'id': 'a' * 32},
        ):
            with self.subTest(action=request['action']), self.assertRaises(vault.VaultError):
                vault.cloud_request(json.dumps(request).encode())

    def test_automatic_login_is_exact_to_the_private_browser_request(self):
        request = {'action': 'automatic-login', 'id': 'a' * 32, 'bot': BROWSER_BOT, 'session': BROWSER_SESSION}
        self.assertEqual(vault.cloud_request(json.dumps(request).encode()), request)
        for extra in ({'scope': 'shared'}, {'password': 'fixture'}, {'session': 'shared-session-test'}, {'id': '_'}):
            with self.subTest(extra=extra), self.assertRaises(vault.VaultError):
                vault.cloud_request(json.dumps({**request, **extra}).encode())
        for action in ({'action': 'list-login-automation'}, {
            'action': 'set-login-automatic', 'id': 'b' * 32, 'bot': BROWSER_BOT, 'enabled': True,
        }):
            self.assertEqual(vault.desktop_request(json.dumps(action).encode()), action)
            with self.assertRaises(vault.VaultError):
                vault.cloud_request(json.dumps(action).encode())

    def test_website_login_setup_starts_the_broker_without_service_grants(self):
        self.store.enable(FIRST_UNIT, CLOUD_UID)
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [FIRST_UNIT])
        with patch.object(vault, 'trusted_file'), \
                patch.object(vault, 'browser_grant_pairs', return_value={(BROWSER_BOT, BROWSER_SESSION)}):
            self.store.enable_login_automation(start=True)
            self.assertTrue(self.cloud_listener_active)
            policy = self.store.root_policy()
            self.assertEqual(self.store.require_requests(policy), set())
            self.assertEqual(self.store.desktop({'action': 'list-login-automation'}, OWNER_UID), {
                'loginAutomation': {'available': True, 'enabled': []},
            })
            grant = (BROWSER_BOT, FIRST_UNIT, 'EXAMPLE_KEY')
            self.store.enable_requests([grant])
            self.store.enable_login_automation(start=True)
            self.assertEqual(self.store.require_requests(policy), {grant})
            self.assertEqual(self.store.cloud({'action': 'list', 'bot': 'bot-other'}, CLOUD_UID), {'credentials': []})

    def test_dedicated_vault_initializes_before_a_bot_exists(self):
        with patch.object(vault, 'trusted_file'), patch.object(vault, 'browser_grants', return_value=(set(), CLOUD_UID)):
            self.store.initialize_cloud(OWNER_UID, CLOUD_UID, start=True)
        self.assertTrue(self.listener_active)
        self.assertTrue(self.cloud_listener_active)
        self.assertEqual(self.store.desktop({'action': 'list-grants'}, OWNER_UID), {
            'access': {'services': [], 'grants': []},
        })
        self.assertEqual(self.store.cloud({'action': 'list', 'bot': BROWSER_BOT}, CLOUD_UID), {'credentials': []})
        with self.assertRaises(vault.VaultError):
            self.store.desktop({'action': 'list-grants'}, CLOUD_UID)
        with self.assertRaises(vault.VaultError):
            self.store.cloud({'action': 'list', 'bot': BROWSER_BOT}, OWNER_UID)

    def test_dedicated_vault_rejects_a_different_browser_publisher(self):
        for browser in ((set(), CLOUD_UID + 10), ({(BROWSER_BOT, BROWSER_SESSION)}, None)):
            with self.subTest(browser=browser), patch.object(vault, 'browser_grants', return_value=browser):
                with self.assertRaises(vault.VaultError):
                    self.store.initialize_cloud(OWNER_UID, CLOUD_UID)
        self.assertFalse((self.root / 'desktop.json').exists())

    def test_dedicated_vault_retries_before_committing_owner_access(self):
        with patch.object(vault, 'trusted_file'), patch.object(vault, 'browser_grants', return_value=(set(), CLOUD_UID)):
            self.failed_listener_start = True
            with self.assertRaises(vault.VaultError):
                self.store.initialize_cloud(OWNER_UID, CLOUD_UID, start=True)
            with self.assertRaises(vault.VaultError):
                self.store.desktop({'action': 'list-grants'}, OWNER_UID)
            self.failed_listener_start = False
            self.store.initialize_cloud(OWNER_UID, CLOUD_UID, start=True)
        self.assertTrue(self.listener_active and self.cloud_listener_active)
        self.assertEqual(self.store.require_requests(self.store.root_policy()), set())

    def test_dedicated_vault_preserves_credentials_grants_and_disabled_requests(self):
        self.store.enable(FIRST_UNIT, CLOUD_UID)
        self.store.save(FIRST_UNIT, 'EXAMPLE_KEY', FIRST_VALUE, CLOUD_UID)
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [FIRST_UNIT])
        grant = (BROWSER_BOT, FIRST_UNIT, 'EXAMPLE_KEY')
        self.store.enable_requests([grant])
        before = {path: path.read_bytes() for path in self.root.rglob('*') if path.is_file()}
        self.store.initialize_cloud(OWNER_UID, CLOUD_UID, start=True)
        self.assertEqual({path: path.read_bytes() for path in self.root.rglob('*') if path.is_file()}, before)
        with self.assertRaises(vault.VaultError):
            self.store.initialize_cloud(OWNER_UID + 1, CLOUD_UID)
        with self.assertRaises(vault.VaultError):
            self.store.initialize_cloud(OWNER_UID, CLOUD_UID + 1)
        self.store.disable_requests()
        self.store.initialize_cloud(OWNER_UID, CLOUD_UID, start=True)
        self.assertFalse(self.cloud_listener_active)
        self.assertEqual(self.store.names(FIRST_UNIT), ['EXAMPLE_KEY'])
        self.assertFalse((self.root / vault.CLOUD_REQUESTS_ENABLED).exists())

    def test_automatic_sign_in_requires_the_current_assigned_account_and_owner_grant(self):
        site = 'https://example.com'
        request = {'action': 'automatic-login', 'id': 'a' * 32, 'bot': BROWSER_BOT, 'session': BROWSER_SESSION}
        login = {'action': 'add-login', 'origin': site, 'label': 'Fixture',
                 'username': 'test-user', 'password': 'synthetic-passphrase'}
        available = {'action': 'list-login-automation'}
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [])
        self.assertEqual(self.store.desktop(available, OWNER_UID), {'loginAutomation': {'available': False, 'enabled': []}})
        self.store.write_request_grants(self.store.root_policy(), set())
        self.store.desktop(login, OWNER_UID)
        self.store.desktop({**login, 'bot': BROWSER_BOT}, OWNER_UID)
        [account] = self.store.desktop({'action': 'list-bot-logins'}, OWNER_UID)['botLogins']
        [personal] = self.store.desktop({'action': 'list-logins'}, OWNER_UID)['logins']
        enable = {'action': 'set-login-automatic', 'id': account['id'], 'bot': BROWSER_BOT, 'enabled': True}
        viewer = {'id': request['id'], 'state': 'pending', 'bot': BROWSER_BOT, 'session': BROWSER_SESSION,
                  'origin': site, 'destination': site + '/login'}
        inspections = []
        submissions = []

        def browser(payload):
            call = json.loads(payload)
            if call['action'] == 'inspect-login-automatic':
                inspections.append(call)
                return json.dumps(viewer).encode()
            self.assertEqual(call['action'], 'use-login')
            submissions.append(call)
            return b'{"state":"submitted"}'

        with patch.object(vault, 'browser_grant_pairs', return_value={(BROWSER_BOT, BROWSER_SESSION)}), \
                patch.object(vault, 'browser_client', side_effect=browser):
            self.assertEqual(self.store.cloud(request, CLOUD_UID), {'state': 'approval-required'})
            with self.assertRaises(vault.VaultError):
                self.store.desktop(enable, CLOUD_UID)
            with self.assertRaises(vault.VaultError):
                self.store.desktop({**enable, 'id': personal['id']}, OWNER_UID)
            self.assertEqual(self.store.desktop(enable, OWNER_UID), {'ok': True})
            self.assertEqual(self.store.desktop(available, OWNER_UID), {
                'loginAutomation': {'available': True, 'enabled': [account['id']]},
            })
            with self.assertRaises(vault.VaultError):
                self.store.cloud(request, OWNER_UID)
            viewer['session'] = 'bot-session-11111111-1111-4111-8111-111111111111'
            self.assertEqual(self.store.cloud(request, CLOUD_UID), {'state': 'unavailable'})
            viewer.update(session=BROWSER_SESSION, origin='https://example.com:444', destination='https://example.com:444/login')
            self.assertEqual(self.store.cloud(request, CLOUD_UID), {'state': 'approval-required'})
            self.assertEqual(self.decrypt_calls, [])
            viewer.update(origin=site, destination=site + '/login')
            self.assertEqual(self.store.cloud(request, CLOUD_UID), {'state': 'submitted'})
            self.assertEqual(submissions, [{
                'action': 'use-login', 'id': request['id'], 'bot': BROWSER_BOT, 'session': BROWSER_SESSION,
                'origin': site, 'username': login['username'], 'password': login['password'],
            }])
            self.assertTrue(all(set(call) == {'action', 'id'} for call in inspections))
            self.store.desktop({'action': 'replace-login', 'id': account['id'], 'bot': BROWSER_BOT,
                                'label': 'Rotated', 'username': 'test-user', 'password': 'rotated-fixture'}, OWNER_UID)
            self.assertEqual(self.store.cloud(request, CLOUD_UID), {'state': 'approval-required'})
            self.assertEqual(self.store.desktop(available, OWNER_UID)['loginAutomation']['enabled'], [])
            self.store.desktop(enable, OWNER_UID)
            self.store.desktop({**enable, 'enabled': False}, OWNER_UID)
            self.assertEqual(self.store.cloud(request, CLOUD_UID), {'state': 'approval-required'})
            self.assertEqual(len(self.decrypt_calls), 1)

    def test_owner_desktop_can_manage_website_logins_without_secret_output(self):
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [])
        add = {
            'action': 'add-login', 'origin': 'https://example.com', 'label': '  Example  ',
            'username': 'owner@example.com', 'password': 'private-password',
        }
        self.assertEqual(self.store.desktop(add, OWNER_UID), {'ok': True})
        inventory = self.store.desktop({'action': 'list-logins'}, OWNER_UID)
        self.assertEqual(set(inventory), {'logins'})
        self.assertEqual(len(inventory['logins']), 1)
        listed = inventory['logins'][0]
        self.assertEqual(set(listed), {'id', 'origin', 'label'})
        self.assertRegex(listed['id'], r'^[0-9a-f]{32}$')
        self.assertEqual(listed['origin'], 'https://example.com')
        self.assertEqual(listed['label'], 'Example')
        path = self.root / vault.WEBSITE_LOGIN_DIRECTORY / listed['id']
        self.assertEqual((self.root / vault.WEBSITE_LOGIN_DIRECTORY).stat().st_mode & 0o777, 0o700)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        stored = json.loads(path.read_text())
        self.assertEqual(set(stored), {'id', 'origin', 'label', 'credential'})
        self.assertEqual(self.sealed_names[0], f'--name=yharness_website_login_{listed["id"]}')
        self.assertEqual(self.sealed[0], b'{"username":"owner@example.com","password":"private-password"}')
        self.assertNotIn('owner@example.com', path.read_text())
        self.assertNotIn('private-password', path.read_text())
        self.assertNotIn('owner@example.com', json.dumps(inventory))
        self.assertNotIn('private-password', json.dumps(inventory))

        replace = {
            'action': 'replace-login', 'id': listed['id'], 'label': 'Updated',
            'username': 'new-owner@example.com', 'password': 'new-private-password',
        }
        self.assertEqual(self.store.desktop(replace, OWNER_UID), {'ok': True})
        updated = self.store.desktop({'action': 'list-logins'}, OWNER_UID)['logins']
        self.assertEqual(updated, [{'id': listed['id'], 'origin': 'https://example.com', 'label': 'Updated'}])
        self.assertEqual(self.store.desktop({'action': 'remove-login', 'id': listed['id']}, OWNER_UID), {'ok': True})
        self.assertEqual(self.store.desktop({'action': 'list-logins'}, OWNER_UID), {'logins': []})

    def test_login_import_reviews_duplicates_and_never_replaces_saved_accounts(self):
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [])
        original = {
            'action': 'add-login', 'origin': 'https://example.com', 'label': 'Existing',
            'username': 'owner@example.com', 'password': 'original-secret',
        }
        self.store.desktop(original, OWNER_UID)
        draft = {'action': 'inspect-login-import', 'salt': 'ab' * 32}
        item = {**original, 'action': 'import-login', 'label': 'Imported', 'password': 'import-secret'}

        for request in (draft, item):
            self.assertEqual(vault.desktop_request(json.dumps(request).encode()), request)
            with self.assertRaises(vault.VaultError):
                vault.cloud_request(json.dumps(request).encode())
            with self.assertRaises(vault.VaultError):
                self.store.desktop(request, CLOUD_UID)
        for request in ({**draft, 'salt': 'invalid'}, {**draft, 'username': 'owner'}, {**item, 'bot': BROWSER_BOT}):
            with self.assertRaises(vault.VaultError):
                vault.desktop_request(json.dumps(request).encode())

        digest = vault.hashlib.sha256(
            bytes.fromhex(draft['salt']) + b'https://example.com\0owner@example.com'
        ).hexdigest()
        index = self.store.desktop(draft, OWNER_UID)
        self.assertEqual(index, {'importIndex': {'fingerprints': [digest], 'remaining': vault.WEBSITE_LOGIN_LIMIT - 1}})
        self.assertNotIn(original['username'], json.dumps(index))
        self.assertNotIn(original['password'], json.dumps(index))
        self.assertEqual(self.store.desktop(item, OWNER_UID), {'outcome': 'duplicate'})
        self.assertEqual(len(self.sealed), 1)

        with patch.object(vault, 'WEBSITE_LOGIN_LIMIT', 2):
            new_item = {**item, 'username': 'second@example.com'}
            self.assertEqual(self.store.desktop(new_item, OWNER_UID), {'outcome': 'imported'})
            self.assertEqual(self.store.desktop(new_item, OWNER_UID), {'outcome': 'duplicate'})
            self.assertEqual(self.store.desktop({**item, 'origin': 'https://elsewhere.test'}, OWNER_UID),
                             {'outcome': 'full'})
        self.assertEqual(len(self.sealed), 2)
        listing = self.store.desktop({'action': 'list-logins'}, OWNER_UID)
        self.assertEqual({login['label'] for login in listing['logins']}, {'Existing', 'Imported'})
        for login in listing['logins']:
            record = (self.store.website_login_directory() / login['id']).read_text()
            self.assertNotIn('example.com","password"', record)
            self.assertNotIn('secret', record)

    def test_website_login_encryption_failure_preserves_the_prior_record(self):
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [])
        add = {
            'action': 'add-login', 'origin': 'https://example.com', 'label': 'Example',
            'username': 'owner', 'password': 'private',
        }
        self.store.desktop(add, OWNER_UID)
        login = self.store.desktop({'action': 'list-logins'}, OWNER_UID)['logins'][0]
        path = self.root / vault.WEBSITE_LOGIN_DIRECTORY / login['id']
        previous = path.read_bytes()
        self.failed_encryption = True
        with self.assertRaises(vault.VaultError):
            self.store.desktop({
                'action': 'replace-login', 'id': login['id'], 'label': 'Changed',
                'username': 'new-owner', 'password': 'new-private',
            }, OWNER_UID)
        self.assertEqual(path.read_bytes(), previous)
        self.assertEqual(self.store.desktop({'action': 'list-logins'}, OWNER_UID)['logins'], [login])

    def test_website_login_rejects_stale_unknown_and_cloud_requests(self):
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [])
        with self.assertRaises(vault.VaultError):
            self.store.desktop({'action': 'replace-login', 'id': 'a' * 32, 'label': 'Example',
                                'username': 'owner', 'password': 'private'}, OWNER_UID)
        with self.assertRaises(vault.VaultError):
            self.store.desktop({'action': 'remove-login', 'id': 'a' * 32}, OWNER_UID)
        with self.assertRaises(vault.VaultError):
            self.store.desktop({'action': 'list-logins'}, CLOUD_UID)
        with self.assertRaises(vault.VaultError):
            self.store.cloud({'action': 'list-logins'}, CLOUD_UID)

    def test_website_login_replace_revalidates_the_private_record_directory(self):
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [])
        self.store.desktop({
            'action': 'add-login', 'origin': 'https://example.com', 'label': 'Example',
            'username': 'owner', 'password': 'private',
        }, OWNER_UID)
        login = self.store.desktop({'action': 'list-logins'}, OWNER_UID)['logins'][0]
        directory = self.root / vault.WEBSITE_LOGIN_DIRECTORY
        directory.chmod(0o755)
        with self.assertRaises(vault.VaultError):
            self.store.desktop({
                'action': 'replace-login', 'id': login['id'], 'label': 'Changed',
                'username': 'new-owner', 'password': 'new-private',
            }, OWNER_UID)

    def test_trusted_browser_consumes_an_existing_v1_login_with_synchronous_delivery(self):
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [])
        self.store.desktop({
            'action': 'add-login', 'origin': 'https://example.com', 'label': 'Example',
            'username': 'owner', 'password': 'private',
        }, OWNER_UID)
        login = self.store.desktop({'action': 'list-logins'}, OWNER_UID)['logins'][0]
        path = self.root / vault.WEBSITE_LOGIN_DIRECTORY / login['id']
        previous = path.read_bytes()
        delivered = []
        reopened = vault.Vault(self.root, self.units, self.run_systemd)

        result = reopened.use_website_login(
            login['id'], login['origin'], lambda username, password: delivered.append((username, password)),
        )

        self.assertIsNone(result)
        self.assertEqual(delivered, [('owner', 'private')])
        self.assertEqual(path.read_bytes(), previous)
        self.assertEqual(self.decrypt_calls, [(
            f'--name=yharness_website_login_{login["id"]}',
            base64.b64encode(b'sealed-1'),
        )])

    def test_trusted_browser_rejects_an_origin_before_decrypting(self):
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [])
        self.store.desktop({
            'action': 'add-login', 'origin': 'https://example.com', 'label': 'Example',
            'username': 'owner', 'password': 'private',
        }, OWNER_UID)
        login = self.store.desktop({'action': 'list-logins'}, OWNER_UID)['logins'][0]

        for origin in ('https://other.example', 'http://example.com', 'https://example.com/'):
            with self.subTest(origin=origin), self.assertRaises(vault.VaultError) as failure:
                self.store.use_website_login(login['id'], origin, lambda *_values: self.fail('delivered'))
            self.assertEqual(str(failure.exception), vault.WEBSITE_LOGIN_UNAVAILABLE)
        self.assertEqual(self.decrypt_calls, [])

    def test_trusted_browser_observes_rotation_and_refuses_a_removed_login(self):
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [])
        self.store.desktop({
            'action': 'add-login', 'origin': 'https://example.com', 'label': 'Example',
            'username': 'owner', 'password': 'private',
        }, OWNER_UID)
        login = self.store.desktop({'action': 'list-logins'}, OWNER_UID)['logins'][0]
        delivered = []
        self.store.use_website_login(login['id'], login['origin'], lambda username, password: delivered.append((username, password)))

        self.store.desktop({
            'action': 'replace-login', 'id': login['id'], 'label': 'Rotated',
            'username': 'new-owner', 'password': 'new-private',
        }, OWNER_UID)
        self.store.use_website_login(login['id'], login['origin'], lambda username, password: delivered.append((username, password)))
        self.assertEqual(delivered, [('owner', 'private'), ('new-owner', 'new-private')])

        self.assertEqual(self.store.desktop({'action': 'remove-login', 'id': login['id']}, OWNER_UID), {'ok': True})
        with self.assertRaises(vault.VaultError) as failure:
            self.store.use_website_login(login['id'], login['origin'], lambda *_values: self.fail('delivered'))
        self.assertEqual(str(failure.exception), vault.WEBSITE_LOGIN_UNAVAILABLE)
        self.assertEqual(len(self.decrypt_calls), 2)

    def test_trusted_browser_rejects_invalid_decrypted_fields_and_callback_errors_safely(self):
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [])
        self.store.desktop({
            'action': 'add-login', 'origin': 'https://example.com', 'label': 'Example',
            'username': 'owner', 'password': 'private',
        }, OWNER_UID)
        login = self.store.desktop({'action': 'list-logins'}, OWNER_UID)['logins'][0]
        record = json.loads((self.root / vault.WEBSITE_LOGIN_DIRECTORY / login['id']).read_text())
        ciphertext = base64.b64decode(record['credential'])
        invalid = (
            b'{"username":"owner"}',
            b'{"username":"owner","password":"private","extra":"private"}',
            b'{"username":"","password":"private"}',
            json.dumps({'username': 'owner', 'password': 'p' * (vault.WEBSITE_LOGIN_PASSWORD_LIMIT + 1)}).encode(),
        )
        for payload in invalid:
            with self.subTest(payload_size=len(payload)):
                self.decryptions[ciphertext] = payload
                with self.assertRaises(vault.VaultError) as failure:
                    self.store.use_website_login(login['id'], login['origin'], lambda *_values: self.fail('delivered'))
                self.assertEqual(str(failure.exception), vault.WEBSITE_LOGIN_UNAVAILABLE)
                self.assertNotIn('private', str(failure.exception))

        self.decryptions[ciphertext] = b'{"username":"owner","password":"private"}'
        def fail_with_secret(_username, password):
            raise RuntimeError(password)

        with self.assertRaises(vault.VaultError) as failure:
            self.store.use_website_login(login['id'], login['origin'], fail_with_secret)
        self.assertEqual(str(failure.exception), vault.WEBSITE_LOGIN_UNAVAILABLE)
        self.assertNotIn('private', str(failure.exception))

    def test_desktop_login_use_actions_are_exact_and_cloud_cannot_call_them(self):
        inspect = {'action': 'inspect-login-use', 'id': 'a' * 32}
        approve = {'action': 'approve-login-use', 'id': 'a' * 32, 'loginId': 'b' * 32,
                   'generation': 'c' * 64}
        enter = {'action': 'enter-login-use', 'id': 'a' * 32, 'origin': 'https://example.com',
                 'destination': 'https://example.com/login', 'username': 'fixture-user', 'password': 'fixture-password'}
        self.assertEqual(vault.desktop_request(json.dumps(inspect).encode()), inspect)
        self.assertEqual(vault.desktop_request(json.dumps({**inspect, 'form': 'entry'}).encode()),
                         {**inspect, 'form': 'entry'})
        self.assertEqual(vault.desktop_request(json.dumps(approve).encode()), approve)
        self.assertEqual(vault.desktop_request(json.dumps(enter).encode()), enter)
        self.assertEqual(vault.desktop_request(json.dumps({**enter, 'saveLabel': ' Work '}).encode()),
                         {**enter, 'saveLabel': 'Work'})
        decline = {'action': 'decline-login-use', 'id': 'a' * 32}
        self.assertEqual(vault.desktop_request(json.dumps(decline).encode()), decline)
        for malformed in (
            {'action': 'inspect-login-use', 'id': 'A' * 32},
            {'action': 'inspect-login-use', 'id': 'a' * 32, 'extra': 1},
            {**inspect, 'form': 'unknown'},
            {'action': 'approve-login-use', 'id': 'a' * 32, 'loginId': 'b' * 31, 'generation': 'c' * 64},
            {'action': 'approve-login-use', 'id': 'a' * 32, 'loginId': 'b' * 32, 'generation': 'c' * 63},
            {'action': 'approve-login-use', 'id': 'a' * 32, 'loginId': 'b' * 32, 'generation': 'c' * 64, 'extra': 1},
            {'action': 'decline-login-use', 'id': 'a' * 32, 'extra': 1},
            {**enter, 'destination': 'https://other.example/login'},
            {**enter, 'saveLabel': ''},
            {**enter, 'saveLabel': None},
            {**enter, 'password': 'é' * vault.WEBSITE_LOGIN_PASSWORD_LIMIT},
            {**enter, 'username': ''},
            {**enter, 'extra': True},
        ):
            with self.subTest(request=malformed), self.assertRaises(vault.VaultError):
                vault.desktop_request(json.dumps(malformed).encode())
        for request in (inspect, approve, enter, decline):
            with self.subTest(action=request['action']), self.assertRaises(vault.VaultError):
                vault.cloud_request(json.dumps(request).encode())

    def test_browser_login_metadata_requires_exact_same_origin_post_destination(self):
        request_id = 'a' * 32
        valid = {
            'id': request_id, 'origin': 'https://example.com:8443',
            'destination': 'https://example.com:8443/login', 'state': 'pending',
        }
        self.assertEqual(vault.browser_login_inspection(json.dumps(valid).encode(), request_id), valid)
        for destination in (
            'https://other.example/login', 'http://example.com:8443/login',
            'https://example.com:8443/login?next=1', 'https://example.com:8443/login#fragment',
            'https://example.com:8443/login\\escape', 'https://example.com:8443/login with-space',
            'https://example.com:8443/login\n',
            'https://example.com:8443/login' + ('x' * vault.WEBSITE_LOGIN_DESTINATION_LIMIT),
        ):
            with self.subTest(destination=destination), self.assertRaises(vault.VaultError):
                vault.browser_login_inspection(json.dumps({**valid, 'destination': destination}).encode(), request_id)

    def test_browser_socket_peer_uses_the_dedicated_worker_account(self):
        with patch.object(vault.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=23003)) as lookup:
            self.assertEqual(vault.browser_peer_uid(), 23003)
        lookup.assert_called_once_with(vault.BROWSER_ACCOUNT)
        for account in (SimpleNamespace(pw_uid=0), SimpleNamespace(pw_uid='23003')):
            with patch.object(vault.pwd, 'getpwnam', return_value=account), self.assertRaises(vault.VaultError):
                vault.browser_peer_uid()
        with patch.object(vault.pwd, 'getpwnam', side_effect=KeyError), self.assertRaises(vault.VaultError):
            vault.browser_peer_uid()

    def browser_access_files(self, grants=None, policy=None):
        """Install fixture-owned browser grant files and patch their fixed paths."""
        config = self.root.parent / 'browser-config'
        config.mkdir(mode=0o700, exist_ok=True)
        grants_path = config / 'grants.json'
        policy_path = config / 'shared-grants.json'
        grants_path.write_text(json.dumps([{'bot': BROWSER_BOT, 'session': BROWSER_SESSION}]
                                          if grants is None else grants) + '\n')
        policy_path.write_text(json.dumps({'version': 1, 'bots': []} if policy is None else policy) + '\n')
        grants_path.chmod(0o640)
        policy_path.chmod(0o640)
        return patch.object(vault, 'BROWSER_GRANTS', grants_path), patch.object(vault, 'BROWSER_SHARED_GRANTS', policy_path), \
            patch.object(vault, 'browser_group_gid', return_value=os.getegid())

    def browser_access_request(self, *, enabled=True, bot=BROWSER_BOT, session=BROWSER_SESSION):
        """Return one exact owner action for the fixture Bot/session pair."""
        return {'action': 'set-browser-access', 'bot': bot, 'session': session, 'enabled': enabled}

    def test_owner_roster_authorizes_current_pairs_and_prunes_only_detached_shared_decisions(self):
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [])
        administrator = self.root.parent / 'roster'
        administrator.mkdir()
        administrator.chmod(0o755)
        publisher = administrator / 'cloud'
        publisher.mkdir()
        cloud_uid = os.geteuid() or CLOUD_UID
        if os.geteuid() == 0:
            os.chown(publisher, cloud_uid, os.getegid())
        publisher.chmod(0o2750)
        roster = publisher / 'active.json'
        original = {'bot': BROWSER_BOT, 'session': BROWSER_SESSION}
        newcomer = {'bot': 'bot-new', 'session': 'bot-session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}
        roster.write_text(json.dumps([newcomer], separators=(',', ':')) + '\n')
        if os.geteuid() == 0:
            os.chown(roster, cloud_uid, os.getegid())
        roster.chmod(0o640)
        grants_patch, policy_patch, group_patch = self.browser_access_files(
            grants={'version': 1, 'cloudUid': cloud_uid, 'grants': [original]},
            policy={'version': 1, 'bots': [{**original, 'enabled': True, 'revision': 'b' * 32}]},
        )
        request = self.browser_access_request(bot=newcomer['bot'], session=newcomer['session'])
        with (grants_patch, policy_patch, group_patch, patch.object(vault, 'BROWSER_OWNER_ROSTER', roster),
              patch.object(vault, 'browser_client', return_value=b'{"ok":true}') as browser):
            self.assertEqual(vault.browser_grant_pairs(), {(newcomer['bot'], newcomer['session'])})
            with self.assertRaises(vault.VaultError):
                self.store.desktop(self.browser_access_request(), OWNER_UID)
            self.assertEqual(self.store.desktop(request, OWNER_UID), {'ok': True})
            self.assertEqual([(row['bot'], row['session']) for row in vault.browser_shared_policy()],
                             [(newcomer['bot'], newcomer['session'])])
            browser.assert_called_once()
            roster.chmod(0o600)
            with self.assertRaises(vault.VaultError):
                self.store.desktop(request, OWNER_UID)
            roster.unlink()
            self.assertFalse(vault.browser_grant_pairs())

    def test_browser_access_wire_requires_the_exact_owner_action_and_canonical_session(self):
        valid = self.browser_access_request()
        self.assertEqual(vault.desktop_request(json.dumps(valid).encode()), valid)
        with self.assertRaises(vault.VaultError):
            vault.cloud_request(json.dumps(valid).encode())
        for malformed in (
            {**valid, 'enabled': 1}, {**valid, 'enabled': 'true'},
            {**valid, 'bot': 'bot bad'},
            {**valid, 'session': 'bot-session-not-a-uuid'},
            {**valid, 'extra': True}, {key: value for key, value in valid.items() if key != 'session'},
        ):
            with self.subTest(request=malformed), self.assertRaises(vault.VaultError):
                vault.desktop_request(json.dumps(malformed).encode())

    def test_browser_access_requires_the_authenticated_owner_and_exact_installed_pair(self):
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [])
        request = self.browser_access_request()
        grants_patch, policy_patch, group_patch = self.browser_access_files()
        with grants_patch, policy_patch, group_patch, patch.object(vault, 'browser_client') as browser:
            with self.assertRaises(vault.VaultError):
                self.store.desktop(request, OWNER_UID + 1)
            browser.assert_not_called()
        other = self.browser_access_request()
        grants = [{'bot': 'bot-other', 'session': BROWSER_SESSION}]
        grants_patch, policy_patch, group_patch = self.browser_access_files(grants=grants)
        with grants_patch, policy_patch, group_patch, patch.object(vault, 'browser_client') as browser:
            with self.assertRaises(vault.VaultError):
                self.store.desktop(other, OWNER_UID)
            browser.assert_not_called()

    def test_browser_access_fails_closed_for_absent_or_unsafe_managed_files(self):
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [])
        request = self.browser_access_request()
        grants_patch, policy_patch, group_patch = self.browser_access_files()
        with grants_patch, policy_patch, group_patch as group, patch.object(vault, 'browser_client') as browser:
            grants_path = vault.BROWSER_GRANTS
            grants_path.unlink()
            with self.assertRaises(vault.VaultError):
                self.store.desktop(request, OWNER_UID)
            browser.assert_not_called()
            grants_path.write_text('[{"bot":"bot-browser","session":"' + BROWSER_SESSION + '"}]\n')
            grants_path.chmod(0o600)
            with self.assertRaises(vault.VaultError):
                self.store.desktop(request, OWNER_UID)
            browser.assert_not_called()
            grants_path.chmod(0o640)
            group.return_value = os.getegid() + 1
            with self.assertRaises(vault.VaultError):
                self.store.desktop(request, OWNER_UID)
            group.return_value = os.getegid()
            vault.BROWSER_SHARED_GRANTS.write_text('{}\n')
            with self.assertRaises(vault.VaultError):
                self.store.desktop(request, OWNER_UID)

    def test_browser_access_persists_revision_before_ack_and_retries_without_rollback(self):
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [])
        request = self.browser_access_request()
        grants_patch, policy_patch, group_patch = self.browser_access_files()
        with grants_patch, policy_patch, group_patch, patch.object(vault, 'browser_client', return_value=b'{"ok":true}') as browser:
            self.assertEqual(self.store.desktop(request, OWNER_UID), {'ok': True})
            first = json.loads(vault.BROWSER_SHARED_GRANTS.read_text())['bots'][0]
            self.assertTrue(first['enabled'])
            self.assertRegex(first['revision'], r'^[0-9a-f]{32}$')
            first_bytes = vault.BROWSER_SHARED_GRANTS.read_bytes()
            self.assertEqual(self.store.desktop(request, OWNER_UID), {'ok': True})
            self.assertEqual(vault.BROWSER_SHARED_GRANTS.read_bytes(), first_bytes)
            self.assertEqual(json.loads(vault.BROWSER_SHARED_GRANTS.read_text())['bots'][0]['revision'], first['revision'])
            browser.return_value = b'{"ok":false}'
            with self.assertRaises(vault.VaultError):
                self.store.desktop(request, OWNER_UID)
            self.assertEqual(vault.BROWSER_SHARED_GRANTS.read_bytes(), first_bytes)
            browser.return_value = b'{"ok":true}'
            browser.side_effect = vault.VaultError(vault.BROWSER_UNAVAILABLE)
            denied = self.browser_access_request(enabled=False)
            with self.assertRaises(vault.VaultError):
                self.store.desktop(denied, OWNER_UID)
            after_denial = json.loads(vault.BROWSER_SHARED_GRANTS.read_text())['bots'][0]
            self.assertFalse(after_denial['enabled'])
            self.assertNotEqual(after_denial['revision'], first['revision'])
            browser.side_effect = None
            browser.return_value = b'{"ok":true}'
            self.assertEqual(self.store.desktop(denied, OWNER_UID), {'ok': True})
            self.assertEqual(json.loads(vault.BROWSER_SHARED_GRANTS.read_text())['bots'][0]['revision'], after_denial['revision'])
            self.assertEqual([json.loads(call.args[0]) for call in browser.call_args_list], [
                {'action': 'refresh-sharing'}, {'action': 'refresh-sharing'},
                {'action': 'refresh-sharing'}, {'action': 'refresh-sharing'},
                {'action': 'refresh-sharing'},
            ])

    def test_desktop_login_use_requires_the_current_owner_before_contacting_browser(self):
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [])
        request = {'action': 'inspect-login-use', 'id': 'a' * 32}
        with patch.object(vault, 'browser_client') as browser:
            for requester in (OWNER_UID + 1, CLOUD_UID):
                with self.subTest(requester=requester), self.assertRaises(vault.VaultError):
                    self.store.desktop(request, requester)
            browser.assert_not_called()

    def test_desktop_login_use_inspects_browser_metadata_and_matching_saved_logins(self):
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [])
        self.store.desktop({
            'action': 'add-login', 'origin': 'https://example.com', 'label': 'Example',
            'username': 'owner', 'password': 'private',
        }, OWNER_UID)
        self.store.desktop({
            'action': 'add-login', 'origin': 'https://other.example', 'label': 'Other',
            'username': 'other', 'password': 'other-private',
        }, OWNER_UID)
        logins = self.store.desktop({'action': 'list-logins'}, OWNER_UID)['logins']
        example_login = next(login for login in logins if login['origin'] == 'https://example.com')
        record = next(record for record in self.store.website_login_records() if record['id'] == example_login['id'])
        generation = vault.website_login_generation(record)
        request_id = 'a' * 32
        destination = 'https://example.com/login'
        calls = []

        def browser(payload):
            calls.append(json.loads(payload))
            return json.dumps({
                'id': request_id, 'origin': 'https://example.com', 'destination': destination, 'state': 'pending',
            }).encode()

        with patch.object(vault, 'browser_client', side_effect=browser):
            old = self.store.desktop({'action': 'inspect-login-use', 'id': request_id}, OWNER_UID)
            result = self.store.desktop({'action': 'inspect-login-use', 'id': request_id, 'form': 'entry'}, OWNER_UID)

        self.assertEqual(result, {'request': {
            'id': request_id, 'origin': 'https://example.com', 'destination': destination,
            'logins': [{'id': example_login['id'], 'label': 'Example', 'generation': generation}],
            'acceptsCredentials': True,
        }})
        self.assertEqual(old, {'request': {key: value for key, value in result['request'].items() if key != 'acceptsCredentials'}})
        self.assertEqual(calls, [{'action': 'inspect-login', 'id': request_id}] * 2)
        self.assertNotIn('private', json.dumps(result))

    def test_owner_can_manage_bot_logins_independently_of_personal_logins(self):
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [])
        site = {
            'action': 'add-login', 'origin': 'https://example.com', 'label': 'Personal',
            'username': 'fixture-personal', 'password': 'fixture-personal-secret',
        }
        scoped = {**site, 'bot': 'bot-scout', 'label': 'Research', 'username': 'fixture-team'}
        self.store.desktop(site, OWNER_UID)
        self.assertEqual(self.store.desktop(vault.desktop_request(json.dumps(scoped).encode()), OWNER_UID), {'ok': True})
        personal = self.store.desktop({'action': 'list-logins'}, OWNER_UID)['logins']
        assigned = self.store.desktop({'action': 'list-bot-logins'}, OWNER_UID)['botLogins']
        self.assertEqual([(item['label'], item['origin']) for item in personal], [('Personal', site['origin'])])
        self.assertEqual([(item['label'], item['bot']) for item in assigned], [('Research', 'bot-scout')])
        [login] = assigned
        self.assertEqual(set(login), {'id', 'origin', 'label', 'bot'})
        self.assertNotIn('fixture-', json.dumps(assigned))
        self.assertNotEqual(self.sealed_names[0], self.sealed_names[1])
        update = {'action': 'replace-login', 'id': login['id'], 'label': 'Rotated',
                  'username': 'fixture-rotated', 'password': 'fixture-rotated-secret'}
        for scope in ({}, {'bot': 'bot-other'}):
            with self.subTest(scope=scope), self.assertRaises(vault.VaultError):
                self.store.desktop({**update, **scope}, OWNER_UID)
        self.assertEqual(self.store.desktop({**update, 'bot': 'bot-scout'}, OWNER_UID), {'ok': True})
        self.assertEqual(self.sealed_names[1], self.sealed_names[2])
        self.assertEqual(self.store.desktop({'action': 'list-bot-logins'}, OWNER_UID)['botLogins'],
                         [{**login, 'label': 'Rotated'}])
        remove = {'action': 'remove-login', 'id': login['id'], 'bot': 'bot-scout'}
        with self.assertRaises(vault.VaultError):
            self.store.desktop(remove, CLOUD_UID)
        with self.assertRaises(vault.VaultError):
            self.store.desktop({'action': 'list-bot-logins'}, CLOUD_UID)
        self.assertEqual(self.store.desktop(remove, OWNER_UID), {'ok': True})
        self.assertEqual(self.store.desktop({'action': 'list-bot-logins'}, OWNER_UID), {'botLogins': []})
        self.assertEqual(self.store.desktop({'action': 'list-logins'}, OWNER_UID)['logins'], personal)

    def test_approval_matches_the_worker_bound_bot_and_exact_website(self):
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [])
        site = 'https://example.com'
        request_id = 'a' * 32
        personal = {'action': 'add-login', 'origin': site, 'label': 'Personal',
                    'username': 'fixture-personal', 'password': 'fixture-secret'}
        self.store.desktop(personal, OWNER_UID)
        self.store.desktop({**personal, 'bot': 'bot-scout', 'label': 'Scout', 'username': 'fixture-scout'}, OWNER_UID)
        self.store.desktop({**personal, 'bot': 'bot-other', 'label': 'Other', 'username': 'fixture-other'}, OWNER_UID)
        worker_bot = 'bot-scout'
        worker_origin = site
        submissions = []

        def browser(payload):
            command = json.loads(payload)
            if command['action'] == 'inspect-login-bot':
                return json.dumps({'bot': worker_bot}).encode()
            if command['action'] == 'use-login':
                submissions.append(command)
                return b'{"state":"submitted"}'
            return json.dumps({'id': request_id, 'origin': worker_origin,
                               'destination': worker_origin + '/login', 'state': 'pending'}).encode()

        with patch.object(vault, 'browser_client', side_effect=browser):
            inspect = {'action': 'inspect-login-use', 'id': request_id}
            reply = self.store.desktop(inspect, OWNER_UID)['request']
            [choice] = reply['logins']
            self.assertEqual(choice['label'], 'Scout')
            approve = {'action': 'approve-login-use', 'id': request_id,
                       'loginId': choice['id'], 'generation': choice['generation']}
            worker_bot = 'bot-other'
            self.assertEqual(self.store.desktop(approve, OWNER_UID), {'state': 'unavailable'})
            worker_bot = 'bot-scout'
            worker_origin = 'https://other.example'
            self.assertEqual(self.store.desktop(approve, OWNER_UID), {'state': 'unavailable'})
            self.assertEqual(self.decrypt_calls, [])
            worker_origin = site
            self.assertEqual(self.store.desktop(approve, OWNER_UID), {'state': 'submitted'})
            self.assertEqual(len(submissions), 1)
            self.assertEqual((submissions[0]['bot'], submissions[0]['username']), ('bot-scout', 'fixture-scout'))
            self.store.desktop({
                'action': 'replace-login', 'id': choice['id'], 'bot': 'bot-scout',
                'label': 'Updated', 'username': 'fixture-rotated', 'password': 'fixture-rotated-secret',
            }, OWNER_UID)
            self.assertEqual(self.store.desktop(approve, OWNER_UID), {'state': 'unavailable'})
            self.assertEqual(len(submissions), 1)
            [current] = self.store.desktop(inspect, OWNER_UID)['request']['logins']
            approve['generation'] = current['generation']
            self.assertEqual(self.store.desktop(approve, OWNER_UID), {'state': 'submitted'})
            self.assertEqual(submissions[-1]['username'], 'fixture-rotated')
            self.store.desktop({'action': 'remove-login', 'id': choice['id'], 'bot': 'bot-scout'}, OWNER_UID)
            self.assertEqual(self.store.desktop(approve, OWNER_UID), {'state': 'unavailable'})
            self.assertEqual(len(submissions), 2)

    def test_site_with_bot_accounts_requires_an_identifiable_browser_request(self):
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [])
        origin = 'https://example.com'
        login = {'action': 'add-login', 'origin': origin, 'label': 'Personal',
                 'username': 'fixture-personal', 'password': 'fixture-password'}
        self.store.desktop(login, OWNER_UID)
        self.store.desktop({**login, 'bot': 'bot-scout', 'label': 'Scout'}, OWNER_UID)
        request_id = 'a' * 32
        with patch.object(vault, 'browser_client', side_effect=[
            json.dumps({'id': request_id, 'origin': origin, 'destination': origin + '/login', 'state': 'pending'}).encode(),
            b'{"error":"unavailable"}',
        ]):
            shown = self.store.desktop({'action': 'inspect-login-use', 'id': request_id}, OWNER_UID)
        self.assertEqual(shown['request']['logins'], [])

    def test_shared_browser_only_offers_assigned_accounts_to_the_owner(self):
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [])
        origin = 'https://example.com'
        request_id = 'a' * 32
        login = {'action': 'add-login', 'origin': origin, 'label': 'Personal',
                 'username': 'fixture-personal', 'password': 'fixture-password'}
        self.store.desktop(login, OWNER_UID)
        self.store.desktop({**login, 'bot': 'bot-other', 'label': 'Other'}, OWNER_UID)
        page = {'id': request_id, 'origin': origin, 'destination': origin + '/login',
                'state': 'pending', 'scope': 'shared', 'bot': 'bot-scout'}
        submissions = []

        def browser(payload):
            command = json.loads(payload)
            if command['action'] == 'use-login':
                submissions.append(command)
                return b'{"state":"submitted"}'
            self.assertEqual(command, {'action': 'inspect-login', 'id': request_id})
            return json.dumps(page).encode()

        inspect = {'action': 'inspect-login-use', 'id': request_id, 'form': 'entry'}
        with patch.object(vault, 'browser_client', side_effect=browser):
            with self.assertRaises(vault.VaultError):
                self.store.desktop(inspect, CLOUD_UID)
            available = self.store.desktop(inspect, OWNER_UID)['request']
            self.assertEqual(available['logins'], [])
            self.assertNotIn('acceptsCredentials', available)
            self.assertEqual(self.store.desktop({
                'action': 'enter-login-use', 'id': request_id, 'origin': origin,
                'destination': page['destination'], 'username': 'fixture-entered', 'password': 'fixture-password',
            }, OWNER_UID), {'state': 'unavailable'})
            self.assertEqual(submissions, [])
            self.store.desktop({**login, 'bot': 'bot-scout', 'label': 'Team',
                                'username': 'fixture-team'}, OWNER_UID)
            request = self.store.desktop(inspect, OWNER_UID)['request']
            self.assertNotIn('acceptsCredentials', request)
            [choice] = request['logins']
            self.assertEqual(choice['label'], 'Team')
            approve = {'action': 'approve-login-use', 'id': request_id,
                       'loginId': choice['id'], 'generation': choice['generation']}
            page['bot'] = 'bot-other'
            self.assertEqual(self.store.desktop(approve, OWNER_UID), {'state': 'unavailable'})
            self.assertEqual(self.decrypt_calls, [])
            page['bot'] = 'bot-scout'
            self.assertEqual(self.store.desktop(approve, OWNER_UID), {'state': 'submitted'})
            self.assertEqual([(call['bot'], call['username']) for call in submissions], [('bot-scout', 'fixture-team')])

    def test_shared_browser_rejects_invalid_scope_metadata(self):
        request_id = 'a' * 32
        page = {'id': request_id, 'origin': 'https://example.com',
                'destination': 'https://example.com/login', 'state': 'pending'}
        for fields in ({'scope': 'shared'}, {'bot': 'bot-scout'}, {'scope': 'owner', 'bot': 'bot-scout'},
                       {'scope': 'shared', 'bot': 'invalid'}, {'scope': 'shared', 'bot': 'bot-scout', 'other': True}):
            with self.subTest(fields=fields), self.assertRaises(vault.VaultError):
                vault.browser_login_inspection(json.dumps({**page, **fields}).encode(), request_id)

    def test_website_signup_saves_a_generated_password_before_the_reviewed_post(self):
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [])
        request = {'action': 'create-login-use', 'id': 'b' * 32, 'origin': 'https://example.com',
                   'destination': 'https://example.com/signup', 'username': 'fixture@example.com', 'saveLabel': 'New account'}
        page = {key: request[key] for key in ('id', 'origin', 'destination')}
        page.update(state='pending', purpose='signup', bot='bot-scout',
                    session='bot-session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
        submitted = []

        def exchange(payload):
            call = json.loads(payload)
            if call['action'] == 'inspect-login':
                return json.dumps(page).encode()
            self.assertEqual(call['action'], 'use-signup')
            self.assertEqual((call['bot'], call['session']), (page['bot'], page['session']))
            self.assertEqual(call['username'], request['username'])
            self.assertGreaterEqual(len(call['password']), 24)
            logins = self.store.website_login_records(scoped=True)
            self.assertEqual([(login['id'], login['bot']) for login in logins], [(request['id'], page['bot'])])
            self.assertNotIn(call['password'], (self.store.website_login_directory(scoped=True) / request['id']).read_text())
            submitted.append(call['id'])
            return b'{"state":"needs-owner"}'

        with patch.object(vault, 'browser_client', side_effect=exchange):
            with patch.object(vault, 'browser_grant_pairs', return_value={(page['bot'], page['session'])}):
                value = vault.desktop_request(json.dumps(request).encode())
                with self.assertRaises(vault.VaultError):
                    self.store.desktop(value, CLOUD_UID)
                wrong_page = {**value, 'destination': request['origin'] + '/other'}
                self.assertEqual(self.store.desktop(wrong_page, OWNER_UID), {'state': 'unavailable'})
                self.failed_encryption = True
                self.assertEqual(self.store.desktop(value, OWNER_UID), {'state': 'unavailable'})
                self.assertEqual(submitted, [])
                self.failed_encryption = False
                for _attempt in range(2):
                    self.assertEqual(self.store.desktop(value, OWNER_UID), {'state': 'needs-owner', 'saved': True})
                self.assertEqual(submitted, [request['id']])
        self.assertEqual(self.store.desktop({'action': 'list-bot-logins'}, OWNER_UID)['botLogins'][0]['label'], 'New account')

    def test_entered_login_requires_the_owner_and_the_reviewed_destination(self):
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [])
        request = {'action': 'enter-login-use', 'id': 'a' * 32, 'origin': 'https://example.com',
                   'destination': 'https://example.com/login', 'username': 'fixture-user', 'password': 'fixture-password'}
        with patch.object(vault, 'browser_client') as browser:
            with self.assertRaises(vault.VaultError):
                self.store.desktop(request, CLOUD_UID)
            browser.assert_not_called()
            browser.return_value = json.dumps({
                'id': request['id'], 'origin': request['origin'], 'destination': 'https://example.com/alternate',
                'state': 'pending',
            }).encode()
            self.assertEqual(self.store.desktop(request, OWNER_UID), {'state': 'unavailable'})
            browser.assert_called_once_with(json.dumps(
                {'action': 'inspect-login', 'id': request['id']}, separators=(',', ':'),
            ).encode())
        self.assertEqual(self.sealed, [])

    def test_entered_login_is_saved_only_after_submission_and_with_consent(self):
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [])
        request = {'action': 'enter-login-use', 'id': 'a' * 32, 'origin': 'https://example.com',
                   'destination': 'https://example.com/login', 'username': 'fixture-user', 'password': 'fixture-password'}
        metadata = {key: request[key] for key in ('id', 'origin', 'destination')}
        use = {'action': 'use-login', **{key: request[key] for key in ('id', 'origin', 'username', 'password')}}
        for state, save, failed in (
            ('submitted', False, False), ('needs-owner', True, False),
            ('submitted', True, True), ('submitted', True, False),
        ):
            with self.subTest(state=state, save=save, failed=failed):
                self.failed_encryption = failed
                entered = {**request, 'saveLabel': 'Work'} if save else request
                with patch.object(vault, 'browser_client', side_effect=[
                    json.dumps({**metadata, 'state': 'pending'}).encode(), json.dumps({'state': state}).encode(),
                ]) as browser:
                    result = self.store.desktop(entered, OWNER_UID)
                expected = {'state': state}
                if save and state == 'submitted':
                    expected['saved'] = not failed
                self.assertEqual(result, expected)
                self.assertEqual([json.loads(call.args[0]) for call in browser.call_args_list],
                                 [{'action': 'inspect-login', 'id': request['id']}, use])
                logins = self.store.desktop({'action': 'list-logins'}, OWNER_UID)['logins']
                self.assertEqual(len(logins), int(result.get('saved', False)))
        self.assertEqual(logins[0]['label'], 'Work')
        self.assertEqual(logins[0]['origin'], request['origin'])
        self.assertNotIn(request['password'], (self.store.website_login_directory() / logins[0]['id']).read_text())

    def test_entered_login_supports_maximum_fields_with_json_escaping(self):
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [])
        request_id = 'a' * 32
        origin = 'https://example.com'
        destination = origin + '/login'
        password = '"' * vault.WEBSITE_LOGIN_PASSWORD_LIMIT

        def browser(payload):
            self.assertLessEqual(len(payload), vault.BROWSER_REQUEST_LIMIT)
            body = json.loads(payload)
            if body['action'] == 'inspect-login':
                return json.dumps({'id': request_id, 'origin': origin, 'destination': destination, 'state': 'pending'}).encode()
            self.assertEqual(body['password'], password)
            return b'{"state":"submitted"}'

        with patch.object(vault, 'browser_client', side_effect=browser):
            self.assertEqual(self.store.desktop({
                'action': 'enter-login-use', 'id': request_id, 'origin': origin, 'destination': destination,
                'username': '"' * vault.WEBSITE_LOGIN_USERNAME_LIMIT, 'password': password,
            }, OWNER_UID), {'state': 'submitted'})

    def test_desktop_login_use_approves_after_reinspection_and_delivers_only_to_browser(self):
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [])
        self.store.desktop({
            'action': 'add-login', 'origin': 'https://example.com', 'label': 'Example',
            'username': 'owner', 'password': 'private',
        }, OWNER_UID)
        login = self.store.desktop({'action': 'list-logins'}, OWNER_UID)['logins'][0]
        generation = next(record for record in self.store.website_login_records() if record['id'] == login['id'])
        generation = vault.website_login_generation(generation)
        request_id = 'a' * 32
        destination = 'https://example.com/login'
        calls = []

        def browser(payload):
            request = json.loads(payload)
            calls.append(request)
            if request['action'] == 'inspect-login':
                return json.dumps({
                    'id': request_id, 'origin': 'https://example.com', 'destination': destination, 'state': 'pending',
                }).encode()
            self.assertEqual(request, {
                'action': 'use-login', 'id': request_id, 'origin': 'https://example.com',
                'username': 'owner', 'password': 'private',
            })
            return b'{"state":"submitted"}'

        with patch.object(vault, 'browser_client', side_effect=browser):
            result = self.store.desktop({
                'action': 'approve-login-use', 'id': request_id, 'loginId': login['id'], 'generation': generation,
            }, OWNER_UID)

        self.assertEqual(result, {'state': 'submitted'})
        self.assertEqual([request['action'] for request in calls], ['inspect-login', 'use-login'])
        self.assertEqual(len(self.decrypt_calls), 1)

    def test_desktop_login_use_rejects_wrong_origin_and_stale_generation_before_decrypting(self):
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [])
        self.store.desktop({
            'action': 'add-login', 'origin': 'https://example.com', 'label': 'Example',
            'username': 'owner', 'password': 'private',
        }, OWNER_UID)
        login = self.store.desktop({'action': 'list-logins'}, OWNER_UID)['logins'][0]
        record = next(record for record in self.store.website_login_records() if record['id'] == login['id'])
        generation = vault.website_login_generation(record)
        request_id = 'a' * 32

        def wrong_origin(payload):
            self.assertEqual(json.loads(payload), {'action': 'inspect-login', 'id': request_id})
            return b'{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","origin":"https://other.example","destination":"https://other.example/login","state":"pending"}'

        with patch.object(vault, 'browser_client', side_effect=wrong_origin):
            result = self.store.desktop({
                'action': 'approve-login-use', 'id': request_id, 'loginId': login['id'], 'generation': generation,
            }, OWNER_UID)
        self.assertEqual(result, {'state': 'unavailable'})
        self.assertEqual(self.decrypt_calls, [])

        pending = json.dumps({
            'id': request_id, 'origin': 'https://example.com',
            'destination': 'https://example.com/login', 'state': 'pending',
        }).encode()
        self.store.desktop({
            'action': 'replace-login', 'id': login['id'], 'label': 'Rotated',
            'username': 'new-owner', 'password': 'new-private',
        }, OWNER_UID)
        with patch.object(vault, 'browser_client', return_value=pending):
            result = self.store.desktop({
                'action': 'approve-login-use', 'id': request_id, 'loginId': login['id'], 'generation': generation,
            }, OWNER_UID)
        self.assertEqual(result, {'state': 'unavailable'})
        self.assertEqual(self.decrypt_calls, [])

        current = next(record for record in self.store.website_login_records() if record['id'] == login['id'])
        latest_generation = vault.website_login_generation(current)
        self.store.desktop({'action': 'remove-login', 'id': login['id']}, OWNER_UID)
        with patch.object(vault, 'browser_client', return_value=pending) as browser:
            self.assertEqual(self.store.desktop({
                'action': 'approve-login-use', 'id': request_id, 'loginId': login['id'], 'generation': latest_generation,
            }, OWNER_UID), {'state': 'unavailable'})
            browser.assert_called_once()
        self.assertEqual(self.decrypt_calls, [])

    def test_desktop_login_use_decline_cancels_the_browser_request_without_diagnostics(self):
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [])
        request_id = 'a' * 32
        calls = []

        def browser(payload):
            calls.append(json.loads(payload))
            return b'{"state":"submitted","extra":"private"}'

        with patch.object(vault, 'browser_client', side_effect=browser):
            result = self.store.desktop({'action': 'decline-login-use', 'id': request_id}, OWNER_UID)
        self.assertEqual(result, {'state': 'unavailable'})
        self.assertEqual(calls, [{'action': 'cancel-login', 'id': request_id}])

    def test_desktop_login_use_sanitizes_invalid_browser_metadata_and_delivery_errors(self):
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [])
        self.store.desktop({
            'action': 'add-login', 'origin': 'https://example.com', 'label': 'Example',
            'username': 'owner', 'password': 'private',
        }, OWNER_UID)
        login = self.store.desktop({'action': 'list-logins'}, OWNER_UID)['logins'][0]
        record = next(record for record in self.store.website_login_records() if record['id'] == login['id'])
        request_id = 'a' * 32
        generation = vault.website_login_generation(record)

        with patch.object(vault, 'browser_client', return_value=b'{"id":"a","origin":"https://example.com","destination":"https://other.example/login","state":"pending"}'):
            with self.assertRaises(vault.VaultError) as failure:
                self.store.desktop({'action': 'inspect-login-use', 'id': request_id}, OWNER_UID)
        self.assertNotIn('private', str(failure.exception))

        def browser(payload):
            request = json.loads(payload)
            if request['action'] == 'inspect-login':
                return json.dumps({
                    'id': request_id, 'origin': 'https://example.com',
                    'destination': 'https://example.com/login', 'state': 'pending',
                }).encode()
            raise RuntimeError('private')

        with patch.object(vault, 'browser_client', side_effect=browser):
            result = self.store.desktop({
                'action': 'approve-login-use', 'id': request_id, 'loginId': login['id'], 'generation': generation,
            }, OWNER_UID)
        self.assertEqual(result, {'state': 'unavailable'})
        self.assertEqual(len(self.decrypt_calls), 1)

    @unittest.skipUnless(hasattr(socket, 'SO_PEERCRED'), 'Linux UNIX peer credentials')
    def test_desktop_peer_identity_comes_from_the_connected_socket(self):
        sender, receiver = socket.socketpair()
        with sender, receiver:
            self.assertEqual(vault.desktop_peer(receiver), os.getuid())

    def test_desktop_socket_is_limited_to_the_owner_and_has_a_short_lifetime(self):
        listener = vault.desktop_socket_unit(OWNER_UID).decode()
        worker = vault.desktop_worker_unit().decode()
        self.assertIn(f'SocketUser={OWNER_UID}', listener)
        self.assertIn('SocketMode=0600', listener)
        self.assertIn('ListenStream=/run/yharness-vault/desktop.sock', listener)
        self.assertIn('Accept=yes', listener)
        self.assertIn('PrivateNetwork=yes', worker)
        self.assertIn('StandardInput=socket', worker)
        self.assertIn('LimitCORE=0', worker)

    def test_removing_desktop_access_disables_the_socket_and_allows_a_new_owner(self):
        self.store.enable(FIRST_UNIT, CLOUD_UID)
        listener = self.units / vault.DESKTOP_LISTENER
        with patch.object(vault, 'trusted_file'):
            self.store.allow_desktop(OWNER_UID, CLOUD_UID, [FIRST_UNIT], start=True)
            self.assertTrue(self.listener_active)
            self.store.deny_desktop()
            self.assertFalse(self.listener_active)
            self.assertFalse(listener.exists())
            self.store.allow_desktop(OWNER_UID + 1, CLOUD_UID, [FIRST_UNIT], start=True)
        self.assertIn(f'SocketUser={OWNER_UID + 1}', listener.read_text())
        with self.assertRaises(vault.VaultError):
            self.store.desktop({'action': 'list'}, OWNER_UID)
        self.assertEqual(self.store.desktop({'action': 'list'}, OWNER_UID + 1), {'services': [{'unit': FIRST_UNIT, 'names': []}]})

    def test_failed_first_listener_start_removes_its_policy_and_socket(self):
        self.store.enable(FIRST_UNIT, CLOUD_UID)
        self.failed_listener_start = True
        with patch.object(vault, 'trusted_file'), self.assertRaises(vault.VaultError):
            self.store.allow_desktop(OWNER_UID, CLOUD_UID, [FIRST_UNIT], start=True)
        self.assertFalse(self.listener_active)
        self.assertFalse((self.units / vault.DESKTOP_LISTENER).exists())
        self.assertFalse((self.root / 'desktop.json').exists())

    def test_cloud_request_wire_is_exact_and_bounded(self):
        valid = {'action': 'create', 'id': 'a' * 32, 'unit': FIRST_UNIT, 'name': 'EXAMPLE_KEY'}
        self.assertEqual(vault.cloud_request(json.dumps(valid).encode()), valid)
        for malformed in (
            b'', b'null', b'{"action":"status","id":"' + b'a' * 32 + b'","id":"' + b'b' * 32 + b'"}',
            b'{"action":"create","id":"' + b'A' * 32 + b'","unit":"' + FIRST_UNIT.encode() + b'","name":"EXAMPLE_KEY"}',
            b' ' * (vault.CLOUD_REQUEST_LIMIT + 1), b'\xff',
        ):
            with self.subTest(size=len(malformed)), self.assertRaises(vault.VaultError):
                vault.cloud_request(malformed)
        for overrides in ({'id': 'a' * 31}, {'unit': '../escape.service'}, {'name': '../KEY'}, {'extra': 1}):
            bad = {**valid, **overrides}
            with self.subTest(fields=list(overrides)), self.assertRaises(vault.VaultError):
                vault.cloud_request(json.dumps(bad).encode())

    def test_desktop_manages_bot_grants_for_administrator_enabled_services(self):
        self.store.enable(FIRST_UNIT, CLOUD_UID)
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [FIRST_UNIT])
        self.assertEqual(self.store.desktop({'action': 'list-grants'}, OWNER_UID), {
            'access': {'services': [FIRST_UNIT], 'grants': []},
        })
        grant = {'bot': 'bot-research', 'unit': FIRST_UNIT, 'name': 'EXAMPLE_KEY'}
        add = {'action': 'add-grant', **grant}
        self.assertEqual(vault.desktop_request(json.dumps(add).encode()), add)
        with self.assertRaises(vault.VaultError):
            vault.desktop_request(json.dumps({**add, 'value': FIRST_VALUE.decode()}).encode())
        with self.assertRaises(vault.VaultError):
            self.store.desktop(add, CLOUD_UID)
        with self.assertRaises(vault.VaultError):
            self.store.desktop({**add, 'unit': SECOND_UNIT}, OWNER_UID)

        self.store.enable_requests(REQUEST_KEYS)
        with patch.object(vault, 'trusted_file'):
            self.assertEqual(self.store.desktop(add, OWNER_UID), {'ok': True})
            self.assertEqual(self.store.desktop(add, OWNER_UID), {'ok': True})
        self.assertTrue(self.cloud_listener_active)
        self.assertEqual(self.store.desktop({'action': 'list-grants'}, OWNER_UID), {
            'access': {'services': [FIRST_UNIT], 'grants': [grant]},
        })
        pending = {'action': 'create', 'id': 'a' * 32, **grant}
        self.assertEqual(self.store.cloud(pending, CLOUD_UID), {'state': 'pending'})
        self.assertEqual(self.store.desktop({**grant, 'action': 'remove-grant'}, OWNER_UID), {'ok': True})
        with self.assertRaises(vault.VaultError):
            self.store.desktop({'action': 'save-request', 'id': pending['id'], 'value': FIRST_VALUE.decode()}, OWNER_UID)
        legacy = {'action': 'create', 'id': 'b' * 32, 'unit': FIRST_UNIT, 'name': 'EXAMPLE_KEY'}
        self.assertEqual(self.store.cloud(legacy, CLOUD_UID), {'state': 'pending'})

    def test_desktop_scoped_grant_wire_is_exact(self):
        grant = {'bot': 'bot-research', 'unit': FIRST_UNIT, 'name': 'EXAMPLE_KEY'}
        list_scoped = {'action': 'list-scoped-grants'}
        self.assertEqual(vault.desktop_request(json.dumps(list_scoped).encode()), list_scoped)
        shared_add = {'action': 'add-grant', 'scope': 'shared', **grant}
        self.assertEqual(vault.desktop_request(json.dumps(shared_add).encode()), shared_add)
        set_scope = {'action': 'set-grant-scope', 'scope': 'owner', **grant}
        self.assertEqual(vault.desktop_request(json.dumps(set_scope).encode()), set_scope)
        for malformed in (
            {'action': 'list-scoped-grants', 'extra': 1},
            {'action': 'add-grant', 'scope': 'owner', **grant},
            {'action': 'add-grant', 'scope': 'shared', **grant, 'extra': 1},
            {'action': 'remove-grant', 'scope': 'shared', **grant},
            {'action': 'set-grant-scope', 'scope': 'invalid', **grant},
            {'action': 'set-grant-scope', **grant},
        ):
            with self.subTest(request=malformed), self.assertRaises(vault.VaultError):
                vault.desktop_request(json.dumps(malformed).encode())

    def test_desktop_scoped_grants_preserve_legacy_add_and_revoke_shared_requests(self):
        self.store.enable(FIRST_UNIT, CLOUD_UID)
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [FIRST_UNIT])
        grant = {'bot': 'bot-research', 'unit': FIRST_UNIT, 'name': 'EXAMPLE_KEY'}
        self.store.enable_requests([tuple(grant.values())])
        expected_services = [FIRST_UNIT]
        self.assertEqual(self.store.desktop({'action': 'list-scoped-grants'}, OWNER_UID), {
            'access': {'services': expected_services, 'grants': [{**grant, 'scope': 'owner'}]},
        })

        with patch.object(vault, 'trusted_file'):
            self.assertEqual(self.store.desktop({'action': 'add-grant', **grant}, OWNER_UID), {'ok': True})
        self.assertEqual(self.store.desktop({'action': 'list-grants'}, OWNER_UID), {
            'access': {'services': expected_services, 'grants': [grant]},
        })
        self.assertEqual(self.store.desktop({'action': 'list-scoped-grants'}, OWNER_UID), {
            'access': {'services': expected_services, 'grants': [{**grant, 'scope': 'owner'}]},
        })

        shared_add = {'action': 'add-grant', 'scope': 'shared', **grant}
        with patch.object(vault, 'trusted_file'):
            self.assertEqual(self.store.desktop(shared_add, OWNER_UID), {'ok': True})
            self.assertEqual(self.store.desktop({'action': 'add-grant', **grant}, OWNER_UID), {'ok': True})
        scoped = self.store.desktop({'action': 'list-scoped-grants'}, OWNER_UID)
        self.assertEqual(scoped, {
            'access': {'services': expected_services, 'grants': [{**grant, 'scope': 'shared'}]},
        })
        self.assertNotIn(FIRST_VALUE.decode(), json.dumps(scoped))
        self.assertEqual(self.store.desktop({'action': 'list-grants'}, OWNER_UID), {
            'access': {'services': expected_services, 'grants': [grant]},
        })

        pending = {'action': 'create', 'id': 'c' * 32, 'scope': 'shared', **grant}
        self.assertEqual(self.store.cloud(pending, CLOUD_UID), {'state': 'pending'})
        self.assertEqual(self.store.desktop({'action': 'set-grant-scope', 'scope': 'owner', **grant}, OWNER_UID), {'ok': True})
        self.assertEqual(self.store.desktop({'action': 'list-scoped-grants'}, OWNER_UID), {
            'access': {'services': expected_services, 'grants': [{**grant, 'scope': 'owner'}]},
        })
        with self.assertRaises(vault.VaultError):
            self.store.desktop({'action': 'inspect-request', 'id': pending['id']}, OWNER_UID)
        for requester in (CLOUD_UID, OWNER_UID + 1):
            with self.subTest(requester=requester), self.assertRaises(vault.VaultError):
                self.store.desktop({'action': 'list-scoped-grants'}, requester)
        self.assertEqual(self.store.desktop({'action': 'remove-grant', **grant}, OWNER_UID), {'ok': True})
        self.assertEqual(self.store.desktop({'action': 'list-scoped-grants'}, OWNER_UID), {
            'access': {'services': expected_services, 'grants': []},
        })

    def test_desktop_removing_the_only_grant_retains_the_vault_service(self):
        self.store.enable(FIRST_UNIT, CLOUD_UID)
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [FIRST_UNIT])
        self.store.save(FIRST_UNIT, 'EXAMPLE_KEY', FIRST_VALUE, CLOUD_UID)
        grant = {'bot': 'bot-research', 'unit': FIRST_UNIT, 'name': 'EXAMPLE_KEY'}
        with patch.object(vault, 'trusted_file'):
            self.store.desktop({'action': 'add-grant', **grant}, OWNER_UID)
        self.store.desktop({'action': 'remove-grant', **grant}, OWNER_UID)
        self.assertTrue(self.cloud_listener_active)
        self.assertEqual(self.store.cloud({'action': 'list', 'bot': 'bot-research'}, CLOUD_UID), {'credentials': []})
        self.assertEqual(self.store.names(FIRST_UNIT), ['EXAMPLE_KEY'])

    def test_a_vault_grant_applies_to_one_bot_and_is_rechecked_on_save(self):
        self.store.enable(FIRST_UNIT, CLOUD_UID)
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [FIRST_UNIT])
        first = vault.request_grant(f'bot-research/{FIRST_UNIT}=EXAMPLE_KEY')
        self.store.enable_requests([first, ('bot-other', FIRST_UNIT, 'OTHER_KEY')])
        discover = {'action': 'list', 'bot': 'bot-research'}
        self.assertEqual(vault.cloud_request(json.dumps(discover).encode()), discover)
        self.assertEqual(self.store.cloud(discover, CLOUD_UID), {
            'credentials': [{'unit': FIRST_UNIT, 'name': 'EXAMPLE_KEY'}],
        })
        self.assertEqual(self.store.cloud({**discover, 'bot': 'bot-visitor'}, CLOUD_UID), {'credentials': []})
        with self.assertRaises(vault.VaultError):
            self.store.cloud(discover, OWNER_UID)

        legacy = {'action': 'create', 'id': 'd' * 32, 'unit': FIRST_UNIT, 'name': 'EXAMPLE_KEY'}
        for request in (legacy, {**legacy, 'bot': 'bot-other'}):
            with self.assertRaises(vault.VaultError):
                self.store.cloud(request, CLOUD_UID)
        request = {**legacy, 'bot': 'bot-research'}
        self.assertEqual(vault.cloud_request(json.dumps(request).encode()), request)
        self.assertEqual(self.store.cloud(request, CLOUD_UID), {'state': 'pending'})
        other = {**request, 'bot': 'bot-other', 'id': 'f' * 32, 'name': 'OTHER_KEY'}
        self.assertEqual(self.store.cloud(other, CLOUD_UID), {'state': 'pending'})
        for bot in ('bot-other', None):
            actor = {} if bot is None else {'bot': bot}
            with self.assertRaises(vault.VaultError):
                self.store.cloud({'action': 'cancel', 'id': request['id'], **actor}, CLOUD_UID)
        save = {'action': 'save-request', 'id': request['id'], 'value': FIRST_VALUE.decode()}
        self.store.enable_requests([('bot-other', FIRST_UNIT, 'OTHER_KEY')])
        with self.assertRaises(vault.VaultError):
            self.store.desktop(save, OWNER_UID)
        self.assertEqual(self.store.cloud(discover, CLOUD_UID), {'credentials': []})
        self.assertEqual(self.store.cloud({
            'action': 'status', 'bot': 'bot-other', 'id': other['id'],
        }, CLOUD_UID), {'state': 'pending'})
        self.store.enable_requests([first, ('bot-other', FIRST_UNIT, 'OTHER_KEY')])
        with self.assertRaises(vault.VaultError):
            self.store.desktop(save, OWNER_UID)
        self.assertEqual(self.sealed, [])

    def test_a_bot_grant_uses_the_same_secure_entry_and_receipt(self):
        self.store.enable(FIRST_UNIT, CLOUD_UID)
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [FIRST_UNIT])
        self.store.enable_requests([('bot-research', FIRST_UNIT, 'EXAMPLE_KEY')])
        actor = {'id': 'e' * 32, 'bot': 'bot-research'}
        request = {'action': 'create', 'unit': FIRST_UNIT, 'name': 'EXAMPLE_KEY', **actor}
        self.assertEqual(self.store.cloud(request, CLOUD_UID), {'state': 'pending'})
        reply = self.store.desktop({'action': 'inspect-request', 'id': actor['id']}, OWNER_UID)
        self.assertEqual(reply, {
            'request': {'id': actor['id'], 'unit': FIRST_UNIT, 'name': 'EXAMPLE_KEY', 'state': 'pending'},
        })
        self.assertEqual(self.store.desktop({
            'action': 'save-request', 'id': actor['id'], 'value': FIRST_VALUE.decode(),
        }, OWNER_UID), {'ok': True})
        self.assertEqual(self.store.cloud({'action': 'status', **actor}, CLOUD_UID), {'state': 'saved'})
        self.assertEqual(self.sealed, [FIRST_VALUE])

    def test_reenabling_after_interrupted_withdrawal_does_not_restore_old_requests(self):
        self.store.enable(FIRST_UNIT, CLOUD_UID)
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [FIRST_UNIT])
        grants = [('bot-research', FIRST_UNIT, 'EXAMPLE_KEY')]
        self.store.enable_requests(grants)
        actor = {'id': 'f' * 32, 'bot': 'bot-research'}
        self.assertEqual(self.store.cloud({
            'action': 'create', 'unit': FIRST_UNIT, 'name': 'EXAMPLE_KEY', **actor,
        }, CLOUD_UID), {'state': 'pending'})
        (self.root / vault.CLOUD_REQUESTS_ENABLED).unlink()
        self.store.enable_requests(grants)
        with self.assertRaises(vault.VaultError):
            self.store.desktop({'action': 'inspect-request', 'id': actor['id']}, OWNER_UID)

    def test_shared_request_needs_a_shared_grant_and_a_fresh_owner_save_challenge(self):
        self.store.enable(FIRST_UNIT, CLOUD_UID)
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [FIRST_UNIT])
        grant = ('bot-research', FIRST_UNIT, 'EXAMPLE_KEY')
        actor = {'id': 'a' * 32, 'bot': grant[0], 'scope': 'shared'}
        mapping = {'unit': grant[1], 'name': grant[2]}
        discover = {'action': 'list', 'bot': grant[0], 'scope': 'shared'}
        create = {'action': 'create', **actor, **mapping}
        other_grant = ('bot-other', FIRST_UNIT, 'ANOTHER_KEY')
        self.store.enable_requests([grant, other_grant])
        self.assertEqual(vault.cloud_request(json.dumps(create).encode()), create)
        self.assertEqual(self.store.cloud(discover, CLOUD_UID), {'credentials': []})
        with self.assertRaises(vault.VaultError):
            self.store.cloud(create, CLOUD_UID)
        self.store.set_shared_request_grant(grant, True)
        self.assertEqual(self.store.cloud({'action': 'list', 'bot': other_grant[0]}, CLOUD_UID), {
            'credentials': [{'unit': FIRST_UNIT, 'name': 'ANOTHER_KEY'}],
        })
        self.assertEqual(self.store.cloud(discover, CLOUD_UID), {'credentials': [mapping]})
        self.assertEqual(self.store.cloud({'action': 'list', 'bot': grant[0]}, CLOUD_UID), {'credentials': [mapping]})
        self.assertEqual(self.store.cloud(create, CLOUD_UID), {'state': 'pending'})
        with self.assertRaises(vault.VaultError):
            self.store.cloud({'action': 'status', 'id': actor['id'], 'bot': actor['bot']}, CLOUD_UID)
        with self.assertRaises(vault.VaultError):
            self.store.cloud({'action': 'authorize', 'challenge': '0' * 32, **actor}, CLOUD_UID)

        def begin_save(executor, request_id):
            approval_written = Event()
            writer = self.store.write_request_records

            def record_write(records):
                writer(records)
                if any(entry.get('approval') and entry['id'] == request_id for entry in records):
                    approval_written.set()

            with patch.object(self.store, 'write_request_records', side_effect=record_write):
                receipt = executor.submit(self.store.desktop, {
                    'action': 'save-request', 'id': request_id, 'value': FIRST_VALUE.decode(),
                }, OWNER_UID)
                self.assertTrue(approval_written.wait(4), 'The owner did not request live admission.')
            return receipt

        with ThreadPoolExecutor(max_workers=1) as executor:
            held = begin_save(executor, actor['id'])
            status = self.store.cloud({'action': 'status', **actor}, CLOUD_UID)
            self.assertEqual(set(status), {'state', 'challenge'})
            self.assertEqual(status['state'], 'awaiting-authorization')
            self.assertFalse(self.sealed)
            self.assertNotIn(status['challenge'], json.dumps(self.store.desktop({
                'action': 'inspect-request', 'id': actor['id'],
            }, OWNER_UID)))
            self.assertEqual(self.store.cloud({'action': 'cancel', **actor}, CLOUD_UID), {'state': 'cancelled'})
            with self.assertRaises(vault.VaultError):
                held.result(timeout=4)
            with self.assertRaises(vault.VaultError):
                self.store.cloud({'action': 'authorize', 'challenge': status['challenge'], **actor}, CLOUD_UID)
            self.assertFalse(self.sealed)

            next_actor = {**actor, 'id': 'b' * 32}
            self.assertEqual(self.store.cloud({**create, **next_actor}, CLOUD_UID), {'state': 'pending'})
            held = begin_save(executor, next_actor['id'])
            status = self.store.cloud({'action': 'status', **next_actor}, CLOUD_UID)
            authorization = {'action': 'authorize', 'challenge': status['challenge'], **next_actor}
            with self.assertRaises(vault.VaultError):
                self.store.cloud({**authorization, 'bot': 'bot-other'}, CLOUD_UID)
            self.assertEqual(self.store.cloud(authorization, CLOUD_UID), {'state': 'pending'})
            self.assertEqual(held.result(timeout=4), {'ok': True})
            with self.assertRaises(vault.VaultError):
                self.store.cloud(authorization, CLOUD_UID)
        self.assertEqual(self.store.cloud({'action': 'status', **next_actor}, CLOUD_UID), {'state': 'saved'})
        self.assertEqual(self.sealed, [FIRST_VALUE])
        self.assertNotIn(FIRST_VALUE, self.store.request_file().read_bytes())
        self.store.set_shared_request_grant(grant, False)
        self.assertEqual(self.store.cloud(discover, CLOUD_UID), {'credentials': []})
        self.assertEqual(self.store.cloud({'action': 'list', 'bot': grant[0]}, CLOUD_UID), {'credentials': [mapping]})
        with self.assertRaises(vault.VaultError):
            self.store.cloud({'action': 'status', **next_actor}, CLOUD_UID)

    def test_cloud_request_round_trip_is_add_only_and_returns_no_secret(self):
        self.store.enable(FIRST_UNIT, CLOUD_UID)
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [FIRST_UNIT])
        self.store.enable_requests(REQUEST_KEYS)
        request = {'action': 'create', 'id': 'a' * 32, 'unit': FIRST_UNIT, 'name': 'EXAMPLE_KEY'}
        self.assertEqual(self.store.cloud(request, CLOUD_UID), {'state': 'pending'})
        self.assertEqual(self.store.desktop({'action': 'inspect-request', 'id': 'a' * 32}, OWNER_UID), {
            'request': {'id': 'a' * 32, 'unit': FIRST_UNIT, 'name': 'EXAMPLE_KEY', 'state': 'pending'},
        })
        self.assertEqual(self.store.desktop({'action': 'save-request', 'id': 'a' * 32, 'value': FIRST_VALUE.decode()}, OWNER_UID), {'ok': True})
        self.assertEqual(self.store.cloud({'action': 'status', 'id': 'a' * 32}, CLOUD_UID), {'state': 'saved'})
        previous = (self.root / FIRST_UNIT / 'credentials' / 'EXAMPLE_KEY').read_bytes()
        self.assertEqual(self.store.desktop({'action': 'save-request', 'id': 'a' * 32, 'value': SECOND_VALUE.decode()}, OWNER_UID), {'ok': True})
        self.assertEqual((self.root / FIRST_UNIT / 'credentials' / 'EXAMPLE_KEY').read_bytes(), previous)
        self.assertEqual(self.sealed, [FIRST_VALUE])
        self.assertEqual(self.store.cloud({'action': 'cancel', 'id': 'a' * 32}, CLOUD_UID), {'state': 'saved'})
        self.assertEqual(self.store.desktop({'action': 'dismiss-request', 'id': 'a' * 32}, OWNER_UID), {'state': 'saved'})
        self.assertNotIn(FIRST_VALUE, json.dumps(self.store.desktop({'action': 'inspect-request', 'id': 'a' * 32}, OWNER_UID)).encode())

    def test_cloud_status_renews_a_short_lease_and_expiry_cancels_the_owner_request(self):
        self.store.enable(FIRST_UNIT, CLOUD_UID)
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [FIRST_UNIT])
        self.store.enable_requests(REQUEST_KEYS)
        request = {'action': 'create', 'id': 'b' * 32, 'unit': FIRST_UNIT, 'name': 'EXAMPLE_KEY'}
        self.assertEqual(self.store.cloud(request, CLOUD_UID), {'state': 'pending'})
        self.now += vault.REQUEST_LEASE - 1
        self.assertEqual(self.store.cloud({'action': 'status', 'id': 'b' * 32}, CLOUD_UID), {'state': 'pending'})
        self.now += vault.REQUEST_LEASE - 1
        self.assertEqual(self.store.cloud({'action': 'status', 'id': 'b' * 32}, CLOUD_UID), {'state': 'pending'})
        self.now += vault.REQUEST_LEASE + 1
        self.assertEqual(self.store.cloud({'action': 'status', 'id': 'b' * 32}, CLOUD_UID), {'state': 'cancelled'})
        self.assertEqual(self.store.cloud({'action': 'cancel', 'id': 'b' * 32}, CLOUD_UID), {'state': 'cancelled'})
        self.assertEqual(self.store.desktop({'action': 'inspect-request', 'id': 'b' * 32}, OWNER_UID), {
            'request': {'id': 'b' * 32, 'unit': FIRST_UNIT, 'name': 'EXAMPLE_KEY', 'state': 'cancelled'},
        })
        with self.assertRaises(vault.VaultError):
            self.store.desktop({'action': 'save-request', 'id': 'b' * 32, 'value': FIRST_VALUE.decode()}, OWNER_UID)

    def test_cloud_request_scope_and_deny_desktop_fail_closed(self):
        self.store.enable(FIRST_UNIT, CLOUD_UID)
        self.store.enable(SECOND_UNIT, CLOUD_UID)
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [FIRST_UNIT])
        self.store.enable_requests(REQUEST_KEYS)
        request = {'action': 'create', 'id': 'c' * 32, 'unit': FIRST_UNIT, 'name': 'EXAMPLE_KEY'}
        for requester in (0, OWNER_UID, CLOUD_UID + 1):
            with self.subTest(requester=requester), self.assertRaises(vault.VaultError):
                self.store.cloud(request, requester)
        with self.assertRaises(vault.VaultError):
            self.store.cloud({**request, 'unit': SECOND_UNIT}, CLOUD_UID)
        with patch.object(vault, 'trusted_file'):
            self.store.enable_requests(REQUEST_KEYS, start=True)
            self.store.deny_desktop()
        with self.assertRaises(vault.VaultError):
            self.store.cloud(request, CLOUD_UID)

    def test_deny_desktop_clears_requests_before_a_later_regrant(self):
        self.store.enable(FIRST_UNIT, CLOUD_UID)
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [FIRST_UNIT])
        self.store.enable_requests(REQUEST_KEYS)
        request = {'action': 'create', 'id': 'g' * 32, 'unit': FIRST_UNIT, 'name': 'EXAMPLE_KEY'}
        self.assertEqual(self.store.cloud(request, CLOUD_UID), {'state': 'pending'})
        self.store.deny_desktop()
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [FIRST_UNIT])
        self.store.enable_requests(REQUEST_KEYS)
        with self.assertRaises(vault.VaultError):
            self.store.desktop({'action': 'inspect-request', 'id': 'g' * 32}, OWNER_UID)

    def test_disabling_cloud_requests_clears_pending_owner_receipts(self):
        self.store.enable(FIRST_UNIT, CLOUD_UID)
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [FIRST_UNIT])
        self.store.enable_requests(REQUEST_KEYS)
        request = {'action': 'create', 'id': 'h' * 32, 'unit': FIRST_UNIT, 'name': 'EXAMPLE_KEY'}
        self.assertEqual(self.store.cloud(request, CLOUD_UID), {'state': 'pending'})
        with patch.object(vault, 'trusted_file'):
            self.store.enable_requests(REQUEST_KEYS, start=True)
            self.store.disable_requests()
        with self.assertRaises(vault.VaultError):
            self.store.desktop({'action': 'inspect-request', 'id': 'h' * 32}, OWNER_UID)

    def test_accepted_worker_cannot_create_after_requests_are_disabled(self):
        self.store.enable(FIRST_UNIT, CLOUD_UID)
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [FIRST_UNIT])
        self.store.enable_requests(REQUEST_KEYS)
        self.store.disable_requests()
        with self.assertRaises(vault.VaultError):
            self.store.cloud({'action': 'create', 'id': 'i' * 32, 'unit': FIRST_UNIT, 'name': 'EXAMPLE_KEY'}, CLOUD_UID)

    def test_broker_accepts_only_the_administrator_selected_key_names(self):
        self.store.enable(FIRST_UNIT, CLOUD_UID)
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [FIRST_UNIT])
        self.store.enable_requests(REQUEST_KEYS)
        request = {'action': 'create', 'id': 'a' * 32, 'unit': FIRST_UNIT, 'name': 'EXAMPLE_KEY'}
        with self.assertRaises(vault.VaultError):
            self.store.cloud({**request, 'name': 'OTHER_KEY'}, CLOUD_UID)
        self.assertEqual(self.store.cloud(request, CLOUD_UID), {'state': 'pending'})
        self.store.enable_requests([(FIRST_UNIT, 'OTHER_KEY')])
        with self.assertRaises(vault.VaultError):
            self.store.desktop({'action': 'save-request', 'id': request['id'], 'value': FIRST_VALUE.decode()}, OWNER_UID)
        self.assertEqual(self.sealed, [])

    def test_requests_from_an_older_boot_are_not_reused(self):
        self.store.enable(FIRST_UNIT, CLOUD_UID)
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [FIRST_UNIT])
        self.store.enable_requests(REQUEST_KEYS)
        request = {'action': 'create', 'id': 'e' * 32, 'unit': FIRST_UNIT, 'name': 'EXAMPLE_KEY'}
        self.assertEqual(self.store.cloud(request, CLOUD_UID), {'state': 'pending'})
        restarted = vault.Vault(self.root, self.units, self.run_systemd, clock=lambda: self.now, boot_id='new-boot')
        self.assertEqual(restarted.cloud(request, CLOUD_UID), {'state': 'pending'})
        with self.assertRaises(vault.VaultError):
            restarted.cloud({'action': 'status', 'id': 'a' * 32}, CLOUD_UID)

    def test_cloud_request_socket_is_cloud_owned_and_can_be_disabled_exactly(self):
        listener = vault.cloud_socket_unit(CLOUD_UID).decode()
        worker = vault.cloud_worker_unit().decode()
        self.assertIn(f'SocketUser={CLOUD_UID}', listener)
        self.assertIn('SocketGroup=root', listener)
        self.assertIn('SocketMode=0600', listener)
        self.assertIn('ListenStream=/run/yharness-vault/cloud-requests.sock', listener)
        self.assertIn('StandardInput=socket', worker)
        self.store.enable(FIRST_UNIT, CLOUD_UID)
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [FIRST_UNIT])
        with patch.object(vault, 'trusted_file'):
            self.store.enable_requests(REQUEST_KEYS, start=True)
            self.assertTrue(self.cloud_listener_active)
            self.assertEqual((self.units / vault.CLOUD_LISTENER).read_bytes(), vault.cloud_socket_unit(CLOUD_UID))
            self.store.disable_requests()
        self.assertFalse(self.cloud_listener_active)
        self.assertFalse((self.units / vault.CLOUD_LISTENER).exists())

    def test_failed_first_cloud_listener_start_removes_its_generated_units(self):
        self.store.enable(FIRST_UNIT, CLOUD_UID)
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [FIRST_UNIT])
        self.failed_listener_start = True
        with patch.object(vault, 'trusted_file'), self.assertRaises(vault.VaultError):
            self.store.enable_requests(REQUEST_KEYS, start=True)
        self.assertFalse(self.cloud_listener_active)
        self.assertFalse((self.units / vault.CLOUD_LISTENER).exists())
        self.assertFalse((self.units / vault.CLOUD_WORKER).exists())

    def test_disabling_cloud_requests_checks_both_generated_units_before_stopping(self):
        self.store.enable(FIRST_UNIT, CLOUD_UID)
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [FIRST_UNIT])
        with patch.object(vault, 'trusted_file'):
            self.store.enable_requests(REQUEST_KEYS, start=True)
            worker = self.units / vault.CLOUD_WORKER
            worker.write_bytes(worker.read_bytes() + b'\n# owner edit\n')
            with self.assertRaises(vault.VaultError):
                self.store.disable_requests()
        self.assertTrue(self.cloud_listener_active)
        self.assertTrue((self.units / vault.CLOUD_LISTENER).exists())

    def test_pending_request_becomes_saved_when_key_appears_without_reading_value(self):
        self.store.enable(FIRST_UNIT, CLOUD_UID)
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [FIRST_UNIT])
        self.store.enable_requests(REQUEST_KEYS)
        request = {'action': 'create', 'id': 'd' * 32, 'unit': FIRST_UNIT, 'name': 'EXAMPLE_KEY'}
        self.assertEqual(self.store.cloud(request, CLOUD_UID), {'state': 'pending'})
        self.store.save(FIRST_UNIT, 'EXAMPLE_KEY', FIRST_VALUE, CLOUD_UID)
        self.assertEqual(self.store.cloud({'action': 'status', 'id': 'd' * 32}, CLOUD_UID), {'state': 'saved'})
        self.assertEqual(self.sealed, [FIRST_VALUE])

    def test_saved_key_remains_a_receipt_when_cloud_status_misses_the_lease(self):
        self.store.enable(FIRST_UNIT, CLOUD_UID)
        self.store.allow_desktop(OWNER_UID, CLOUD_UID, [FIRST_UNIT])
        self.store.enable_requests(REQUEST_KEYS)
        request = {'action': 'create', 'id': 'f' * 32, 'unit': FIRST_UNIT, 'name': 'EXAMPLE_KEY'}
        self.assertEqual(self.store.cloud(request, CLOUD_UID), {'state': 'pending'})
        self.now += vault.REQUEST_LEASE + 1
        self.store.save(FIRST_UNIT, 'EXAMPLE_KEY', FIRST_VALUE, CLOUD_UID)
        self.assertEqual(self.store.cloud({'action': 'status', 'id': 'f' * 32}, CLOUD_UID), {'state': 'saved'})


if __name__ == '__main__':
    unittest.main()
