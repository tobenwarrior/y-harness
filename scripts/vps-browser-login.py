#!/usr/bin/python3 -I
"""Submit a saved login through a separately isolated, trusted Firefox instance.

This worker needs an administrator-controlled browser and loopback namespace.
Its Firefox endpoint must be unreachable to Bots and websites. The caller
owns browser identity and admission, approves the action, and limits runtime.
"""

import json
import os
import re
import resource
import signal
import sys
import time
from urllib.parse import urlsplit


MAX_INPUT = 64 * 1024
MAX_REPLY = 256 * 1024
COMMAND_TIMEOUT = 12
HOST_LABEL = r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
ORIGIN = re.compile(rf'https://({HOST_LABEL}(?:\.{HOST_LABEL})+)(?::([1-9][0-9]{{0,4}}))?')
STATES = {'submitted', 'unavailable', 'needs-owner'}

# The isolated realm builds the form body without putting the account details
# in page inputs, keyboard events, or the clipboard.
SUBMIT = r'''async (origin, approvedAction, username, password) => {
  if (!isSecureContext || window !== window.top || location.origin !== origin || document.visibilityState !== 'visible') {
    return 'unavailable';
  }
  if (document.forms.length > 32) return 'unavailable';
  const candidates = [];
  for (const form of document.forms) {
    const target = form.target || document.querySelector('base[target]')?.target || '_self';
    const action = new URL(form.action, document.baseURI);
    if (form.method !== 'post' || target.toLowerCase() !== '_self'
        || form.enctype !== 'application/x-www-form-urlencoded'
        || action.href !== approvedAction || form.elements.length > 32) continue;
    const fields = [...form.elements].filter(field => field instanceof HTMLInputElement);
    const editable = field => field.name && field.name.length <= 256 && !field.matches(':disabled') && !field.readOnly
      && field.getClientRects().length > 0 && getComputedStyle(field).visibility === 'visible';
    const passwords = fields.filter(field => field.type === 'password');
    const identifiers = fields.filter(field => ['text', 'email', 'tel'].includes(field.type)
      && field.autocomplete === 'username' && editable(field));
    if (passwords.length !== 1 || passwords[0].autocomplete !== 'current-password'
        || !editable(passwords[0]) || identifiers.length !== 1) continue;
    const [user] = identifiers;
    const [pass] = passwords;
    if (user.name === pass.name) continue;
    candidates.push({form, action, user, pass});
  }
  if (candidates.length !== 1) return 'unavailable';
  const [{form, action, user, pass}] = candidates;
  const payload = new URLSearchParams();
  // Copy ordinary hidden fields without dispatching a page-owned formdata event.
  for (const field of form.elements) {
    if (field === user || field === pass || !field.name || field.matches(':disabled')) continue;
    if (!(field instanceof HTMLInputElement) || field.type !== 'hidden'
        || field.name.length > 256 || field.value.length > 8192
        || field.name === user.name || field.name === pass.name || payload.has(field.name)) return 'unavailable';
    payload.append(field.name, field.value);
  }
  payload.set(user.name, username);
  payload.set(pass.name, password);
  if (payload.toString().length > 65536 || location.origin !== origin) return 'unavailable';
  try {
    const response = await fetch(action.href, {
      method: 'POST', body: payload, mode: 'same-origin', credentials: 'same-origin',
      redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(8000),
    });
    if (response.type !== 'opaqueredirect' && !response.ok) {
      await response.body?.cancel();
      return 'needs-owner';
    }
    // Revisit the original page with the new cookies without following the POST's redirect.
    await response.body?.cancel();
    if (location.origin !== origin) return 'needs-owner';
    setTimeout(() => location.reload(), 0);
    return 'submitted';
  } catch {
    return 'needs-owner';
  }
}'''


class BrowserError(Exception):
    """Fixed failure that contains no browser replies or input."""


