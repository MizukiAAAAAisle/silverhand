declare const __SILVERHAND_BUILD_COMMIT__: string | undefined;
declare const __SILVERHAND_BUILD_DIRTY__: boolean | undefined;

/**
 * Full 40-hex commit sha the packaged bundle was built from, or `dev` for an
 * un-stamped local/dev build. Full sha (not `--short`) so a dirty build is never
 * mistaken for a reproducible artifact of that short prefix.
 */
export const BUILD_COMMIT: string =
  typeof __SILVERHAND_BUILD_COMMIT__ === "string" && __SILVERHAND_BUILD_COMMIT__.length > 0
    ? __SILVERHAND_BUILD_COMMIT__
    : "dev";

/** True iff the build tree had uncommitted changes at package time. */
export const BUILD_DIRTY: boolean =
  typeof __SILVERHAND_BUILD_DIRTY__ === "boolean" ? __SILVERHAND_BUILD_DIRTY__ : false;
