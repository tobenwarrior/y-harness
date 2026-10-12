"""Portable owner regressions replace process inspection with complete ps fixtures."""

import importlib
import subprocess
import sys
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import development_owner


EXECUTABLE = '/work trees/Harness (copy)+[a]/Y harness.app/Contents/MacOS/Electron'
APP_ROOT = '/work trees/Harness (copy)+[a]/apps/desktop'
USER_DATA = '/work trees/Harness (copy)+[a]/apps/desktop/.desktop-build/browser data'
HOST_ENTRY = '/work trees/Harness (copy)+[a]/apps/desktop-host/lib/index.js'


def native_arguments(port='19322', executable=EXECUTABLE, app_root=APP_ROOT,
                     user_data=USER_DATA, extra_options=''):
    debug = '' if port is None else ' --remote-debugging-port=' + port
    extra = '' if not extra_options else ' ' + extra_options
    return (executable + ' --inspect=127.0.0.1:19329' + debug
            + ' --user-data-dir=' + user_data + extra + ' ' + app_root)


class ProcessTable:
    """Only the two supported ps forms can inspect these process rows."""

    def __init__(self, rows):
        self.rows = rows
        self.inspected = []

    def check_output(self, command, *, text):
        if text is not True:
            raise AssertionError('Process inspection must request text output')
        if command == ['/bin/ps', '-axo', 'pid=,comm=']:
            return '\n'.join('  {}  {}'.format(pid, comm) for pid, comm, _ in self.rows)
        if (len(command) == 5 and command[:2] == ['/bin/ps', '-p']
                and command[3:] == ['-o', 'args=']):
            pid = int(command[2])
            self.inspected.append(pid)
            for row_pid, _, arguments in self.rows:
                if row_pid == pid:
                    if isinstance(arguments, Exception):
                        raise arguments
                    return arguments + '\n'
            raise AssertionError('No arguments fixture for PID {}'.format(pid))
        raise AssertionError('Unexpected process inspection: {}'.format(command))


