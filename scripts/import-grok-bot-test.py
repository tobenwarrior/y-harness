#!/usr/bin/env python3
"""Synthetic tests for the reviewed Grok connected-app import lane."""

import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name('import-grok-bot.py')
SPEC = importlib.util.spec_from_file_location('import_grok_bot', MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError('Could not load the importer module')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FakeConnection:
    def close(self):
        pass


class ImporterTests(unittest.TestCase):
    def test_map_requires_exact_reviewed_fields_and_unique_indexes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'map.json'
            path.write_text(json.dumps([{
                'sourceIndex': 0,
                'sourceLabel': 'GitHub workspace',
                'targetServerName': 'github',
            }]), encoding='utf-8')
            self.assertEqual(MODULE.read_connected_app_map(path)[0]['targetServerName'], 'github')

            path.write_text(json.dumps([{
                'sourceIndex': 0,
                'sourceLabel': 'GitHub workspace',
                'targetServerName': 'github',
            }, {
                'sourceIndex': 0,
                'sourceLabel': 'Another label',
                'targetServerName': 'offline',
            }]), encoding='utf-8')
            with self.assertRaises(MODULE.ImportErrorDetail):
                MODULE.read_connected_app_map(path)

            path.write_text(json.dumps([{
                'sourceIndex': 0,
                'sourceLabel': 'GitHub workspace',
                'targetServerName': 'github',
                'secret': 'must be rejected',
            }]), encoding='utf-8')
            with self.assertRaises(MODULE.ImportErrorDetail):
                MODULE.read_connected_app_map(path)

    def test_app_map_preview_does_not_invent_an_apply_revision(self):
        calls = []

        def fake_invoke(_connection, _cookie, endpoint, **arguments):
            calls.append((endpoint, arguments))
            if endpoint == 'bots/list':
                return {'bots': [{'id': 'bot-destination', 'name': 'Destination', 'updatedAt': 42}]}
            return {
                'bot': {'id': 'bot-destination'},
                'updatedAt': 42,
                'mappings': [],
                'changedAppIds': [],
                'catalogAvailable': True,
            }

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            export = root / 'export.json'
            export.write_text(json.dumps({
                'format': 'grok-bot-export',
                'version': 1,
                'bots': [{'name': 'Source', 'apps': ['GitHub workspace']}],
            }), encoding='utf-8')
            mapping = root / 'map.json'
            mapping.write_text(json.dumps([{
                'sourceIndex': 0,
                'sourceLabel': 'GitHub workspace',
                'targetServerName': 'github',
            }]), encoding='utf-8')
            old_connect = MODULE.connect
            old_invoke = MODULE.invoke
            old_argv = sys.argv
            try:
                MODULE.connect = lambda: (FakeConnection(), 'cookie')
                MODULE.invoke = fake_invoke
                sys.argv = [str(MODULE_PATH), str(export), '--bot', 'Destination', '--source-name', 'Source',
                            '--connected-app-map', str(mapping)]
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    MODULE.main()
            finally:
                MODULE.connect = old_connect
                MODULE.invoke = old_invoke
                sys.argv = old_argv

        self.assertEqual(calls[1][0], 'bots/importGrokConnectedApps')
        request = calls[1][1]['request']
        self.assertNotIn('expectedUpdatedAt', request)
        self.assertEqual(request['mappings'][0]['targetServerName'], 'github')
        self.assertEqual(json.loads(output.getvalue())['mode'], 'connected-app-preview')

    def test_app_map_apply_uses_the_captured_preview_revision(self):
        calls = []

        def fake_invoke(_connection, _cookie, endpoint, **arguments):
            calls.append((endpoint, arguments))
            if endpoint == 'bots/list':
                return {'bots': [{'id': 'bot-destination', 'name': 'Destination', 'updatedAt': 99}]}
            return {
                'updatedAt': 100,
                'mappings': [],
                'changedAppIds': ['github'],
                'catalogAvailable': True,
            }

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            export = root / 'export.json'
            export.write_text(json.dumps({
                'format': 'grok-bot-export',
                'version': 1,
                'bots': [{'name': 'Source', 'apps': ['GitHub workspace']}],
            }), encoding='utf-8')
            mapping = root / 'map.json'
            mapping.write_text(json.dumps([{
                'sourceIndex': 0,
                'sourceLabel': 'GitHub workspace',
                'targetServerName': 'github',
            }]), encoding='utf-8')
            old_connect = MODULE.connect
            old_invoke = MODULE.invoke
            old_argv = sys.argv
            try:
                MODULE.connect = lambda: (FakeConnection(), 'cookie')
                MODULE.invoke = fake_invoke
                sys.argv = [str(MODULE_PATH), str(export), '--bot', 'Destination', '--source-name', 'Source',
                            '--connected-app-map', str(mapping), '--apply', '--expected-updated-at', '42']
                with contextlib.redirect_stdout(io.StringIO()):
                    MODULE.main()
            finally:
                MODULE.connect = old_connect
                MODULE.invoke = old_invoke
                sys.argv = old_argv

        self.assertEqual(calls[1][0], 'bots/importGrokConnectedApps')
        request = calls[1][1]['request']
        self.assertEqual(request['expectedUpdatedAt'], 42)
        self.assertNotEqual(request['expectedUpdatedAt'], 99)

    def test_normal_import_keeps_existing_endpoint(self):
        endpoints = []

        def fake_invoke(_connection, _cookie, endpoint, **arguments):
            endpoints.append(endpoint)
            if endpoint == 'bots/list':
                return {'bots': [{'id': 'bot-destination', 'name': 'Destination', 'updatedAt': 42}]}
            return {'sourceName': 'Source', 'memories': 0, 'skills': 0, 'skillNames': [], 'routines': 0,
                    'missingRoutineSkills': []}

        with tempfile.TemporaryDirectory() as directory:
            export = Path(directory) / 'export.json'
            export.write_text(json.dumps({
                'format': 'grok-bot-export',
                'version': 1,
                'bots': [{'name': 'Source'}],
            }), encoding='utf-8')
            old_connect = MODULE.connect
            old_invoke = MODULE.invoke
            old_argv = sys.argv
            try:
                MODULE.connect = lambda: (FakeConnection(), 'cookie')
                MODULE.invoke = fake_invoke
                sys.argv = [str(MODULE_PATH), str(export), '--bot', 'Destination']
                with contextlib.redirect_stdout(io.StringIO()):
                    MODULE.main()
            finally:
                MODULE.connect = old_connect
                MODULE.invoke = old_invoke
                sys.argv = old_argv
        self.assertEqual(endpoints, ['bots/list', 'bots/importGrokBot'])


if __name__ == '__main__':
    unittest.main()
