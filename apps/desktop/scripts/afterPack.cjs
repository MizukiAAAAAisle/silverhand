// electron-builder afterPack hook — ad-hoc code signing for local/dev builds.
//
// Why this exists:
//   We have no Apple "Developer ID" codesigning identity, so the config sets
//   `mac.identity: null`. In electron-builder that does NOT ad-hoc sign — it
//   logs "skipped macOS code signing" and returns (see app-builder-lib
//   macPackager.js: `if (qualifier === null) { ...; return false }`). The
//   packaged .app would then carry only Electron's own linker-signed stub
//   signature (Identifier=Electron, Info.plist not bound, no CodeResources),
//   which macOS rejects as an invalid bundle — the app "won't open", and once
//   the dmg/zip add a quarantine xattr it's a hard Gatekeeper block.
//
// Why afterPack (not afterSign):
//   afterPack runs after the .app is fully assembled (files, asar,
//   extraResources) but BEFORE the dmg/zip artifacts are built — so the
//   signature we apply here ends up inside the shipped dmg/zip. afterSign is
//   skipped entirely when no signing occurred (electron-builder logs
//   'skipping "afterSign" hook as no signing occurred'), so it can't be used
//   while builtin signing is disabled.
//
// What it does:
//   `codesign --deep --force --sign -` replaces the stub with a valid ad-hoc
//   bundle signature (Identifier=com.silverhand.desktop, Info.plist bound,
//   CodeResources sealed), then verifies it. Ad-hoc apps still fail
//   `spctl -a` (that's why `gatekeeperAssess: false` is set) but they launch
//   once the quarantine xattr is cleared. For real distribution, replace this
//   with a Developer ID identity + notarization.

const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function loadAsar(projectDir) {
  const projectRequire = createRequire(path.join(projectDir, "package.json"));
  const builderRequire = createRequire(
    projectRequire.resolve("electron-builder/package.json"),
  );
  return builderRequire("@electron/asar");
}

function asarHeaderSha256Hex(asar, filePath) {
  return createHash("sha256")
    .update(asar.getRawHeader(filePath).headerString)
    .digest("hex");
}

function updateElectronAsarIntegrity(appPath, asarPath, asar) {
  const infoPlistPath = path.join(appPath, "Contents", "Info.plist");
  if (!fs.existsSync(infoPlistPath)) {
    return;
  }

  try {
    execFileSync(
      "/usr/libexec/PlistBuddy",
      [
        "-c",
        "Print :ElectronAsarIntegrity:Resources/app.asar:hash",
        infoPlistPath,
      ],
      { stdio: "ignore" },
    );
  } catch {
    return;
  }

  const nextHash = asarHeaderSha256Hex(asar, asarPath);
  execFileSync(
    "/usr/libexec/PlistBuddy",
    [
      "-c",
      `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${nextHash}`,
      infoPlistPath,
    ],
    { stdio: "inherit" },
  );
  console.log(
    `[afterPack] ElectronAsarIntegrity header hash updated to ${nextHash}`,
  );
}

async function rewriteRemoteOnlyAsar(context, appPath) {
  if (process.env.SILVERHAND_DESKTOP_REMOTE_ONLY !== "1") {
    return;
  }

  const resourcesDir = path.join(appPath, "Contents", "Resources");
  const asarPath = path.join(resourcesDir, "app.asar");
  const remoteOnlyPackagePath = path.join(
    context.packager.projectDir,
    // package.sh injects the canonical release version into this generated
    // manifest. Reusing the tracked versionless template here would undo the
    // electron-builder rename-copy and make app.getVersion() drift.
    "package.remote-only.generated.json",
  );
  if (!fs.existsSync(asarPath)) {
    throw new Error(`[afterPack] remote-only asar not found: ${asarPath}`);
  }
  if (!fs.existsSync(remoteOnlyPackagePath)) {
    throw new Error(
      `[afterPack] remote-only package metadata not found: ${remoteOnlyPackagePath}`,
    );
  }

  const asar = loadAsar(context.packager.projectDir);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "silverhand-remote-asar-"));
  const nextAsarPath = `${asarPath}.next`;
  try {
    asar.extractAll(asarPath, tmpDir);

    const nodeModulesDir = path.join(tmpDir, "node_modules");
    if (fs.existsSync(nodeModulesDir)) {
      for (const entry of fs.readdirSync(nodeModulesDir)) {
        if (entry === "zod") continue;
        fs.rmSync(path.join(nodeModulesDir, entry), {
          recursive: true,
          force: true,
        });
      }
    }
    fs.copyFileSync(remoteOnlyPackagePath, path.join(tmpDir, "package.json"));
    fs.rmSync(nextAsarPath, { force: true });
    await asar.createPackageWithOptions(tmpDir, nextAsarPath, {});
    fs.renameSync(nextAsarPath, asarPath);
    updateElectronAsarIntegrity(appPath, asarPath, asar);
    fs.rmSync(path.join(resourcesDir, "app.asar.unpacked"), {
      recursive: true,
      force: true,
    });
    console.log("[afterPack] remote-only app.asar pruned and metadata replaced");
  } finally {
    fs.rmSync(nextAsarPath, { force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function restorePackagedBetterSqlite3Binding(appPath) {
  if (process.env.SILVERHAND_DESKTOP_REMOTE_ONLY === "1") {
    return;
  }

  const source = process.env.SILVERHAND_ELECTRON_BETTER_SQLITE3_BINDING;
  if (!source) {
    throw new Error(
      "[afterPack] missing SILVERHAND_ELECTRON_BETTER_SQLITE3_BINDING for regular package",
    );
  }
  if (!fs.existsSync(source)) {
    throw new Error(`[afterPack] Electron better-sqlite3 binding missing: ${source}`);
  }

  const target = path.join(
    appPath,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node",
  );
  if (!fs.existsSync(target)) {
    throw new Error(`[afterPack] packaged better-sqlite3 binding missing: ${target}`);
  }

  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o755);
  console.log(`[afterPack] restored Electron ABI better-sqlite3 binding → ${target}`);
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  const entitlementsPath = path.join(
    context.packager.projectDir,
    "build",
    "entitlements.mac.plist",
  );
  if (!fs.existsSync(entitlementsPath)) {
    throw new Error(`[afterPack] entitlements file missing: ${entitlementsPath}`);
  }

  await rewriteRemoteOnlyAsar(context, appPath);
  restorePackagedBetterSqlite3Binding(appPath);

  console.log(`[afterPack] ad-hoc deep-signing ${appPath}`);
  execFileSync(
    "codesign",
    [
      "--deep",
      "--force",
      "--sign",
      "-",
      "--entitlements",
      entitlementsPath,
      appPath,
    ],
    { stdio: "inherit" },
  );
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], {
    stdio: "inherit",
  });
  console.log("[afterPack] ad-hoc signature applied and verified");
};
