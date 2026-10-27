import contextlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('supervisor', Path(__file__).resolve().parents[1] / 'scripts' / 'github-desktop-supervisor.py')
supervisor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supervisor)
A, B = 'a' * 40, 'b' * 40


class FakeUpdater:
    def __init__(self, root):
        self.root = root
        self.remote = A
        self.running = False
        self.fail = False
        self.activations = []
        (root / 'versions').mkdir(parents=True)

    def current(self):
        return supervisor.current_commit(self.root)

    def check(self):
        if self.fail:
            raise RuntimeError('secret')
        return self.remote

    def mark_current(self):
        commit = self.current()
        (self.root / 'update-status.json').write_text(json.dumps({'phase': 'active', 'commit': commit}))

    def stage(self, commit):
        if self.fail:
            raise RuntimeError('secret')
        (self.root / 'versions' / commit).mkdir(exist_ok=True)
        (self.root / 'update-status.json').write_text(json.dumps({'phase': 'ready', 'commit': commit}))

    def activate(self, commit, *, between_runs):
        assert between_runs and not self.running
        link = self.root / 'current'
        if link.is_symlink():
            link.unlink()
        link.symlink_to('versions/' + commit)
        self.activations.append(commit)
        (self.root / 'update-status.json').write_text(json.dumps({'phase': 'active', 'commit': commit}))

    @contextlib.contextmanager
    def run_guard(self):
        self.running = True
        try:
            yield
        finally:
            self.running = False


