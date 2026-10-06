"use strict";

/**
 * Explicit desktop build targets. Every preparation script resolves the
 * platform/architecture it is producing through here instead of trusting the
 * host implicitly, so CI can cross-download assets while native build steps
 * still refuse to run for an architecture they cannot produce.
 */

const fs = require("node:fs");

const TARGETS = Object.freeze({
  "linux-x64": Object.freeze({
    key: "linux-x64",
    platform: "linux",
    arch: "x64",
    label: "Linux x64",
    ytDlpRemote: "yt-dlp_linux",
    ytDlpLocal: "yt-dlp",
    workerName: "scope-x-worker",
    betterSqlite3Prebuild: "linux-x64",
  }),
  "linux-arm64": Object.freeze({
    key: "linux-arm64",
    platform: "linux",
    arch: "arm64",
    label: "Linux arm64",
    ytDlpRemote: "yt-dlp_linux_aarch64",
    ytDlpLocal: "yt-dlp",
    workerName: "scope-x-worker",
    betterSqlite3Prebuild: "linux-arm64",
  }),
  "win32-x64": Object.freeze({
    key: "win32-x64",
    platform: "win32",
    arch: "x64",
    label: "Windows x64",
    ytDlpRemote: "yt-dlp.exe",
    ytDlpLocal: "yt-dlp.exe",
    workerName: "scope-x-worker.exe",
    betterSqlite3Prebuild: "win32-x64",
  }),
  "win32-arm64": Object.freeze({
    key: "win32-arm64",
    platform: "win32",
    arch: "arm64",
    label: "Windows arm64",
    ytDlpRemote: "yt-dlp_arm64.exe",
    ytDlpLocal: "yt-dlp.exe",
    workerName: "scope-x-worker.exe",
    betterSqlite3Prebuild: "win32-arm64",
  }),
  "darwin-arm64": Object.freeze({
    key: "darwin-arm64",
    platform: "darwin",
    arch: "arm64",
    label: "macOS arm64 (Apple Silicon)",
    // The pinned yt-dlp release ships one universal2 asset for both Mac
    // architectures; verified against that release's SHA2-256SUMS.
    ytDlpRemote: "yt-dlp_macos",
    ytDlpLocal: "yt-dlp",
    workerName: "scope-x-worker",
    betterSqlite3Prebuild: "darwin-arm64",
    // Candidate floor only: verify every native dependency, including frozen
    // Python payloads, and test on this OS before publishing support.
    minimumMacOS: "13.0",
  }),
  "darwin-x64": Object.freeze({
    key: "darwin-x64",
    platform: "darwin",
    arch: "x64",
    label: "macOS x64 (Intel)",
    // The pinned yt-dlp release ships one universal2 asset for both Mac
    // architectures; verified against that release's SHA2-256SUMS.
    ytDlpRemote: "yt-dlp_macos",
    ytDlpLocal: "yt-dlp",
    workerName: "scope-x-worker",
    betterSqlite3Prebuild: "darwin-x64",
    // Candidate floor only: verify every native dependency, including frozen
    // Python payloads, and test on this OS before publishing support.
    minimumMacOS: "12.0",
  }),
});

/** Targets the first release ships; everything here must stay buildable. */
const RELEASE_TARGETS = Object.freeze(["linux-x64", "win32-x64", "darwin-arm64", "darwin-x64"]);

function supportedTargetList() {
  return Object.keys(TARGETS).join(", ");
}

/**
 * Resolves the build target from SCOPE_DESKTOP_TARGET_PLATFORM and
 * SCOPE_DESKTOP_TARGET_ARCH, falling back to the host. Setting only one half
 * is an error — silently mixing an explicit platform with the host
 * architecture is how wrong-architecture artifacts get produced.
 */
