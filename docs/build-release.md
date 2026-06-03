# Building & Releasing the Desktop App

End-to-end recipe for producing a distributable `.dmg` from the
silverhand source tree, plus the **list of footguns we already
stepped on** so the next person doesn't.

> Scope: macOS only. Per `CLAUDE.md` v1 ships Mac-only; nothing
> below has been tested on Win/Linux and at least the
> `process.platform === 'darwin'` PATH-fix branch in `main/index.ts`
> would silently no-op on other OSes.

---

## TL;DR

```fish
# 1. (one-time) make the icon — drop a 1024×1024 PNG at
#    apps/desktop/build/icon.png, then:
cd apps/desktop/build
mkdir -p icon.iconset
# (sips/iconutil recipe — see apps/desktop/build/README.md)
iconutil -c icns icon.iconset
rm -r icon.iconset

# 2. build (from repo root)
pnpm package           # universal off, arm64 dmg + zip in apps/desktop/release/
pnpm package:dir       # faster: skip dmg, just .app for smoke testing
```

Artifacts land in `apps/desktop/release/`:
- `Silverhand-<version>-arm64.dmg`
- `Silverhand-<version>-arm64-mac.zip`
- `mac-arm64/Silverhand.app/` (raw bundle)

---

## How the pieces fit

```
scripts/package.sh
   ├── pnpm -r build              # tsc + esbuild for backend / shared / CLI
   ├── pnpm --filter @silverhand/desktop build   # electron-vite → out/{main,preload,renderer}
   ├── ensure_binding ELECTRON_ABI ...           # swap better-sqlite3 .node to electron ABI
   └── electron-builder --mac --config electron-builder.yml
              ↓
       apps/desktop/release/
```

Three things this dance handles that electron-builder alone can't:

1. **better-sqlite3 ABI swap.** `dev.sh` and `test.sh` swap the
   `.node` binding between Electron's ABI (130 for Electron 33) and
   system Node's (137 for Node 24) on every invocation, cached by
   ABI under `node_modules/.native-binding-cache/`. `package.sh`
   does the same dance before kicking off electron-builder, so
   inside builder `npmRebuild: false` is safe — the binding sitting
   in node_modules is already the right ABI. If you let
   electron-builder rebuild, it builds for system Node ABI and the
   packaged app crashes on launch with "wrong ELF class" /
   "NODE_MODULE_VERSION mismatch" the first time it touches the DB.

2. **Silverhand CLI bundling.** `packages/cli` produces a single
   esbuild bundle at `dist/cli.js` (≈200KB, emitted as ESM).
   electron-builder ships it outside the asar as
   `<app>/Contents/Resources/silverhand-cli/cli.mjs` — the `.mjs`
   rename is important: without a sibling `package.json` type=module
   Node would otherwise parse it as CommonJS and choke on `import`.
   In dev the repo file is loaded directly because
   `packages/cli/package.json` already sets `type: module`. Both paths
   invoke it through Electron's own Node runtime (`process.execPath`
   + `ELECTRON_RUN_AS_NODE=1`) so no extra Node or Bun runtime is
   bundled. The backend exposes it to spawned agents by writing a
   per-spawn `bin/silverhand` shim and prepending that `bin/` to
   `PATH`.

