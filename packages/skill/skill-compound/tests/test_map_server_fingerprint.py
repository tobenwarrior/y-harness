"""Standalone regression tests for the asynchronous map fingerprint."""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "assets/compound/scripts"))
import map_server


class FingerprintTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        environment = mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": str(self.root / "global-git-config"), "GIT_CONFIG_NOSYSTEM": "1", "GIT_TERMINAL_PROMPT": "0"})
        environment.start()
        self.addCleanup(environment.stop)
        self.git('init', '-q')
        self.git('config', 'user.email', 'test@example.com')
        self.git('config', 'user.name', 'Test')
        (self.root / 'file.py').write_text('one')
        self.git('add', '.')
        self.git('commit', '-qm', 'initial')



    def git(self, *args):
        subprocess.run(['git', '-C', str(self.root), *args], check=True, stdout=subprocess.PIPE)

    def test_inventory_metadata_and_head(self):
        fingerprint = map_server._inventory_fingerprint
        initial = fingerprint(self.root)
        file = self.root / 'file.py'
        initial_time = file.stat().st_mtime_ns
        file.write_text('two')
        os.utime(file, ns=(initial_time + 2_000_000_000, initial_time + 2_000_000_000))
        modified = fingerprint(self.root)
        self.assertNotEqual(initial, modified)
        file.write_text('six')
        os.utime(file, ns=(initial_time + 4_000_000_000, initial_time + 4_000_000_000))
        self.assertNotEqual(modified, fingerprint(self.root))
        modified = fingerprint(self.root)
        extra = self.root / 'package.json'
        extra.write_text('{}')
        self.assertNotEqual(modified, fingerprint(self.root))
        extra.unlink()
        self.assertEqual(modified, fingerprint(self.root))
        file.unlink()
        self.assertNotEqual(modified, fingerprint(self.root))
        file.write_text('six')
        self.git('add', '.')
        self.git('commit', '-qm', 'next')
        self.assertNotEqual(initial, fingerprint(self.root))

    def test_worker_skips_unchanged_and_retries_pending_and_errors(self):
        service = map_server.MapService('token', 0, {})
        project = map_server.Project('id', 'name', self.root, '', 100)
        model = {'files': [], 'coverage': {'pending': 0}}
        with mock.patch.object(service, '_remember'), mock.patch.object(map_server.engine, 'build_map', return_value=(model, None)) as build:
            service._refresh_worker(project)
            service._refresh_worker(project)
            self.assertEqual(build.call_count, 1)
            model['coverage']['pending'] = 1
            service._refresh_worker(project)
            self.assertEqual(build.call_count, 2)
            model['coverage']['pending'] = 0
            service._refresh_worker(project, True)
            self.assertEqual(build.call_count, 3)
            with mock.patch.object(map_server, '_inventory_fingerprint', side_effect=OSError('failure')):
                service._refresh_worker(project)
            self.assertIn('failure', project.error)
            with mock.patch.object(service, '_refresh'):
                self.assertIsNone(service._model_snapshot(project)[0])
            service._refresh_worker(project)
            self.assertIsNone(project.error)
            self.assertEqual(build.call_count, 4)


if __name__ == '__main__':
    unittest.main()
