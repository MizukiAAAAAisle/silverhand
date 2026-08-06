/**
 * Which sub-page of Settings is visible.
 *
 * A module of its own (rather than local state inside `SettingsPage`)
 * because another surface now needs to *aim* at a section: the read-only
 * human profile card in Members routes the viewer to Settings > Account
 * (#task:1845), and `nav.toSettings()` carries no section — settings
 * deep-links have no URL slot, the pane restores its last section from
 * localStorage on mount.
 */
export type SettingsSection = 'appearance' | 'account' | 'connection';

export const SETTINGS_SECTIONS: ReadonlyArray<SettingsSection> = [
  'appearance',
  'account',
  'connection',
];

const SETTINGS_SECTION_KEY = 'silverhand:settings-section';

export function readPersistedSettingsSection(): SettingsSection {
  if (typeof localStorage === 'undefined') return 'appearance';
  const raw = localStorage.getItem(SETTINGS_SECTION_KEY);
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

/**
 * Aim the next mount of Settings at `section`.
 *
 * Write-only on purpose: `SettingsPage` reads this once on mount, so a
 * caller elsewhere in the app pairs this with `nav.toSettings()` and the
 * pane opens on the requested section. It does not steer an already-
 * mounted Settings page (no such caller exists — every caller is on a
 * different app section, which unmounts Settings).
 */
export function persistSettingsSection(section: SettingsSection): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(SETTINGS_SECTION_KEY, section);
}
