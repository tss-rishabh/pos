"""Regression for stale ordinary patches omitting the shared metadata reader.

No upstream application, database, Go toolchain or service is started.
"""
from pathlib import Path
import shutil
import tempfile
import unittest

from assemble_payments import ROOT, verify_membership_metadata_base


class MembershipMetadataPackaging(unittest.TestCase):
    required = ('membership.go', 'screening_head_metadata.go',
                'screening_head_metadata_definition.go')

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='pos-base-metadata-test-')
        self.addCleanup(self.temporary.cleanup)
        self.tree = Path(self.temporary.name)
        self.package = self.tree / 'internal/poscheckout'
        self.package.mkdir(parents=True)
        self.canonical = ROOT / 'go/internal/poscheckout'
        for name in self.required:
            shutil.copyfile(self.canonical / name, self.package / name)

    def test_exact_current_consumer_and_reader_are_accepted(self):
        verify_membership_metadata_base(self.tree)

    def test_each_missing_or_stale_component_is_refused(self):
        for name in self.required:
            target = self.package / name
            original = target.read_bytes()
            for fault in ('missing', 'stale'):
                with self.subTest(component=name, fault=fault):
                    target.unlink()
                    if fault == 'stale':
                        target.write_bytes(original + b'\n// different source revision\n')
                    with self.assertRaisesRegex(RuntimeError, '^PAYMENTS_SOURCE_ASSEMBLY_UNAVAILABLE$'):
                        verify_membership_metadata_base(self.tree)
                    target.write_bytes(original)

    def test_symlinks_cannot_substitute_for_owned_packaged_files(self):
        for name in self.required:
            with self.subTest(component=name):
                target = self.package / name
                target.unlink()
                target.symlink_to(self.canonical / name)
                with self.assertRaisesRegex(RuntimeError, '^PAYMENTS_SOURCE_ASSEMBLY_UNAVAILABLE$'):
                    verify_membership_metadata_base(self.tree)
                target.unlink()
                shutil.copyfile(self.canonical / name, target)


if __name__ == '__main__':
    unittest.main()
