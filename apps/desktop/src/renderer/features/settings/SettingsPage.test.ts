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

describe('SettingsPage — Account owns the profile editor, not Computer lifecycle', () => {
  it('composes the shared viewer profile editor instead of re-implementing it', () => {
    // Profile editing lives in Account (#task:1846), but the `/api/me`
    // wiring stays in `features/me/ViewerProfileEditor` — one owner for
    // the mutations, whichever pane hosts it.
    expect(CODE).toMatch(/ViewerProfileEditor/);
    expect(CODE).not.toMatch(/\buseUpdateProfile\b/);
    expect(CODE).not.toMatch(/\buseUploadAvatar\b/);
    expect(CODE).not.toMatch(/\buseViewerAvatarObjectUrl\b/);
    expect(CODE).not.toMatch(/AvatarPickerButton/);
    expect(CODE).not.toMatch(/validateAvatarFile/);
  });

  it('holds no Members navigation coupling (Account stands alone)', () => {
    // Account is not a wayfinding surface for Members; the one link
    // between them points this way (Members → Account), not back.
    expect(CODE).not.toMatch(/toMembersUser/);
  });

  it('holds only the session-scope Log out action — no Computer lifecycle', () => {
    // Log out is user-session scope; revoking / deleting / refreshing a
    // Computer lives on the Computer Detail page. Bundling either into
    // Account would recreate the two-ownership-site problem #1476/1477
    // are draining.
    expect(CODE).toMatch(/useLogout\(\)/);
    expect(CODE).not.toMatch(/\buseLogoutAndDisableHost\b/);
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
});
