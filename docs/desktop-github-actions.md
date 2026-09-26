# Desktop DMG builds on GitHub Actions

`.github/workflows/desktop-dmg.yml` calls the same `scripts/package.sh` used
locally. It builds embedded and remote-only apps in separate standard
`macos-15` ARM64 jobs. It does not build or deploy the standalone ECS server,
publish npm packages, bump versions, or create tags.

## Repository setup

Configure the non-secret repository Actions variable (not an Environment):

```sh
gh variable set SILVERHAND_REMOTE_SERVER_URL --body 'https://silverhand.taobao.net'
gh variable list
```

Run this in the intended repository, or pass `--repo OWNER/REPO`. Missing or
invalid HTTPS origins fail preflight. Credentials, paths, query strings and
loopback URLs are rejected. The URL is baked into the remote-only app; changing
the variable does not alter previously built apps. Embedded keeps its existing
local default.

No Apple signing secrets are needed: existing ad-hoc signing is retained, with
no Apple notarization. These builds are not Developer ID distribution builds;
macOS Gatekeeper may require user intervention after downloading.

Allow the pinned actions in repository/organization Actions policy. Build jobs
have read-only repository permissions; only the tag release job gets
`contents: write` through `GITHUB_TOKEN`. No personal token is needed.

## Triggering

- **Manual:** Actions → Desktop DMG → Run workflow. This produces both variants
  as download artifacts, even when manually selecting a tag. It never publishes
  a Release. The workflow must first exist on the default branch.
- **Release:** push `desktop-vX.Y.Z`, exactly matching
  `apps/desktop/package.json.version`. Both builds must succeed before creating
  a Release. Old `desktop-vX.Y.Z-build.*` names and prerelease versions are not
  accepted by this workflow. Use manual runs for development builds.
- Ordinary branch pushes and daemon tags do not trigger packaging.

Version and source SHA come from the checked-out commit, not the latest main.
Node 22, the root `packageManager` pnpm version and Rust 1.94.0 are used; pnpm
and Cargo lockfiles are enforced. Actions are SHA-pinned. Rust compilation is
cached for embedded builds; target/config/toolchain changes invalidate its key.
Each build job has a 60-minute timeout, adjustable after hosted-runner evidence.

## Outputs and recovery

Each variant uploads only:

- `Silverhand-X.Y.Z-embedded-arm64.dmg` or `Silverhand-X.Y.Z-remote-only-arm64.dmg`
- Its `.dmg.sha256` sidecar (`shasum -a 256 -c FILE.dmg.sha256` on macOS).

ZIPs, unpacked apps and caches are not uploaded as artifacts. Actions artifacts
expire after 7 days, including the temporary handoff artifacts for tag builds.
The tag Release retains both DMGs and checksums independently of that expiry.
Private-repository releases remain private.

The release job verifies both checksums, creates a draft and publishes it only
after all uploads succeed. It never overwrites an existing release or assets.
If uploading/publishing fails, inspect the draft before recovery: complete and
publish that draft manually, or explicitly delete only that failed draft before
rerunning the release job. A published release is not replaced on reruns.
Electron-builder automatic publishing is disabled; this workflow owns publishing.

## Verification

```sh
node --test scripts/ci/desktop-dmg.test.mjs
actionlint .github/workflows/desktop-dmg.yml
bash -n scripts/package.sh
```

Packaging also verifies app signatures, shipped version/source metadata and
daemon bytes using the existing script. Local static checks do not substitute
for the first hosted build: validate both downloaded DMGs on a test Mac before
announcing a release. No running user instance is started by this workflow.
