"""Exercise the isolated browser installer without changing a VPS."""

import errno
import importlib.util
import json
import os
import pathlib
import stat
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    'setup_vps_browser', pathlib.Path(__file__).with_name('setup-vps-browser.py')
)
assert SPEC is not None and SPEC.loader is not None
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class IsolatedBrowserTest(unittest.TestCase):
    def test_service_uses_absolute_trusted_paths_and_two_named_socket_fds(self):
        unit = installer.service_unit(
            721,
            '/opt/node/bin/node',
            '/opt/chromium/chrome',
        ).decode()
        self.assertIn('User=yharness-browser\n', unit)
        self.assertIn('Group=yharness-browser\n', unit)
        self.assertIn(
            'ExecStart=/opt/node/bin/node /usr/local/lib/yharness-browser/service.mjs '
            '--chromium /opt/chromium/chrome --root /var/lib/yharness-browser '
            '--cloud-uid 721 --grants /etc/yharness-browser/grants.json\n',
            unit,
        )
        self.assertIn(
            'Sockets=yharness-browser-control.socket yharness-browser-vault.socket\n',
            unit,
        )
        self.assertNotIn('Environment=LISTEN_FDNAMES=', unit)
        self.assertIn('ProtectHome=tmpfs', unit)
        self.assertIn('ProtectSystem=strict', unit)
        self.assertIn('ReadWritePaths=/var/lib/yharness-browser', unit)
        self.assertIn('RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6', unit)
        self.assertIn('IPAddressAllow=127.0.0.53/32', unit)
        self.assertIn(
            'IPAddressDeny=127.0.0.0/8 169.254.0.0/16 10.0.0.0/8 '
            '172.16.0.0/12 192.168.0.0/16 ::1/128 fe80::/10 fc00::/7',
            unit,
        )
        self.assertIn('LimitCORE=0', unit)
        self.assertIn('CapabilityBoundingSet=', unit)
        self.assertIn(
            'InaccessiblePaths=/root /home /etc/ssh -/etc/ssl/private '
            '-/etc/NetworkManager/system-connections -/var/lib/yharness-cloud -/var/lib/yharness-vault', unit,
        )
        self.assertNotIn('PrivateNetwork=yes', unit)

    def test_service_rejects_systemd_syntax_untrusted_or_invalid_paths(self):
        for arguments in (
            (0, '/opt/node/bin/node', '/opt/chromium/chrome'),
            (721, 'node', '/opt/chromium/chrome'),
            (721, '/opt/node/bin/node', '/opt/chromium/chrome\nUser=root'),
            (721, '/opt/node/%h/bin/node', '/opt/chromium/chrome'),
        ):
            with self.subTest(arguments=arguments), self.assertRaises(installer.BrowserError):
                installer.service_unit(*arguments)

    def test_socket_units_use_cloud_owner_and_root_only_vault(self):
        control = installer.control_socket_unit(721).decode()
        vault = installer.vault_socket_unit().decode()
        self.assertIn('ListenStream=/run/yharness-browser/control.sock', control)
        self.assertIn('SocketUser=721', control)
        self.assertIn('SocketGroup=root', control)
        self.assertIn('SocketMode=0600', control)
        self.assertIn('DirectoryMode=0755', control)
        self.assertIn('FileDescriptorName=control', control)
        self.assertIn('Service=yharness-browser.service', control)
        self.assertIn('Before=yharness-browser.service', control)
        self.assertIn('ListenStream=/run/yharness-browser/vault.sock', vault)
        self.assertIn('SocketUser=root', vault)
        self.assertIn('SocketGroup=root', vault)
        self.assertIn('SocketMode=0600', vault)
        self.assertIn('FileDescriptorName=vault', vault)
        self.assertIn('Service=yharness-browser.service', vault)
        self.assertIn('Before=yharness-browser.service', vault)
        self.assertNotIn('ListenStream=127.0.0.1', control + vault)

    def test_source_requires_named_fds_and_uses_chromium_pipe_not_tcp_control(self):
        source = ''.join(installer.artifact_source(name).decode() for name in installer.SERVICE_ARTIFACTS)
        for fragment in (
            "process.env.LISTEN_FDNAMES",
            "for (const name of ['control', 'vault'])",
            "--remote-debugging-pipe",
            "--user-data-dir",
            "join(root, session)",
            "readFile(grantsFile",
            "createServer",
        ):
            self.assertIn(fragment, source)
        self.assertNotIn('--remote-debugging-port', source)
        self.assertNotIn('listen(.*127.0.0.1', source)

    def test_grants_are_canonical_sorted_and_account_readable_only(self):
        records = installer.grant_records([
            ('bot-beta', 'bot-session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
            ('bot-alpha', 'bot-session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
        ])
        self.assertEqual(records, [
            {'bot': 'bot-alpha', 'session': 'bot-session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},
            {'bot': 'bot-beta', 'session': 'bot-session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'},
        ])
        payload = installer.grants_payload(records)
        self.assertEqual(json.loads(payload), records)
        self.assertTrue(payload.endswith(b'\n'))
        for bad in (
            [('bot-alpha', 'ordinary-session')],
            [('bot/escape', 'bot-session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')],
            [('bot-alpha', 'bot-session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
             ('bot-alpha', 'bot-session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')],
            [('bot-alpha', 'bot-session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
             ('bot-beta', 'bot-session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')],
            [('bot-alpha', '')],
            [],
            [('bot-alpha', f'bot-session-{index:08x}-aaaa-4aaa-8aaa-aaaaaaaaaaaa') for index in range(65)],
        ):
            with self.subTest(bad=bad), self.assertRaises(installer.BrowserError):
                installer.grant_records(bad)

    def test_trusted_path_requires_root_owned_non_writable_executable(self):
        path = pathlib.Path('/opt/chromium/chrome')
        with patch.object(pathlib.Path, 'resolve', return_value=path), patch.object(
            pathlib.Path, 'stat', return_value=SimpleNamespace(st_uid=0, st_mode=stat.S_IFREG | 0o755)
        ):
            self.assertEqual(installer.trusted_executable(path), path)
        with patch.object(pathlib.Path, 'resolve', return_value=path), patch.object(
            pathlib.Path, 'stat', return_value=SimpleNamespace(st_uid=1000, st_mode=stat.S_IFREG | 0o755)
        ):
            with self.assertRaises(installer.BrowserError):
                installer.trusted_executable(path)
        with patch.object(pathlib.Path, 'resolve', return_value=path), patch.object(
            pathlib.Path, 'stat', return_value=SimpleNamespace(st_uid=0, st_mode=stat.S_IFREG | 0o775)
        ):
            with self.assertRaises(installer.BrowserError):
                installer.trusted_executable(path)

    def test_existing_account_with_supplementary_group_or_unlocked_password_is_rejected(self):
        account = SimpleNamespace(
            pw_uid=721,
            pw_gid=721,
            pw_name=installer.ACCOUNT,
            pw_dir=str(installer.STATE_ROOT),
            pw_shell=installer.NOLOGIN,
        )
        with (
            patch.object(installer.pwd, 'getpwnam', return_value=account),
            patch.object(installer.grp, 'getgrnam', return_value=SimpleNamespace(gr_gid=721, gr_mem=[])),
            patch.object(installer.os, 'getgrouplist', return_value=[721, 27]),
            patch.object(installer, 'command') as run,
        ):
            with self.assertRaises(installer.BrowserError):
                installer.ensure_account()
            run.assert_not_called()
        with (
            patch.object(installer.pwd, 'getpwnam', return_value=account),
            patch.object(installer.grp, 'getgrnam', return_value=SimpleNamespace(gr_gid=721, gr_mem=[])),
            patch.object(installer.os, 'getgrouplist', return_value=[721]),
            patch.object(installer, 'command', return_value='yharness-browser P 01-01-2026 0 99999 7 -1'),
        ):
            with self.assertRaises(installer.BrowserError):
                installer.ensure_account()

    def test_install_writes_root_managed_artifacts_without_starting_cloud(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            paths = installer.InstallPaths(
                install_root=root / 'usr-local-lib',
                state_root=root / 'var-lib',
                config_root=root / 'etc',
                unit_root=root / 'units',
                runtime_root=root / 'run',
            )
            account = SimpleNamespace(pw_uid=721, pw_gid=721)
            with (
                patch.object(installer, 'ensure_account', return_value=account),
                patch.object(installer, 'trusted_executable', side_effect=lambda path: pathlib.Path(path)),
                patch.object(installer, 'ensure_units_inactive'),
                patch.object(installer, 'command') as command,
            ):
                previous_umask = os.umask(0o077)
                try:
                    installer.install(
                        '/opt/chromium/chrome',
                        '/opt/node/bin/node',
                        722,
                        [('bot-alpha', 'bot-session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')],
                        paths=paths,
                    )
                finally:
                    os.umask(previous_umask)
            self.assertEqual(
                (paths.install_root / 'service.mjs').read_bytes(), installer.service_source()
            )
            for name in installer.SERVICE_ARTIFACTS:
                self.assertTrue((paths.install_root / name).read_bytes().startswith(installer.ARTIFACT_MARKER))
            grant = paths.config_root / 'grants.json'
            self.assertEqual(json.loads(grant.read_text()), [{
                'bot': 'bot-alpha',
                'session': 'bot-session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            }])
            self.assertEqual(stat.S_IMODE(grant.stat().st_mode), 0o640)
            self.assertEqual(stat.S_IMODE(paths.config_root.stat().st_mode), 0o750)
            self.assertEqual(stat.S_IMODE(paths.state_root.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(paths.install_root.stat().st_mode), 0o755)
            self.assertEqual(stat.S_IMODE(paths.runtime_root.stat().st_mode), 0o755)
            self.assertFalse(any('yharness-cloud' in str(call.args[0]) for call in command.call_args_list))
            self.assertFalse(any('restart' in call.args[0] for call in command.call_args_list))

    def test_install_is_idempotent_and_refuses_active_mismatched_units(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            paths = installer.InstallPaths(
                install_root=root / 'usr-local-lib',
                state_root=root / 'var-lib',
                config_root=root / 'etc',
                unit_root=root / 'units',
                runtime_root=root / 'run',
            )
            account = SimpleNamespace(pw_uid=721, pw_gid=721)
            kwargs = dict(
                chromium='/opt/chromium/chrome',
                node='/opt/node/bin/node',
                cloud_uid=722,
                grants=[('bot-alpha', 'bot-session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')],
                paths=paths,
            )
            with (
                patch.object(installer, 'ensure_account', return_value=account),
                patch.object(installer, 'trusted_executable', side_effect=lambda path: pathlib.Path(path)),
                patch.object(installer, 'ensure_units_inactive'),
            ):
                installer.install(**kwargs)
                installer.install(**kwargs)
            service = paths.unit_root / installer.SERVICE_UNIT
            service.write_text('administrator edit\n')
            with (
                patch.object(installer, 'ensure_account', return_value=account),
                patch.object(installer, 'trusted_executable', side_effect=lambda path: pathlib.Path(path)),
                patch.object(installer, 'ensure_units_inactive', side_effect=installer.BrowserError('active')) as inactive,
            ):
                with self.assertRaisesRegex(installer.BrowserError, 'active'):
                    installer.install(**kwargs)
            inactive.assert_called_once()
            self.assertEqual(service.read_text(), 'administrator edit\n')

    def test_install_does_not_fix_permissions_on_unrelated_existing_state(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            paths = installer.InstallPaths(
                install_root=root / 'usr-local-lib',
                state_root=root / 'var-lib',
                config_root=root / 'etc',
                unit_root=root / 'units',
                runtime_root=root / 'run',
            )
            paths.state_root.mkdir(mode=0o755)
            with (
                patch.object(installer, 'ensure_account', return_value=SimpleNamespace(pw_uid=721, pw_gid=721)),
                patch.object(installer, 'trusted_executable', side_effect=lambda path: pathlib.Path(path)),
            ):
                with self.assertRaises(installer.BrowserError):
                    installer.install(
                        '/opt/chromium/chrome', '/opt/node/bin/node', 722,
                        [('bot-alpha', 'bot-session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')], paths=paths,
                    )
            self.assertEqual(stat.S_IMODE(paths.state_root.stat().st_mode), 0o755)

    def test_ensure_units_inactive_checks_each_browser_unit(self):
        with patch.object(installer, 'command', return_value='ActiveState=inactive\nLoadState=loaded\n') as run:
            installer.ensure_units_inactive()
        self.assertEqual(
            [call.args[0][-1] for call in run.call_args_list],
            [installer.SERVICE_UNIT, installer.CONTROL_SOCKET_UNIT, installer.VAULT_SOCKET_UNIT],
        )
        with patch.object(installer, 'command', return_value='ActiveState=active\nLoadState=loaded\n'):
            with self.assertRaisesRegex(installer.BrowserError, 'Stop the isolated browser service'):
                installer.ensure_units_inactive()
        with patch.object(installer, 'command', side_effect=installer.BrowserError('systemd unavailable')):
            with self.assertRaisesRegex(installer.BrowserError, 'Could not inspect'):
                installer.ensure_units_inactive()

    def test_check_executable_rejects_file_capabilities(self):
        path = pathlib.Path('/opt/chromium/chrome')
        with (
            patch.object(pathlib.Path, 'stat', return_value=SimpleNamespace(st_mode=stat.S_IFREG | 0o755)),
            patch.object(installer.os, 'getxattr', return_value=b'capability', create=True),
        ):
            with self.assertRaises(installer.BrowserError):
                installer.check_executable(path)
        with (
            patch.object(pathlib.Path, 'stat', return_value=SimpleNamespace(st_mode=stat.S_IFREG | 0o755)),
            patch.object(installer.os, 'getxattr', side_effect=OSError(errno.ENODATA, 'none'), create=True),
        ):
            installer.check_executable(path)


if __name__ == '__main__':
    unittest.main()
