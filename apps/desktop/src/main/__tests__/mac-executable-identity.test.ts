import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { readUuid, renewUuid } = require("../../../scripts/mac-executable-identity.cjs");
const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
const packagingRequire = createRequire(builderRequire.resolve("app-builder-lib/package.json"));
const { load: parseYaml } = packagingRequire("js-yaml");

function executable() {
  const bytes = Buffer.alloc(96, 0xaa);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  bytes.writeUInt32LE(2, 12);
  bytes.writeUInt32LE(2, 16);
  bytes.writeUInt32LE(32, 20);
  bytes.writeUInt32LE(0x1b, 32);
  bytes.writeUInt32LE(24, 36);
  bytes.writeUInt32LE(0x99, 56);
  bytes.writeUInt32LE(8, 60);
  return bytes;
}

describe("macOS packaged main executable identity", () => {
  it("replaces only UUID bytes, without modifying the development source", () => {
    const source = executable();
    const before = Buffer.from(source);
    const first = renewUuid(source);
    const second = renewUuid(source);
    expect(source).toEqual(before);
    expect(first.originalUuid).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(readUuid(source)).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(first.bytes.subarray(40, 56).toString("hex")).toBe(first.uuid.replaceAll("-", ""));
    expect(readUuid(first.bytes)).toBe(first.uuid);
    expect(first.uuid).not.toBe(first.originalUuid);
    expect(first.uuid).not.toBe(second.uuid);
    expect(first.bytes.length).toBe(source.length);
    expect(first.bytes.subarray(0, 40)).toEqual(source.subarray(0, 40));
    expect(first.bytes.subarray(56)).toEqual(source.subarray(56));
  });

  it.each([
    ["wrong magic", 0, 0xcafebabe],
    ["unsupported architecture", 4, 0x01000007],
    ["not executable", 12, 6],
    ["excess command count", 16, 99],
    ["truncated table", 20, 1000],
    ["unaligned command", 36, 23],
    ["zero command size", 36, 0],
    ["oversized command", 36, 1000],
    ["missing uuid", 32, 0x99],
    ["wrong uuid size", 36, 32],
    ["short second uuid command", 56, 0x1b],
    ["unconsumed table", 16, 1],
  ])("fails closed for %s without changing input", (_name, offset, value) => {
    const source = executable();
    source.writeUInt32LE(value as number, offset as number);
    const before = Buffer.from(source);
    expect(() => renewUuid(source)).toThrow();
    expect(source).toEqual(before);
  });

  it("rejects a truncated header", () => {
    expect(() => renewUuid(Buffer.alloc(8))).toThrow();
  });

  it("rejects two otherwise valid UUID commands", () => {
    const source = executable();
    source.writeUInt32LE(48, 20);
    source.writeUInt32LE(0x1b, 56);
    source.writeUInt32LE(24, 60);
    expect(() => renewUuid(source)).toThrow("duplicate LC_UUID");
  });

  it.each(["electron-builder.yml", "electron-builder.remote-only.yml"])(
    "%s includes the local network usage declaration",
    (name) => {
      const config = parseYaml(readFileSync(new URL(`../../../${name}`, import.meta.url), "utf8"));
      expect(config.mac.extendInfo.NSLocalNetworkUsageDescription).toMatch(/\S/);
      expect(config.afterPack).toBe("scripts/afterPack.cjs");
    },
  );
});
