import { describe, expect, it } from 'vitest';
import { describeStartupFailure } from '../startup-failure';
import { LayoutMigrationError } from '../layout-migration/engine';
import { ProfileUnusableError } from '../backend-boot-mode';

describe('describeStartupFailure — the "data was not modified" claim', () => {
  it('claims it for the typed refusals that abort before writing', () => {
    expect(
      describeStartupFailure(
        new LayoutMigrationError('layout_conflict', 'both roots exist'),
      ),
    ).toMatchObject({ code: 'layout_conflict', dataUntouched: true });
    expect(
      describeStartupFailure(
        new ProfileUnusableError({
          mode: 'profile_invalid',
          profileUrl: 'http://box.local:8765',
          classifyMessage: 'plaintext http remote requires an opt-in build',
        }),
      ),
    ).toMatchObject({ code: 'profile_invalid', dataUntouched: true });
  });

  it('never claims it for an unknown crash — it may have failed mid-write', () => {
    expect(describeStartupFailure(new Error('EIO on daemon spawn'))).toMatchObject({
      code: 'startup_failed',
      dataUntouched: false,
    });
    expect(describeStartupFailure('boom')).toMatchObject({
      dataUntouched: false,
    });
  });
});

describe('describeStartupFailure — detail stays one short line', () => {
  it('trims the profile refusal down to address + classifier reason', () => {
    const notice = describeStartupFailure(
      new ProfileUnusableError({
        mode: 'profile_invalid',
        profileUrl: 'http://box.local:8765',
        classifyMessage: 'plaintext http remote requires an opt-in build',
      }),
    );
    // The error's own message is a multi-clause repair essay (env vars,
    // Settings steps); the window must not become that.
    expect(notice.detail).toBe(
      'http://box.local:8765 — plaintext http remote requires an opt-in build',
    );
  });

  it('collapses whitespace and caps length', () => {
    const notice = describeStartupFailure(
      new Error(`line one\n   line two ${'x'.repeat(400)}`),
    );
    expect(notice.detail).not.toContain('\n');
    expect(notice.detail!.length).toBeLessThanOrEqual(200);
    expect(notice.detail!.endsWith('…')).toBe(true);
  });

  it('omits detail entirely when the error says nothing', () => {
    expect(describeStartupFailure(new Error('   ')).detail).toBeNull();
  });
});
