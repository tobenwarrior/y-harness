"""Exercise the installer without installing a service on the test machine."""

import importlib.util
import io
import os
import shutil
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
        distribution = patch.object(installer, 'ubuntu_2404', return_value=False, create=True)
        self.addCleanup(distribution.stop)
        distribution.start()

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

        sandboxed = []

        def sandbox(root, checkout, node):
            self.assertEqual(root, self.root)
            self.assertEqual(node, Path('/opt/node/bin/node'))
            self.assertFalse((root / 'source').exists())
            self.assertTrue((checkout / installer.CLI).is_file())
            sandboxed.append(checkout)

        with (
            patch.object(installer, 'ensure_sandbox', side_effect=sandbox, create=True),
            patch.dict(os.environ, {'DEEPSEEK_API_KEY': 'fixture-private', 'SSH_AUTH_SOCK': 'fixture-private'}),
            patch.object(installer.shutil, 'which', return_value='/usr/bin/fixture'),
            patch.object(installer, 'run', side_effect=fake_command),
        ):
            installer.build_source(self.root, Path('/opt/node/bin/node'))
        self.assertEqual(len(sandboxed), 1)
        self.assertTrue((self.root / 'source' / installer.CLI).is_file())
        self.assertEqual((self.root / 'build.log').stat().st_mode & 0o777, 0o600)

    def bubblewrap_install_fixture(self, *, can_start=True, existing_profile=False):
        self.root.mkdir(mode=0o700)
        binary = self.home / 'bwrap'
        profile_dir = self.home / 'apparmor.d'
        profile_dir.mkdir()
        profile = profile_dir / 'bwrap-userns-restrict'
        if existing_profile:
            profile.write_text('administrator profile')
        setting = self.home / 'userns'
        setting.write_text('1\n')
        pending = profile_dir / '.yharness-bwrap.abc123'
        calls = []
        loaded = False

        def command(args, **options):
            nonlocal loaded
            self.assertNotIn('DEEPSEEK_API_KEY', options['env'])
            self.assertNotIn('SSH_AUTH_SOCK', options['env'])
            calls.append(args)
            actual = args[2:] if args[:2] == ['/usr/bin/sudo', '-n'] else args
            name = actual[0]
            if name == str(binary):
                if not (binary.exists() and loaded and can_start):
                    raise subprocess.CalledProcessError(1, args)
            elif actual[-1] == 'bubblewrap':
                self.assertIn('--no-upgrade', actual)
                self.assertIn('--no-remove', actual)
                binary.touch()
            elif actual == ['/usr/bin/apt-get', 'download', 'apparmor-profiles']:
                (Path(options['cwd']) / 'apparmor-profiles_fixture.deb').touch()
            elif name == '/usr/bin/dpkg-deb':
                package_profile = Path(actual[-1]) / 'usr/share/apparmor/extra-profiles/bwrap-userns-restrict'
                package_profile.parent.mkdir(parents=True)
                package_profile.write_text('Ubuntu fixture')
            elif name == '/usr/bin/mktemp':
                pending.touch()
                return subprocess.CompletedProcess(args, 0, str(pending) + '\n')
            elif name == '/usr/bin/install':
                shutil.copyfile(actual[-2], actual[-1])
            elif name == '/usr/bin/ln':
                os.link(actual[-2], actual[-1])
            elif name == '/usr/sbin/apparmor_parser' and actual[1] == '-a':
                self.assertEqual(profile.read_text(), 'Ubuntu fixture')
                loaded = True
            elif name == '/usr/sbin/apparmor_parser' and actual[1] == '-R':
                loaded = False
            elif name == '/usr/bin/rm':
                Path(actual[-1]).unlink()
            return subprocess.CompletedProcess(args, 0, '')

        with (
            patch.dict(os.environ, {'DEEPSEEK_API_KEY': 'fixture-private', 'SSH_AUTH_SOCK': 'fixture-private'}),
            patch.object(installer, 'BUBBLEWRAP_BIN', binary),
            patch.object(installer, 'BUBBLEWRAP_PROFILE', profile),
            patch.object(installer, 'APPARMOR_USERNS', setting),
            patch.object(installer, 'run', side_effect=command),
            patch('sys.stdout', new_callable=io.StringIO),
        ):
            if existing_profile:
                with self.assertRaisesRegex(installer.SetupError, 'administrator review'):
                    installer.ensure_bubblewrap(self.root)
                self.assertEqual(profile.read_text(), 'administrator profile')
            elif can_start:
                installer.ensure_bubblewrap(self.root)
                self.assertEqual(profile.read_text(), 'Ubuntu fixture')
                self.assertTrue(loaded)
                after_install = len(calls)
                installer.ensure_bubblewrap(self.root)
                self.assertEqual(calls[after_install:], [calls[0]])
            else:
                with self.assertRaisesRegex(installer.SetupError, 'Bubblewrap could not start'):
                    installer.ensure_bubblewrap(self.root)
                self.assertFalse(profile.exists())
                self.assertFalse(loaded)
        self.assertFalse(pending.exists())
        self.assertEqual(setting.read_text(), '1\n')
        self.assertFalse(any('install' in call and 'apparmor-profiles' in call for call in calls))
        self.assertEqual((self.root / 'bubblewrap.log').stat().st_mode & 0o777, 0o600)

    def test_fresh_ubuntu_install_loads_the_packaged_profile_and_reuses_it(self):
        self.bubblewrap_install_fixture()

    def test_ubuntu_install_preserves_an_existing_profile(self):
        self.bubblewrap_install_fixture(existing_profile=True)

    def test_failed_bubblewrap_probe_removes_only_the_new_profile(self):
        self.bubblewrap_install_fixture(can_start=False)

    def test_ubuntu_setup_provisions_bubblewrap_before_building(self):
        events = []
        with (
            patch.object(installer, 'ubuntu_2404', return_value=True),
            patch.object(installer, 'require_linux_user'),
            patch.object(installer.sys, 'executable', '/usr/bin/python3'),
            patch.object(installer, 'node_executable', return_value=Path('/opt/node/bin/node')),
            patch.object(installer, 'run') as command,
            patch.object(installer, 'ensure_bubblewrap', create=True, side_effect=lambda _root: events.append('sandbox')),
            patch.object(installer, 'build_source', side_effect=lambda *_args: events.append('build')),
            patch('sys.stdout', new_callable=io.StringIO),
        ):
            command.return_value.stdout = 'yes\n'
            installer.setup(self.root, self.unit_dir)
        self.assertEqual(events, ['sandbox', 'build'])

    def test_ubuntu_startup_reuses_full_bubblewrap_without_provisioning(self):
        self.root.mkdir(mode=0o700)
        source = self.root / 'replacement-source'
        with (
            patch.object(installer, 'ubuntu_2404', return_value=True),
            patch.object(installer, 'sandbox_probe', return_value=('bubblewrap', self.root / 'unused')),
            patch.object(installer, 'run') as command,
            patch.object(installer, 'ensure_bubblewrap', create=True) as provision,
        ):
            installer.ensure_sandbox(self.root, source, Path('/opt/node/bin/node'))
        command.assert_not_called()
        provision.assert_not_called()

    def test_ubuntu_startup_reports_loss_of_bubblewrap_instead_of_falling_back(self):
        self.root.mkdir(mode=0o700)
        with (
            patch.object(installer, 'ubuntu_2404', return_value=True),
            patch.object(installer, 'sandbox_probe', return_value=('other', self.root / 'unused')),
            patch.object(installer, 'run') as command,
        ):
            with self.assertRaisesRegex(installer.SetupError, 'Full Bubblewrap'):
                installer.ensure_sandbox(self.root, self.root / 'source', Path('/opt/node/bin/node'))
        command.assert_not_called()

    def test_setup_enables_service_without_restarting_an_existing_install(self):
        self.root.mkdir(mode=0o700)
        source = self.root / 'source'
        (source / 'apps/cli/lib').mkdir(parents=True)
        (source / 'apps/cli/lib/bin.js').touch()
        with (
            patch.object(installer, 'require_linux_user'),
            patch.object(installer.sys, 'executable', '/usr/bin/python3'),
            patch.object(installer, 'node_executable', return_value=Path('/opt/node/bin/node')),
            patch.object(installer, 'run') as command,
            patch.object(installer, 'build_source') as build,
            patch.object(installer, 'ensure_sandbox', create=True) as sandbox,
            patch('sys.stdout', new_callable=io.StringIO),
        ):
            command.return_value.stdout = 'yes\n'
            installer.setup(self.root, self.unit_dir)
        build.assert_not_called()
        sandbox.assert_called_once_with(self.root, source, Path('/opt/node/bin/node'))
        check = self.unit_dir / (installer.SERVICE + '.d') / 'sandbox.conf'
        self.assertIn('ExecStartPre=', check.read_text())
        self.assertIn('%h/.yharness-vps/sandbox-setup.py" sandbox', check.read_text())
        self.assertEqual((self.root / 'sandbox-setup.py').read_bytes(), Path(installer.__file__).read_bytes())
        self.assertTrue((self.unit_dir / installer.SERVICE).is_file())
        self.assertEqual((self.unit_dir / installer.SERVICE).stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.root / 'state').stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.root / 'host.log').stat().st_mode & 0o777, 0o600)
        self.assertIn(['systemctl', '--user', 'enable', '--now', installer.SERVICE], [call.args[0] for call in command.call_args_list])
        self.assertFalse(any('restart' in call.args[0] for call in command.call_args_list))

    def test_startup_restores_the_missing_runner_in_a_replacement_checkout(self):
        self.root.mkdir(mode=0o700)
        source = self.root / 'source'
        native = source / 'native/system/packages'
        launcher = native / 'linux-x64/bin/landlock-run'
        c_source = native / 'entry/src/main.c'
        c_source.parent.mkdir(parents=True)
        c_source.write_text('/* fixture */')
        node = Path('/opt/node/bin/node')

        def probe(checkout, executable, environment):
            self.assertEqual(checkout, source)
            self.assertEqual(executable, node)
            self.assertNotIn('DEEPSEEK_API_KEY', environment)
            return ('other' if launcher.is_file() else None, launcher)

        def command(args, **options):
            self.assertNotIn('SSH_AUTH_SOCK', options['env'])
            if args[-1] == '--probe':
                self.assertFalse(launcher.exists())
                return
            self.assertEqual(args[0], 'cc')
            self.assertEqual(args[-1], str(c_source.resolve()))
            Path(args[args.index('-o') + 1]).write_text('compiled runner')

        with (
            patch.dict(os.environ, {'DEEPSEEK_API_KEY': 'fixture-private', 'SSH_AUTH_SOCK': 'fixture-private'}),
            patch.object(installer, 'sandbox_probe', side_effect=probe, create=True),
            patch.object(installer, 'run', side_effect=command) as commands,
        ):
            installer.ensure_sandbox(self.root, source, node)
            self.assertEqual(launcher.read_text(), 'compiled runner')
            self.assertTrue(launcher.stat().st_mode & 0o100)
            installer.ensure_sandbox(self.root, source, node)
            self.assertEqual(commands.call_count, 2)

    def test_does_not_publish_an_unusable_runner(self):
        self.root.mkdir(mode=0o700)
        source = self.root / 'source'
        native = source / 'native/system/packages'
        launcher = native / 'linux-arm64/bin/landlock-run'
        c_source = native / 'entry/src/main.c'
        c_source.parent.mkdir(parents=True)
        c_source.write_text('/* fixture */')

        def command(args, **_options):
            if args[-1] == '--probe':
                raise subprocess.CalledProcessError(125, args)
            Path(args[args.index('-o') + 1]).write_text('compiled runner')

        with (
            patch.object(installer, 'sandbox_probe', return_value=(None, launcher)),
            patch.object(installer, 'run', side_effect=command),
        ):
            with self.assertRaisesRegex(installer.SetupError, 'Could not build or run the Linux sandbox'):
                installer.ensure_sandbox(self.root, source, Path('/opt/node/bin/node'))
        self.assertFalse(launcher.exists())


if __name__ == '__main__':
    unittest.main()
