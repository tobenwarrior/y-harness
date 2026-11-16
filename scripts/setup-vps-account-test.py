"""Exercise dedicated Cloud service setup without changing host accounts or units."""

import errno
import importlib.util
import os
import pathlib
import stat
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location('setup_vps_account', pathlib.Path(__file__).with_name('setup-vps-account.py'))
assert SPEC is not None and SPEC.loader is not None
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class DedicatedCloudTest(unittest.TestCase):
    def test_unit_runs_web_as_its_own_user_on_loopback(self):
        unit = installer.service_unit(721, '/opt/node/bin/node', '/opt/yharness/release', 3180).decode()
        self.assertIn('ConditionUser=yharness-cloud\n', unit)
        self.assertIn('WantedBy=default.target\n', unit)
        self.assertNotIn('\nUser=', unit)
        self.assertNotIn('\nGroup=', unit)
        self.assertNotIn('user@721.service', unit)
        self.assertIn('Environment="XDG_RUNTIME_DIR=/run/user/721"', unit)
        self.assertIn('Environment="YH_HOME=/var/lib/yharness-cloud/.yharness-vps/state"', unit)
        self.assertIn('Environment="YH_VPS_BOT_ROOT=/var/lib/yharness-cloud/.yharness-vps/bots"', unit)
        self.assertIn(' --profile web --no-open --host 127.0.0.1 --port 3180\n', unit)
        self.assertIn('StandardOutput=journal\n', unit)
        self.assertIn('UMask=0077\n', unit)
        self.assertNotIn('truncate:', unit)

    def test_rejects_systemd_syntax_in_paths_and_root_identity(self):
        for arguments in (
            (0, '/opt/node/bin/node', '/opt/yharness/release', 3180),
            (721, '/opt/node/%h/bin/node', '/opt/yharness/release', 3180),
            (721, '/opt/node/bin/node', '/opt/yharness/release\nUser=root', 3180),
            (721, '/opt/node/bin/node', '/opt/yharness/release', 0),
        ):
            with self.subTest(arguments=arguments), self.assertRaises(installer.AccountError):
                installer.service_unit(*arguments)

    def test_rejects_privileged_runtime_executables(self):
        path = pathlib.Path('/opt/node/bin/node')
        for mode, capabilities in ((stat.S_ISUID, None), (stat.S_ISGID, None), (0, b'file capabilities')):
            with (
                self.subTest(mode=mode, capabilities=capabilities),
                patch.object(installer.os, 'getxattr', return_value=capabilities, create=True),
                patch.object(pathlib.Path, 'stat', return_value=SimpleNamespace(st_mode=stat.S_IFREG | 0o755 | mode)),
                self.assertRaises(installer.AccountError),
            ):
                installer.check_executable(path)

    def test_accepts_an_ordinary_executable_without_capabilities(self):
        path = pathlib.Path('/opt/node/bin/node')
        with (
            patch.object(installer.os, 'getxattr', side_effect=OSError(errno.ENODATA, 'no capabilities'), create=True),
            patch.object(pathlib.Path, 'stat', return_value=SimpleNamespace(st_mode=stat.S_IFREG | 0o755)),
        ):
            installer.check_executable(path)

    def test_live_invocation_requires_the_installed_unit_and_dedicated_process(self):
        invocation = 'd' * 32
        raw = f'Id={installer.UNIT}\nActiveState=active\nInvocationID={invocation}\nMainPID=4321\n'
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(installer, 'command') as run,
            patch.object(installer, 'process_uid') as process_uid,
        ):
            unit = pathlib.Path(directory) / 'yharness-cloud.service'
            unit.touch()
            alias = unit.with_name('distribution-user-unit.service')
            alias.symlink_to(unit)
            other = unit.with_name('other.service')
            other.touch()
            with patch.object(installer, 'UNIT_PATH', unit):
                run.return_value = raw + f'FragmentPath={alias}\n'
                process_uid.return_value = 721
                self.assertEqual(installer.live_invocation(721), (invocation, '4321'))
                args = run.call_args.args[0]
                self.assertIn('--user', args)
                self.assertNotIn('--system', args)
                self.assertIn('DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/721/bus', args)
                self.assertEqual(installer.live_invocation(721, through_local_bus=True), (invocation, '4321'))
                args = run.call_args.args[0]
                self.assertEqual(args[0], '/usr/bin/systemctl')
                self.assertIn('--user', args)
                self.assertIn('--machine=yharness-cloud@.host', args)
                self.assertEqual(args[-1], installer.UNIT)
                process_uid.return_value = 0
                with self.assertRaises(installer.AccountError):
                    installer.live_invocation(721)
                process_uid.return_value = 721
                run.return_value = raw + f'FragmentPath={other}\n'
                with self.assertRaises(installer.AccountError):
                    installer.live_invocation(721)

    def test_only_reports_the_current_service_invocations_private_url(self):
        invocation = 'd' * 32
        candidate = 'http://127.0.0.1:3180/?token=' + 'b' * 43
        with (
            patch.object(installer, 'live_invocation', return_value=(invocation, '4321')),
            patch.object(installer, 'command', return_value='yharness web: ' + candidate + '\n') as run,
        ):
            self.assertEqual(installer.launch_url(721, 3180), candidate)
        arguments = run.call_args.args[0]
        self.assertIn('_SYSTEMD_INVOCATION_ID=' + invocation, arguments)
        self.assertIn('_SYSTEMD_USER_UNIT=' + installer.UNIT, arguments)
        self.assertIn('_UID=721', arguments)
        self.assertIn('_PID=4321', arguments)

    def test_rejects_stale_or_misdirected_sign_in_output(self):
        candidate = 'yharness web: http://127.0.0.1:3080/?token=' + 'b' * 43
        with (
            patch.object(installer, 'live_invocation', return_value=('a' * 32, '4321')),
            patch.object(installer, 'command', return_value=candidate),
        ):
            with self.assertRaises(installer.AccountError):
                installer.launch_url(721, 3180)
        with (
            patch.object(installer, 'live_invocation', side_effect=[('a' * 32, '4321'), ('b' * 32, '4322')]),
            patch.object(installer, 'command', return_value=candidate),
        ):
            with self.assertRaises(installer.AccountError):
                installer.launch_url(721, 3080)

    def test_installer_refuses_to_replace_an_existing_unrelated_unit(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'yharness-cloud.service'
            path.write_bytes(b'administrator settings')
            with self.assertRaises(installer.AccountError):
                installer.install_unit(path, b'new unit')
            self.assertEqual(path.read_bytes(), b'administrator settings')

    def test_existing_account_with_unexpected_group_is_rejected(self):
        account = SimpleNamespace(pw_uid=721, pw_gid=721, pw_name=installer.ACCOUNT, pw_dir=str(installer.HOME),
                                  pw_shell='/usr/sbin/nologin')
        with (
            patch.object(installer.pwd, 'getpwnam', return_value=account),
            patch.object(installer.grp, 'getgrnam', return_value=SimpleNamespace(gr_gid=721)),
            patch.object(installer.os, 'getgrouplist', return_value=[721, 27]),
            patch.object(installer.subprocess, 'run') as run,
        ):
            run.return_value = subprocess.CompletedProcess([], 0)
            with self.assertRaises(installer.AccountError):
                installer.ensure_account()
            run.assert_not_called()

    def test_install_prepares_the_container_image_inside_the_cloud_user_manager(self):
        account = SimpleNamespace(pw_uid=721)
        node = pathlib.Path('/opt/node/bin/node')
        release = pathlib.Path('/opt/yharness/release')
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(installer, 'UNIT_PATH', pathlib.Path(directory) / installer.UNIT),
            patch.object(installer, 'trusted_path', side_effect=lambda path: path),
            patch.object(pathlib.Path, 'is_file', return_value=True),
            patch.object(installer, 'check_executable'),
            patch.object(installer, 'ensure_account', return_value=account),
            patch.object(installer, 'command') as run,
            patch.object(installer.os, 'chdir'),
            patch.object(installer, 'start_cloud'),
        ):
            installer.install(node, release, 3180)
        preparation = next(call for call in run.call_args_list if '--prepare-image' in call.args[0])
        arguments = preparation.args[0]
        launcher = arguments.index('/usr/bin/systemd-run')
        entry = arguments.index('/usr/bin/python3')
        self.assertIn('--user', arguments[launcher:entry])
        self.assertIn('--wait', arguments[launcher:entry])
        self.assertIn('--collect', arguments[launcher:entry])
        self.assertIn('--property=RuntimeMaxSec=890s', arguments[launcher:entry])
        self.assertIn('/usr/bin/env', arguments[launcher:entry])
        self.assertIn('-i', arguments[launcher:entry])
        self.assertIn('HOME=' + str(installer.HOME), arguments[launcher:entry])
        self.assertIn('XDG_RUNTIME_DIR=/run/user/721', arguments[launcher:entry])
        self.assertEqual(arguments[entry:], [
            '/usr/bin/python3', '-I', str(release / 'scripts/setup-vps-account.py'),
            'check-runtime', '--node', str(node), '--release', str(release), '--prepare-image',
        ])

    def test_owner_link_units_pin_local_socket_identity_and_trusted_worker(self):
        directory = pathlib.Path('/opt/yharness/release')
        units = installer.owner_link_units(1001, 721, directory)
        listener = units[installer.LINK_SOCKET_UNIT].decode()
        self.assertIn('ListenStream=/run/yharness-cloud-link.sock', listener)
        self.assertIn('SocketUser=1001', listener)
        self.assertIn('SocketMode=0600', listener)
        self.assertIn('Accept=yes', listener)
        worker = units[installer.LINK_WORKER_UNIT].decode()
        self.assertIn('StandardInput=socket', worker)
        self.assertIn('StandardOutput=null', worker)
        self.assertIn('RestrictAddressFamilies=AF_UNIX', worker)
        self.assertIn('"/opt/yharness/release/scripts/setup-vps-account.py" link-worker --owner-uid 1001 --cloud-uid 721', worker)
        for owner in (0, 721):
            with self.assertRaises(installer.AccountError):
                installer.owner_link_units(owner, 721, directory)

    def test_privileged_status_commands_do_not_inherit_connection_input(self):
        with patch.object(installer.subprocess, 'run') as run:
            run.return_value = subprocess.CompletedProcess([], 0, stdout='ready')
            self.assertEqual(installer.command(['systemctl', 'show'], 'could not check status'), 'ready')
            self.assertEqual(run.call_args.kwargs['stdin'], subprocess.DEVNULL)

    def test_only_the_owner_peer_receives_a_live_launch_link(self):
        connection = Mock()
        link = 'http://127.0.0.1:3080/?token=' + 'b' * 43
        with (
            patch.object(installer, 'link_peer_uid', return_value=1002) as peer,
            patch.object(installer, 'launch_url', return_value=link) as get_link,
        ):
            with self.assertRaises(installer.AccountError):
                installer.send_owner_link(connection, 1001, 721)
            get_link.assert_not_called()
            connection.sendall.assert_not_called()
            peer.return_value = 1001
            installer.send_owner_link(connection, 1001, 721)
            get_link.assert_called_once_with(721, 3080, through_local_bus=True)
            connection.sendall.assert_called_once_with((link + '\n').encode('ascii'))

    @unittest.skipIf(os.geteuid() == 0, 'the launch helper is installed as the unprivileged owner')
    def test_install_link_client_refuses_to_replace_the_legacy_helper(self):
        with tempfile.TemporaryDirectory() as directory:
            home = pathlib.Path(directory)
            release = home / 'release'
            (release / 'scripts').mkdir(parents=True)
            (release / 'scripts' / 'vps-cloud-link.py').write_bytes(b'# client\n')
            with patch.object(installer.pwd, 'getpwuid', return_value=SimpleNamespace(pw_dir=str(home))):
                installer.install_owner_link_client(release)
                path = home / '.local/bin/yharness-vps'
                self.assertEqual(path.read_bytes(), b'# client\n')
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)
                inode = path.stat().st_ino
                installer.install_owner_link_client(release)
                self.assertEqual(path.stat().st_ino, inode)
                path.write_bytes(b'legacy workspace\n')
                with self.assertRaises(installer.AccountError):
                    installer.install_owner_link_client(release)
                self.assertEqual(path.read_bytes(), b'legacy workspace\n')

    def test_owner_link_setup_validates_all_units_before_writing_a_helper(self):
        owner = SimpleNamespace(pw_uid=1001, pw_name='cloud-owner')
        release = pathlib.Path('/opt/yharness/release')
        with tempfile.TemporaryDirectory() as directory, patch.object(installer, 'command') as run:
            root = pathlib.Path(directory)
            with patch.object(installer, 'SYSTEM_UNIT_DIRECTORY', root):
                (root / installer.LINK_WORKER_UNIT).write_bytes(b'site administrator config')
                with self.assertRaises(installer.AccountError):
                    installer.prepare_owner_link(owner, 721, release)
                run.assert_not_called()
                self.assertFalse((root / installer.LINK_SOCKET_UNIT).exists())

    def test_native_owner_setup_uses_the_app_port(self):
        with (
            patch.object(installer, 'trusted_path', side_effect=pathlib.Path),
            patch.object(installer, 'check_executable'),
        ):
            with self.assertRaisesRegex(installer.AccountError, '3080'):
                installer.install('/opt/node/bin/node', '/opt/yharness/release', 3180, ssh_owner='cloud-owner')

    def test_owner_socket_starts_only_after_cloud_can_authenticate(self):
        owner = SimpleNamespace(pw_uid=1001, pw_name='cloud-owner')
        cloud = SimpleNamespace(pw_uid=721)
        node = pathlib.Path('/opt/node/bin/node')
        release = pathlib.Path('/opt/yharness/release')
        calls = []
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(installer, 'UNIT_PATH', pathlib.Path(directory) / installer.UNIT),
            patch.object(installer, 'trusted_path', side_effect=pathlib.Path),
            patch.object(pathlib.Path, 'is_file', return_value=True),
            patch.object(installer, 'check_executable'),
            patch.object(installer, 'ensure_account', return_value=cloud),
            patch.object(installer.pwd, 'getpwnam', return_value=owner),
            patch.object(installer, 'prepare_owner_link', side_effect=lambda *_: calls.append('prepare link')) as prepare,
            patch.object(installer, 'command'),
            patch.object(installer, 'prepare_cloud_runtime'),
            patch.object(installer.os, 'chdir'),
            patch.object(installer, 'start_cloud', side_effect=lambda *_: calls.append('Cloud ready')),
            patch.object(installer, 'start_owner_link', side_effect=lambda: calls.append('listen for owner')),
        ):
            installer.install(node, release, 3080, ssh_owner='cloud-owner')
        self.assertEqual(calls, ['prepare link', 'Cloud ready', 'listen for owner'])
        prepare.assert_called_once_with(owner, 721, release)

    def test_launch_helper_accepts_only_a_bounded_loopback_link(self):
        path = pathlib.Path(__file__).with_name('vps-cloud-link.py')
        spec = importlib.util.spec_from_file_location('vps_cloud_link', path)
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        link = b'http://127.0.0.1:3080/?token=' + b'b' * 43 + b'\n'
        with patch.object(helper.socket, 'socket') as make_connection:
            connection = make_connection.return_value.__enter__.return_value
            read = connection.makefile.return_value.__enter__.return_value.readline
            read.return_value = link
            self.assertEqual(helper.owner_link('/run/test-cloud-link.sock'), link)
            connection.connect.assert_called_once_with('/run/test-cloud-link.sock')
            read.assert_called_once_with(128)
            for value in (b'', link.replace(b'3080', b'3180'), link + b'more', link.replace(b'token=', b'other=')):
                with self.subTest(value=value), self.assertRaises(ValueError):
                    read.return_value = value
                    helper.owner_link('/run/test-cloud-link.sock')

    def test_enables_the_service_after_the_current_process_is_ready(self):
        calls = []
        with (
            patch.object(installer, 'command', side_effect=lambda args, *_a, **_kw: calls.append(args[-3:]) or 'inactive'),
            patch.object(installer, 'assert_port_free', side_effect=lambda _port: calls.append('check port')),
            patch.object(installer, 'wait_for_web', side_effect=lambda _uid, _port: calls.append('ready')),
        ):
            installer.start_cloud(721, 3180)
        self.assertEqual(calls[1:], [
            'check port',
            ['start', '--', installer.UNIT],
            'ready',
            ['enable', '--', installer.UNIT],
        ])

    def test_stops_a_new_service_that_cannot_start(self):
        with (
            patch.object(installer, 'command', return_value='inactive') as run,
            patch.object(installer, 'assert_port_free'),
            patch.object(installer, 'wait_for_web', side_effect=installer.AccountError('not ready')),
        ):
            with self.assertRaisesRegex(installer.AccountError, 'not ready'):
                installer.start_cloud(721, 3180)
        self.assertEqual(run.call_args.args[0][-3:], ['stop', '--', installer.UNIT])
        self.assertFalse(any('enable' in call.args[0] for call in run.call_args_list))

    def test_interrupted_first_start_is_stopped(self):
        with (
            patch.object(installer, 'command', return_value='inactive') as run,
            patch.object(installer, 'assert_port_free'),
            patch.object(installer, 'wait_for_web', side_effect=KeyboardInterrupt),
        ):
            with self.assertRaises(KeyboardInterrupt):
                installer.start_cloud(721, 3180)
        self.assertEqual(run.call_args.args[0][-3:], ['stop', '--', installer.UNIT])


if __name__ == '__main__':
    unittest.main()
