#!/usr/bin/env python3
"""Preview or import one Grok Bot export into an existing VPS Bot."""

import argparse
import http.client
import json
import re
import subprocess
import sys
import uuid
from pathlib import Path
from urllib.parse import urlsplit

MAX_DOCUMENT_BYTES = 512 * 1024
MAX_MAPPING_BYTES = 64 * 1024


class ImportErrorDetail(Exception):
    """Error safe to print without printing the export or sign-in link."""


def format_connected_app_discovery(preview, catalog):
    """Return a credential-free source-label and target-access projection."""
    if not isinstance(preview, dict):
        raise ImportErrorDetail('The connected-app preview returned an unexpected response.')
    updated_at = preview.get('updatedAt')
    source_rows = preview.get('mappings')
    catalog_available = preview.get('catalogAvailable')
    if (isinstance(updated_at, bool) or not isinstance(updated_at, int) or updated_at < 0
            or not isinstance(source_rows, list) or not isinstance(catalog_available, bool)):
        raise ImportErrorDetail('The connected-app preview returned an unexpected response.')
    source_apps = []
    for row in source_rows:
        if not isinstance(row, dict) or not isinstance(row.get('sourceIndex'), int) \
                or isinstance(row['sourceIndex'], bool) or row['sourceIndex'] < 0 \
                or not isinstance(row.get('sourceLabel'), str) \
                or row['sourceLabel'] == '' or row.get('resolution') != 'unmapped':
            raise ImportErrorDetail('The connected-app preview returned an unexpected response.')
        source_apps.append({
            'sourceIndex': row['sourceIndex'],
            'sourceLabel': row['sourceLabel'],
        })
    if not isinstance(catalog, dict) or not isinstance(catalog.get('apps'), list):
        raise ImportErrorDetail('The connected-app catalog returned an unexpected response.')
    targets = []
    for app in catalog['apps']:
        if (not isinstance(app, dict) or not isinstance(app.get('id'), str)
                or not isinstance(app.get('name'), str)
                or not isinstance(app.get('allowed'), bool)):
            raise ImportErrorDetail('The connected-app catalog returned an unexpected response.')
        targets.append({
            'targetServerName': app['id'],
            'name': app['name'],
            'accessStatus': 'allowed' if app['allowed'] else 'denied',
        })
    return {
        'mode': 'connected-app-discovery',
        'updatedAt': updated_at,
        'catalogAvailable': catalog_available,
        'sourceApps': source_apps,
        'targets': targets,
    }


def read_connected_app_map(path):
    """Read an owner-reviewed exact connector map without inferring identities."""
    if not path.is_absolute() or not path.is_file():
        raise ImportErrorDetail('Choose an absolute connected-app map file.')
    try:
        raw = path.read_bytes()
    except OSError as error:
        raise ImportErrorDetail('Could not read the connected-app map file.') from error
    if len(raw) > MAX_MAPPING_BYTES:
        raise ImportErrorDetail('The connected-app map must be at most 64 KiB.')
    try:
        payload = json.loads(raw.decode('utf-8-sig'))
    except (UnicodeDecodeError, ValueError) as error:
        raise ImportErrorDetail('The connected-app map must be valid UTF-8 JSON.') from error
    if not isinstance(payload, list):
        raise ImportErrorDetail('The connected-app map must be a JSON array.')
    mappings = []
    seen_indexes = set()
    for index, item in enumerate(payload):
        if not isinstance(item, dict) or set(item) != {'sourceIndex', 'sourceLabel', 'targetServerName'}:
            raise ImportErrorDetail(f'Connected-app map entry {index} has invalid fields.')
        source_index = item['sourceIndex']
        source_label = item['sourceLabel']
        target_server_name = item['targetServerName']
        if isinstance(source_index, bool) or not isinstance(source_index, int) or source_index < 0:
            raise ImportErrorDetail(f'Connected-app map entry {index} has an invalid source index.')
        if source_index in seen_indexes:
            raise ImportErrorDetail('Connected-app map source indexes must be unique.')
        if not isinstance(source_label, str) or not source_label or source_label.strip() != source_label or len(source_label) > 160:
            raise ImportErrorDetail(f'Connected-app map entry {index} has an invalid source label.')
        if not isinstance(target_server_name, str) or not target_server_name or target_server_name.strip() != target_server_name or len(target_server_name) > 128:
            raise ImportErrorDetail(f'Connected-app map entry {index} has an invalid target server name.')
        seen_indexes.add(source_index)
        mappings.append({
            'sourceIndex': source_index,
            'sourceLabel': source_label,
            'targetServerName': target_server_name,
        })
    return mappings


def connect():
    """Authenticate to the VPS service's private loopback listener."""
    helper = Path.home() / '.local/bin/yharness-vps'
    result = subprocess.run(
        [sys.executable, str(helper), 'url'], check=True, capture_output=True, text=True, timeout=10,
    )
    origin = urlsplit(result.stdout.strip())
    if origin.scheme != 'http' or origin.netloc != '127.0.0.1:3080' or origin.path != '/':
        raise ImportErrorDetail('The VPS setup helper returned an unexpected sign-in address.')
    connection = http.client.HTTPConnection('127.0.0.1', 3080, timeout=120)
    connection.request('GET', '/?' + origin.query)
    response = connection.getresponse()
    cookie = (response.getheader('Set-Cookie') or '').partition(';')[0]
    response.read()
    if response.status != 303 or not re.fullmatch(r'dsh-auth-[\w-]{43}=v1\.[\w-]+\.[\w-]+', cookie):
        connection.close()
        raise ImportErrorDetail('Could not sign in to the private Y Harness service.')
    return connection, cookie


