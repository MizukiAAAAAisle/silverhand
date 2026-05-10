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

## Signing & notarization (not yet wired)

- `mac.identity: null` in `electron-builder.yml` → ad-hoc signed
  with the local `codesign --sign -`. Gatekeeper warns on first
  open ("App can't be opened because it is from an unidentified
  developer"). User has to right-click → Open the first time,
  then it remembers.
- For wider distribution: get an Apple Developer ID Application
  certificate, set `mac.identity: "Developer ID Application: <name>
  (<team-id>)"`, set `mac.hardenedRuntime: true`, add a notarization
  step (`afterSign` hook calling `@electron/notarize`).
- For the App Store: completely different config (`mas` target,
  provisioning profiles, App Sandbox entitlements). Out of scope
  here.

---

## Where the magic lives

| file | role |
|---|---|
| `scripts/package.sh` | wrapper: build → ABI swap → electron-builder |
| `scripts/_native.sh` | shared with `dev.sh`/`test.sh`; per-ABI binding cache |
| `apps/desktop/electron-builder.yml` | files / asarUnpack / extraResources / mac config |
| `apps/desktop/build/` | icon + README with `sips` recipe |
| `apps/desktop/build/icon.icns` | gets baked into `Contents/Resources/icon.icns` |
| `apps/desktop/src/main/index.ts` | `patchPathFromLoginShell()` + `resolveSilverhandCliLauncher()` packaged-build path |
| `packages/backend/src/proxy.ts` | one-URL → three env-vars expansion |
