import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveBackendSidecarManifestPath, verifySidecar } from "../rust-backend-sidecar.js";

// SHA-256 of the literal artifact bytes "abc", not computed by the verifier under test.
const SHA = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const archDescriptor = Object.getOwnPropertyDescriptor(process, "arch")!;
let root: string;
let manifestPath: string;
let executablePath: string;

function platform(platform: string, arch: string): void {
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
  Object.defineProperty(process, "arch", { ...archDescriptor, value: arch });
}

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    executable: "backend",
    target: "aarch64-apple-darwin",
    arch: "arm64",
    sha256: SHA,
    ...overrides,
  });
}

beforeEach(async () => {
  const parent = process.env.SILVERHAND_DIR;
  if (!parent) throw new Error("sidecar tests require isolated SILVERHAND_DIR");
  await mkdir(parent, { recursive: true });
  root = await mkdtemp(join(parent, "sidecar-"));
  await mkdir(join(root, "artifact"));
  manifestPath = join(root, "artifact", "manifest.json");
  executablePath = join(root, "artifact", "backend");
  await writeFile(executablePath, "abc", { mode: 0o700 });
  await writeFile(manifestPath, manifest());
  platform("darwin", "arm64");
});

afterEach(async () => {
  Object.defineProperty(process, "platform", platformDescriptor);
  Object.defineProperty(process, "arch", archDescriptor);
  if (root) await rm(root, { recursive: true, force: true });
});

describe("packaged sidecar verification", () => {
  it.each([
    ["darwin", "arm64", "aarch64-apple-darwin"],
    ["darwin", "x64", "x86_64-apple-darwin"],
    ["linux", "arm64", "aarch64-unknown-linux-gnu"],
    ["linux", "x64", "x86_64-unknown-linux-gnu"],
    ["win32", "x64", "x86_64-pc-windows-msvc"],
  ])("verifies actual bytes for %s/%s", async (os, arch, target) => {
    platform(os, arch);
    await writeFile(manifestPath, manifest({ arch, target }));
    await expect(verifySidecar(manifestPath)).resolves.toEqual({
      executablePath: await realpath(executablePath),
    });
  });

  it.each(["absolute", "parent", "directory", "symlink"])(
    "rejects %s containment escape even when artifact integrity matches",
    async (escape) => {
      const outside = join(root, "outside");
      await writeFile(outside, "abc", { mode: 0o700 });
      let executable = "..";
      if (escape === "absolute") executable = outside;
      if (escape === "parent") executable = "../outside";
      if (escape === "symlink") {
        await symlink(outside, join(root, "artifact", "link"));
        executable = "link";
      }
      await writeFile(manifestPath, manifest({ executable }));
      await expect(verifySidecar(manifestPath)).rejects.toMatchObject({
        kind: "executable-uncontained",
      });
    },
  );

  it("returns the canonical path of an allowed contained symlink", async () => {
    await symlink("backend", join(root, "artifact", "link"));
    await writeFile(manifestPath, manifest({ executable: "link" }));
    await expect(verifySidecar(manifestPath)).resolves.toEqual({
      executablePath: await realpath(executablePath),
    });
  });

  it.each(["directory", "not executable", "missing"])("rejects a %s artifact", async (fault) => {
    let kind = "executable-missing";
    if (fault === "directory") {
      await rm(executablePath);
      await mkdir(executablePath);
      kind = "executable-not-regular";
    } else if (fault === "not executable") {
      await chmod(executablePath, 0o600);
      kind = "executable-not-executable";
    } else await rm(executablePath);
    await expect(verifySidecar(manifestPath)).rejects.toMatchObject({ kind });
  });

  it.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
    "reports an unreadable executable without accepting its manifest digest",
    async () => {
      await chmod(executablePath, 0o100);
      await expect(verifySidecar(manifestPath)).rejects.toMatchObject({
        kind: "executable-missing",
      });
    },
  );

  it.each([
    ["darwin", "arm64", { arch: "x64" }, "arch-mismatch"],
    ["darwin", "x64", {}, "target-mismatch"],
    ["darwin", "arm64", { target: "aarch64-unknown-linux-gnu" }, "target-mismatch"],
    ["aix", "ppc64", {}, "unsupported-platform"],
  ] as const)("rejects incompatible identity %s/%s %j", async (os, arch, overrides, kind) => {
    platform(os, arch);
    await writeFile(manifestPath, manifest(overrides));
    await expect(verifySidecar(manifestPath)).rejects.toMatchObject({ kind });
  });

  it("reports a missing manifest", async () => {
    await rm(manifestPath);
    await expect(verifySidecar(manifestPath)).rejects.toMatchObject({ kind: "manifest-missing" });
  });

  it.each([
    "not json",
    "null",
    "[]",
    manifest({ sha256: "short" }),
    manifest({ arch: "" }),
    manifest({ executable: "" }),
    manifest({ target: 1 }),
    manifest({ extra: "unexpected" }),
  ])("rejects malformed manifest %s", async (raw) => {
    await writeFile(manifestPath, raw);
    await expect(verifySidecar(manifestPath)).rejects.toMatchObject({ kind: "manifest-invalid" });
  });

  it("rejects replaced bytes and accepts the restored artifact with an uppercase digest", async () => {
    await writeFile(executablePath, "substituted artifact");
    await expect(verifySidecar(manifestPath)).rejects.toMatchObject({ kind: "sha256-mismatch" });
    await writeFile(executablePath, "abc");
    await writeFile(manifestPath, manifest({ sha256: SHA.toUpperCase() }));
    await expect(verifySidecar(manifestPath)).resolves.toEqual({
      executablePath: await realpath(executablePath),
    });
  });
});

it.each([
  [
    true,
    "/Applications/Silverhand.app/Contents/Resources/silverhand-backend/silverhand-backend.manifest.json",
  ],
  [false, "/project/rust/target/release/silverhand-backend.manifest.json"],
] as const)("locates the manifest for packaged=%s", (isPackaged, expected) => {
  expect(
    resolveBackendSidecarManifestPath({
      isPackaged,
      resourcesPath: "/Applications/Silverhand.app/Contents/Resources",
      appPath: "/project/apps/desktop",
    }),
  ).toBe(expected);
});
