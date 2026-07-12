import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SRC = readFileSync(
  path.join(fileURLToPath(new URL('./SettingsPage.tsx', import.meta.url))),
  'utf8',
);

// Strip comments so a docstring that mentions a removed API can't pass a
// negative assertion.
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('SettingsPage — Account holds Log out only, no Computer lifecycle', () => {
  it('does not import the /api/me mutation hooks (edit surface moved to Members > Human Profile)', () => {
    expect(CODE).not.toMatch(/\buseUpdateProfile\b/);
    expect(CODE).not.toMatch(/\buseUploadAvatar\b/);
    expect(CODE).not.toMatch(/\buseClearAvatar\b/);
    expect(CODE).not.toMatch(/\buseViewerAvatarObjectUrl\b/);
  });

  it('does not import avatar picker primitives (no editing controls in this pane)', () => {
    expect(CODE).not.toMatch(/AvatarPickerButton/);
    expect(CODE).not.toMatch(/validateAvatarFile/);
    expect(CODE).not.toMatch(/AVATAR_MAX_SIZE_LABEL/);
  });

  it('holds no Members navigation coupling (Account stands alone)', () => {
    // Account is not a wayfinding surface for Members; carrying a link
    // in either direction would drift back into a second ownership site.
    expect(CODE).not.toMatch(/toMembersUser/);
    expect(CODE).not.toContain('Open in Members');
    expect(CODE).not.toMatch(/id="profile-display-name"/);
  });

  it('uses the `account` section id in place of the retired `profile` id', () => {
    expect(CODE).toMatch(
      /type SettingsSection = 'appearance' \| 'account' \| 'connection'/,
    );
    expect(CODE).not.toMatch(/type SettingsSection = [^;]*'profile'/);
    expect(CODE).toContain("label: 'Account'");
    expect(CODE).not.toContain("label: 'Profile'");
  });

  it("migrates the persisted `profile` key forward to `account` so returning users land somewhere valid", () => {
    expect(CODE).toMatch(/raw === 'profile'.*return 'account'/s);
  });

  it('renames the pane component from Profile to Account', () => {
    expect(CODE).toMatch(/function AccountPane\b/);
    expect(CODE).not.toMatch(/function ProfilePane\b/);
    expect(CODE).toMatch(/<AccountPane\s*\/>/);
  });

  it('holds only the plain Log out session action — no Computer lifecycle', () => {
    // Log out is user-session scope; revoking / deleting / refreshing a
    // Computer lives on the Computer Detail page. Bundling either into
    // Account would recreate the two-ownership-site problem #1476/1477
    // are draining.
    expect(CODE).toContain('Log out');
    expect(CODE).toMatch(/useLogout\(\)/);
    expect(CODE).not.toMatch(/\buseLogoutAndDisableHost\b/);
    expect(CODE).not.toMatch(/Remove this computer/);
    expect(CODE).not.toMatch(/Remove &? ?log out/);
    expect(CODE).not.toMatch(/\brevokeHost\b/);
    expect(CODE).not.toMatch(/\bShieldOff\b/);
  });

  it('does not read current-Computer lifecycle state (no BackendInfo / hosts import in Account scope)', () => {
    // Account is session-scope; any Computer lifecycle probe here would
    // drift Account back into a wayfinding role for Computers.
    expect(CODE).not.toMatch(/useBackendInfoSnapshot/);
    expect(CODE).not.toMatch(/local_host_status/);
    expect(CODE).not.toMatch(/local_host_id/);
  });

  it('page-scope subtitle does not claim host ownership', () => {
    // Settings is app/client-scope; host ownership lives on the
    // Computers surface. The page subtitle covers Appearance + Account
    // + Connection and stays clear of host-kind chrome.
    expect(SRC).not.toMatch(/Host-level preferences/);
    expect(SRC).not.toMatch(/data-host-kind-tag/);
    expect(SRC).toContain(
      'Application preferences, account access, and server connection.',
    );
  });

  it('carries the Log out action fact in declarative product copy', () => {
    // One row, one fact — Log out ends the current sign-in on this
    // computer. Any imperative/possessive/future-tense phrasing from
    // the prior compound "Remove & log out" copy is retired.
    expect(SRC).toContain('Ends the current sign-in on this computer.');
    expect(SRC).not.toMatch(/Revokes this computer's access/);
    expect(SRC).not.toMatch(/Workspaces and messages are preserved/);
    expect(SRC).not.toMatch(/Agents on this computer stop/);
    expect(SRC).not.toMatch(/Stop this computer from running agents/);
    expect(SRC).not.toMatch(/Your workspaces and messages are kept/);
    expect(SRC).not.toMatch(/This computer will stop running agents/);
  });

  it("Log out button holds an ink border at rest and swaps to a still-floating hover with a 1px lift", () => {
    expect(SRC).toMatch(
      /border-\[length:var\(--control-border-width\)\]\s+border-border-focus\s+transition-\[color,background-color,border-color,transform\]\s+hover:-translate-y-px\s+hover:bg-bg-floating/,
    );
  });
});
