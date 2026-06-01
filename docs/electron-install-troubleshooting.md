# Electron install troubleshooting — `pnpm dev` fails with "Electron uninstall"

First observed: 2026-06-01.

## Symptom

```
error during start dev server and electron app:
Error: Electron uninstall
```

`electron-vite` aborts before launching anything. This is **not** a project
code problem — the `electron` npm package itself is half-installed.

## Root cause

`node_modules/.pnpm/electron@<ver>/node_modules/electron/index.js` resolves the
binary at load time by reading `path.txt`. If that file is missing it throws
`Electron failed to install correctly`, which `electron-vite` surfaces as the
opaque `Electron uninstall`.

In the observed case the package was left in this state:

- `path.txt` **missing**.
- `dist/` contained only a ~256K skeleton (`Electron.app/Contents/MacOS/Electron`
  — the 50K stub launcher — plus `LICENSE`), missing `version`,
  `LICENSES.chromium.html`, and the ~242M of real app contents.

The electron postinstall (`install.js`, which downloads via `@electron/get` and
unpacks via `extract-zip`) had **downloaded fine but failed during
extraction**: `extract-zip` bailed after ~2 entries and exited `0` with no
error, leaving the stub + no `path.txt`.

### Why it is NOT a mirror / download problem

This is the key diagnostic, and the part that diverges from the common advice in
[electron-vite#129](https://github.com/alex8088/electron-vite/issues/129) (where
setting `ELECTRON_MIRROR` fixes a *download* failure):

- The cached zip was **complete and valid** —
  `~/Library/Caches/electron/<hash>/electron-v<ver>-darwin-arm64.zip`, full byte
  count, `unzip -t` passes.
- Re-running `install.js` logged `@electron/get:index Cache hit` — it never
  touched the network.
- The cached zip's mtime predated the failure by days — the original download
  had already succeeded.

The download stage was healthy; the **extraction** stage is what broke. A mirror
only affects download, so it cannot fix this specific failure.

### Why the usual reinstall advice doesn't work here

Because the bug is in `extract-zip`, every code path that re-runs the postinstall
reproduces the same broken result:

- `pnpm install` → "Already up to date", postinstall not re-run.
- `pnpm rebuild electron` → silently skips, no `path.txt`.
- `node install.js` directly → re-extracts the same 256K skeleton, exits `0`.

## Fix — extract the cached zip manually

Bypass the broken `extract-zip` by unpacking the already-validated cached zip
with the system `unzip`, then write `path.txt` by hand. Run from the repo root:

```bash
P="$PWD/node_modules/.pnpm/$(ls node_modules/.pnpm | grep -m1 '^electron@')/node_modules/electron"
VER=$(node -p "require('$P/package.json').version")
ZIP=$(find ~/Library/Caches/electron -name "electron-v$VER-darwin-arm64.zip" | head -1)

rm -rf "$P/dist" "$P/path.txt"
unzip -q "$ZIP" -d "$P/dist"
printf 'Electron.app/Contents/MacOS/Electron' > "$P/path.txt"
```

Verify:

```bash
node -e "console.log(require('$P'))"          # prints .../Electron.app/Contents/MacOS/Electron
ELECTRON_RUN_AS_NODE= node "$P/cli.js" --version   # prints v<ver>
```

`dist/` should now be ~242M with `version`, `LICENSES.chromium.html`, and the
full `Electron.app`.

If the cached zip is missing or itself corrupt (`unzip -t` fails), delete it and
let `node "$P/install.js"` re-download once (optionally with a mirror — see
below), then unzip manually as above.

### Cosmetic note: codesign warning

After a manual `unzip`, `codesign -v dist/Electron.app` may warn `code has no
resources but signature indicates they must be present`. The binary still
launches (`electron --version` works), so this is harmless for local dev.
`scripts/dev.sh` only re-signs the swapped `better-sqlite3` `.node` binding, not
`Electron.app`, so nothing downstream depends on this signature.

## Optional: set a mirror for future reliability

A mirror won't fix the extraction bug above, but on a China network it makes
future downloads (reinstalls, version bumps) faster and less likely to land a
truncated zip:

```bash
# ~/.npmrc
electron_mirror=https://npmmirror.com/mirrors/electron/
# or, ad-hoc / CI:
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
```
