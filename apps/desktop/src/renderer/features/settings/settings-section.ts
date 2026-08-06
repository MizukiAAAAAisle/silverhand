/**
 * Which sub-page of Settings is visible.
 *
 * A module of its own (rather than local state inside `SettingsPage`)
 * because another surface now needs to *aim* at a section: the read-only
 * human profile card in Members routes the viewer to Settings > Account
 * (#task:1846), and `nav.toSettings()` carries no section — settings
 * deep-links have no URL slot, the pane picks its section up from here on
 * mount.
 *
 * The section is a module-level singleton with localStorage as
 * write-through backing, the same shape as `lib/place-memory`. Memory is
 * what the next mount reads; storage only carries the choice across a
 * restart and may be unavailable (disabled, partitioned, over quota), so
 * every access is best-effort. An aim that depended on the disk write
 * would turn a storage failure into a dead click.
 */
export type SettingsSection = 'appearance' | 'account' | 'connection';

export const SETTINGS_SECTIONS: ReadonlyArray<SettingsSection> = [
  'appearance',
  'account',
  'connection',
];

const SETTINGS_SECTION_KEY = 'silverhand:settings-section';

let currentSection: SettingsSection | null = null;

function loadPersistedSection(): SettingsSection {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(SETTINGS_SECTION_KEY);
  } catch {
    // Unavailable storage — the default section is a fine starting point.
    return 'appearance';
  }
  // Migrate retired sections so returning users land somewhere valid.
  // `server` / `hosts` folded into Connection; `proxy` moved to the
  // Computers/Host detail surface because proxy affects runtime hosts,
  // not app-level settings. `profile` was renamed to `account` back when
  // identity editing lived in Members — a returning user who left the
  // app on `profile` lands on Account, which is again where profile
  // editing lives.
  if (raw === 'server' || raw === 'hosts' || raw === 'proxy') return 'connection';
  if (raw === 'profile') return 'account';
  return SETTINGS_SECTIONS.includes(raw as SettingsSection)
    ? (raw as SettingsSection)
    : 'appearance';
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
