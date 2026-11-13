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
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('vps_vault', Path(__file__).with_name('vps-vault.py'))
assert SPEC is not None and SPEC.loader is not None
vault = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(vault)

FIRST_UNIT = 'example-search.service'
SECOND_UNIT = 'example-report@batch.service'
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
        self.sealed = []
        self.store = vault.Vault(self.root, self.units, self.run_systemd)

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
        if args[0] == '/usr/bin/systemctl' and args[-1] == vault.DESKTOP_LISTENER:
            self.listener_active = 'enable' in args
            return subprocess.CompletedProcess(args, int(self.listener_active and self.failed_listener_start))
        self.assertEqual(args, ['/usr/bin/systemd-creds', '--with-key=host', '--name=yharness_EXAMPLE_KEY', 'encrypt', '-', '-'])
        self.assertEqual(options['stderr'], subprocess.DEVNULL)
        self.sealed.append(options['input'])
        if self.failed_encryption:
            return subprocess.CompletedProcess(args, 1, stdout=options['input'])
        return subprocess.CompletedProcess(args, 0, stdout=base64.b64encode(f'sealed-{len(self.sealed)}'.encode()) + b'\n')

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


if __name__ == '__main__':
    unittest.main()
