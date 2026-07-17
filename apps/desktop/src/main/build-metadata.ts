// #task:1530 — desktop build metadata, injected at build time (main bundle ONLY).
//
// These defines are set in `electron.vite.config.ts`'s `main` block from env
// exported by `scripts/package.sh` before `pnpm -r build`. They are deliberately
// NOT defined for preload/renderer — build metadata is a main-process concern.
//
// `app_version` is NOT here: it comes from packaged `app.getVersion()` (a single
// release-version SoT). This module only carries the commit identity that
// `app.getVersion()` can't express.

declare const __SILVERHAND_BUILD_COMMIT__: string | undefined;
declare const __SILVERHAND_BUILD_DIRTY__: boolean | undefined;

/**
 * Full 40-hex commit sha the packaged bundle was built from, or `dev` for an
 * un-stamped local/dev build. Full sha (not `--short`) so a dirty build is never
 * mistaken for a reproducible artifact of that short prefix.
 */
export const BUILD_COMMIT: string =
  typeof __SILVERHAND_BUILD_COMMIT__ === 'string' &&
  __SILVERHAND_BUILD_COMMIT__.length > 0
    ? __SILVERHAND_BUILD_COMMIT__
    : 'dev';

/** True iff the build tree had uncommitted changes at package time. */
export const BUILD_DIRTY: boolean =
  typeof __SILVERHAND_BUILD_DIRTY__ === 'boolean' ? __SILVERHAND_BUILD_DIRTY__ : false;
