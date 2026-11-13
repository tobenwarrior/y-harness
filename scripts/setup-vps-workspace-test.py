"""Exercise the dedicated account's persistent legacy workspace mapping."""

import importlib.util
import pathlib
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location('workspace_setup', pathlib.Path(__file__).with_name('setup-vps-workspace.py'))
assert SPEC is not None and SPEC.loader is not None
setup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(setup)


class WorkspaceSetupTest(unittest.TestCase):
    def test_map_preserves_workspace_path_in_only_the_cloud_user_manager(self):
        owner = SimpleNamespace(pw_dir='/home/operator', pw_uid=1001, pw_gid=1002)
        cloud = SimpleNamespace(pw_uid=721, pw_gid=722)
        mount, manager = setup.workspace_units(owner, cloud, pathlib.Path('/var/lib/yharness-cloud-data'), 'fixture.mount')
        self.assertIn('What=/home/operator/.yharness-vps/workspace\n', mount.decode())
        self.assertIn('Where=/var/lib/yharness-cloud-data/workspace\n', mount.decode())
        self.assertIn('Options=bind,nosuid,nodev,X-mount.idmap=u:1001:721:1 g:1002:722:1\n', mount.decode())
        self.assertIn('Requires=fixture.mount\n', manager.decode())
        self.assertIn('After=fixture.mount\n', manager.decode())
        self.assertIn('TemporaryFileSystem=/home/operator:ro,mode=0755\n', manager.decode())
        self.assertIn('BindPaths=/var/lib/yharness-cloud-data:/home/operator/.yharness-vps:rbind\n', manager.decode())
        self.assertNotIn('BindPaths=/home/operator', manager.decode())

    def test_rejects_root_or_shared_identities_and_paths_outside_regular_homes(self):
        cloud = SimpleNamespace(pw_uid=721, pw_gid=722)
        for home, uid, gid in (
            ('/home/operator', 0, 1002),
            ('/home/operator', 1001, 0),
            ('/home/operator', 721, 1002),
            ('/home/operator', 1001, 722),
            ('/home', 1001, 1002),
            ('/home/operator/child', 1001, 1002),
            ('/home/operator%h', 1001, 1002),
            ('/home/../root', 1001, 1002),
        ):
            with self.subTest(home=home, uid=uid, gid=gid), self.assertRaises(setup.AccountError):
                setup.workspace_units(SimpleNamespace(pw_dir=home, pw_uid=uid, pw_gid=gid), cloud,
                                      pathlib.Path('/var/lib/yharness-cloud-data'), 'fixture.mount')

    def test_refuses_to_replace_the_workspace_or_follow_a_link(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            existing = root / 'existing'
            existing.mkdir(mode=0o700)
            data = existing / 'marker'
            data.write_text('saved workspace')
            link = root / 'link'
            link.symlink_to(existing)
            with self.assertRaises(setup.AccountError):
                setup.require_directory(link, existing.stat().st_uid, existing.stat().st_gid)
            with self.assertRaises(setup.AccountError):
                setup.prepare_mountpoint(existing)
            self.assertEqual(data.read_text(), 'saved workspace')

    def test_unit_rejects_changes_to_an_existing_configuration(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / 'fixture.mount'
            path.write_bytes(b'custom administrator configuration')
            with self.assertRaises(setup.AccountError):
                setup.check_unit(path, b'managed workspace mapping')
            self.assertEqual(path.read_bytes(), b'custom administrator configuration')

    def test_mountpoint_check_rejects_an_empty_bind_on_the_same_filesystem(self):
        with (
            tempfile.TemporaryDirectory() as folder,
            patch.object(setup, 'require_directory'),
            patch.object(setup, 'mount_points', return_value={pathlib.Path(folder)}),
            self.assertRaises(setup.AccountError),
        ):
            setup.prepare_mountpoint(pathlib.Path(folder))

    def test_mountinfo_decodes_spaces_without_adopting_an_ordinary_directory(self):
        content = '1 0 1:1 / / rw - ext4 /dev/example rw\n2 1 1:1 /sample /private/sample\\040directory rw - ext4 /dev/example rw\n'
        self.assertEqual(setup.parse_mount_points(content), {pathlib.Path('/'), pathlib.Path('/private/sample directory')})

    def test_unrelated_data_is_rejected_before_widening_access(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            private = root / 'unrelated'
            private.write_text('private fixture')
            with (
                patch.object(setup, 'require_directory', return_value=SimpleNamespace(st_gid=0, st_mode=0o700)),
                patch.object(setup, 'mount_points', return_value=set()),
                patch.object(setup.os, 'chown') as change,
                self.assertRaises(setup.AccountError),
            ):
                setup.prepare_data_root(root, 721)
            self.assertFalse(change.called)
            self.assertEqual(private.read_text(), 'private fixture')

    def test_mounted_data_root_is_rejected_before_widening_access(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            with (
                patch.object(setup, 'require_directory', return_value=SimpleNamespace(st_gid=0, st_mode=0o700)),
                patch.object(setup, 'mount_points', return_value={root}),
                patch.object(setup.os, 'chown') as change,
                self.assertRaises(setup.AccountError),
            ):
                setup.prepare_data_root(root, 721)
            self.assertFalse(change.called)

    def test_does_not_create_a_new_manager_namespace_for_an_active_account(self):
        owner = SimpleNamespace(pw_dir='/home/operator', pw_uid=1001, pw_gid=1002)
        cloud = SimpleNamespace(pw_uid=721, pw_gid=722)
        with (
            patch.object(setup, 'read_accounts', return_value=(owner, cloud)),
            patch.object(setup, 'legacy_workspace'),
            patch.object(setup, 'command', side_effect=['active', 'fixture.mount']) as execute,
            patch.object(setup, 'prepare_mountpoint') as mountpoint,
            patch.object(setup, 'install_unit') as write,
            self.assertRaises(setup.AccountError),
        ):
            setup.prepare('operator')
        self.assertFalse(mountpoint.called)
        self.assertFalse(write.called)
        self.assertEqual(execute.call_args_list[0].args[0][-1], 'user@721.service')


if __name__ == '__main__':
    unittest.main()