3. **PATH from login shell.** GUI-launched .app's inherit
   launchd's minimal `/usr/bin:/bin:/usr/sbin:/sbin` — they do NOT
   see `~/.zshrc` / `config.fish` PATH additions where users have
   `claude` / `codex` installed. `apps/desktop/src/main/index.ts`'s
   `patchPathFromLoginShell()` runs `$SHELL -ilc 'printenv PATH'`
   at startup and copies the result into `process.env.PATH` (only
   in packaged darwin builds). `printenv` is used instead of `echo
   $PATH` because it's a real binary, so the same incantation
   works in fish (which doesn't accept `${VAR}` syntax) AND
   bash/zsh.

---

## Footguns the easy way (i.e. retrospective)

| # | symptom | cause | fix |
|---|---|---|---|
| 1 | `EOF` / `bad file descriptor` downloading `electron-v33.x.x-darwin-x64.zip` | github.com/electron/electron releases unreliable from CN | `scripts/package.sh` exports `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` |
| 2 | `ERR_ELECTRON_BUILDER` "must be under apps/desktop/" walking into `packages/backend/dist/...` | electron-builder follows the pnpm symlink for workspace deps | `@silverhand/backend` + `@silverhand/shared` moved to `devDependencies` (electron-vite bundles them at build time, no runtime require). electron-builder by default only walks production deps |
| 3 | "runtime 'codex' is not installed (no binary on PATH)" only in packaged build, fine in dev | macOS GUI apps inherit launchd PATH, not the shell PATH | login-shell PATH probe in `main/index.ts` (see point 3 above) |
| 4 | `silverhand: command not found` inside an agent | CLI bundle missing from the packaged resources, or the per-spawn PATH shim was not prepended | ensure `pnpm --filter @silverhand/cli build` runs before packaging and `extraResources` copies to `silverhand-cli/cli.mjs` (the `.mjs` rename is required — Node rejects ESM `.js` without a sibling `package.json` type=module) |
| 5 | codex spawns OK but can't reach chatgpt.com | proxy URL had `https://` scheme; almost all local proxies (Clash/mihomo) speak plain HTTP CONNECT | `expandProxyEnv()` in `packages/backend/src/proxy.ts` rewrites `https://` → `http://` and derives `socks5://` for `all_proxy` |
| 6 | packaged `.app` won't open / "is damaged" after `package.sh` | `mac.identity: null` does NOT ad-hoc sign — electron-builder *skips* signing, leaving only Electron's stub sig (Identifier=Electron, no CodeResources) → invalid bundle | `scripts/afterPack.cjs` ad-hoc deep-signs the .app before dmg/zip are built. See "Signing & notarization" below |
| 7 | (electron-builder **26+**) dmg step fails with `404` for `cdn.npmmirror.com/binaries/electron/dmg-builder@.../dmgbuild-bundle-*.tar.gz` | v26's dmg-builder fetches a `dmgbuild` bundle via `@electron/get`, which honors `ELECTRON_MIRROR` over the mirror it passes — so our *electron* mirror hijacks the *electron-builder-binaries* URL to a path that 404s | `scripts/package.sh` `stage_dmgbuild_bundle()` pre-downloads the bundle from the electron-builder-binaries mirror (github fallback), checksum-verifies it, and exports `CUSTOM_DMGBUILD_PATH` so dmg-builder skips the network |
| 8 | packaged app crashes at launch: `Error: Failed to load native binding` from `app.asar/node_modules/@node-rs/argon2/index.js` | `@node-rs/argon2`'s native binding ships in a platform-specific optional dep (`@node-rs/argon2-darwin-arm64`) that pnpm nests in its virtual store; electron-builder doesn't pull nested optional native deps into the asar (electron-userland/electron-builder#6289) | declare `@node-rs/argon2-darwin-arm64` as a direct `optionalDependencies` entry in `apps/desktop/package.json` (surfaces it so electron-builder includes it) **and** add it to `asarUnpack` so the `.node` lands on disk. Chose this over `node-linker=hoisted` to avoid reshaping the whole monorepo's node_modules (would disrupt the better-sqlite3 ABI swap) |
| 9 | packaged app **AND** `pnpm dev` both fail with `NODE_MODULE_VERSION 137 vs 130` for `better-sqlite3` from the workspace path — even right after a successful `pnpm package` | `_native.sh` `ensure_binding` trusted its `.active-abi` stamp blindly: if a later `pnpm install` re-extracted the Node-ABI prebuild on top of the .node file, the stamp still said "130 (Electron)", so dev/test/package all skipped the swap and shipped the Node-ABI binding. Symptom is identical to an ABI mismatch from anywhere else, but the actual binding file no longer matches the stamp | `_native.sh` now records the binding's file size at swap time and re-checks it on every call; size drift → log a clear "file was replaced — probably by pnpm install" line and re-swap from the per-ABI cache. The cache itself was always intact; only the stamp lied |

---

## When the version bumps

1. Bump `apps/desktop/package.json` `version` field. electron-builder
   uses this in artifact filenames (`Silverhand-X.Y.Z-arm64.dmg`).
2. `pnpm package`.
3. Smoke-test the .app: drag from dmg to /Applications, right-click
   → Open (Gatekeeper warns because we ad-hoc sign — see below),
   confirm logger first line in `~/.silverhand/logs/backend-*.log`
   reports `pathPatch.ok=true`.
4. Tag the release commit + upload the dmg + zip wherever.

---

## Adding x64 / Universal back

Currently `electron-builder.yml` has `target.arch: [arm64]`. To
ship for Intel too, add `- x64` (or `- universal`):

```yaml
mac:
  target:
    - target: dmg
      arch:
        - arm64
        - x64
```

Universal needs both arch's Electron zips downloaded. `ELECTRON_MIRROR`
should help; if it still EOFs, manually drop the zips into the
electron-builder cache (`~/Library/Caches/electron/`) then retry.

---

## Signing & notarization

### How we ad-hoc sign (and why it's not via `identity`)

The app is **ad-hoc signed** so macOS will open it on the build machine.
Important gotcha that bit us once: `mac.identity: null` does **NOT** ad-hoc
sign. In electron-builder it means *skip signing entirely* — the packager logs
`skipped macOS code signing  reason=identity explicitly is set to null` and
returns (see `app-builder-lib` `macPackager.js`: `if (qualifier === null) {
...; return false }`). With signing skipped, the bundle keeps only Electron's
own linker-signed stub (`Identifier=Electron`, `Info.plist` not bound, no
`CodeResources`), which macOS rejects as an invalid bundle — the packaged app
**won't open**, and once the dmg/zip add a quarantine xattr it's a hard
Gatekeeper block.

The actual ad-hoc signature is applied by **`apps/desktop/scripts/afterPack.cjs`**
(wired via `afterPack:` in `electron-builder.yml`). It runs `codesign --deep
--force --sign -` on the assembled `.app` after files/asar/extraResources are
in place but **before** the dmg/zip are built, so the artifacts ship a valid
signature (`Identifier=com.silverhand.desktop`, `Info.plist` bound,
`--verify --deep --strict` passes).

- Why `afterPack`, not `afterSign`: electron-builder **skips the `afterSign`
  hook when no signing occurred** (`skipping "afterSign" hook as no signing
  occurred`). Since builtin signing is disabled, only `afterPack` runs.
- We keep `identity: null` so the builtin signer cleanly no-ops; the hook is
  the single source of the signature. (electron-builder 26 additionally prints
  `arm64 requires signing, but identity is set to null and signing is being
  skipped` — that warning is expected and harmless; our hook covers it.)
- Ad-hoc apps still fail `spctl -a` (rejected) — that's why
  `gatekeeperAssess: false` is set. They launch fine once the quarantine xattr
  is cleared (right-click → Open the first time, or `xattr -dr
  com.apple.quarantine <app>`).

### For wider distribution (not yet wired)

- Get an Apple Developer ID Application certificate, set `mac.identity:
  "Developer ID Application: <name> (<team-id>)"`, set `mac.hardenedRuntime:
  true`. With a real identity the builtin signer runs (and `afterSign` fires),
  so move notarization into an `afterSign` hook calling `@electron/notarize`
  and drop / guard the ad-hoc `afterPack` step.
- For the App Store: completely different config (`mas` target,
  provisioning profiles, App Sandbox entitlements). Out of scope here.

---

## Where the magic lives

| file | role |
|---|---|
| `scripts/package.sh` | wrapper: build → ABI swap → stage dmgbuild bundle → electron-builder |
| `scripts/_native.sh` | shared with `dev.sh`/`test.sh`; per-ABI binding cache |
| `apps/desktop/electron-builder.yml` | files / asarUnpack / extraResources / mac config |
| `apps/desktop/scripts/afterPack.cjs` | ad-hoc `codesign --deep` of the .app (builtin signing is disabled via `identity: null`) |
| `apps/desktop/build/` | icon + README with `sips` recipe |
| `apps/desktop/build/icon.icns` | gets baked into `Contents/Resources/icon.icns` |
| `apps/desktop/src/main/index.ts` | `patchPathFromLoginShell()` + `resolveSilverhandCliLauncher()` packaged-build path |
| `packages/backend/src/proxy.ts` | one-URL → three env-vars expansion |
