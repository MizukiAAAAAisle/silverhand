import { describe, expect, it } from 'vitest';
import { resolveAgentSideSection, visibleAgentSideSections } from './side-section-access';

describe('agent side section access', () => {
  it.each([
    [false, false, ['activity', 'profile']],
    [true, false, ['activity', 'profile', 'workspace']],
    [false, true, ['activity', 'profile', 'schedules']],
    [true, true, ['activity', 'profile', 'workspace', 'schedules']],
  ] as const)('projects file=%s schedule=%s access independently', (files, schedules, expected) => {
    expect(visibleAgentSideSections(files, schedules)).toEqual(expected);
  });

  it('clamps stored or externally requested private sections while permission is absent', () => {
    const visible = visibleAgentSideSections(false, false);

    expect(resolveAgentSideSection('workspace', visible)).toBe('activity');
    expect(resolveAgentSideSection('schedules', visible)).toBe('activity');
    expect(resolveAgentSideSection('profile', visible)).toBe('profile');
  });

  it('uses the same selection safely across permission loss and resolution', () => {
    expect(resolveAgentSideSection('workspace', visibleAgentSideSections(true, false))).toBe(
      'workspace',
    );
    expect(resolveAgentSideSection('workspace', visibleAgentSideSections(false, false))).toBe(
      'activity',
    );
    expect(resolveAgentSideSection('schedules', visibleAgentSideSections(false, true))).toBe(
      'schedules',
    );
  });
});