function resolveTarget({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const envPlatform = env.SCOPE_DESKTOP_TARGET_PLATFORM?.trim();
  const envArch = env.SCOPE_DESKTOP_TARGET_ARCH?.trim();
  if ((envPlatform && !envArch) || (!envPlatform && envArch)) {
    throw new Error(
      "SCOPE_DESKTOP_TARGET_PLATFORM and SCOPE_DESKTOP_TARGET_ARCH must be set together.",
    );
  }
  const targetPlatform = envPlatform || platform;
  const targetArch = envArch || arch;
  const target = TARGETS[`${targetPlatform}-${targetArch}`];
  if (!target) {
    throw new Error(
      `Unsupported desktop target ${targetPlatform}/${targetArch}. Supported: ${supportedTargetList()}.`,
    );
  }
  return target;
}

/**
 * Native toolchains (uv/PyInstaller worker builds) cannot cross-compile;
 * refuse when the requested target is not the machine actually running.
 */
function requireHostTarget(target, { platform = process.platform, arch = process.arch } = {}) {
  if (target.platform !== platform || target.arch !== arch) {
    throw new Error(
      `Cannot build native ${target.label} artifacts on ${platform}/${arch}. ` +
        "Run the native build on a matching machine or CI runner.",
    );
  }
  return target;
}

function readUInt16(buffer, offset, littleEndian) {
  return littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
}

function readUInt32(buffer, offset, littleEndian) {
  return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
}

const ELF_MACHINES = new Map([
  [0x3e, "x64"],
  [0xb7, "arm64"],
]);

const MACHO_CPUTYPES = new Map([
  [0x01000007, "x64"],
  [0x0100000c, "arm64"],
]);

const PE_MACHINES = new Map([
  [0x8664, "x64"],
  [0xaa64, "arm64"],
]);

/**
 * Identifies the architecture of an ELF, Mach-O, or PE binary from its
 * header. Returns { format, arch } where arch is "x64", "arm64", "universal",
 * or null when the format is unknown. Used to reject stale or foreign output
 * before it is bundled.
 */
function readBinaryArchitecture(filePath) {
  let header;
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      header = Buffer.alloc(4096);
      const read = fs.readSync(fd, header, 0, header.length, 0);
      header = header.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { format: "unknown", arch: null };
  }

  if (header.length >= 20 && header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c) {
    const littleEndian = header[5] !== 2;
    return { format: "elf", arch: ELF_MACHINES.get(readUInt16(header, 18, littleEndian)) ?? null };
  }

  if (header.length >= 8) {
    const magic = header.readUInt32BE(0);
    if (magic === 0xcafebabe || magic === 0xcafebabf) {
      return { format: "macho", arch: "universal" };
    }
    const littleEndian = header.readUInt32LE(0) === 0xfeedfacf;
    if (littleEndian || magic === 0xfeedfacf || magic === 0xfeedface) {
      return {
        format: "macho",
        arch: MACHO_CPUTYPES.get(readUInt32(header, 4, littleEndian)) ?? null,
      };
    }
  }

  if (header.length >= 0x40 && header[0] === 0x4d && header[1] === 0x5a) {
    const peOffset = header.readUInt32LE(0x3c);
    if (
      peOffset + 6 <= header.length &&
      header[peOffset] === 0x50 &&
      header[peOffset + 1] === 0x45
    ) {
      return {
        format: "pe",
        arch: PE_MACHINES.get(readUInt16(header, peOffset + 4, true)) ?? null,
      };
    }
  }

  return { format: "unknown", arch: null };
}

const LC_VERSION_MIN_MACOSX = 0x24;
const LC_BUILD_VERSION = 0x32;

function readAt(fd, position, length) {
  const buffer = Buffer.alloc(length);
  const read = fs.readSync(fd, buffer, 0, length, position);
  return read === length ? buffer : read === 0 ? null : buffer.subarray(0, read);
}

function decodeMachOVersion(value) {
  const major = value >>> 16;
  const minor = (value >>> 8) & 0xff;
  const patch = value & 0xff;
  return patch > 0 ? `${major}.${minor}.${patch}` : `${major}.${minor}`;
}

/**
 * Reads the minimum macOS version out of one Mach-O slice's load commands.
 * Returns null when the slice has no LC_BUILD_VERSION or
 * LC_VERSION_MIN_MACOSX command.
 */
