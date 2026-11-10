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


class ImportErrorDetail(Exception):
    """Error safe to print without printing the export or sign-in link."""


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
    parser.add_argument('--apply', action='store_true', help='Write entries. By default, preview only.')
    options = parser.parse_args()
    try:
        with options.export.open('rb') as file:
            raw = file.read(MAX_DOCUMENT_BYTES + 1)
        if len(raw) > MAX_DOCUMENT_BYTES:
            raise ImportErrorDetail('Choose a Grok Bot export of at most 512 KiB.')
        document = raw.decode('utf-8-sig')
        connection, cookie = connect()
        try:
            bots = invoke(connection, cookie, 'bots/list', request={'includeHidden': True})['bots']
            matches = [bot for bot in bots if options.bot in (bot['id'], bot['name'])]
            if len(matches) != 1:
                raise ImportErrorDetail('Choose exactly one existing destination Bot by name or id.')
            request = {'botId': matches[0]['id'], 'document': document, 'preview': not options.apply}
            if options.source_name is not None:
                request['sourceName'] = options.source_name
            result = invoke(connection, cookie, 'bots/importGrokBot', request=request)
            print(json.dumps({'mode': 'import' if options.apply else 'preview', **result}, ensure_ascii=False))
        finally:
            connection.close()
    except ImportErrorDetail as error:
        parser.exit(1, f'{error}\n')
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError, http.client.HTTPException):
        parser.exit(1, 'Could not read the export or communicate with the private Y Harness service.\n')


if __name__ == '__main__':
    main()
