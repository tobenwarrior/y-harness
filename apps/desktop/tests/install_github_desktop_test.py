import importlib.util
import fcntl
import json
import os
import plistlib
from pathlib import Path
import subprocess
import sys
import threading
import time
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "install-github-desktop.py"
spec = importlib.util.spec_from_file_location("github_installer", SCRIPT)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.home = self.root / 'home "quote" \\ slash'
        self.home.mkdir()
        self.source = self.root / "updater.py"
        self.source.write_text("updater contents")
        self.supervisor = self.root / "github-desktop-supervisor.py"
        self.supervisor.write_text("supervisor contents")
        self.bootstrap = self.root / "github-desktop-bootstrap.py"
        self.bootstrap.write_text("bootstrap contents")
        self.owner = self.root / "development_owner.py"
        self.owner.write_text("owner contents")
        self.node = self.root / "node"
        self.pnpm = self.root / "pnpm"
        for tool in (self.node, self.pnpm):
            tool.write_text("tool")
            tool.chmod(0o700)
        self.calls = []
        self.registration_calls = []
        self.sign_calls = []

    def compile(self, args, check):
        self.calls.append((args, check))
        app = Path(args[args.index("-o") + 1])
        (app / "Contents" / "MacOS").mkdir(parents=True)
        (app / "Contents" / "Info.plist").write_bytes(plistlib.dumps({"CFBundleName": "Y Harness"}))
        executable = app / "Contents" / "MacOS" / "applet"
        executable.write_text("launcher")
        executable.chmod(0o700)

    def sign(self, app):
        self.sign_calls.append(Path(app))

    def register(self, args, check, **kwargs):
        self.registration_calls.append((args, check, kwargs))

    def test_install_and_safe_applescript_arguments(self):
        app = installer.install(self.home, self.source, self.compile, resolve_tool=self.which)
        updater = self.home / "Library/Application Support/Y Harness GitHub/bootstrap/github-source-updater.py"
        self.assertEqual(updater.read_text(), "updater contents")
        supervisor = updater.with_name("github-desktop-supervisor.py")
        self.assertEqual(supervisor.read_text(), "supervisor contents")
        bootstrap = updater.with_name("github-desktop-bootstrap.py")
        self.assertEqual(bootstrap.read_text(), "bootstrap contents")
        self.assertEqual(updater.with_name("development_owner.py").read_text(), "owner contents")
        config = json.loads(updater.with_name("runtime.json").read_text())
        self.assertEqual(config, {"schemaVersion": 1, "node": str(self.node), "pnpm": str(self.pnpm)})
        self.assertEqual(updater.stat().st_mode & 0o777, 0o600)
        self.assertEqual(updater.parent.stat().st_mode & 0o777, 0o700)
        self.assertTrue((app / "Contents/Info.plist").is_file())
        values = plistlib.loads((app / "Contents/Info.plist").read_bytes())
        self.assertEqual(values["CFBundleURLTypes"], [{
            "CFBundleTypeRole": "Viewer",
            "CFBundleURLName": "Y Harness",
            "CFBundleURLSchemes": ["dsh"],
        }])
        args, check = self.calls[0]
        self.assertTrue(check)
        self.assertEqual(args[0], "/usr/bin/osacompile")
        script = args[args.index("-e") + 1]
        self.assertIn(installer.applescript_string(str(bootstrap)), script)
        self.assertIn('"--start"', script)
        self.assertIn("GURLGURL", script)
        self.assertIn('"--open-url"', script)
        self.assertIn("NSTask", script)
        self.assertNotIn("do shell script", script)

    def test_registers_stable_wrapper_with_launch_services_on_macos(self):
        with mock.patch.object(installer.sys, "platform", "darwin"):
            installer.install(self.home, self.source, self.compile, resolve_tool=self.which, register=self.register)
        self.assertEqual(self.registration_calls, [([
            installer.LSREGISTER, "-f", str(self.home / "Applications/Y Harness GitHub.app")
        ], False, {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL})])

    def test_collisions_include_dangling_symlinks(self):
        for relative in ("Applications/Y Harness GitHub.app", "Library/Application Support/Y Harness GitHub"):
            with self.subTest(relative=relative), tempfile.TemporaryDirectory() as tmp:
                home = Path(tmp)
                path = home / relative
                path.parent.mkdir(parents=True)
                path.symlink_to(home / "missing")
                with self.assertRaises(FileExistsError):
                    installer.install(home, self.source, self.compile, resolve_tool=self.which)
                self.assertTrue(path.is_symlink())
                self.assertFalse(self.calls)

    def test_existing_launcher_is_never_replaced(self):
        app = self.home / "Applications/Y Harness GitHub.app"
        app.mkdir(parents=True)
        marker = app / "Contents"
        marker.write_text("installed launcher")
        with self.assertRaises(FileExistsError):
            installer.install(self.home, self.source, self.compile, resolve_tool=self.which)
        self.assertEqual(marker.read_text(), "installed launcher")
        self.assertFalse(self.calls)

    def test_upgrade_replaces_only_launcher_and_bootstrap(self):
        app = installer.install(self.home, self.source, self.compile, resolve_tool=self.which)
        support = self.home / "Library/Application Support/Y Harness GitHub"
        data = support / "data"
        managed = support / "managed"
        data.mkdir()
        managed.mkdir()
        (data / "profile").write_text("keep profile")
        (managed / "current").write_text("keep versions")
        runtime = (support / "bootstrap" / "runtime.json").read_bytes()
        result = installer.upgrade_existing(
            self.home, self.source, self.compile, register=self.register, sign=self.sign)
        self.assertEqual(result, app)
        self.assertEqual((data / "profile").read_text(), "keep profile")
        self.assertEqual((managed / "current").read_text(), "keep versions")
        self.assertEqual((support / "bootstrap" / "runtime.json").read_bytes(), runtime)
        self.assertTrue(self.sign_calls)
        self.assertEqual(app.stat().st_mode & 0o777, 0o700)
        values = plistlib.loads((app / "Contents/Info.plist").read_bytes())
        self.assertEqual(values["CFBundleURLTypes"][0]["CFBundleURLSchemes"], ["dsh"])
        self.assertTrue(any(path.name.startswith(".launcher-backup-") for path in support.iterdir()))
        self.assertTrue(any(path.name.startswith(".bootstrap-backup-") for path in support.iterdir()))
        self.assertEqual(self.registration_calls[-1][0][-2:], ["-f", str(app)])
        upgrade_script = self.calls[-1][0][self.calls[-1][0].index("-e") + 1]
        self.assertIn('bootstrap/github-desktop-bootstrap.py"', upgrade_script)
        self.assertNotIn(".bootstrap-upgrade-", upgrade_script)
        installer.upgrade_existing(
            self.home, self.source, self.compile, register=self.register, sign=self.sign)
        self.assertEqual((data / "profile").read_text(), "keep profile")
        self.assertEqual((managed / "current").read_text(), "keep versions")

    def test_upgrade_refuses_a_running_managed_supervisor(self):
        installer.install(self.home, self.source, self.compile, resolve_tool=self.which)
        support = self.home / "Library/Application Support/Y Harness GitHub"
        lock = support / ".supervisor.lock"
        lock.touch(mode=0o600)
        fd = os.open(lock, os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(RuntimeError, "quit Y Harness"):
                installer.upgrade_existing(self.home, self.source, self.compile, sign=self.sign)
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)
        self.assertFalse(self.sign_calls)
        self.assertFalse(any(path.name.startswith(".bootstrap-upgrade-") for path in support.iterdir()))

    def test_parent_symlink_and_source_symlink_are_rejected(self):
        (self.home / "Applications").symlink_to(self.root)
        with self.assertRaises(ValueError):
            installer.install(self.home, self.source, self.compile, resolve_tool=self.which)
        self.assertFalse((self.root / "Y Harness GitHub.app").exists())
        (self.home / "Applications").unlink()
        link = self.root / "source-link"
        link.symlink_to(self.source)
        with self.assertRaises(ValueError):
            installer.install(self.home, link, self.compile, resolve_tool=self.which)

    def test_compilation_failure_does_not_remove_bootstrap(self):
        def fail(args, check):
            raise subprocess.CalledProcessError(1, args)
        with self.assertRaises(subprocess.CalledProcessError):
            installer.install(self.home, self.source, fail, resolve_tool=self.which)
        self.assertTrue((self.home / "Library/Application Support/Y Harness GitHub/bootstrap/github-source-updater.py").is_file())
        self.assertFalse((self.home / "Applications/Y Harness GitHub.app").exists())

    def test_rejects_control_characters(self):
        with self.assertRaises(ValueError):
            installer.launcher_source("/bad\npath")

    def which(self, name):
        return str({"node": self.node, "pnpm": self.pnpm}[name])
    def test_missing_runtime_is_rejected_before_any_installation(self):
        with self.assertRaisesRegex(ValueError, "node executable is required"):
            installer.install(self.home, self.source, self.compile, resolve_tool=lambda name: None)
        self.assertFalse((self.home / "Applications").exists())
        self.assertFalse((self.home / "Library").exists())
    @unittest.skipUnless(sys.platform == "darwin", "AppleScript compiler is macOS-only")
    def test_generated_applescript_compiles(self):
        result = subprocess.run(["/usr/bin/osacompile", "-o", str(self.root / "probe.app"),
                                 "-e", installer.launcher_source(self.supervisor)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
    @unittest.skipUnless(sys.platform == "darwin", "AppleScript runtime is macOS-only")
    def test_generated_launcher_starts_supervisor_without_a_shell(self):
        marker = self.root / "started"
        helper = self.home / "helper.py"
        helper.write_text("from pathlib import Path\nimport sys\nPath(" + repr(str(marker)) + ").write_text(sys.argv[1])\n")
        result = subprocess.run(["/usr/bin/osascript", "-e", installer.launcher_source(helper)],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        deadline = time.monotonic() + 10
        while not marker.exists() and time.monotonic() < deadline:
            threading.Event().wait(0.05)
        self.assertTrue(marker.exists(), "AppleScript did not start its child")
        self.assertEqual(marker.read_text(), "--start")
    @unittest.skipUnless(sys.platform == "darwin", "AppleScript compiler is macOS-only")
    def test_real_installer_builds_a_separate_app_bundle(self):
        app = installer.install(self.home, self.source, resolve_tool=self.which, register=self.register)
        self.assertTrue((app / "Contents/Info.plist").is_file())
        self.assertTrue((app / "Contents/MacOS/applet").is_file())
        verified = subprocess.run(
            [installer.CODESIGN, "--verify", "--deep", "--strict", str(app)],
            capture_output=True, text=True)
        self.assertEqual(verified.returncode, 0, verified.stderr)

    @unittest.skipUnless(sys.platform == "darwin", "AppleScript compiler is macOS-only")
    def test_real_upgrade_signs_an_existing_launcher_bundle(self):
        app = installer.install(self.home, self.source, resolve_tool=self.which, register=self.register)
        result = installer.upgrade_existing(self.home, self.source, register=self.register)
        self.assertEqual(result, app)
        verified = subprocess.run(
            [installer.CODESIGN, "--verify", "--deep", "--strict", str(app)],
            capture_output=True, text=True)
        self.assertEqual(verified.returncode, 0, verified.stderr)
        self.assertEqual(app.stat().st_mode & 0o777, 0o700)
    @unittest.skipUnless(sys.platform == "darwin", "AppleScript compiler is macOS-only")
    def test_documented_command_installs_into_an_isolated_home(self):
        home = self.root / "isolated-home"
        home.mkdir()
        environment = {**os.environ, "HOME": str(home), "PATH": str(self.root) + os.pathsep + "/usr/bin:/bin"}
        result = subprocess.run([sys.executable, str(SCRIPT)], env=environment, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Installed", result.stdout)
        self.assertTrue((home / "Applications/Y Harness GitHub.app/Contents/Info.plist").is_file())


if __name__ == "__main__":
    unittest.main()
