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
        self.assertEqual(vault.desktop_request(json.dumps(inspect).encode()), inspect)
        self.assertEqual(vault.desktop_request(json.dumps(approve).encode()), approve)
        decline = {'action': 'decline-login-use', 'id': 'a' * 32}
        self.assertEqual(vault.desktop_request(json.dumps(decline).encode()), decline)
        for malformed in (
            {'action': 'inspect-login-use', 'id': 'A' * 32},
            {'action': 'inspect-login-use', 'id': 'a' * 32, 'extra': 1},
            {'action': 'approve-login-use', 'id': 'a' * 32, 'loginId': 'b' * 31, 'generation': 'c' * 64},
            {'action': 'approve-login-use', 'id': 'a' * 32, 'loginId': 'b' * 32, 'generation': 'c' * 63},
            {'action': 'approve-login-use', 'id': 'a' * 32, 'loginId': 'b' * 32, 'generation': 'c' * 64, 'extra': 1},
            {'action': 'decline-login-use', 'id': 'a' * 32, 'extra': 1},
        ):
            with self.subTest(request=malformed), self.assertRaises(vault.VaultError):
                vault.desktop_request(json.dumps(malformed).encode())
        for request in (inspect, approve, decline):
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
            result = self.store.desktop({'action': 'inspect-login-use', 'id': request_id}, OWNER_UID)

        self.assertEqual(result, {'request': {
            'id': request_id, 'origin': 'https://example.com', 'destination': destination,
            'logins': [{'id': example_login['id'], 'label': 'Example', 'generation': generation}],
        }})
        self.assertEqual(calls, [{'action': 'inspect-login', 'id': request_id}])
        self.assertNotIn('private', json.dumps(result))

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

        self.store.desktop({
            'action': 'replace-login', 'id': login['id'], 'label': 'Rotated',
            'username': 'new-owner', 'password': 'new-private',
        }, OWNER_UID)
        with patch.object(vault, 'browser_client', return_value=b'{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","origin":"https://example.com","destination":"https://example.com/login","state":"pending"}'):
            result = self.store.desktop({
                'action': 'approve-login-use', 'id': request_id, 'loginId': login['id'], 'generation': generation,
            }, OWNER_UID)
        self.assertEqual(result, {'state': 'unavailable'})
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
