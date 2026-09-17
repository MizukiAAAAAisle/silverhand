// The packaged Electron stub must not share its LC_UUID with development
// Electron. Change only the UUID payload, before signing. TN3178 documents why
// distinct app executables need distinct UUIDs. This intentionally supports
// only our current arm64, thin Mach-O target; other formats must fail closed.
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function uuidOffset(bytes) {
  if (
    bytes.length < 32 ||
    bytes.readUInt32LE(0) !== 0xfeedfacf ||
    bytes.readUInt32LE(4) !== 0x0100000c ||
    bytes.readUInt32LE(12) !== 2
  ) {
    throw new Error("Expected a thin arm64 Mach-O executable");
  }
  const count = bytes.readUInt32LE(16);
  const end = 32 + bytes.readUInt32LE(20);
  if (end > bytes.length || count > (end - 32) / 8) {
    throw new Error("Invalid Mach-O load-command bounds");
  }
  let offset = 32;
  let found;
  for (let i = 0; i < count; i++) {
    if (offset + 8 > end) throw new Error("Truncated Mach-O load command");
    const command = bytes.readUInt32LE(offset);
    const size = bytes.readUInt32LE(offset + 4);
    if (size < 8 || size % 8 !== 0 || offset + size > end) {
      throw new Error("Invalid Mach-O load-command size");
    }
    if (command === 0x1b) {
      if (found !== undefined || size !== 24) throw new Error("Invalid or duplicate LC_UUID");
      found = offset + 8;
    }
    offset += size;
  }
  if (offset !== end || found === undefined)
    throw new Error("Missing LC_UUID or invalid command table");
  return found;
}

function readUuid(bytes) {
  const offset = uuidOffset(bytes);
  const hex = bytes.subarray(offset, offset + 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function renewUuid(bytes) {
  const offset = uuidOffset(bytes);
  const originalUuid = readUuid(bytes);
  const uuid = randomUUID();
  const result = Buffer.from(bytes);
  Buffer.from(uuid.replaceAll("-", ""), "hex").copy(result, offset);
  return { bytes: result, originalUuid, uuid };
}

function prepareMacExecutableIdentity(appPath) {
  const plist = path.join(appPath, "Contents", "Info.plist");
  const executable = execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleExecutable", plist],
    { encoding: "utf8" },
  ).trim();
  if (
    !executable ||
    executable === "." ||
    executable === ".." ||
    path.basename(executable) !== executable
  ) {
    throw new Error("Invalid CFBundleExecutable");
  }
  const executablePath = path.join(appPath, "Contents", "MacOS", executable);
  const result = renewUuid(fs.readFileSync(executablePath));
  fs.writeFileSync(executablePath, result.bytes);
  // Upstream Electron symbols still refer to originalUuid. Keep the mapping
  // in the signed bundle; this does not itself remap dSYM/Breakpad symbols.
  fs.writeFileSync(
    path.join(appPath, "Contents", "Resources", "silverhand-executable-uuid.json"),
    JSON.stringify(
      { executable, arch: "arm64", originalUuid: result.originalUuid, uuid: result.uuid },
      null,
      2,
    ) + "\n",
  );
  console.log(`[afterPack] main executable UUID ${result.originalUuid} -> ${result.uuid}`);
  return { executablePath, uuid: result.uuid };
}

module.exports = { readUuid, renewUuid, prepareMacExecutableIdentity };
