import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import signal
import tempfile
import threading
import unittest
from unittest import mock

MODULE = Path(__file__).resolve().parents[1] / 'scripts' / 'github-source-updater.py'
spec = importlib.util.spec_from_file_location('github_source_updater', MODULE)
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


def git(*args, cwd=None):
    return subprocess.run(['git', *args], cwd=cwd, check=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, text=True).stdout.strip()


def create_build_artifacts(root):
    paths = [
        'apps/desktop/lib/main.js', 'apps/desktop-host/lib/index.js', 'node_modules/.bin/tsx',
        'apps/desktop/node_modules/pnpm/package.json', 'apps/desktop/node_modules/electron/package.json',
        'apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
        'apps/desktop/.desktop-build/targets/mac-arm64/runtime/primary-runtime/runtime.json',
        'apps/desktop/.desktop-build/targets/mac-x64/runtime/primary-runtime/runtime.json',
    ]
    for relative in paths:
        path = Path(root) / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('{}')


class UpdaterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name).resolve()
        self.repo = base / 'remote'
        self.repo.mkdir()
        git('init', '-b', 'master', cwd=self.repo)
        git('config', 'user.email', 'test@example.invalid', cwd=self.repo)
        git('config', 'user.name', 'Test', cwd=self.repo)
        (self.repo / 'file').write_text('one')
        git('add', 'file', cwd=self.repo)
        git('commit', '-m', 'one', cwd=self.repo)
        self.root = base / 'managed'
        self.calls = []
        self.fail_command = None
        self.incomplete = False
        self.escape_artifact = False
        def runner(argv, cwd, timeout):
            self.calls.append(argv[:])
            if argv[0] == self.fail_command:
                raise subprocess.TimeoutExpired(argv, timeout)
            if argv[0] in ('install-test', 'build-test'):
                if argv[0] == 'build-test' and not self.incomplete:
                    create_build_artifacts(cwd)
                    if self.escape_artifact:
                        artifact = Path(cwd) / "apps/desktop/lib/main.js"
                        artifact.unlink()
                        artifact.symlink_to(self.root.parent / "foreign.js")
                return ''
            argv = [str(self.repo) if x == updater.DEFAULT_REPO else x for x in argv]
            return updater._run(argv, cwd, timeout)
        self.u = updater.SourceUpdater(self.root, install=['install-test'], build=['build-test'], runner=runner)
        self.u.bootstrap()

    def test_stage_activate_and_reuse(self):
        commit = self.u.check()
        version = self.u.stage(commit)
        self.assertEqual(json.loads((self.root / 'update-status.json').read_text()), {'phase': 'ready', 'commit': commit})
        with self.assertRaises(ValueError):
            self.u.activate(commit)
        with self.u.run_guard():
            with self.assertRaises(RuntimeError):
                self.u.activate(commit, between_runs=True)
        self.u.activate(commit, between_runs=True)
        self.assertEqual((self.root / 'current').resolve(), version)
        self.assertEqual(json.loads((self.root / 'update-status.json').read_text())['phase'], 'active')
        self.u.stage(commit)
        self.assertEqual(sum(c[0] == 'install-test' for c in self.calls), 1)

    def test_failures_preserve_current_and_partial(self):
        first = self.u.check()
        self.u.stage(first)
        self.u.activate(first, between_runs=True)
        (self.repo / 'file').write_text('two')
        git('commit', '-am', 'two', cwd=self.repo)
        second = self.u.check()
        self.fail_command = 'build-test'
        with self.assertRaises(subprocess.TimeoutExpired):
            self.u.stage(second)
        self.assertEqual(os.readlink(self.root / 'current'), 'versions/' + first)
        self.assertTrue(any((self.root / 'staging').iterdir()))
        self.assertEqual(json.loads((self.root / 'update-status.json').read_text())['commit'], first)

    def test_corrupt_and_dirty_versions_rejected(self):
        commit = self.u.check()
        path = self.u.stage(commit)
        (path / 'file').write_text('dirty')
        with self.assertRaises(RuntimeError):
            self.u.activate(commit, between_runs=True)
        (path / '.updater-ready').unlink()
        with self.assertRaises(RuntimeError):
            self.u.stage(commit)
        self.assertFalse((self.root / 'current').exists())

    def test_input_and_root_validation(self):
        for repo in ('http://github.com/a/b', 'https://github.com/a/b?x=1', 'https://github.com/a/../b'):
            with self.assertRaises(ValueError):
                updater.SourceUpdater(self.root, repo=repo)
        for branch in ('-bad', 'x..y', 'x.lock', 'a;touch'):
            with self.assertRaises(ValueError):
                updater.SourceUpdater(self.root, branch=branch)
        with self.assertRaises(ValueError):
            self.u.stage('HEAD')
        with self.assertRaises(ValueError):
            updater.SourceUpdater(self.repo / 'managed').bootstrap()
        occupied = self.root.parent / 'occupied'
        occupied.mkdir()
        (occupied / 'user-file').write_text('keep')
        with self.assertRaises(ValueError):
            updater.SourceUpdater(occupied).bootstrap()
        self.assertEqual((occupied / 'user-file').read_text(), 'keep')

    def test_branch_moves_and_invalid_current(self):
        old = self.u.check()
        (self.repo / 'file').write_text('new')
        git('commit', '-am', 'new', cwd=self.repo)
        with self.assertRaises(RuntimeError):
            self.u.stage(old)
        new = self.u.check()
        self.u.stage(new)
        (self.root / 'current').symlink_to('/tmp/elsewhere')
        with self.assertRaises(RuntimeError):
            self.u.activate(new, between_runs=True)
    def test_successful_build_may_emit_large_output(self):
        import sys
        output = updater._run([sys.executable, "-c", "print(\"x\" * 70000)"], None, 5)
        self.assertLessEqual(len(output), 65536)
    def test_timeout_stops_the_entire_owned_process_group(self):
        pidfile = self.root.parent / "child.pid"
        script = ("import pathlib,subprocess,sys,time; "
                  "child=subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']); "
                  "pathlib.Path(sys.argv[1]).write_text(str(child.pid)); time.sleep(60)")
        with self.assertRaises(subprocess.TimeoutExpired):
            updater._run([sys.executable, "-c", script, str(pidfile)], None, 1.5)
        pid = int(pidfile.read_text())
        self.addCleanup(lambda: self._kill_if_alive(pid))
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            result = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True)
            if result.returncode != 0 or result.stdout.strip().startswith("Z"):
                break
            time.sleep(0.05)
        else:
            raise AssertionError("timed-out updater left its child process running")

    def test_pre_cancelled_run_does_not_spawn_a_process(self):
        cancel = threading.Event()
        cancel.set()
        with mock.patch.object(updater.subprocess, 'Popen') as popen:
            with self.assertRaises(InterruptedError):
                updater._run([sys.executable, '-c', 'pass'], None, 5, cancel_event=cancel)
        popen.assert_not_called()

    def test_cancellable_run_still_honors_timeout(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            updater._run([sys.executable, '-c', 'import time; time.sleep(60)'], None, .2,
                         cancel_event=threading.Event())

    def test_cancellation_stops_the_entire_owned_process_group(self):
        pidfile = self.root.parent / 'cancel-child.pid'
        script = ("import pathlib,subprocess,sys,time; "
                  "child=subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']); "
                  "pathlib.Path(sys.argv[1]).write_text(str(child.pid)); time.sleep(60)")
        cancel = threading.Event()
        errors = []
        def run():
            try:
                updater._run([sys.executable, '-c', script, str(pidfile)], None, 60, cancel_event=cancel)
            except Exception as exc:
                errors.append(exc)
        thread = threading.Thread(target=run)
        thread.start()
        try:
            deadline = time.monotonic() + 5
            while not pidfile.exists() and thread.is_alive() and time.monotonic() < deadline:
                threading.Event().wait(.02)
            self.assertTrue(pidfile.exists(), 'updater subprocess did not start')
            pid = int(pidfile.read_text())
            self.addCleanup(lambda: self._kill_if_alive(pid))
            cancel.set()
            thread.join(3)
            self.assertFalse(thread.is_alive(), 'cancellation did not stop the build')
            self.assertEqual(len(errors), 1)
            self.assertIsInstance(errors[0], InterruptedError)
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                result = subprocess.run(['ps', '-p', str(pid), '-o', 'stat='], capture_output=True, text=True)
                if result.returncode != 0 or result.stdout.strip().startswith('Z'):
                    break
                threading.Event().wait(.05)
            else:
                self.fail('cancelled updater left its child process running')
        finally:
            cancel.set()
            thread.join(3)

    @staticmethod
    def _kill_if_alive(pid):
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    def test_current_checkout_is_verified_before_launch(self):
        commit = self.u.check()
        path = self.u.stage(commit)
        self.u.activate(commit, between_runs=True)
        self.assertEqual(self.u.current(), commit)
        (path / "file").write_text("tampered")
        with self.assertRaisesRegex(RuntimeError, "modified tracked files"):
            self.u.current()
    def test_rejects_non_fast_forward_remote_without_switching(self):
        first = self.u.check()
        self.u.stage(first)
        self.u.activate(first, between_runs=True)
        replacement = self.root.parent / "unrelated"
        replacement.mkdir()
        git("init", "-b", "master", cwd=replacement)
        git("config", "user.email", "test@example.invalid", cwd=replacement)
        git("config", "user.name", "Test", cwd=replacement)
        (replacement / "file").write_text("unrelated")
        git("add", "file", cwd=replacement)
        git("commit", "-m", "unrelated", cwd=replacement)
        self.repo = replacement
        new = self.u.check()
        with self.assertRaisesRegex(RuntimeError, "non-fast-forward"):
            self.u.stage(new)
        self.assertEqual(self.u.current(), first)
    def test_default_build_prepares_primary_runtime_before_activation(self):
        required = ["pnpm", "--filter", "@yharness/desktop", "run", "prepare:primary-runtime"]
        self.assertIn(required, updater.SourceUpdater(self.root).build)
    def test_stage_rejects_a_build_without_runnable_artifacts(self):
        self.incomplete = True
        commit = self.u.check()
        with self.assertRaisesRegex(RuntimeError, "missing.*artifact"):
            self.u.stage(commit)
        self.assertIsNone(self.u.current())
    def test_build_cannot_reference_artifacts_outside_its_version(self):
        (self.root.parent / "foreign.js").write_text("untrusted")
        self.escape_artifact = True
        commit = self.u.check()
        with self.assertRaisesRegex(RuntimeError, "invalid build artifact"):
            self.u.stage(commit)
        self.assertIsNone(self.u.current())
    def test_another_process_cannot_activate_while_app_guard_is_held(self):
        commit = self.u.check()
        self.u.stage(commit)
        self.u.activate(commit, between_runs=True)
        script = ("import importlib.util, pathlib, sys; "
                  "s=importlib.util.spec_from_file_location('u', sys.argv[1]); "
                  "m=importlib.util.module_from_spec(s); s.loader.exec_module(m); "
                  "m.SourceUpdater(pathlib.Path(sys.argv[2])).activate(sys.argv[3], between_runs=True)")
        environment = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
        with self.u.run_guard():
            result = subprocess.run([sys.executable, "-c", script, str(MODULE), str(self.root), commit],
                                    env=environment, capture_output=True, text=True, timeout=15)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("already running", result.stderr)
            self.assertEqual(self.u.current(), commit)
    def test_relocation_failure_keeps_old_version_and_allows_retry(self):
        commit = self.u.check()
        original = updater._validate_build
        def reject_relocated(path):
            if Path(path).parent.name == "versions":
                raise RuntimeError("relocation verification failed")
            original(path)
        with mock.patch.object(updater, "_validate_build", side_effect=reject_relocated):
            with self.assertRaisesRegex(RuntimeError, "relocation"):
                self.u.stage(commit)
        self.assertFalse((self.root / "versions" / commit).exists())
        self.assertTrue(any((self.root / "staging").iterdir()))
        self.assertEqual(self.u.stage(commit).name, commit)


if __name__ == '__main__':
    unittest.main()
