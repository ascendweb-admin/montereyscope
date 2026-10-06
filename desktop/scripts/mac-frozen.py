"""Maintainer-only inspection/signing of PyInstaller onefile payloads.

The pinned worker build environment supplies PyInstaller. Preserve the upstream
bootloader, Python version, options, bytecode and non-native data verbatim; only
native signatures change. Unlike codesign on the outer executable, this rebuilds
the PKG archive and fixes its Mach-O container before Electron seals the app.
Never extract archive paths or execute archived Python code.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import tempfile
import zlib

from PyInstaller.archive.readers import CArchiveReader
from PyInstaller.archive.writers import CArchiveWriter


def is_macho(data):
    return data[:4] in (
        b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf",
        b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf",
    )


def native_entries(archive):
    for name, entry in archive.toc.items():
        data = archive.extract(name)
        if is_macho(data):
            yield name, data
        elif entry[4] == "b" and (
            Path(name).name == "Python"
            or re.search(r"\.(?:dylib|node|so(?:\.\d+)*)$", name)
        ):
            raise ValueError(f"Frozen native entry is not Mach-O: {name}")


def extract_native(binary, output):
    archive = CArchiveReader(str(binary))
    result = []
    for name, data in native_entries(archive):
        # Archive names are labels only, never filesystem destinations.
        file = output / hashlib.sha256(name.encode()).hexdigest()
        file.write_bytes(data)
        result.append({"label": name, "file": str(file)})
    if not result:
        raise ValueError(f"No frozen native payload found in {binary}")
    return result


def rebuild_archive(binary, replacements):
    """Replace selected raw entries, preserving bytecode and Python metadata.

    The caller removes the outer code signature first, then repairs the Mach-O
    lengths after this function changes the archive size.
    """
    archive = CArchiveReader(str(binary))
    original = binary.read_bytes()
    cookie = list(struct.unpack(
        archive._COOKIE_FORMAT,
        original[archive._end_offset - archive._COOKIE_LENGTH:archive._end_offset],
    ))
    chunks = []
    toc = []
    offset = 0
    for name, (start, size, raw_size, compressed, kind) in archive.toc.items():
        if name in replacements:
            raw = replacements[name]
            data = zlib.compress(raw, 9) if compressed else raw
            raw_size = len(raw)
        else:
            data = original[archive._start_offset + start:archive._start_offset + start + size]
        chunks.append(data)
        toc.append((offset, len(data), raw_size, compressed, kind, name))
        offset += len(data)
    for option in archive.options:
        toc.append((0, 0, 0, 0, "o", option))
    table = CArchiveWriter._serialize_toc(toc)
    cookie[1:4] = [offset + len(table) + archive._COOKIE_LENGTH, offset, len(table)]
    binary.write_bytes(
        original[:archive._start_offset] + b"".join(chunks) + table
        + struct.pack(archive._COOKIE_FORMAT, *cookie)
    )
    # Fail closed on an archive-format change, before replacing the packaged file.
    rebuilt = CArchiveReader(str(binary))
    if rebuilt.options != archive.options or rebuilt.toc.keys() != archive.toc.keys():
        raise ValueError("Frozen archive metadata changed during signing")
    for name in archive.toc:
        expected = replacements.get(name)
        if expected is None:
            start, size, _, compressed, _ = archive.toc[name]
            expected = original[archive._start_offset + start:archive._start_offset + start + size]
            if compressed:
                expected = zlib.decompress(expected)
        if rebuilt.extract(name) != expected:
            raise ValueError(f"Frozen entry changed during signing: {name}")


def sign_payload(binary, identity, keychain):
    from PyInstaller.utils.osx import fix_exe_for_code_signing

    with tempfile.TemporaryDirectory(prefix="scope-frozen-sign-") as directory:
        directory = Path(directory)
        working = directory / "executable"
        shutil.copy2(binary, working)
        subprocess.run(["codesign", "--remove-signature", str(working)], check=True)
        archive = CArchiveReader(str(working))
        replacements = {}
        for name, data in native_entries(archive):
            file = directory / hashlib.sha256(name.encode()).hexdigest()
            file.write_bytes(data)
            args = ["codesign", "--force", "--sign", identity, "--options", "runtime", "--timestamp"]
            if keychain:
                args += ["--keychain", keychain]
            subprocess.run([*args, str(file)], check=True)
            subprocess.run(["codesign", "--verify", "--strict", str(file)], check=True)
            replacements[name] = file.read_bytes()
        if not replacements:
            raise ValueError(f"No frozen native payload found in {binary}")
        rebuild_archive(working, replacements)
        fix_exe_for_code_signing(str(working))
        # The app bundle is still unsigned; electron-osx-sign signs the outer
        # executable and app next. Preserve its executable mode.
        shutil.copyfile(working, binary)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["extract", "sign"])
    parser.add_argument("binary", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--identity")
    parser.add_argument("--keychain")
    args = parser.parse_args()
    if args.operation == "extract":
        if args.output is None:
            parser.error("extract requires --output")
        args.output.mkdir(parents=True, exist_ok=True)
        print(json.dumps(extract_native(args.binary, args.output)))
    else:
        if not args.identity or args.identity == "-":
            parser.error("sign requires a Developer ID identity")
        if os.uname().sysname != "Darwin":
            parser.error("sign must run on macOS")
        sign_payload(args.binary, args.identity, args.keychain)


if __name__ == "__main__":
    main()