class DevelopmentOwnerTests(unittest.TestCase):
    def setUp(self):
        self.table = ProcessTable([(301, EXECUTABLE, native_arguments())])
        self.inspection = patch.object(development_owner.subprocess, 'check_output',
                                       side_effect=self.table.check_output)
        self.inspection.start()
        self.addCleanup(self.inspection.stop)

    def find(self, expected_pid=None, executable=EXECUTABLE, app_root=APP_ROOT,
             user_data=USER_DATA):
        return development_owner.find_development_owner(executable, app_root, user_data,
                                                        expected_pid=expected_pid)

    def test_default_custom_and_absent_debug_port_identify_native_owner(self):
        for port in ('19322', '9222', None):
            with self.subTest(port=port):
                self.table.rows = [(301, EXECUTABLE, native_arguments(port))]
                self.assertEqual(self.find(), 301)

    def test_caller_paths_with_spaces_and_regex_characters_select_their_owner(self):
        executable = '/other root/Harness $() [b]+.app/Contents/MacOS/Electron'
        app_root = '/other root/Harness $() [b]+/apps/desktop'
        user_data = '/other root/Harness $() [b]+/browser data'
        self.table.rows.append((302, executable, native_arguments(
            executable=executable, app_root=app_root, user_data=user_data)))
        self.assertEqual(self.find(executable=executable, app_root=app_root,
                                   user_data=user_data), 302)

    def test_foreign_executable_is_not_inspected(self):
        self.table.rows = [(303, EXECUTABLE + '-other', native_arguments())]
        self.assertIsNone(self.find())
        self.assertEqual(self.table.inspected, [])

    def test_arguments_must_start_with_the_exact_executable(self):
        self.table.rows = [(304, EXECUTABLE,
                            native_arguments(executable=EXECUTABLE + '-other'))]
        self.assertIsNone(self.find())

    def test_electron_helpers_are_excluded_before_the_terminal_app_entry(self):
        for option in ('--type=renderer', '--type=utility', '--type=gpu-process',
                       '--type', '--type renderer'):
            with self.subTest(option=option):
                self.table.rows = [(305, EXECUTABLE,
                                    native_arguments(extra_options=option))]
                self.assertIsNone(self.find())

    def test_expose_internals_is_excluded_before_the_terminal_app_entry(self):
        self.table.rows = [(306, EXECUTABLE,
                            native_arguments(extra_options='--expose-internals'))]
        self.assertIsNone(self.find())

    def test_node_host_positional_entry_is_excluded(self):
        for option in ('', '--expose-internals '):
            with self.subTest(option=option):
                arguments = (EXECUTABLE + ' ' + option + '--remote-debugging-port=19322 '
                             + HOST_ENTRY + ' ' + APP_ROOT)
                self.table.rows = [(307, EXECUTABLE, arguments)]
                self.assertIsNone(self.find())

    def test_foreign_app_roots_and_spaced_suffixes_are_excluded(self):
        for root in (APP_ROOT + '-other', APP_ROOT + ' other',
                     '/other workspace/apps/desktop'):
            with self.subTest(root=root):
                self.table.rows = [(308, EXECUTABLE, native_arguments(app_root=root))]
                self.assertIsNone(self.find())

    def test_app_root_used_only_as_an_option_value_is_excluded(self):
        self.table.rows = [(309, EXECUTABLE,
                            native_arguments(app_root='/other-app', user_data=APP_ROOT))]
        self.assertIsNone(self.find())

    def test_app_root_after_another_positional_entry_is_excluded(self):
        self.table.rows = [(310, EXECUTABLE,
                            native_arguments(app_root='/other-app ' + APP_ROOT))]
        self.assertIsNone(self.find())

    def test_trailing_positional_arguments_are_conservatively_excluded(self):
        self.table.rows = [(311, EXECUTABLE, native_arguments() + ' opened-file')]
        self.assertIsNone(self.find())

    def test_expected_pid_does_not_switch_to_another_native_owner(self):
        self.table.rows.append((312, EXECUTABLE, native_arguments('9222')))
        self.assertEqual(self.find(expected_pid=312), 312)
        self.assertEqual(self.table.inspected, [312])
        self.assertIsNone(self.find(expected_pid=313))

    def test_expected_pid_still_requires_the_native_app_entry(self):
        self.table.rows = [(313, EXECUTABLE, native_arguments(app_root='/other-app'))]
        self.assertIsNone(self.find(expected_pid=313))

    def test_vanished_pid_is_skipped_for_the_next_native_owner(self):
        vanished = subprocess.CalledProcessError(1, ['/bin/ps', '-p', '314', '-o', 'args='])
        self.table.rows = [(314, EXECUTABLE, vanished),
                           (315, EXECUTABLE, native_arguments('9222'))]
        self.assertEqual(self.find(), 315)

    def test_vanished_expected_pid_does_not_switch_to_another_owner(self):
        vanished = subprocess.CalledProcessError(1, ['/bin/ps', '-p', '314', '-o', 'args='])
        self.table.rows = [(314, EXECUTABLE, vanished),
                           (315, EXECUTABLE, native_arguments())]
        self.assertIsNone(self.find(expected_pid=314))

    def test_unexpected_pid_inspection_failure_propagates_the_original_error(self):
        error = subprocess.CalledProcessError(2, ['/bin/ps', '-p', '316', '-o', 'args='])
        self.table.rows = [(316, EXECUTABLE, error)]
        with self.assertRaises(subprocess.CalledProcessError) as caught:
            self.find()
        self.assertIs(caught.exception, error)

    def test_process_listing_failure_propagates_the_original_error(self):
        error = subprocess.CalledProcessError(1, ['/bin/ps', '-axo', 'pid=,comm='])
        with patch.object(development_owner.subprocess, 'check_output', side_effect=error):
            with self.assertRaises(subprocess.CalledProcessError) as caught:
                self.find()
        self.assertIs(caught.exception, error)

    def test_empty_process_table_has_no_owner(self):
        self.table.rows = []
        self.assertIsNone(self.find())


class ImportTests(unittest.TestCase):
    def test_import_does_not_inspect_or_launch_processes(self):
        with ExitStack() as stack:
            stack.enter_context(patch('subprocess.check_output',
                                      side_effect=AssertionError('inspection on import')))
            stack.enter_context(patch('subprocess.run', side_effect=AssertionError('run on import')))
            stack.enter_context(patch('subprocess.Popen', side_effect=AssertionError('launch on import')))
            importlib.reload(development_owner)


if __name__ == '__main__':
    unittest.main()
