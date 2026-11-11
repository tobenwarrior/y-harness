"""Exercise Grok importer mode selection without contacting a VPS service."""

import contextlib
import importlib.util
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location(
    'import_grok_bot', Path(__file__).with_name('import-grok-bot.py')
)
assert SPEC is not None and SPEC.loader is not None
importer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(importer)


class ImportGrokBotTest(unittest.TestCase):
    def run_importer(self, arguments, responses):
        with tempfile.TemporaryDirectory() as directory:
            export = Path(directory) / 'grok.json'
            export.write_text('{"fixture": true}', encoding='utf-8')
            connection = Mock()
            calls = []

            def invoke(connection_arg, cookie, endpoint, **args):
                self.assertIs(connection_arg, connection)
                self.assertEqual(cookie, 'fixture-cookie')
                calls.append((endpoint, args))
                return responses[endpoint]

            output = io.StringIO()
            with (
                patch.object(importer, 'connect', return_value=(connection, 'fixture-cookie')) as connect,
                patch.object(importer, 'invoke', side_effect=invoke),
                patch.object(importer.sys, 'argv', ['import-grok-bot.py', str(export), *arguments]),
                contextlib.redirect_stdout(output),
            ):
                importer.main()
            return calls, output.getvalue(), connect

    def test_history_mode_dispatches_the_archive_endpoint(self):
        calls, output, _ = self.run_importer(
            ['--bot', 'Research Bot', '--history', '--apply'],
            {
                'bots/list': {'bots': [{'id': 'bot-a', 'name': 'Research Bot'}]},
                'bots/importGrokHistory': {'messages': 2},
            },
        )

        self.assertEqual([endpoint for endpoint, _ in calls], ['bots/list', 'bots/importGrokHistory'])
        self.assertEqual(
            calls[1][1],
            {'request': {'botId': 'bot-a', 'document': '{"fixture": true}'}},
        )
        self.assertIn('"mode": "history-import"', output)

    def test_default_mode_keeps_previewing_bot_exports(self):
        calls, output, _ = self.run_importer(
            ['--bot', 'Research Bot'],
            {
                'bots/list': {'bots': [{'id': 'bot-a', 'name': 'Research Bot'}]},
                'bots/importGrokBot': {'memories': 1},
            },
        )

        self.assertEqual([endpoint for endpoint, _ in calls], ['bots/list', 'bots/importGrokBot'])
        self.assertEqual(
            calls[1][1],
            {'request': {
                'botId': 'bot-a',
                'document': '{"fixture": true}',
                'preview': True,
            }},
        )
        self.assertIn('"mode": "preview"', output)

    def test_history_requires_apply_before_connecting(self):
        with tempfile.TemporaryDirectory() as directory:
            export = Path(directory) / 'grok-history.json'
            export.write_text('{}', encoding='utf-8')
            output = io.StringIO()
            with (
                patch.object(importer, 'connect') as connect,
                patch.object(importer.sys, 'argv', [
                    'import-grok-bot.py', str(export), '--bot', 'Research Bot', '--history',
                ]),
                contextlib.redirect_stderr(output),
            ):
                with self.assertRaises(SystemExit) as error:
                    importer.main()

        self.assertEqual(error.exception.code, 2)
        self.assertIn('--history requires --apply', output.getvalue())
        connect.assert_not_called()


if __name__ == '__main__':
    unittest.main()
