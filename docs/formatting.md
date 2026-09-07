# Formatting

Oxfmt is pinned in the root development dependencies. Install dependencies with
`pnpm install --frozen-lockfile`.

```sh
# Format selected files or directories.
pnpm fmt apps/desktop/src/renderer/features/profile

# Check selected files without writing.
pnpm fmt:check apps/desktop/src/renderer/features/profile

# Format the repository (a separate migration from installing the tool).
pnpm fmt
```

The root `.oxfmtrc.json` sets a 100-column print width, two-space indentation, and
single-quoted JavaScript strings. Package key sorting is disabled. Generated
files, the lockfile, Rust build output, and local verification artifacts are
excluded. Existing source has not been bulk-formatted, so a repository-wide
check can report pre-existing formatting differences.

Oxfmt expands compressed blocks and wraps expressions, but can retain short
unbraced statements such as `if (!value) return null;`. Write explicit multiline
braced blocks when a branch needs that structure; formatting does not enforce
braces. This setup does not add a lint rule or a commit hook.

See the [official Oxfmt quickstart](https://oxc.rs/docs/guide/usage/formatter/quickstart.html).
