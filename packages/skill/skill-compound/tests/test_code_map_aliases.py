import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'assets/compound/scripts'))
import code_map


class AliasTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.candidates = {}

    def put(self, rel, value):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value))
        self.candidates[rel] = {'absolute': path, 'fingerprint': code_map._fingerprint(path)}

    def test_inheritance_many_rules_and_nearby_override(self):
        paths = {f'@pkg/{i}': [f'src/{i}.ts'] for i in range(150)}
        self.put('tsconfig.base.json', {'compilerOptions': {'baseUrl': '.', 'paths': paths}})
        self.put('tsconfig.json', {'extends': './tsconfig.base.json'})
        self.put('nested/tsconfig.json', {'extends': '../tsconfig.json', 'compilerOptions': {'paths': {'@pkg/149': ['nested/override.ts']}}})
        known = {'src/149.ts', 'nested/override.ts'}
        configs = code_map._load_alias_configs(self.root, self.candidates)
        self.assertEqual(code_map._javascript_dep('main.ts', '@pkg/149', known, configs), 'src/149.ts')
        self.assertEqual(code_map._javascript_dep('nested/main.ts', '@pkg/149', known, configs), 'nested/override.ts')
        self.assertIsNone(code_map._javascript_dep('nested/main.ts', '@pkg/148', {'src/148.ts'}, configs))

    def test_cycles_and_unindexed_extends(self):
        self.put('tsconfig.json', {'extends': './base', 'compilerOptions': {'paths': {'a': ['a']}}})
        self.put('base.json', {'extends': './tsconfig.json'})
        self.put('other/jsconfig.json', {'extends': '../../outside.json'})
        configs = code_map._load_alias_configs(self.root, self.candidates)
        self.assertEqual(code_map._javascript_dep('main.ts', 'a', {'a.ts'}, configs), 'a.ts')
        self.assertLessEqual(len(configs), 2)

    def test_workspace_fallback_and_reload(self):
        self.put('package.json', {'name': 'local', 'source': 'src/one.ts'})
        known = {'src/one.ts', 'src/two.ts'}
        entry = {'language': 'typescript', 'imports': ['local'], 'symbols': [], 'lines': 1, 'analysis': 'javascript-outline', 'exports': []}
        packages = code_map.load_workspace_packages(self.root, self.candidates)
        self.assertEqual(code_map._record('app.ts', entry, known, packages=packages)['dependencies'], ['src/one.ts'])
        self.put('package.json', {'name': 'local', 'source': 'src/two.ts'})
        packages = code_map.load_workspace_packages(self.root, self.candidates)
        self.assertEqual(code_map._record('app.ts', entry, known, packages=packages)['dependencies'], ['src/two.ts'])
    def test_javascript_outline_records_literal_dynamic_imports_and_exports(self):
        source = "export default function greet() {}\nexport default class Example {}\nexport const lookup = new Map()\nconst p = import('./local')\nconst q = import(name)"
        symbols, imports = code_map._javascript_outline(source)
        self.assertIn({"name": "greet", "kind": "function", "line": 1}, symbols)
        self.assertIn({"name": "Example", "kind": "class", "line": 2}, symbols)
        self.assertIn({"name": "lookup", "kind": "variable", "line": 3}, symbols)
        self.assertEqual(imports, ["./local"])


if __name__ == '__main__':
    unittest.main()
