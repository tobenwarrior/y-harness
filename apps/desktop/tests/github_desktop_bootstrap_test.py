import fcntl
import importlib.util
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'github-desktop-bootstrap.py'
spec = importlib.util.spec_from_file_location('github_desktop_bootstrap', SCRIPT)
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.support = Path(self.temp.name).resolve()
        self.fallback = self.support / 'bootstrap/github-desktop-supervisor.py'
        self.fallback.parent.mkdir()
        self.fallback.write_text('fallback')
        self.fallback.with_name('github-source-updater.py').write_text('engine')
        self.fallback.with_name('development_owner.py').write_text('owner')
        self.managed = self.support / 'managed'
        self.managed.mkdir()

    def test_initial_launch_uses_installed_supervisor(self):
        self.assertEqual(bootstrap.select_supervisor(self.support), self.fallback)

    def test_updated_supervisor_is_selected_from_current_version(self):
        commit = 'a' * 40
        source = self.managed / 'versions' / commit / 'apps/desktop/scripts/github-desktop-supervisor.py'
        source.parent.mkdir(parents=True)
        source.write_text('updated')
        source.with_name('github-source-updater.py').write_text('engine')
        (self.managed / 'current').symlink_to('versions/' + commit)
        seen = []
        self.assertEqual(bootstrap.select_supervisor(self.support, validate=lambda root, value: seen.append((root, value))), source)
        self.assertEqual(seen, [(self.managed, commit)])

    def test_untrusted_current_and_symlinked_source_are_rejected(self):
        current = self.managed / 'current'
        current.symlink_to('/tmp/elsewhere')
        with self.assertRaises(ValueError):
            bootstrap.select_supervisor(self.support)
        current.unlink()
        commit = 'b' * 40
        source = self.managed / 'versions' / commit / 'apps/desktop/scripts/github-desktop-supervisor.py'
        source.parent.mkdir(parents=True)
        source.symlink_to(self.fallback)
        current.symlink_to('versions/' + commit)
        with self.assertRaises(ValueError):
            bootstrap.select_supervisor(self.support)
    def test_refuses_an_unverified_version_before_running_it(self):
        commit = "c" * 40
        source = self.managed / "versions" / commit / "apps/desktop/scripts/github-desktop-supervisor.py"
        source.parent.mkdir(parents=True)
        source.write_text("updated")
        source.with_name("github-source-updater.py").write_text("engine")
        (self.managed / "current").symlink_to("versions/" + commit)
        def reject(root, value):
            raise RuntimeError("unverified")
        with self.assertRaisesRegex(RuntimeError, "unverified"):
            bootstrap.select_supervisor(self.support, validate=reject)
    def test_active_supervisor_uses_stable_bootstrap_without_waiting_for_update_lock(self):
        commit = "d" * 40
        source = self.managed / "versions" / commit / "apps/desktop/scripts/github-desktop-supervisor.py"
        source.parent.mkdir(parents=True)
        source.write_text("updated")
        source.with_name("github-source-updater.py").write_text("engine")
        (self.managed / "current").symlink_to("versions/" + commit)
        with (self.support / ".supervisor.lock").open("w") as lock:
            (self.support / ".supervisor.lock").chmod(0o600)
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(bootstrap.select_supervisor(self.support), self.fallback)


if __name__ == '__main__':
    unittest.main()
