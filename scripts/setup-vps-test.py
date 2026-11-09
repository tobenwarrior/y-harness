"""Exercise the installer without installing a service on the test machine."""

import importlib.util
import io
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('setup_vps', Path(__file__).with_name('setup-vps.py'))
assert SPEC is not None and SPEC.loader is not None
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class SetupVpsTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.home = Path(directory.name)
        self.root = self.home / '.yharness-vps'
        self.unit_dir = self.home / '.config' / 'systemd' / 'user'

    def test_service_uses_the_private_workspace_and_loopback_web_profile(self):
        unit = installer.service_unit(Path('/opt/node/bin/node'))
        self.assertIn('WorkingDirectory=%h/.yharness-vps/workspace', unit)
        self.assertIn('Environment="YH_HOME=%h/.yharness-vps/state"', unit)
        self.assertIn('--profile web --no-open --host 127.0.0.1 --port 3080', unit)
        self.assertIn('StandardOutput=truncate:%h/.yharness-vps/host.log', unit)
        self.assertIn('Restart=on-failure', unit)
        self.assertIn('UMask=0077', unit)

    def test_refuses_to_create_private_state_under_a_git_checkout(self):
        subprocess.run(['git', 'init', '-q', str(self.home)], check=True)
        with self.assertRaisesRegex(installer.SetupError, 'outside a Git checkout'):
            installer.require_outside_git(self.root)
        self.assertFalse(self.root.exists())

    def test_rejects_private_directory_symlink(self):
        target = self.home / 'elsewhere'
        target.mkdir(mode=0o700)
        self.root.symlink_to(target)
        with self.assertRaisesRegex(installer.SetupError, 'private directory'):
            installer.private_directory(self.root)

    def test_url_reads_only_the_loopback_link_from_a_private_log(self):
        private = self.home / 'host.log'
        token = 'a' * 43
        private.write_text(
            f'yharness web: http://example.invalid:3080/?token={token}\n'
            f'yharness web: http://127.0.0.1:3080/?token={token} (fixture)\n'
        )
        private.chmod(0o600)
        self.assertEqual(installer.launch_url(private), f'http://127.0.0.1:3080/?token={token}')
        private.chmod(0o644)
        with self.assertRaisesRegex(installer.SetupError, 'private'):
            installer.launch_url(private)

    def test_build_uses_public_source_without_inheriting_secrets(self):
        self.root.mkdir(mode=0o700)

        def fake_command(args, **options):
            self.assertNotIn('DEEPSEEK_API_KEY', options['env'])
            self.assertNotIn('SSH_AUTH_SOCK', options['env'])
            self.assertEqual(options['env']['GIT_CONFIG_GLOBAL'], '/dev/null')
            self.assertEqual(options['env']['NPM_CONFIG_USERCONFIG'], '/dev/null')
            if args[0] == 'git':
                self.assertEqual(args[-2], 'https://github.com/tobenwarrior/y-harness.git')
                checkout = Path(args[-1])
                checkout.mkdir()
                (checkout / 'package.json').write_text('{"packageManager":"pnpm@11.25.0"}')
            elif args[-1] == 'build':
                cli = options['cwd'] / installer.CLI
                cli.parent.mkdir(parents=True)
                cli.touch()

        with (
            patch.dict(os.environ, {'DEEPSEEK_API_KEY': 'fixture-private', 'SSH_AUTH_SOCK': 'fixture-private'}),
            patch.object(installer.shutil, 'which', return_value='/usr/bin/fixture'),
            patch.object(installer, 'run', side_effect=fake_command),
        ):
            installer.build_source(self.root)
        self.assertTrue((self.root / 'source' / installer.CLI).is_file())
        self.assertEqual((self.root / 'build.log').stat().st_mode & 0o777, 0o600)

    def test_setup_enables_service_without_restarting_an_existing_install(self):
        self.root.mkdir(mode=0o700)
        source = self.root / 'source'
        (source / 'apps/cli/lib').mkdir(parents=True)
        (source / 'apps/cli/lib/bin.js').touch()
        with (
            patch.object(installer, 'require_linux_user'),
            patch.object(installer, 'node_executable', return_value=Path('/opt/node/bin/node')),
            patch.object(installer, 'run') as command,
            patch.object(installer, 'build_source') as build,
            patch('sys.stdout', new_callable=io.StringIO),
        ):
            command.return_value.stdout = 'yes\n'
            installer.setup(self.root, self.unit_dir)
        build.assert_not_called()
        self.assertTrue((self.unit_dir / installer.SERVICE).is_file())
        self.assertEqual((self.unit_dir / installer.SERVICE).stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.root / 'state').stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.root / 'host.log').stat().st_mode & 0o777, 0o600)
        self.assertIn(['systemctl', '--user', 'enable', '--now', installer.SERVICE], [call.args[0] for call in command.call_args_list])
        self.assertFalse(any('restart' in call.args[0] for call in command.call_args_list))


if __name__ == '__main__':
    unittest.main()
