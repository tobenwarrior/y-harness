import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


engine = load('github_engine_integration', 'github-source-updater.py')
supervisor = load('github_supervisor_integration', 'github-desktop-supervisor.py')


def git(root, *args):
    env = {**os.environ, 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1'}
    return subprocess.run(['git', *args], cwd=root, env=env, check=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True).stdout.strip()


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


class DesktopUpdateIntegrationTests(unittest.TestCase):
    def test_stages_remote_commit_while_running_then_activates_after_quit(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            remote = root / 'remote'
            remote.mkdir()
            git(remote, 'init', '-b', 'master')
            git(remote, 'config', 'user.email', 'test@example.invalid')
            git(remote, 'config', 'user.name', 'Test')
            (remote / 'content').write_text('first')
            git(remote, 'add', 'content')
            git(remote, 'commit', '-m', 'first')
            support = root / 'support'
            support.mkdir(mode=0o700)

            def runner(argv, cwd, timeout):
                if argv[0] in ('fake-install', 'fake-build'):
                    if argv[0] == 'fake-build':
                        create_build_artifacts(cwd)
                    return ''
                argv = [str(remote) if value == engine.DEFAULT_REPO else value for value in argv]
                return engine._run(argv, cwd, timeout)

            updater = engine.SourceUpdater(support / 'managed', runner=runner,
                                           install=['fake-install'], build=['fake-build'])
            updater.bootstrap()
            started = threading.Event()
            release = threading.Event()
            calls = []

            class Child:
                def wait(self):
                    started.set()
                    if not release.wait(10):
                        raise AssertionError('application did not receive shutdown signal')
                    return 0

            class ControlledSupervisor(supervisor.Supervisor):
                def poll_loop(self):
                    self.stop.wait()

            def launch(argv, **kwargs):
                calls.append((argv, kwargs))
                return Child()

            app = ControlledSupervisor(updater, support, {'node': '/bin/sh', 'pnpm': '/bin/sh'}, popen=launch)
            outcome = []
            worker = threading.Thread(target=lambda: outcome.append(app.serve()))
            worker.start()
            try:
                self.assertTrue(started.wait(10), 'application did not start')
                first = updater.current()
                (remote / 'content').write_text('second')
                git(remote, 'commit', '-am', 'second')
                second = git(remote, 'rev-parse', 'HEAD')
                app.poll_once()
                self.assertEqual(updater.current(), first)
                self.assertEqual(supervisor.ready_commit(updater.root), second)
            finally:
                release.set()
                worker.join(20)
            self.assertFalse(worker.is_alive(), 'supervisor did not finish')
            self.assertEqual(outcome, [0])
            self.assertEqual(len(calls), 1)
            self.assertEqual(updater.current(), second)
            self.assertEqual((updater.root / 'versions' / first / 'content').read_text(), 'first')


if __name__ == '__main__':
    unittest.main()