def invoke(connection, cookie, endpoint, **args):
    """Send a trusted operator request and return the decoded success value."""
    rpc_id = str(uuid.uuid4())
    envelope = {'type': 'client-request', 'rpcId': rpc_id, 'method': endpoint, 'payload': {'args': args}}
    connection.request('POST', '/api/' + endpoint, body=json.dumps(envelope), headers={
        'Cookie': cookie, 'Content-Type': 'application/json',
    })
    response = connection.getresponse()
    body = response.read()
    if response.status != 200:
        raise ImportErrorDetail(f'{endpoint} returned HTTP {response.status}.')
    decoded = json.loads(body)
    if decoded.get('type') != 'server-response' or decoded.get('rpcId') != rpc_id:
        raise ImportErrorDetail(f'{endpoint} returned an unexpected response.')
    result = decoded['result']
    if result['ok'] is not True:
        error = result['error']
        message = error.get('message') if error.get('code') == 'gateway/bad-request' else None
        raise ImportErrorDetail(message or f"{endpoint} failed with {error.get('code', 'unknown error')}.")
    return result['value']


def main():
    """Resolve one operator-owned destination and preview or apply the export."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('export', type=Path)
    parser.add_argument('--bot', required=True, help='Exact destination Bot name or id')
    parser.add_argument('--source-name', help='Source Bot name for exports containing several Bots')
    parser.add_argument('--connected-app-map', type=Path,
                        help='Absolute JSON map for reviewed connected-app grants. This mode imports apps only.')
    parser.add_argument('--discover-connected-apps', action='store_true',
                        help='Read source app labels and visible target access entries without changing the Bot.')
    parser.add_argument('--expected-updated-at', type=int,
                        help='Revision printed by a reviewed connected-app preview. Required with --apply.')
    parser.add_argument('--apply', action='store_true', help='Write entries. By default, preview only.')
    options = parser.parse_args()
    try:
        if options.discover_connected_apps:
            if options.apply:
                raise ImportErrorDetail('--discover-connected-apps cannot be combined with --apply.')
            if options.connected_app_map is not None:
                raise ImportErrorDetail('--discover-connected-apps cannot be combined with --connected-app-map.')
            if options.expected_updated_at is not None:
                raise ImportErrorDetail('--expected-updated-at is only valid with --apply and --connected-app-map.')
        with options.export.open('rb') as file:
            raw = file.read(MAX_DOCUMENT_BYTES + 1)
        if len(raw) > MAX_DOCUMENT_BYTES:
            raise ImportErrorDetail('Choose a Grok Bot export of at most 512 KiB.')
        document = raw.decode('utf-8-sig')
        mappings = None if options.connected_app_map is None else read_connected_app_map(options.connected_app_map)
        connection, cookie = connect()
        try:
            bots = invoke(connection, cookie, 'bots/list', request={'includeHidden': True})['bots']
            matches = [bot for bot in bots if options.bot in (bot['id'], bot['name'])]
            if len(matches) != 1:
                raise ImportErrorDetail('Choose exactly one existing destination Bot by name or id.')
            if options.discover_connected_apps:
                preview = invoke(connection, cookie, 'bots/importGrokConnectedApps', request={
                    'botId': matches[0]['id'], 'document': document, 'preview': True, 'mappings': [],
                    **({'sourceName': options.source_name} if options.source_name is not None else {}),
                })
                catalog = invoke(connection, cookie, 'bots/listConnectedApps', request={
                    'botId': matches[0]['id'],
                })
                print(json.dumps(format_connected_app_discovery(preview, catalog), ensure_ascii=False))
                return
            request = {'botId': matches[0]['id'], 'document': document, 'preview': not options.apply}
            if options.source_name is not None:
                request['sourceName'] = options.source_name
            if mappings is None:
                if options.expected_updated_at is not None:
                    raise ImportErrorDetail('--expected-updated-at is only valid with --connected-app-map.')
                result = invoke(connection, cookie, 'bots/importGrokBot', request=request)
                print(json.dumps({'mode': 'import' if options.apply else 'preview', **result}, ensure_ascii=False))
            else:
                if options.apply:
                    if options.expected_updated_at is None or options.expected_updated_at < 0:
                        raise ImportErrorDetail('Pass the non-negative updatedAt from the connected-app preview with --expected-updated-at.')
                elif options.expected_updated_at is not None:
                    raise ImportErrorDetail('--expected-updated-at is only valid with --apply.')
                request['mappings'] = mappings
                if options.apply:
                    request['expectedUpdatedAt'] = options.expected_updated_at
                result = invoke(connection, cookie, 'bots/importGrokConnectedApps', request=request)
                mode = 'connected-app-import' if options.apply else 'connected-app-preview'
                print(json.dumps({'mode': mode, **result}, ensure_ascii=False))
        finally:
            connection.close()
    except ImportErrorDetail as error:
        parser.exit(1, f'{error}\n')
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError, http.client.HTTPException):
        parser.exit(1, 'Could not read the export or communicate with the private Y Harness service.\n')


if __name__ == '__main__':
    main()