class BrowserSession:
    """One short-lived BiDi session on a private loopback endpoint."""

    def __init__(self, port):
        if type(port) is not int or not 1024 <= port <= 65535:
            raise BrowserError()
        self.port = port
        self.socket = None
        self.sequence = 0

    def __enter__(self):
        from websocket import create_connection

        self.socket = create_connection(f'ws://127.0.0.1:{self.port}/session', timeout=COMMAND_TIMEOUT,
                                        suppress_origin=True, http_no_proxy=['127.0.0.1'])
        try:
            self.command('session.new', {'capabilities': {'alwaysMatch': {'acceptInsecureCerts': False}}})
        except Exception:
            self.socket.close()
            raise BrowserError() from None
        return self

    def __exit__(self, *_exception):
        try:
            self.command('session.end', {})
        except Exception:
            # Closing the socket is still required when Firefox shuts it first.
            pass
        finally:
            self.socket.close()

    def command(self, method, params):
        """Call a fixed worker-selected method and return only its result."""
        self.sequence += 1
        command_id = self.sequence
        self.socket.send(json.dumps({'id': command_id, 'method': method, 'params': params}))
        deadline = time.monotonic() + COMMAND_TIMEOUT
        while time.monotonic() < deadline:
            self.socket.settimeout(max(0.01, deadline - time.monotonic()))
            message = self.socket.recv()
            if len(message) > MAX_REPLY:
                raise BrowserError()
            reply = json.loads(message)
            if reply.get('id') != command_id:
                continue
            if reply.get('type') != 'success' or type(reply.get('result')) is not dict:
                raise BrowserError()
            return reply['result']
        raise BrowserError()


def exact_object(pairs):
    """Reject duplicate JSON keys on the credential pipe."""
    value = dict(pairs)
    if len(value) != len(pairs):
        raise BrowserError()
    return value


def request(payload):
    """Parse the fixed pipe message from the Vault with bounded values."""
    if len(payload) > MAX_INPUT:
        raise BrowserError()
    value = json.loads(payload, object_pairs_hook=exact_object)
    if type(value) is not dict or set(value) != {'origin', 'action', 'username', 'password'}:
        raise BrowserError()
    origin, action, username, password = (value[field] for field in ('origin', 'action', 'username', 'password'))
    if any(type(field) is not str for field in (origin, action, username, password)):
        raise BrowserError()
    match = ORIGIN.fullmatch(origin)
    if (match is None or len(match[1]) > 253 or match[1].rsplit('.', 1)[1].isdecimal()
            or match[1].endswith(('.localhost', '.local', '.localdomain'))):
        raise BrowserError()
    if match[2] is not None and (int(match[2]) > 65535 or int(match[2]) == 443):
        raise BrowserError()
    if (not 0 < len(action) <= 4096 or not action.startswith(origin + '/') or '#' in action
            or not action.isascii() or re.search(r'[\x00-\x20\x7f\\]', action) is not None):
        raise BrowserError()
    if not 0 < len(username.encode()) <= 512 or not 0 < len(password.encode()) <= 8192:
        raise BrowserError()
    return origin, action, username, password


def use_login(port, origin, action, username, password):
    """Use one visible top-level tab with the exact approved HTTPS form action."""
    with BrowserSession(port) as browser:
        contexts = browser.command('browsingContext.getTree', {'maxDepth': 0})['contexts']
        if len(contexts) != 1:
            return 'unavailable'
        context = contexts[0]
        current = urlsplit(context['url'])
        if current.scheme + '://' + current.netloc != origin:
            return 'unavailable'
        result = browser.command('script.callFunction', {
            'functionDeclaration': SUBMIT, 'awaitPromise': True,
            'target': {'context': context['context'], 'sandbox': 'yharness-vault'},
            'arguments': [{'type': 'string', 'value': item} for item in (origin, action, username, password)],
        })
        state = result.get('result', {}).get('value')
        return state if result.get('type') == 'success' and state in STATES else 'needs-owner'


def main():
    """Consume credentials on a pipe and write a fixed result with no page data."""
    try:
        if os.geteuid() == 0:
            raise BrowserError()
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        signal.alarm(18)
        if len(sys.argv) != 2:
            raise BrowserError()
        state = use_login(int(sys.argv[1]), *request(sys.stdin.buffer.read(MAX_INPUT + 1)))
    except Exception:
        state = 'needs-owner'
    print(json.dumps({'state': state}, separators=(',', ':')))


if __name__ == '__main__':
    main()
