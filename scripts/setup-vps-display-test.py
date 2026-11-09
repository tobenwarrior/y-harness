"""Exercise the private display installer without changing the test machine."""

import importlib.util
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    'setup_vps_display', Path(__file__).with_name('setup-vps-display.py')
)
assert SPEC is not None and SPEC.loader is not None
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class SetupVpsDisplayTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.home = Path(directory.name)
        self.root = self.home / '.yharness-vps'
        self.unit_dir = self.home / '.config' / 'systemd' / 'user'

    def test_display_unit_uses_private_authenticated_1280x800_desktop(self):
        unit = installer.display_unit()
        self.assertIn('Description=Y Harness VPS private virtual display', unit)
        self.assertIn('Before=yharness-vps.service', unit)
        self.assertIn('Environment="YH_VPS_DISPLAY=:99"', unit)
        self.assertIn(
            'Environment="YH_VPS_XAUTHORITY=%h/.yharness-vps/display/Xauthority"', unit
        )
        self.assertIn('Environment="YH_VPS_LAUNCH_XTERM=1"', unit)
        self.assertIn('ExecStart=/usr/bin/python3 "%h/.yharness-vps/display/supervisor.py"', unit)
        self.assertIn('UMask=0077', unit)
        self.assertIn('Restart=on-failure', unit)

    def test_web_dropin_requires_display_and_exposes_private_settings(self):
        dropin = installer.web_dropin()
        self.assertIn('Wants=yharness-vps-display.service', dropin)
        self.assertIn('After=yharness-vps-display.service', dropin)
        self.assertIn('Environment="YH_VPS_DISPLAY=:99"', dropin)
        self.assertIn(
            'Environment="YH_VPS_XAUTHORITY=%h/.yharness-vps/display/Xauthority"', dropin
        )
        self.assertNotIn('Environment="DISPLAY=', dropin)

    def test_supervisor_starts_authenticated_xvfb_openbox_and_safe_terminal(self):
        supervisor = installer.supervisor_source()
        for fragment in (
            "'/usr/bin/Xvfb'",
            "'1280x800x24'",
            "'-nolisten', 'tcp'",
            "'/usr/bin/xauth'",
            "'add', display, '.', cookie",
            "'/usr/bin/openbox'",
            "'/usr/bin/xdotool'",
            "'/usr/bin/scrot'",
            """'/usr/bin/xterm', '-title', 'Y Harness Terminal'""",
            "'Y Harness$ '",
            "'--noprofile', '--norc', '-i'",
        ):
            self.assertIn(fragment, supervisor)
        self.assertNotIn('hostname', supervisor.lower())

    def test_apt_prerequisites_are_explicit_and_do_not_upgrade(self):
        with patch.object(installer, 'run') as command:
            installer.install_packages(with_terminal=True)
        calls = [call.args[0] for call in command.call_args_list]
        self.assertEqual(
            calls,
            [
                ['/usr/bin/sudo', '/usr/bin/apt-get', 'update'],
                [
                    '/usr/bin/sudo',
                    '/usr/bin/apt-get',
                    'install',
                    '--no-install-recommends',
                    '--no-upgrade',
                    '--no-remove',
                    '--yes',
                    'xvfb',
                    'xauth',
                    'openbox',
                    'xdotool',
                    'scrot',
                    'xterm',
                ],
            ],
        )
        arguments = [argument for call in calls for argument in call]
        self.assertNotIn('upgrade', arguments)
        self.assertNotIn('dist-upgrade', arguments)

    def test_apt_prerequisites_omit_optional_terminal_when_disabled(self):
        with patch.object(installer, 'run') as command:
            installer.install_packages(with_terminal=False)
        install = command.call_args_list[1].args[0]
        self.assertNotIn('xterm', install)
        self.assertIn('xvfb', install)

    def test_install_writes_private_files_without_touching_running_host(self):
        self.root.mkdir(mode=0o700)
        host_marker = self.root / 'host.log'
        host_marker.write_text('running host fixture\n')
        host_marker.chmod(0o600)
        with (
            patch.object(installer, 'require_linux_user'),
            patch.object(installer, 'require_outside_git'),
            patch.object(installer, 'install_packages'),
            patch.object(installer, 'run') as command,
        ):
            installer.install(self.root, self.unit_dir, with_terminal=True)
        self.assertEqual(host_marker.read_text(), 'running host fixture\n')
        self.assertEqual((self.root / 'display').stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.root / 'display' / 'supervisor.py').stat().st_mode & 0o777, 0o600)
        service = self.unit_dir / installer.DISPLAY_SERVICE
        dropin = self.unit_dir / installer.WEB_SERVICE_DROPIN
        self.assertEqual(service.stat().st_mode & 0o777, 0o600)
        self.assertEqual(dropin.stat().st_mode & 0o777, 0o600)
        command.assert_not_called()

    def test_install_cleans_new_files_after_partial_write(self):
        self.root.mkdir(mode=0o700)
        original = installer.write_private_text

        def fail_on_dropin(path, content, created):
            if path.name == 'display.conf':
                raise installer.SetupError('fixture write failure')
            return original(path, content, created)

        with (
            patch.object(installer, 'require_linux_user'),
            patch.object(installer, 'require_outside_git'),
            patch.object(installer, 'install_packages'),
            patch.object(installer, 'write_private_text', side_effect=fail_on_dropin),
            self.assertRaisesRegex(installer.SetupError, 'fixture write failure'),
        ):
            installer.install(self.root, self.unit_dir, with_terminal=False)
        self.assertFalse((self.root / 'display' / 'supervisor.py').exists())
        self.assertFalse((self.unit_dir / installer.DISPLAY_SERVICE).exists())
        self.assertFalse((self.unit_dir / installer.WEB_SERVICE_DROPIN).exists())

    def test_install_refuses_mismatched_existing_service_file(self):
        self.root.mkdir(mode=0o700)
        self.unit_dir.mkdir(mode=0o700, parents=True)
        service = self.unit_dir / installer.DISPLAY_SERVICE
        service.write_text('unrelated service\n')
        service.chmod(0o600)
        with (
            patch.object(installer, 'require_linux_user'),
            patch.object(installer, 'require_outside_git'),
            patch.object(installer, 'install_packages'),
            self.assertRaisesRegex(installer.SetupError, 'differs'),
        ):
            installer.install(self.root, self.unit_dir, with_terminal=False)
        self.assertEqual(service.read_text(), 'unrelated service\n')

    def test_install_rejects_git_checkout_before_creating_state(self):
        subprocess.run(['git', 'init', '-q', str(self.home)], check=True)
        with self.assertRaisesRegex(installer.SetupError, 'outside a Git checkout'):
            installer.require_outside_git(self.root)
        self.assertFalse(self.root.exists())

    def test_activate_is_the_only_path_that_restarts_existing_host(self):
        with patch.object(installer, 'run') as command:
            installer.activate()
        self.assertEqual(
            [call.args[0] for call in command.call_args_list],
            [
                ['systemctl', '--user', 'daemon-reload'],
                ['systemctl', '--user', 'enable', '--now', installer.DISPLAY_SERVICE],
                ['systemctl', '--user', 'restart', installer.WEB_SERVICE],
            ],
        )


if __name__ == '__main__':
    unittest.main()
