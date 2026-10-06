"""Offline checks for the pinned PyInstaller archive signing adapter."""

import importlib.util
from pathlib import Path
import struct
import tempfile
import types
import unittest
from unittest.mock import patch
import zlib

from PyInstaller.archive.readers import CArchiveReader

spec = importlib.util.spec_from_file_location("mac_frozen", Path(__file__).with_name("mac-frozen.py"))
frozen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(frozen)


def fixture(file):
    # Independently encode a onefile fixture, including a foreign Python
    # version, repeated options, a symlink and opaque script/PYZ bytecode.
    entries = [
        ("Python", b"\xcf\xfa\xed\xfe" + b"native-python", "b", 1),
        ("../unsafe/module.so", b"\xcf\xfa\xed\xfe" + b"native-extension", "b", 0),
        ("certifi/tests/test_certify.py", b"ordinary package data", "b", 0),
        ("main", b"opaque-script-bytecode", "s", 1),
        ("PYZ.pyz", b"opaque-PYZ-bytecode", "z", 0),
        ("alias", b"Python\0", "n", 0),
        ("v", b"", "o", 0),
        ("v", b"", "o", 0),
    ]
    payload = b""
    table = b""
    for name, raw, kind, compressed in entries:
        data = zlib.compress(raw) if compressed else raw
        name = name.encode() + b"\0"
        size = (18 + len(name) + 15) // 16 * 16
        table += struct.pack("!IIIIBc", size, len(payload), len(data), len(raw), compressed, kind.encode())
        table += name.ljust(size - 18, b"\0")
        payload += data
    cookie = struct.pack("!8sIIII64s", b"MEI\014\013\012\013\016",
                         len(payload) + len(table) + 88, len(payload), len(table), 313, b"Python")
    file.write_bytes(b"bootloader-prefix" + payload + table + cookie)
    return entries


class FrozenArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.binary = self.root / "executable"
        self.entries = fixture(self.binary)

    def test_rebuild_preserves_python_version_options_and_all_non_native_bytes(self):
        replacement = b"\xcf\xfa\xed\xfe" + b"new-signature-of-different-length"
        frozen.rebuild_archive(self.binary, {"Python": replacement})
        archive = CArchiveReader(str(self.binary))
        self.assertEqual(archive.options, ["v", "v"])
        for name, raw, kind, _ in self.entries:
            if kind != "o":
                self.assertEqual(archive.extract(name), replacement if name == "Python" else raw)
        cookie = self.binary.read_bytes()[-88:]
        self.assertEqual(struct.unpack("!8sIIII64s", cookie)[4], 313)
        self.assertTrue(self.binary.read_bytes().startswith(b"bootloader-prefix"))

    def test_inventory_never_extracts_archive_paths(self):
        output = self.root / "extract"
        output.mkdir()
        result = frozen.extract_native(self.binary, output)
        self.assertEqual(len(result), 2)
        self.assertEqual(result[1]["label"], "../unsafe/module.so")
        self.assertFalse((self.root / "unsafe").exists())
        for entry in result:
            self.assertEqual(Path(entry["file"]).parent, output)
            self.assertTrue(frozen.is_macho(Path(entry["file"]).read_bytes()))

    def test_bad_native_format_fails_closed(self):
        frozen.rebuild_archive(self.binary, {"Python": b"not-Mach-O"})
        with self.assertRaisesRegex(ValueError, "not Mach-O"):
            list(frozen.native_entries(CArchiveReader(str(self.binary))))

    def test_signing_repackages_signed_libraries_and_repairs_container(self):
        calls = []
        repaired = []

        def codesign(args, check):
            calls.append(args)
            if "--force" in args:
                file = Path(args[-1])
                file.write_bytes(file.read_bytes() + b"signed")

        fake_osx = types.SimpleNamespace(fix_exe_for_code_signing=lambda file: repaired.append(file))
        with patch.dict("sys.modules", {"PyInstaller.utils.osx": fake_osx}), \
                patch.object(frozen.subprocess, "run", side_effect=codesign):
            frozen.sign_payload(self.binary, "IDENTITY", "private.keychain")
        self.assertEqual(len(repaired), 1)
        signatures = [args for args in calls if "--force" in args]
        self.assertEqual(len(signatures), 2)
        for args in signatures:
            self.assertIn("--timestamp", args)
            self.assertIn("runtime", args)
            self.assertIn("private.keychain", args)
        for _, data in frozen.native_entries(CArchiveReader(str(self.binary))):
            self.assertTrue(data.endswith(b"signed"))

    def test_failed_signature_does_not_modify_packaged_executable(self):
        original = self.binary.read_bytes()
        fake_osx = types.SimpleNamespace(fix_exe_for_code_signing=lambda _: None)
        with patch.dict("sys.modules", {"PyInstaller.utils.osx": fake_osx}), \
                patch.object(frozen.subprocess, "run", side_effect=RuntimeError("signing failed")):
            with self.assertRaisesRegex(RuntimeError, "signing failed"):
                frozen.sign_payload(self.binary, "IDENTITY", None)
        self.assertEqual(self.binary.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
