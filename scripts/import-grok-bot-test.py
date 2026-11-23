"""Exercise the local, synthetic attachment side of the Grok Bot importer."""

import hashlib
import importlib.util
import io
import json
import os
import pathlib
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location('import_grok_bot', pathlib.Path(__file__).with_name('import-grok-bot.py'))
assert SPEC is not None and SPEC.loader is not None
importer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(importer)


class ImportGrokBotAttachmentTest(unittest.TestCase):
    def entry(
        self,
        root: pathlib.Path,
        *,
        bot_id: str = 'bot-alpha',
        source_id: str = 'conversation-1',
        sequence: int = 0,
        filename: str = 'research.txt',
        content: bytes = b'synthetic research',
        timestamp_ms: int = 1_700_000_000_000,
    ) -> dict:
        digest = hashlib.sha256(content).hexdigest()
        (root / digest).write_bytes(content)
        return {
            'botId': bot_id,
            'sourceId': source_id,
            'sourceSequence': sequence,
            'filename': filename,
            'timestampMs': timestamp_ms,
            'sha256': digest,
        }

    def manifest(self, root: pathlib.Path, entries: list[dict]) -> None:
        (root / 'manifest.json').write_text(
            json.dumps({'version': 1, 'entries': entries}, separators=(',', ':')) + '\n',
            encoding='utf-8',
        )

    def memory_source(
        self,
        memories: list[dict] | None = None,
        user_facts: list[dict] | None = None,
    ) -> pathlib.Path:
        path = pathlib.Path(self.directory.name) / 'supplemental-memory.json'
        path.write_text(json.dumps({
            'version': 1,
            'memories': memories or [],
            'user_facts': user_facts or [],
        }), encoding='utf-8')
        return path

    def vault(self) -> pathlib.Path:
        root = pathlib.Path(self.directory.name) / f'vault-{len(self.vaults)}'
        root.mkdir(mode=0o700)
        self.vaults.append(root)
        return root

    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.vaults: list[pathlib.Path] = []

    def test_preview_validates_without_creating_destination(self):
        source = self.vault()
        entry = self.entry(source)
        self.manifest(source, [entry])
        destination = pathlib.Path(self.directory.name) / 'preview-destination'

        result = importer.stage_attachments(source, destination, dry_run=True)

        self.assertEqual(result, {
            'dryRun': True,
            'entries': 1,
            'bytes': len(b'synthetic research'),
            'copiedBlobs': 1,
            'reusedBlobs': 0,
            'wroteManifest': True,
        })
        self.assertFalse(destination.exists())

    def test_apply_stages_verified_blob_and_manifest(self):
        source = self.vault()
        entry = self.entry(source)
        self.manifest(source, [entry])
        destination = pathlib.Path(self.directory.name) / 'staged-destination'

        result = importer.stage_attachments(source, destination, dry_run=False)

        self.assertEqual(result['dryRun'], False)
        self.assertEqual(result['copiedBlobs'], 1)
        self.assertEqual(result['reusedBlobs'], 0)
        self.assertTrue(result['wroteManifest'])
        self.assertEqual(json.loads((destination / 'manifest.json').read_text()), {'version': 1, 'entries': [entry]})
        self.assertEqual((destination / entry['sha256']).read_bytes(), b'synthetic research')
        self.assertEqual((destination / entry['sha256']).stat().st_mode & 0o777, 0o400)
        self.assertEqual((destination / 'manifest.json').stat().st_mode & 0o777, 0o600)

    def test_successful_retry_reuses_existing_object_without_rewriting_manifest(self):
        source = self.vault()
        entry = self.entry(source)
        self.manifest(source, [entry])
        destination = pathlib.Path(self.directory.name) / 'retry-destination'
        importer.stage_attachments(source, destination, dry_run=False)
        os.chmod(destination / entry['sha256'], 0o640)
        manifest_before = (destination / 'manifest.json').stat().st_mtime_ns

        result = importer.stage_attachments(source, destination, dry_run=False)

        self.assertEqual(result['copiedBlobs'], 0)
        self.assertEqual(result['reusedBlobs'], 1)
        self.assertFalse(result['wroteManifest'])
        self.assertEqual((destination / 'manifest.json').stat().st_mtime_ns, manifest_before)
        self.assertEqual((destination / entry['sha256']).stat().st_mode & 0o777, 0o640)

    def test_update_merges_new_entry_into_existing_manifest(self):
        original = self.vault()
        first = self.entry(original, sequence=0, filename='first.txt', content=b'first')
        self.manifest(original, [first])
        destination = pathlib.Path(self.directory.name) / 'updated-destination'
        importer.stage_attachments(original, destination, dry_run=False)

        expanded = self.vault()
        (expanded / first['sha256']).write_bytes(b'first')
        second = self.entry(expanded, sequence=1, filename='second.txt', content=b'second')
        self.manifest(expanded, [first, second])

        result = importer.stage_attachments(expanded, destination, dry_run=False)

        self.assertEqual(result['entries'], 2)
        self.assertEqual(result['copiedBlobs'], 1)
        self.assertEqual(result['reusedBlobs'], 1)
        self.assertTrue(result['wroteManifest'])
        self.assertEqual(json.loads((destination / 'manifest.json').read_text())['entries'], [first, second])
        self.assertEqual((destination / second['sha256']).read_bytes(), b'second')

    def test_conflicting_position_is_rejected_before_destination_changes(self):
        initial = self.vault()
        first = self.entry(initial, filename='first.txt', content=b'first')
        self.manifest(initial, [first])
        destination = pathlib.Path(self.directory.name) / 'conflict-destination'
        importer.stage_attachments(initial, destination, dry_run=False)
        manifest_before = (destination / 'manifest.json').read_bytes()

        conflicting = self.vault()
        changed = self.entry(conflicting, filename='changed.txt', content=b'changed')
        self.manifest(conflicting, [changed])

        with self.assertRaisesRegex(importer.ImportErrorDetail, 'Conflicting Grok history attachment position'):
            importer.stage_attachments(conflicting, destination, dry_run=False)
        self.assertEqual((destination / 'manifest.json').read_bytes(), manifest_before)
        self.assertEqual((destination / first['sha256']).read_bytes(), b'first')

    def test_source_hash_mismatch_is_rejected(self):
        source = self.vault()
        entry = self.entry(source)
        self.manifest(source, [entry])
        (source / entry['sha256']).write_bytes(b'tampered source')
        destination = pathlib.Path(self.directory.name) / 'hash-destination'

        with self.assertRaisesRegex(importer.ImportErrorDetail, 'attachment object is not verified'):
            importer.stage_attachments(source, destination, dry_run=True)
        self.assertFalse(destination.exists())

    def test_destination_hash_mismatch_is_rejected_on_retry(self):
        source = self.vault()
        entry = self.entry(source)
        self.manifest(source, [entry])
        destination = pathlib.Path(self.directory.name) / 'bad-destination'
        importer.stage_attachments(source, destination, dry_run=False)
        os.chmod(destination / entry['sha256'], 0o600)
        (destination / entry['sha256']).write_bytes(b'tampered destination')

        with self.assertRaisesRegex(importer.ImportErrorDetail, 'attachment object is not verified'):
            importer.stage_attachments(source, destination, dry_run=True)

    def test_invalid_absolute_and_symlink_paths_are_rejected(self):
        source = self.vault()
        entry = self.entry(source)
        self.manifest(source, [entry])
        destination = pathlib.Path(self.directory.name) / 'path-destination'
        with self.assertRaisesRegex(importer.ImportErrorDetail, 'paths must be absolute'):
            importer.stage_attachments(pathlib.Path('relative-source'), destination, dry_run=True)

        source_link = pathlib.Path(self.directory.name) / 'source-link'
        source_link.symlink_to(source, target_is_directory=True)
        with self.assertRaisesRegex(importer.ImportErrorDetail, 'source attachment vault must be a regular directory'):
            importer.stage_attachments(source_link, destination, dry_run=True)

        destination_link = pathlib.Path(self.directory.name) / 'destination-link'
        destination_link.symlink_to(destination, target_is_directory=True)
        with self.assertRaisesRegex(importer.ImportErrorDetail, 'destination attachment vault must be a regular directory'):
            importer.stage_attachments(source, destination_link, dry_run=True)

    def test_invalid_manifest_filename_cannot_escape_attachment_vault(self):
        source = self.vault()
        entry = self.entry(source, filename='../outside.txt')
        self.manifest(source, [entry])
        destination = pathlib.Path(self.directory.name) / 'filename-destination'

        with self.assertRaisesRegex(importer.ImportErrorDetail, 'Invalid Grok history attachment source manifest'):
            importer.stage_attachments(source, destination, dry_run=True)

    def test_concurrent_disjoint_applies_preserve_both_positions(self):
        first_source = self.vault()
        first = self.entry(first_source, source_id='conversation-first', content=b'first concurrent blob')
        self.manifest(first_source, [first])
        second_source = self.vault()
        second = self.entry(second_source, source_id='conversation-second', content=b'second concurrent blob')
        self.manifest(second_source, [second])
        destination = pathlib.Path(self.directory.name) / 'concurrent-destination'
        start = threading.Barrier(2)

        def apply(source: pathlib.Path) -> dict:
            start.wait()
            return importer.stage_attachments(source, destination, dry_run=False)

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(apply, (first_source, second_source)))

        self.assertEqual(sorted(result['entries'] for result in results), [1, 2])
        self.assertTrue(all(result['copiedBlobs'] == 1 for result in results))
        self.assertTrue(all(result['wroteManifest'] for result in results))
        merged = json.loads((destination / 'manifest.json').read_text())['entries']
        self.assertEqual(
            {importer._position(entry) for entry in merged},
            {importer._position(first), importer._position(second)},
        )
        self.assertEqual((destination / first['sha256']).read_bytes(), b'first concurrent blob')
        self.assertEqual((destination / second['sha256']).read_bytes(), b'second concurrent blob')

    def test_attachments_only_mode_previews_and_applies_without_connecting(self):
        source = self.vault()
        entry = self.entry(source)
        self.manifest(source, [entry])
        destination = pathlib.Path(self.directory.name) / 'attachments-only-destination'

        def fail_connect():
            raise AssertionError('attachments-only mode must not contact Y Harness')

        with (
            patch.object(importer, 'connect', side_effect=fail_connect),
            patch.dict('os.environ', {'DSH_GROK_HISTORY_ATTACHMENT_VAULT': str(destination)}),
            patch('sys.argv', [
                str(pathlib.Path(importer.__file__)), '--attachments-only', '--attachments', str(source),
            ]),
            patch('sys.stdout', new_callable=io.StringIO) as output,
        ):
            importer.main()
        preview = json.loads(output.getvalue())
        self.assertEqual(preview['mode'], 'attachments-only')
        self.assertTrue(preview['attachments']['dryRun'])
        self.assertFalse(destination.exists())

        with (
            patch.object(importer, 'connect', side_effect=fail_connect),
            patch.dict('os.environ', {'DSH_GROK_HISTORY_ATTACHMENT_VAULT': str(destination)}),
            patch('sys.argv', [
                str(pathlib.Path(importer.__file__)), '--attachments-only', '--attachments', str(source), '--apply',
            ]),
            patch('sys.stdout', new_callable=io.StringIO) as output,
        ):
            importer.main()
        applied = json.loads(output.getvalue())
        self.assertEqual(applied['mode'], 'attachments-only')
        self.assertFalse(applied['attachments']['dryRun'])
        self.assertTrue((destination / 'manifest.json').exists())

    def test_apply_recovers_verified_orphan_object_left_without_manifest(self):
        source = self.vault()
        entry = self.entry(source)
        self.manifest(source, [entry])
        destination = pathlib.Path(self.directory.name) / 'orphan-destination'
        destination.mkdir(mode=0o700)
        (destination / entry['sha256']).write_bytes(b'synthetic research')
        os.chmod(destination / entry['sha256'], 0o400)

        result = importer.stage_attachments(source, destination, dry_run=False)

        self.assertEqual(result['copiedBlobs'], 0)
        self.assertEqual(result['reusedBlobs'], 1)
        self.assertTrue(result['wroteManifest'])
        self.assertEqual(json.loads((destination / 'manifest.json').read_text())['entries'], [entry])

    def test_apply_repairs_missing_object_referenced_by_existing_manifest(self):
        source = self.vault()
        entry = self.entry(source)
        self.manifest(source, [entry])
        destination = pathlib.Path(self.directory.name) / 'repair-destination'
        importer.stage_attachments(source, destination, dry_run=False)
        (destination / entry['sha256']).unlink()

        result = importer.stage_attachments(source, destination, dry_run=False)

        self.assertEqual(result['copiedBlobs'], 1)
        self.assertEqual(result['reusedBlobs'], 0)
        self.assertFalse(result['wroteManifest'])
        self.assertEqual((destination / entry['sha256']).read_bytes(), b'synthetic research')

    def test_unrelated_oversized_legacy_blob_does_not_block_repair(self):
        source = self.vault()
        target = self.entry(source, source_id='conversation-target', content=b'restored target')
        self.manifest(source, [target])

        destination = pathlib.Path(self.directory.name) / 'legacy-destination'
        destination.mkdir(mode=0o700)
        legacy_content = b'legacy expected bytes'
        legacy = {
            'botId': 'bot-alpha',
            'sourceId': 'conversation-legacy',
            'sourceSequence': 7,
            'filename': 'legacy.bin',
            'timestampMs': 1_700_000_000_001,
            'sha256': hashlib.sha256(legacy_content).hexdigest(),
        }
        self.manifest(destination, [legacy, target])
        legacy_path = destination / legacy['sha256']
        with legacy_path.open('wb') as blob:
            blob.truncate(importer.MAX_ATTACHMENT_BYTES + 1)
        legacy_size = legacy_path.stat().st_size
        manifest_before = (destination / 'manifest.json').read_bytes()

        result = importer.stage_attachments(source, destination, dry_run=False)

        self.assertEqual(result['entries'], 2)
        self.assertEqual(result['copiedBlobs'], 1)
        self.assertEqual(result['reusedBlobs'], 0)
        self.assertFalse(result['wroteManifest'])
        self.assertEqual(legacy_path.stat().st_size, legacy_size)
        self.assertEqual((destination / 'manifest.json').read_bytes(), manifest_before)
        self.assertEqual((destination / target['sha256']).read_bytes(), b'restored target')

    def test_oversized_merged_manifest_is_rejected_without_writes(self):
        content = b'shared bulk fixture'
        digest = hashlib.sha256(content).hexdigest()

        def bulk_vault(prefix: str, count: int, start: int) -> tuple[pathlib.Path, list[dict]]:
            root = self.vault()
            (root / digest).write_bytes(content)
            entries = [{
                'botId': 'bot-alpha',
                'sourceId': f'{prefix}-{index:05d}',
                'sourceSequence': start + index,
                'filename': f'{prefix}-{index:05d}.txt',
                'timestampMs': 1_700_000_000_000,
                'sha256': digest,
            } for index in range(count)]
            self.manifest(root, entries)
            return root, entries

        destination, existing = bulk_vault('destination', 8_500, 0)
        source, incoming = bulk_vault('source', 2_500, 20_000)
        destination_manifest = (destination / 'manifest.json').read_bytes()
        source_manifest = (source / 'manifest.json').read_bytes()
        self.assertLess(len(destination_manifest), importer.MAX_MANIFEST_BYTES)
        self.assertLess(len(source_manifest), importer.MAX_MANIFEST_BYTES)
        self.assertGreater(len(json.dumps(
            {'version': 1, 'entries': existing + incoming}, separators=(',', ':')
        ).encode()), importer.MAX_MANIFEST_BYTES)

        with self.assertRaisesRegex(importer.ImportErrorDetail, '(?i)manifest.*(large|size)'):
            importer.stage_attachments(source, destination, dry_run=False)
        self.assertEqual((destination / 'manifest.json').read_bytes(), destination_manifest)
        self.assertEqual((source / 'manifest.json').read_bytes(), source_manifest)

    def test_main_filters_to_requested_bot_and_keeps_preview_read_only(self):
        source = self.vault()
        entry = self.entry(source, bot_id='bot-alpha')
        selected = self.entry(source, bot_id='bot-beta', content=b'selected attachment')
        self.manifest(source, [entry, selected])
        destination = pathlib.Path(self.directory.name) / 'main-destination'
        export = pathlib.Path(self.directory.name) / 'grok-export.json'
        export.write_text('{"bot":"beta"}\n', encoding='utf-8')
        calls = []

        class Connection:
            def __init__(self):
                self.closed = False

            def close(self):
                self.closed = True

        connection = Connection()

        def invoke(_connection, _cookie, endpoint, **args):
            calls.append((endpoint, args))
            if endpoint == 'bots/list':
                return {'bots': [
                    {'id': 'bot-alpha', 'name': 'Alpha'},
                    {'id': 'bot-beta', 'name': 'Beta'},
                ]}
            self.assertEqual(endpoint, 'bots/importGrokBot')
            return {'imported': True}

        with (
            patch.object(importer, 'connect', return_value=(connection, 'fixture-cookie')),
            patch.object(importer, 'invoke', side_effect=invoke),
            patch.dict('os.environ', {'DSH_GROK_HISTORY_ATTACHMENT_VAULT': str(destination)}),
            patch('sys.argv', [
                str(pathlib.Path(importer.__file__)), str(export), '--bot', 'bot-beta',
                '--attachments', str(source),
            ]),
            patch('sys.stdout', new_callable=io.StringIO) as output,
        ):
            importer.main()

        decoded = json.loads(output.getvalue())
        self.assertEqual(decoded['mode'], 'preview')
        self.assertEqual(decoded['attachments']['entries'], 1)
        self.assertEqual(decoded['attachments']['copiedBlobs'], 1)
        self.assertEqual(calls[1][0], 'bots/importGrokBot')
        self.assertEqual(calls[1][1]['request']['botId'], 'bot-beta')
        self.assertTrue(calls[1][1]['request']['preview'])
        self.assertFalse(destination.exists())
        self.assertTrue(connection.closed)

    def test_memory_source_preview_skips_truncated_and_deduplicates_without_profile_fields(self):
        source = self.memory_source(
            memories=[{'text': 'New memory', 'truncated': False}],
            user_facts=[
                {'text': ' New memory ', 'truncated': False},
                {'text': 'Incomplete fragment', 'truncated': True},
            ],
        )
        calls = []

        class Connection:
            def close(self):
                pass

        def invoke(_connection, _cookie, endpoint, **kwargs):
            calls.append((endpoint, kwargs))
            if endpoint == 'bots/list':
                return {'bots': [{'id': 'bot-destination', 'name': 'Destination'}]}
            self.assertEqual(endpoint, 'bots/importGrokBot')
            document = json.loads(kwargs['request']['document'])
            bot = document['bots'][0]
            self.assertNotIn('persona', bot)
            self.assertEqual(bot['memories'], ['New memory'])
            self.assertEqual(bot['user_facts'], [])
            self.assertEqual(bot['skills'], [])
            self.assertEqual(bot['routines'], [])
            self.assertTrue(kwargs['request']['preview'])
            self.assertTrue(kwargs['request']['memoryOnly'])
            return {
                'memories': 1, 'skills': 0, 'routines': 0, 'missingRoutineSkills': [],
                'memoryCapacity': {'existingRecords': 1, 'newRecords': 1, 'limit': 256},
            }

        with (
            patch.object(importer, 'connect', return_value=(Connection(), 'fixture-cookie')),
            patch.object(importer, 'invoke', side_effect=invoke),
            patch('sys.argv', [
                str(pathlib.Path(importer.__file__)), '--memory-source', str(source), '--bot', 'bot-destination',
            ]),
            patch('sys.stdout', new_callable=io.StringIO) as output,
        ):
            importer.main()

        decoded = json.loads(output.getvalue())
        self.assertEqual(decoded['mode'], 'memory-preview')
        self.assertEqual(decoded['memorySource'], {
            'sourceRecords': 3,
            'usableRecords': 1,
            'duplicateRecords': 1,
            'skippedTruncated': 1,
            'memoryCapacity': {'existingRecords': 1, 'newRecords': 1, 'limit': 256},
        })
        self.assertEqual([endpoint for endpoint, _ in calls], ['bots/list', 'bots/importGrokBot'])

    def test_memory_source_skips_invalid_usable_text_when_marked_truncated(self):
        source = self.memory_source(memories=[
            {'text': '', 'truncated': True},
            {'text': 'x' * 2_001, 'truncated': True},
            {'text': 'Usable memory', 'truncated': False},
        ])

        document, stats = importer._read_memory_source(source)

        decoded = json.loads(document)
        self.assertEqual(decoded['bots'][0]['memories'], ['Usable memory'])
        self.assertEqual(stats, {
            'sourceRecords': 3,
            'usableRecords': 1,
            'duplicateRecords': 0,
            'skippedTruncated': 2,
        })

    def test_memory_source_rejects_non_integer_version_and_truncated_flag(self):
        version_source = self.memory_source(memories=[])
        version_source.write_text(json.dumps({
            'version': 1.0, 'memories': [], 'user_facts': [],
        }), encoding='utf-8')
        with self.assertRaises(importer.ImportErrorDetail):
            importer._read_memory_source(version_source)

        flag_source = self.memory_source(memories=[{'text': 'Memory', 'truncated': 'true'}])
        with self.assertRaises(importer.ImportErrorDetail):
            importer._read_memory_source(flag_source)

    def test_memory_source_apply_is_idempotent_across_retry(self):
        source = self.memory_source(memories=[{'text': 'Retry-safe memory', 'truncated': False}])
        memory_rows = [{'id': 'memory-existing', 'text': 'Existing memory'}]
        import_requests = []

        class Connection:
            def close(self):
                pass

        def invoke(_connection, _cookie, endpoint, **kwargs):
            if endpoint == 'bots/list':
                return {'bots': [{'id': 'bot-destination', 'name': 'Destination'}]}
            self.assertEqual(endpoint, 'bots/importGrokBot')
            request = kwargs['request']
            import_requests.append(request)
            document = json.loads(request['document'])
            if request['preview']:
                new_records = 0 if document['bots'][0]['memories'][0] in [row['text'] for row in memory_rows] else 1
                return {
                    'memories': 1, 'skills': 0, 'routines': 0, 'missingRoutineSkills': [],
                    'memoryCapacity': {
                        'existingRecords': len(memory_rows), 'newRecords': new_records, 'limit': 256,
                    },
                }
            existing_records = len(memory_rows)
            new_records = 0 if document['bots'][0]['memories'][0] in [row['text'] for row in memory_rows] else 1
            if document['bots'][0]['memories'][0] not in [row['text'] for row in memory_rows]:
                memory_rows.append({'id': 'memory-retry-safe', 'text': document['bots'][0]['memories'][0]})
            return {
                'memories': 1, 'skills': 0, 'routines': 0, 'missingRoutineSkills': [],
                'memoryCapacity': {'existingRecords': existing_records, 'newRecords': new_records, 'limit': 256},
            }

        def run() -> dict:
            with (
                patch.object(importer, 'connect', return_value=(Connection(), 'fixture-cookie')),
                patch.object(importer, 'invoke', side_effect=invoke),
                patch('sys.argv', [
                    str(pathlib.Path(importer.__file__)), '--memory-source', str(source), '--bot', 'bot-destination', '--apply',
                ]),
                patch('sys.stdout', new_callable=io.StringIO) as output,
            ):
                importer.main()
            return json.loads(output.getvalue())

        first = run()
        second = run()
        self.assertEqual(first['memorySource']['memoryCapacity']['newRecords'], 1)
        self.assertEqual(second['memorySource']['memoryCapacity']['newRecords'], 0)
        self.assertEqual(len(memory_rows), 2)
        self.assertEqual(len(import_requests), 4)
        self.assertTrue(import_requests[0]['preview'])
        self.assertFalse(import_requests[1]['preview'])
        self.assertTrue(import_requests[2]['preview'])
        self.assertFalse(import_requests[3]['preview'])
        self.assertTrue(all(request['memoryOnly'] for request in import_requests))

    def test_memory_source_accepts_more_than_the_removed_cli_limit(self):
        source = self.memory_source(memories=[
            {'text': f'Memory {index}', 'truncated': False} for index in range(101)
        ])
        requests = []

        class Connection:
            def close(self):
                pass

        def invoke(_connection, _cookie, endpoint, **kwargs):
            if endpoint == 'bots/list':
                return {'bots': [{'id': 'bot-destination', 'name': 'Destination'}]}
            self.assertEqual(endpoint, 'bots/importGrokBot')
            requests.append(kwargs['request'])
            return {
                'memories': 101, 'skills': 0, 'routines': 0, 'missingRoutineSkills': [],
                'memoryCapacity': {'existingRecords': 0, 'newRecords': 101, 'limit': 256},
            }

        with (
            patch.object(importer, 'connect', return_value=(Connection(), 'fixture-cookie')),
            patch.object(importer, 'invoke', side_effect=invoke),
            patch('sys.argv', [
                str(pathlib.Path(importer.__file__)), '--memory-source', str(source), '--bot', 'bot-destination',
            ]),
            patch('sys.stdout', new_callable=io.StringIO) as output,
        ):
            importer.main()

        decoded = json.loads(output.getvalue())
        self.assertEqual(decoded['memorySource']['usableRecords'], 101)
        self.assertEqual(decoded['memorySource']['memoryCapacity']['newRecords'], 101)
        self.assertTrue(requests[0]['memoryOnly'])

    def test_legacy_capacity_preview_does_not_invent_host_counts(self):
        source = self.memory_source(memories=[{'text': 'Legacy capacity', 'truncated': False}])
        calls = []

        class Connection:
            def close(self):
                pass

        def invoke(_connection, _cookie, endpoint, **kwargs):
            calls.append(endpoint)
            if endpoint == 'bots/list':
                return {'bots': [{'id': 'bot-full', 'name': 'Full'}]}
            raise importer.RemoteRequestError(
                endpoint, 'gateway/bad-request', importer.MEMORY_CAPACITY_ERROR,
            )

        with (
            patch.object(importer, 'connect', return_value=(Connection(), 'fixture-cookie')),
            patch.object(importer, 'invoke', side_effect=invoke),
            patch('sys.argv', [
                str(pathlib.Path(importer.__file__)), '--memory-source', str(source), '--bot', 'bot-full',
            ]),
            patch('sys.stdout', new_callable=io.StringIO) as output,
        ):
            importer.main()

        decoded = json.loads(output.getvalue())
        self.assertEqual(decoded['blocked'], 'memory-capacity')
        self.assertNotIn('memoryCapacity', decoded['memorySource'])
        self.assertEqual(calls, ['bots/list', 'bots/importGrokBot'])

    def test_invoke_preserves_structured_remote_error_code(self):
        class Response:
            status = 200

            def read(self):
                return json.dumps({
                    'type': 'server-response', 'rpcId': self.rpc_id,
                    'result': {'ok': False, 'error': {
                        'code': 'gateway/bad-request', 'message': 'Synthetic rejection', 'details': {},
                    }},
                }).encode()

        class Connection:
            def request(self, _method, _path, body, headers):
                del headers
                self.rpc_id = json.loads(body)['rpcId']

            def getresponse(self):
                response = Response()
                response.rpc_id = self.rpc_id
                return response

        with self.assertRaises(importer.RemoteRequestError) as raised:
            importer.invoke(Connection(), 'fixture-cookie', 'bots/importGrokBot', request={})
        self.assertEqual(raised.exception.code, 'gateway/bad-request')
        self.assertEqual(raised.exception.remote_message, 'Synthetic rejection')

    def test_memory_source_capacity_preview_reports_block_before_import(self):
        source = self.memory_source(memories=[{'text': 'One more memory', 'truncated': False}])
        calls = []

        class Connection:
            def close(self):
                pass

        def invoke(_connection, _cookie, endpoint, **kwargs):
            calls.append(endpoint)
            if endpoint == 'bots/list':
                return {'bots': [{'id': 'bot-full', 'name': 'Full'}]}
            self.assertEqual(endpoint, 'bots/importGrokBot')
            self.assertTrue(kwargs['request']['preview'])
            self.assertTrue(kwargs['request']['memoryOnly'])
            return {
                'memories': 1, 'skills': 0, 'routines': 0, 'missingRoutineSkills': [],
                'memoryCapacity': {'existingRecords': 100, 'newRecords': 1, 'limit': 100},
            }

        with (
            patch.object(importer, 'connect', return_value=(Connection(), 'fixture-cookie')),
            patch.object(importer, 'invoke', side_effect=invoke),
            patch('sys.argv', [
                str(pathlib.Path(importer.__file__)), '--memory-source', str(source), '--bot', 'bot-full',
            ]),
            patch('sys.stderr', new_callable=io.StringIO),
            patch('sys.stdout', new_callable=io.StringIO) as output,
        ):
            importer.main()

        decoded = json.loads(output.getvalue())
        self.assertEqual(decoded['mode'], 'memory-preview')
        self.assertEqual(decoded['blocked'], 'memory-capacity')
        self.assertEqual(decoded['memorySource']['memoryCapacity'], {
            'existingRecords': 100, 'newRecords': 1, 'limit': 100,
        })
        self.assertEqual(calls, ['bots/list', 'bots/importGrokBot'])

        calls.clear()
        with (
            patch.object(importer, 'connect', return_value=(Connection(), 'fixture-cookie')),
            patch.object(importer, 'invoke', side_effect=invoke),
            patch('sys.argv', [
                str(pathlib.Path(importer.__file__)), '--memory-source', str(source), '--bot', 'bot-full', '--apply',
            ]),
            patch('sys.stderr', new_callable=io.StringIO),
        ):
            with self.assertRaises(SystemExit) as error:
                importer.main()
        self.assertEqual(error.exception.code, 1)
        self.assertEqual(calls, ['bots/list', 'bots/importGrokBot'])

    def test_memory_source_rejects_malformed_host_capacity(self):
        source = self.memory_source(memories=[{'text': 'Malformed capacity', 'truncated': False}])
        calls = []

        class Connection:
            def close(self):
                pass

        def invoke(_connection, _cookie, endpoint, **kwargs):
            calls.append(endpoint)
            if endpoint == 'bots/list':
                return {'bots': [{'id': 'bot-destination', 'name': 'Destination'}]}
            self.assertEqual(kwargs['request']['memoryOnly'], True)
            return {
                'memories': 1, 'skills': 0, 'routines': 0, 'missingRoutineSkills': [],
                'memoryCapacity': {'existingRecords': 1, 'newRecords': 1},
            }

        with (
            patch.object(importer, 'connect', return_value=(Connection(), 'fixture-cookie')),
            patch.object(importer, 'invoke', side_effect=invoke),
            patch('sys.argv', [
                str(pathlib.Path(importer.__file__)), '--memory-source', str(source), '--bot', 'bot-destination',
            ]),
            patch('sys.stderr', new_callable=io.StringIO) as error_output,
        ):
            with self.assertRaises(SystemExit) as error:
                importer.main()

        self.assertEqual(error.exception.code, 1)
        self.assertIn(importer.MEMORY_CAPACITY_WIRE_ERROR, error_output.getvalue())
        self.assertEqual(calls, ['bots/list', 'bots/importGrokBot'])


if __name__ == '__main__':
    unittest.main()