class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=Path.home())
        self.addCleanup(self.tmp.cleanup)
        self.support = Path(self.tmp.name)
        self.u = FakeUpdater(self.support / 'managed')
        self.config = {'node': '/node', 'pnpm': '/pnpm'}

    def test_initial_and_deferred_update(self):
        started, release = threading.Event(), threading.Event()
        calls = []
        class Child:
            def wait(self):
                started.set()
                self.assert_release()
                return 0
            def assert_release(self):
                if not release.wait(5):
                    raise AssertionError('child barrier timed out')
        def popen(argv, **kwargs):
            calls.append((argv, kwargs))
            return Child()
        s = supervisor.Supervisor(self.u, self.support, self.config, popen=popen)
        thread = threading.Thread(target=s.run_once)
        thread.start()
        self.assertTrue(started.wait(5))
        self.assertEqual(self.u.activations, [A])
        self.u.remote = B
        s.poll_once()
        self.assertEqual(supervisor.current_commit(self.u.root), A)
        self.assertEqual(supervisor.ready_commit(self.u.root), B)
        release.set()
        thread.join(5)
        self.assertFalse(thread.is_alive())
        s.prepare()
        self.assertEqual(self.u.activations, [A, B])
        self.assertEqual(calls[0][0], ['/node', '/pnpm', 'run', 'start:desktop'])
        self.assertEqual(calls[0][1]['env']['DSH_HOME'], str(self.support / 'data/home'))
        self.assertEqual(calls[0][1]['env']['DSH_DESKTOP_USER_DATA_DIR'], str(self.support / 'data/electron-user-data'))
        self.assertEqual(calls[0][1]['env']['DSH_DESKTOP_DISABLE_INSPECTORS'], '1')
        self.assertEqual(calls[0][1]['env']['DSH_DESKTOP_GITHUB_STATUS'], str(self.u.root / 'update-status.json'))
        self.assertEqual(calls[0][1]['env']['DSH_DESKTOP_GITHUB_BUILD_COMMIT'], A)
        self.assertEqual(calls[0][1]['env']['DSH_DESKTOP_OPEN_DEVTOOLS'], '0')

    def test_offline_and_stage_failure_preserve_current(self):
        s = supervisor.Supervisor(self.u, self.support, self.config)
        s.prepare()
        self.u.fail = True
        s.poll_once()
        self.assertEqual(s.prepare(), A)
        self.u.fail = False
        self.u.remote = B
        def fail_stage(commit):
            raise RuntimeError('build failed')
        self.u.stage = fail_stage
        s.poll_once()
        self.assertEqual(s.prepare(), A)

    def test_lock_and_links(self):
        with supervisor.supervisor_lock(self.support):
            with self.assertRaises(BlockingIOError):
                with supervisor.supervisor_lock(self.support):
                    pass
        (self.u.root / 'current').symlink_to('/tmp/evil')
        with self.assertRaises(ValueError):
            supervisor.current_commit(self.u.root)
        (self.u.root / 'update-status.json').symlink_to('/tmp/evil')
        with self.assertRaises(ValueError):
            supervisor.ready_commit(self.u.root)

    def test_config(self):
        bootstrap = self.support / 'bootstrap'
        bootstrap.mkdir(mode=0o700)
        path = bootstrap / 'runtime.json'
        path.write_text(json.dumps({'schemaVersion': 1, 'node': '/bin/sh', 'pnpm': '/bin/sh'}))
        path.chmod(0o600)
        self.assertEqual(supervisor.load_config(self.support)['schemaVersion'], 1)
        path.chmod(0o644)
        with self.assertRaises(ValueError):
            supervisor.load_config(self.support)
        path.unlink()
        path.symlink_to('/etc/passwd')
        with self.assertRaises(OSError):
            supervisor.load_config(self.support)
    def test_user_quit_applies_ready_update_without_relaunching(self):
        calls = []
        outer = self
        class Child:
            def wait(self):
                outer.u.remote = B
                outer.u.stage(B)
                return 0
        class OneRunSupervisor(supervisor.Supervisor):
            def poll_loop(self):
                self.stop.wait()
        def popen(*args, **kwargs):
            calls.append(args)
            if len(calls) > 1:
                runner.stop.set()
            return Child()
        runner = OneRunSupervisor(self.u, self.support, self.config, popen=popen)
        runner.serve()
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.u.activations, [A, B])
        self.assertEqual(supervisor.current_commit(self.u.root), B)
    def test_build_environment_finds_node_and_pnpm_without_gui_path(self):
        config = {"node": "/opt/test-node/bin/node", "pnpm": "/opt/test-pnpm/bin/pnpm"}
        with mock.patch.dict(os.environ, {"PATH": "/usr/bin", "GH_TOKEN": "secret", "DEEPSEEK_API_KEY": "secret"}), mock.patch.object(supervisor._engine, "_run", return_value="") as run:
            supervisor.runtime_run([config["pnpm"], "install"], None, 5, config)
        argv, _, _, environment = run.call_args.args
        self.assertEqual(argv, [config["node"], config["pnpm"], "install"])
        self.assertEqual(environment["PATH"].split(os.pathsep)[:2], ["/opt/test-node/bin", "/opt/test-pnpm/bin"])
        self.assertNotIn("GH_TOKEN", environment)
        self.assertNotIn("DEEPSEEK_API_KEY", environment)
    def test_second_launch_focuses_the_running_app(self):
        with supervisor.supervisor_lock(self.support), \
             mock.patch.object(supervisor, "SUPPORT", self.support), \
             mock.patch.object(supervisor, "focus_existing", create=True) as focus:
            self.assertEqual(supervisor.main(["--serve"]), 0)
        focus.assert_called_once_with(self.support)
    def test_focus_uses_only_the_managed_app_bundle(self):
        self.u.stage(A)
        self.u.activate(A, between_runs=True)
        app = self.u.root / "versions" / A / "apps/desktop/.desktop-build/development/Y harness.app"
        app.mkdir(parents=True)
        with mock.patch.object(supervisor.subprocess, "run") as run:
            supervisor.focus_existing(self.support, owner_finder=lambda *_: 123)
        command = run.call_args.args[0]
        self.assertEqual(command[0], "/usr/bin/osascript")
        self.assertEqual(command[-1], "123")
        self.assertNotIn("/usr/bin/open", command)
    def test_never_relaunches_a_quit_app_outside_the_supervisor(self):
        self.u.stage(A)
        self.u.activate(A, between_runs=True)
        app = self.u.root / "versions" / A / "apps/desktop/.desktop-build/development/Y harness.app"
        app.mkdir(parents=True)
        with mock.patch.object(supervisor.subprocess, "run") as run:
            supervisor.focus_existing(self.support, owner_finder=lambda *_: None)
        run.assert_not_called()
    def test_update_status_is_bounded_and_rejects_non_regular_files(self):
        path = self.u.root / "update-status.json"
        path.write_text("x" * 4097)
        with self.assertRaisesRegex(ValueError, "status"):
            supervisor.ready_commit(self.u.root)
        path.unlink()
        path.mkdir()
        with self.assertRaisesRegex(ValueError, "status"):
            supervisor.ready_commit(self.u.root)
    def test_existing_app_starts_before_a_slow_update_check(self):
        self.u.stage(A)
        self.u.activate(A, between_runs=True)
        poll_entered = threading.Event()
        release_poll = threading.Event()
        launched = threading.Event()
        release_child = threading.Event()
        class SlowPollSupervisor(supervisor.Supervisor):
            def poll_loop(self):
                with self.operation:
                    poll_entered.set()
                    release_poll.wait(10)
        class Child:
            def wait(self):
                release_child.wait(10)
                return 0
        def popen(*args, **kwargs):
            launched.set()
            return Child()
        runner = SlowPollSupervisor(self.u, self.support, self.config, popen=popen)
        outer = threading.Thread(target=runner.serve)
        original_thread = threading.Thread
        class ControlledThread(original_thread):
            def start(self):
                super().start()
                if not poll_entered.wait(10):
                    raise AssertionError("update poll did not acquire its lock")
        with mock.patch.object(supervisor.threading, "Thread", ControlledThread):
            try:
                outer.start()
                self.assertTrue(poll_entered.wait(10))
                self.assertTrue(launched.wait(1), "update check blocked an existing app from starting")
            finally:
                release_poll.set()
                release_child.set()
                outer.join(15)
        self.assertFalse(outer.is_alive())
    def test_fresh_install_builds_primary_runtime(self):
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(supervisor, 'SUPPORT', self.support))
            stack.enter_context(mock.patch.object(supervisor, 'load_config', return_value=self.config))
            source = stack.enter_context(mock.patch.object(supervisor._engine, 'SourceUpdater'))
            runner = stack.enter_context(mock.patch.object(supervisor, 'Supervisor'))
            runner.return_value.serve.return_value = 0
            self.assertEqual(supervisor.main(['--serve']), 0)
        self.assertIn(['/pnpm', '--filter', '@deepseek-ai/dsh-desktop', 'run', 'prepare:primary-runtime'],
                      source.call_args.kwargs['build'])
        cancel = runner.call_args.kwargs['cancel']
        with mock.patch.object(supervisor._engine, '_run', return_value='') as run:
            source.call_args.kwargs['runner'](['/pnpm', 'install'], None, 5)
        self.assertIs(run.call_args.kwargs['cancel_event'], cancel)

    def test_quit_cancels_an_in_flight_background_build(self):
        cancel = threading.Event()
        entered = threading.Event()
        self.u.stage(A)
        self.u.activate(A, between_runs=True)
        self.u.remote = B
        def stage(commit):
            entered.set()
            if not cancel.wait(5):
                raise AssertionError('build was not cancelled')
            raise InterruptedError('cancelled')
        self.u.stage = stage
        class Child:
            def wait(self):
                if not entered.wait(5):
                    raise AssertionError('background build did not start')
                return 0
        runner = supervisor.Supervisor(self.u, self.support, self.config,
                                       popen=lambda *args, **kwargs: Child(), cancel=cancel)
        completed = threading.Event()
        def serve():
            try:
                runner.serve()
            finally:
                completed.set()
        thread = threading.Thread(target=serve)
        thread.start()
        try:
            self.assertTrue(completed.wait(2), 'shutdown waited for an in-flight build')
        finally:
            cancel.set()
            thread.join(6)
        self.assertFalse(thread.is_alive())
        self.assertEqual(self.u.activations, [A])

    def test_stale_candidate_is_not_activated_after_remote_rewinds(self):
        runner = supervisor.Supervisor(self.u, self.support, self.config)
        runner.prepare()
        self.u.remote = B
        runner.poll_once()
        self.assertEqual(supervisor.ready_commit(self.u.root), B)
        self.u.remote = A
        self.assertEqual(runner.prepare(), A)
        self.assertEqual(self.u.activations, [A])
        runner.poll_once()
        self.assertIsNone(supervisor.ready_commit(self.u.root))


if __name__ == '__main__':
    unittest.main()
