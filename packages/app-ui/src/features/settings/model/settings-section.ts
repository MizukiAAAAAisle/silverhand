export type SettingsSection = "account" | "appearance" | "connection" | "hooks" | "notifications";

export const SETTINGS_SECTIONS: ReadonlyArray<SettingsSection> = [
  "account",
  "appearance",
  "connection",
  "notifications",
  "hooks",
];

const DEFAULT_SECTION: SettingsSection = SETTINGS_SECTIONS[0]!;

const SETTINGS_SECTION_KEY = "silverhand:settings-section";

let currentSection: SettingsSection | null = null;

function loadPersistedSection(): SettingsSection {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(SETTINGS_SECTION_KEY);
  } catch {
    // Unavailable storage — the default section is a fine starting point.
    return DEFAULT_SECTION;
  }
  // Migrate retired sections so returning users land somewhere valid.
  // `server` / `hosts` folded into Connection; `proxy` moved to the
  // Computers/Host detail surface because proxy affects runtime hosts,
  // not app-level settings. `profile` was renamed to `account` back when
  // identity editing lived in Members — a returning user who left the
  // app on `profile` lands on Account, which is again where profile
  // editing lives.
  if (raw === "server" || raw === "hosts" || raw === "proxy") return "connection";
  if (raw === "profile") return "account";
  return SETTINGS_SECTIONS.includes(raw as SettingsSection)
    ? (raw as SettingsSection)
    : DEFAULT_SECTION;
}

/** The section Settings opens on: this session's choice, else the stored one. */
export function readSettingsSection(): SettingsSection {
  currentSection ??= loadPersistedSection();
  return currentSection;
}

/**
 * Aim the next mount of Settings at `section`.
 *
 * Callers elsewhere in the app pair this with `nav.toSettings()`; the
 * in-memory write always lands, so the pane opens on the requested
 * section whether or not storage accepts the value. It does not steer an
 * already-mounted Settings page (no such caller exists — every caller is
 * on a different app section, which unmounts Settings).
 */
export function persistSettingsSection(section: SettingsSection): void {
  currentSection = section;
  try {
    localStorage.setItem(SETTINGS_SECTION_KEY, section);
  } catch {
    // Quota / disabled storage — the choice still holds for this session.
  }
}

/**
 * Forget the section, memory AND disk.
 *
 * The section is identity-bound — it reveals what the previous viewer was
 * looking at — so logout must wipe it (`clearViewerLocalState` in
 * `features/session/hooks`). Clearing the localStorage key alone would not:
 * the singleton above outlives a sign-out inside one renderer process, so
 * the next viewer would inherit the previous viewer's section from memory
 * and never consult the emptied storage. Same two-layer reset as
 * `clearPlaceMemory`, and it lives here because this module is the only
 * owner of both layers.
 */
export function clearSettingsSection(): void {
  currentSection = null;
  try {
    localStorage.removeItem(SETTINGS_SECTION_KEY);
  } catch {
    // Quota / disabled storage — the in-memory reset above is what matters.
  }
}
