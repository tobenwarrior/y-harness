#!/usr/bin/env python3
"""Verify the trusted login worker with Firefox ESR in a disposable Linux container.

Run with YH_TEST_VAULT_FIREFOX=1, firefox-esr, python3-websocket, certutil,
openssl and systemd-creds. Map the two .test hostnames to 127.0.0.1 and keep
the container offline. The root fixture needs the unprivileged `node` user
and a newly generated systemd host key within the container.
"""

import http.server
import importlib.util
import json
import os
import pwd
import re
import resource
import secrets
import shutil
import ssl
import subprocess
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from urllib.parse import parse_qs


SCRIPTS = Path(__file__).resolve().parent
HOST = 'login.example.test'
ALTERNATE = 'other.example.test'
VALID_FORM = '''<form method="post" action="/session" target="_self">
<input name="account" type="email" autocomplete="username">
<input name="pass" type="password" autocomplete="current-password">
<input name="nonce" type="hidden" value="form-token">
<button>Sign in</button></form>'''


class FixtureHandler(http.server.BaseHTTPRequestHandler):
    """Serve a password form and record only whether the dummy login matched."""

    def log_message(self, *_args):
        pass

    def html(self, body):
        data = ('<!doctype html><title>Vault test</title>' + body).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == '/cross-origin':
            body = VALID_FORM.replace('"/session"', f'"{self.server.other_origin}/session"')
        elif self.path == '/method':
            body = VALID_FORM.replace('method="post"', 'method="get"')
        elif self.path == '/iframe':
            body = '<iframe src="/login"></iframe>'
        elif self.path == '/ambiguous':
            body = VALID_FORM + VALID_FORM
        elif self.path == '/redirect-form':
            body = VALID_FORM.replace('"/session"', '"/redirect"')
        elif self.path == '/failed-form':
            body = VALID_FORM.replace('"/session"', '"/failed"')
        elif self.path == '/cookie-form':
            body = ('<p>Signed in</p>' if 'authenticated=1' in self.headers.get('Cookie', '')
                    else VALID_FORM.replace('"/session"', '"/cookie"'))
        elif self.path == '/duplicate-field':
            body = VALID_FORM.replace('<button>', '<input name="account" type="hidden" value="duplicate"><button>')
        elif self.path == '/wrong-purpose':
            body = VALID_FORM.replace('autocomplete="current-password"', '')
        elif self.path == '/oversized-field':
            body = VALID_FORM.replace('form-token', 'x' * 32769)
        elif self.path == '/page-script':
            body = VALID_FORM + '''<script>
              window.fetch = () => Promise.reject(new Error('Page fetch should not handle a Vault login'));
              document.addEventListener('input', () => { document.title = 'Unexpected input'; });
            </script>'''
        else:
            body = VALID_FORM
        self.html(body)

    def do_POST(self):
        data = self.rfile.read(int(self.headers['Content-Length']))
        fields = parse_qs(data.decode())
        valid = fields == {
            'account': [self.server.username], 'pass': [self.server.password], 'nonce': ['form-token'],
        }
        self.server.posts.append((self.headers['Host'], self.path, valid))
        if self.path == '/failed':
            self.send_response(401)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        if self.path in ('/redirect', '/cookie'):
            if self.path == '/cookie':
                self.send_response(303)
                self.send_header('Location', '/cookie-form')
                self.send_header('Set-Cookie', 'authenticated=1; Secure; HttpOnly; Path=/')
            else:
                self.send_response(307)
                self.send_header('Location', self.server.other_origin + '/session')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        self.html('<p>Signed in</p>')


def openssl(*arguments):
    """Generate fixture-only TLS keys without printing their contents."""
    subprocess.run(['openssl', *arguments], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)


class BrowserLoginTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.environ.get('YH_TEST_VAULT_FIREFOX') != '1':
            raise unittest.SkipTest('Use the isolated Firefox fixture image and test hosts.')
        cls.directory = tempfile.TemporaryDirectory(prefix='yh-vault-firefox-')
        cls.addClassCleanup(cls.directory.cleanup)
        root = Path(cls.directory.name)
        cls.profile = root / 'profile'
        cls.profile.mkdir()
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        cert = root / 'cert.pem'
        key = root / 'key.pem'
        openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                '-subj', '/CN=Y Harness fixture CA', '-keyout', str(root / 'ca.key'), '-out', str(root / 'ca.pem'))
        openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', f'/CN={HOST}',
                '-keyout', str(key), '-out', str(root / 'tls.csr'))
        extensions = root / 'tls.conf'
        extensions.write_text(f'subjectAltName=DNS:{HOST},DNS:{ALTERNATE}\nextendedKeyUsage=serverAuth\n')
        openssl('x509', '-req', '-in', str(root / 'tls.csr'), '-CA', str(root / 'ca.pem'), '-CAkey', str(root / 'ca.key'),
                '-CAcreateserial', '-days', '1', '-extfile', str(extensions), '-out', str(cert))
        for arguments in (('-N', '--empty-password'), ('-A', '-n', 'Fixture CA', '-t', 'C,,', '-i', str(root / 'ca.pem'))):
            subprocess.run(['certutil', '-d', f'sql:{cls.profile}', *arguments], check=True, capture_output=True)
        options = {}
        if os.geteuid() == 0:
            cls.browser_user = pwd.getpwnam('node')
            for path in (root, cls.profile, *cls.profile.iterdir()):
                os.chown(path, cls.browser_user.pw_uid, cls.browser_user.pw_gid)
            options = {
                'user': cls.browser_user.pw_uid, 'group': cls.browser_user.pw_gid, 'extra_groups': [],
                'env': {'PATH': '/usr/bin:/bin', 'HOME': str(root), 'MOZ_HEADLESS': '1'},
            }
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(cert, key)
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), FixtureHandler)
        server.socket = tls.wrap_socket(server.socket, server_side=True)
        cls.addClassCleanup(server.server_close)
        cls.server = server
        cls.origin = f'https://{HOST}:{server.server_port}'
        server.other_origin = f'https://{ALTERNATE}:{server.server_port}'
        server.username = 'fixture@example.test'
        server.password = 'fixture-' + secrets.token_hex(12)
        server.posts = []
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        cls.addClassCleanup(cls.stop_server, server, thread)
        firefox = subprocess.Popen([
            shutil.which('firefox-esr') or 'firefox', '--headless', '--no-remote', '--profile', str(cls.profile),
            '--remote-debugging-port', '0', 'about:blank',
        ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, **options)
        cls.addClassCleanup(cls.stop_firefox, firefox)
        def discard_browser_logs():
            with firefox.stderr:
                for line in firefox.stderr:
                    if match := re.fullmatch(rb'WebDriver BiDi listening on ws://127\.0\.0\.1:(\d+)\n', line):
                        cls.port = int(match[1])
                        ready.set()
        ready = threading.Event()
        cls.firefox_logs = threading.Thread(target=discard_browser_logs, daemon=True)
        cls.firefox_logs.start()
        if not ready.wait(timeout=15):
            raise RuntimeError('The Firefox fixture did not start.')

    @staticmethod
    def stop_server(server, thread):
        server.shutdown()
        thread.join()

    @staticmethod
    def stop_firefox(process):
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()

    def controller(self):
        spec = importlib.util.spec_from_file_location('vps_browser_login', SCRIPTS / 'vps-browser-login.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def navigate(self, path):
        controller = self.controller()
        with controller.BrowserSession(self.port) as browser:
            context = browser.command('browsingContext.getTree', {'maxDepth': 0})['contexts'][0]['context']
            browser.command('browsingContext.navigate', {'context': context, 'url': path, 'wait': 'complete'})
            browser.command('browsingContext.activate', {'context': context})

    def run_worker(self, payload):
        options = {}
        if os.geteuid() == 0:
            options = {'user': self.browser_user.pw_uid, 'group': self.browser_user.pw_gid, 'extra_groups': []}
        return subprocess.run(['/usr/bin/python3', '-I', '-B', str(SCRIPTS / 'vps-browser-login.py'), str(self.port)],
                              input=payload, capture_output=True, text=True, timeout=20, **options)

    def invoke(self, path, *, action=None, origin=None):
        self.navigate(path)
        payload = json.dumps({
            'origin': origin or self.origin, 'action': self.origin + (action or '/session'),
            'username': self.server.username, 'password': self.server.password,
        })
        return self.run_worker(payload)

    def test_submits_a_same_origin_post_form(self):
        before = len(self.server.posts)
        result = self.invoke(self.origin + '/login')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {'state': 'submitted'})
        deadline = time.monotonic() + 4
        while len(self.server.posts) == before and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertEqual(self.server.posts[before:], [(self.origin.split('://')[1], '/session', True)])

    def test_refuses_other_origins_and_unsafe_or_ambiguous_forms(self):
        before = len(self.server.posts)
        for destination in (self.server.other_origin + '/login', *(self.origin + path for path in (
                '/cross-origin', '/method', '/iframe', '/ambiguous', '/duplicate-field', '/wrong-purpose', '/oversized-field',
        ))):
            with self.subTest(destination=destination):
                result = self.invoke(destination)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout), {'state': 'unavailable'})
        self.assertEqual(len(self.server.posts), before)

    def test_worker_does_not_follow_redirects_with_the_password(self):
        before = len(self.server.posts)
        result = self.invoke(self.origin + '/redirect-form', action='/redirect')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {'state': 'submitted'})
        self.assertEqual(self.server.posts[before:], [(self.origin.split('://')[1], '/redirect', True)])
        self.assertNotIn(self.server.password, result.stdout + result.stderr)

    def test_reloads_original_page_with_the_cookie_set_on_a_redirect(self):
        before = len(self.server.posts)
        result = self.invoke(self.origin + '/cookie-form', action='/cookie')
        self.assertEqual(json.loads(result.stdout), {'state': 'submitted'})
        self.assertEqual(self.server.posts[before:], [(self.origin.split('://')[1], '/cookie', True)])
        with self.controller().BrowserSession(self.port) as browser:
            context = browser.command('browsingContext.getTree', {'maxDepth': 0})['contexts'][0]['context']
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                state = browser.command('script.evaluate', {
                    'expression': 'document.body.textContent.includes("Signed in")',
                    'target': {'context': context}, 'awaitPromise': False,
                })
                if state['result']['value']:
                    break
                time.sleep(0.025)
            else:
                self.fail('Firefox did not show the signed-in fixture page.')

    def test_page_overrides_do_not_intercept_saved_values(self):
        before = len(self.server.posts)
        result = self.invoke(self.origin + '/page-script')
        self.assertEqual(json.loads(result.stdout), {'state': 'submitted'})
        self.assertEqual(self.server.posts[before:], [(self.origin.split('://')[1], '/session', True)])

    def test_refuses_an_unapproved_form_action_on_the_saved_origin(self):
        before = len(self.server.posts)
        result = self.invoke(self.origin + '/redirect-form')
        self.assertEqual(json.loads(result.stdout), {'state': 'unavailable'})
        self.assertEqual(len(self.server.posts), before)

    def test_failed_post_returns_owner_handoff_without_response_data(self):
        result = self.invoke(self.origin + '/failed-form', action='/failed')
        self.assertEqual(json.loads(result.stdout), {'state': 'needs-owner'})
        self.assertNotIn(self.server.password, result.stdout + result.stderr)

    def test_rotated_vault_record_can_be_delivered_through_a_private_pipe(self):
        host_key = Path('/var/lib/systemd/credential.secret')
        if os.geteuid() != 0 or not host_key.is_file():
            self.skipTest('Use the fixture image with its generated host key and a separate Firefox user.')
        spec = importlib.util.spec_from_file_location('vps_vault', SCRIPTS / 'vps-vault.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory(prefix='yh-vault-delivery-') as directory:
            vault = module.Vault(Path(directory), boot_id=str(uuid.uuid4()))
            probe = subprocess.run(['/usr/bin/test', '-r', directory], user=self.browser_user.pw_uid,
                                   group=self.browser_user.pw_gid, extra_groups=[], check=False)
            self.assertEqual(probe.returncode, 1)
            with vault.locked():
                vault.add_website_login({'origin': self.origin, 'label': 'Test', 'username': 'old', 'password': 'old'})
                record, = vault.website_login_records()
                vault.replace_website_login({
                    'id': record['id'], 'label': 'Rotated', 'username': self.server.username, 'password': self.server.password,
                })

            def deliver(username, password):
                reply = self.run_worker(json.dumps({
                    'origin': self.origin, 'action': self.origin + '/session', 'username': username, 'password': password,
                }))
                self.assertEqual(reply.returncode, 0, reply.stderr)
                self.assertEqual(json.loads(reply.stdout), {'state': 'submitted'})
                self.assertNotIn(password, reply.stdout + reply.stderr)

            self.navigate(self.origin + '/login')
            before = len(self.server.posts)
            vault.use_website_login(record['id'], self.origin, deliver)
            self.assertEqual(self.server.posts[before:], [(self.origin.split('://')[1], '/session', True)])
            with vault.locked():
                vault.remove_website_login(record)
            with self.assertRaises(module.VaultError):
                vault.use_website_login(record['id'], self.origin, deliver)

    def test_worker_refuses_a_root_browser_context(self):
        if os.geteuid() != 0:
            self.skipTest('Use the root fixture with the browser running as a separate user.')
        self.navigate(self.origin + '/login')
        before = len(self.server.posts)
        result = subprocess.run(['/usr/bin/python3', '-I', '-B', str(SCRIPTS / 'vps-browser-login.py'), str(self.port)],
                                input=json.dumps({'origin': self.origin, 'action': self.origin + '/session',
                                                  'username': self.server.username, 'password': self.server.password}),
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(json.loads(result.stdout), {'state': 'needs-owner'})
        self.assertEqual(len(self.server.posts), before)


if __name__ == '__main__':
    unittest.main()
