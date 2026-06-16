import { describe, expect, it } from 'vitest';
import { archivedChannelsEnabledForKind } from './hooks';

/** #task:1145 regression guard. The archived channel-like query must stay
 *  enabled for DM (agent_home) workspaces, not just regular ones — otherwise
 *  an archived DM opened from the global Archived panel can't load and the
 *  conversation pane goes blank. Pins `dm` enabled so this can't silently
 *  revert to the old regular-only gate. */
describe('archivedChannelsEnabledForKind', () => {
  it('is enabled for regular workspaces', () => {
    expect(archivedChannelsEnabledForKind('regular')).toBe(true);
  });

  it('is enabled for DM (agent_home) workspaces', () => {
    expect(archivedChannelsEnabledForKind('dm')).toBe(true);
  });

  it('is disabled when the workspace kind is unknown (null)', () => {
    expect(archivedChannelsEnabledForKind(null)).toBe(false);
  });
});
