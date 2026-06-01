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
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  console.log(`[afterPack] ad-hoc deep-signing ${appPath}`);
  execFileSync("codesign", ["--deep", "--force", "--sign", "-", appPath], {
    stdio: "inherit",
  });
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], {
    stdio: "inherit",
  });
  console.log("[afterPack] ad-hoc signature applied and verified");
};
