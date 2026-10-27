import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "assets/compound/scripts"))
from workspace_imports import load_workspace_packages, resolve_workspace_import


def candidates(base, known):
    for path in (base, base + '.ts', base + '/index.ts'):
        if path in known:
            return path
    return None


class WorkspaceImportsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.index = {}
        self.known = set()

    def manifest(self, directory, payload):
        path = self.root / directory / 'package.json'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload))
        self.index[path.relative_to(self.root).as_posix()] = {'absolute': path}

    def resolve(self, spec):
        return resolve_workspace_import(spec, self.known, load_workspace_packages(self.root, self.index), candidates)

    def test_exports_and_wildcards(self):
        self.manifest('packages/harness', {'name': '@example/y-harness', 'exports': {
            '.': {'source': './src/index.ts', 'default': './dist/index.js'},
            './features/*': './src/features/*.ts', './private': None}})
        self.known.update({'packages/harness/src/index.ts', 'packages/harness/src/features/a.ts'})
        self.assertEqual(self.resolve('@example/y-harness'), 'packages/harness/src/index.ts')
        self.assertEqual(self.resolve('@example/y-harness/features/a'), 'packages/harness/src/features/a.ts')
        self.assertIsNone(self.resolve('@example/y-harness/private'))
        self.assertIsNone(self.resolve('@example/y-harness/src/index'))
        self.assertIsNone(self.resolve('external'))

    def test_legacy_and_duplicate_names(self):
        self.manifest('a', {'name': 'local', 'main': 'src/index'})
        self.known.update({'a/src/index.ts', 'a/lib/x.ts'})
        self.assertEqual(self.resolve('local'), 'a/src/index.ts')
        self.assertEqual(self.resolve('local/lib/x'), 'a/lib/x.ts')
        self.manifest('b', {'name': 'local', 'main': 'index'})
        self.assertIsNone(self.resolve('local'))

    def test_invalid_and_escaping_targets(self):
        self.manifest('a', {'name': 'local', 'exports': {'./*': './../outside/*'}})
        self.known.add('outside/x.ts')
        self.assertIsNone(self.resolve('local/x'))
        self.assertIsNone(self.resolve('local/../x'))
        self.assertIsNone(self.resolve('./local'))
        self.assertIsNone(self.resolve('local\\x'))

    def test_untrusted_manifest_and_size(self):
        outside = self.root.parent / (self.root.name + '-outside.json')
        outside.write_text('{"name":"external"}')
        self.addCleanup(outside.unlink)
        self.index['evil/package.json'] = {'absolute': outside}
        self.manifest('big', {'name': 'big', 'padding': 'x' * (256 * 1024)})
        self.manifest('node_modules/pkg', {'name': 'dependency'})
        self.assertEqual(load_workspace_packages(self.root, self.index), {})
    def test_rejects_symlinked_manifest_inside_the_repository(self):
        target = self.root / "private.json"
        target.write_text('{"name":"leaked"}')
        directory = self.root / "linked"
        directory.mkdir()
        manifest = directory / "package.json"
        try:
            manifest.symlink_to(target)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        self.index["linked/package.json"] = {"absolute": manifest}
        self.assertEqual(load_workspace_packages(self.root, self.index), {})


if __name__ == '__main__':
    unittest.main()
