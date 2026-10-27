"""Regression tests for the bounded large-repository index."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "assets/compound/scripts"))
import code_map
import map_server


class LargeMapTests(unittest.TestCase):
    def test_index_and_projection_include_files_after_old_cap(self):
        inventory = [f"src/file_{i:05}.py" for i in range(5001)]
        entry = {"fingerprint": {}, "language": "python", "symbols": [], "imports": [],
                 "lines": 1, "analysis": "python-ast", "exports": []}
        candidate = {"language": "python", "fingerprint": {}}
        with patch.object(code_map, "_candidate", return_value=(candidate, None)), \
             patch.object(code_map, "_read_parse", return_value=(entry, 0, None)), \
             patch.object(code_map, "_load_alias_configs", return_value=[]), \
             patch.object(code_map, "_git_state", return_value=("", {}, None)), \
             patch.object(code_map, "_cochanges", return_value={}):
            model = code_map._build(Path("/"), "", inventory, [], "", code_map.MAX_FILES, False, False)
        self.assertEqual(model["coverage"]["indexed"], 5001)
        self.assertFalse(model["coverage"]["truncated"])
        result = map_server._project_model(model, "file_05000", map_server.RESPONSE_MAX_FILES)
        self.assertEqual(len(result["files"]), 5000)
        self.assertTrue(any(f["path"] == inventory[-1] for f in result["files"]))
        self.assertTrue(result["coverage"]["truncated"])
        self.assertEqual(result["coverage"]["skipped"], 1)
        self.assertEqual(result["coverage"]["available"], 5001)
        self.assertEqual(result["coverage"]["response_skipped"], 1)
        self.assertEqual(len(model["files"]), 5001)

    def test_inventory_limit_is_reported(self):
        inventory = [f"src/{i:05}.py" for i in range(4)]
        candidate = {"language": "python", "fingerprint": {}}
        entry = {"fingerprint": {}, "language": "python", "symbols": [], "imports": [],
                 "lines": 1, "analysis": "python-ast", "exports": []}
        with patch.object(code_map, "MAX_FILES", 3), \
             patch.object(code_map, "_candidate", return_value=(candidate, None)), \
             patch.object(code_map, "_read_parse", return_value=(entry, 0, None)), \
             patch.object(code_map, "_load_alias_configs", return_value=[]), \
             patch.object(code_map, "_git_state", return_value=("", {}, None)), \
             patch.object(code_map, "_cochanges", return_value={}):
            model = code_map._build(Path("/"), "", inventory, [], "", 3, False, False)
        self.assertEqual(model["coverage"]["indexed"], 3)
        self.assertEqual(model["coverage"]["skipped"], 1)
        self.assertTrue(model["coverage"]["truncated"])
        self.assertIn("file inventory cap reached at 3 files", model["coverage"]["notes"])


if __name__ == "__main__":
    unittest.main()