function readMachOSliceMinimumOS(fd, offset) {
  const header = readAt(fd, offset, 32);
  if (!header || header.length < 32 || header.readUInt32LE(0) !== 0xfeedfacf) {
    return null;
  }
  const commandCount = header.readUInt32LE(16);
  let position = offset + 32;
  for (let index = 0; index < commandCount; index += 1) {
    const command = readAt(fd, position, 8);
    if (!command || command.length < 8) {
      return null;
    }
    const kind = command.readUInt32LE(0);
    const size = command.readUInt32LE(4);
    if (size < 8) {
      return null;
    }
    if (kind === LC_BUILD_VERSION || kind === LC_VERSION_MIN_MACOSX) {
      const payload = readAt(fd, position, 24);
      if (!payload || payload.length < 16) {
        return null;
      }
      // LC_BUILD_VERSION puts minos after the platform; the legacy command
      // starts with the version.
      const minos = kind === LC_BUILD_VERSION ? payload.readUInt32LE(12) : payload.readUInt32LE(8);
      return decodeMachOVersion(minos);
    }
    position += size;
  }
  return null;
}

/**
 * Minimum macOS version recorded in a Mach-O binary (thin or universal).
 * `arch` selects the slice, defaulting to the first one. Returns a version
 * string such as "13.0", or null for a non-Mach-O or unreadable file.
 */
function readMachOMinimumOS(filePath, arch = null) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return null;
  }
  try {
    const header = readAt(fd, 0, 8);
    if (!header || header.length < 8) {
      return null;
    }
    const magic = header.readUInt32BE(0);
    const slices = [];
    if (magic === 0xcafebabe || magic === 0xcafebabf) {
      const entrySize = magic === 0xcafebabe ? 20 : 32;
      const count = header.readUInt32BE(4);
      const table = readAt(fd, 8, count * entrySize);
      if (!table || table.length < count * entrySize) {
        return null;
      }
      for (let index = 0; index < count; index += 1) {
        const base = index * entrySize;
        slices.push({
          arch: MACHO_CPUTYPES.get(table.readUInt32BE(base)) ?? null,
          offset:
            entrySize === 32
              ? Number(table.readBigUInt64BE(base + 8))
              : table.readUInt32BE(base + 8),
        });
      }
    } else {
      const littleEndian = header.readUInt32LE(0) === 0xfeedfacf;
      if (!littleEndian && magic !== 0xfeedfacf && magic !== 0xfeedface) {
        return null;
      }
      slices.push({
        arch: MACHO_CPUTYPES.get(readUInt32(header, 4, littleEndian)) ?? null,
        offset: 0,
      });
    }
    const slice = arch === null ? slices[0] : slices.find((candidate) => candidate.arch === arch);
    return slice === undefined ? null : readMachOSliceMinimumOS(fd, slice.offset);
  } finally {
    fs.closeSync(fd);
  }
}

/** Numeric dotted-version comparison; returns -1, 0, or 1. */
function compareVersionStrings(left, right) {
  const parse = (value) =>
    String(value)
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return difference < 0 ? -1 : 1;
    }
  }
  return 0;
}

/** Throws unless the binary header matches the target architecture. */
function assertBinaryMatchesTarget(filePath, target) {
  const { format, arch } = readBinaryArchitecture(filePath);
  if (arch === null) {
    throw new Error(`Could not identify the architecture of ${filePath} (format: ${format}).`);
  }
  if (arch !== "universal" && arch !== target.arch) {
    throw new Error(
      `Wrong architecture: ${filePath} is ${arch}, expected ${target.arch} for ${target.label}.`,
    );
  }
  return { format, arch };
}

module.exports = {
  RELEASE_TARGETS,
  TARGETS,
  assertBinaryMatchesTarget,
  compareVersionStrings,
  readBinaryArchitecture,
  readMachOMinimumOS,
  requireHostTarget,
  resolveTarget,
  supportedTargetList,
};
