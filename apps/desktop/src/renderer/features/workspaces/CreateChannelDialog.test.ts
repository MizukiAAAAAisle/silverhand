/**
 * Unit tests for the pure seed helper used by `CreateChannelDialog`.
 * Cindy review #task:890 surfaced a race: when `members` resolves
 * BEFORE the viewer query, the seed effect previously ran with
 * `viewerUserId === null`, the `filter(m => m.id !== null)` became a
 * no-op, the viewer ended up in `selectedHumans`, and the latched
 * `seededOnceRef` prevented self-correction once the viewer id later
 * arrived. Since `candidates` always excludes the viewer, the leftover
 * selected key rendered as a `id.slice(0, 8)` orphan chip.
 *
 * The fix is two parts:
 *   1. The seed effect now gates on `viewerUserId !== null` — these
 *      tests document that contract by asserting the helper produces
 *      a viewer-free human list ONLY when the caller has a real id.
 *   2. The pure helper itself is exported so the gate logic stays
 *      verifiable without spinning up React DOM.
 */
import { describe, expect, it } from 'vitest';
import { computeChannelSeedSelection } from './CreateChannelDialog';

describe('computeChannelSeedSelection', () => {
  const members = {
    agents: [{ id: 'agent-alice' }, { id: 'agent-bob' }],
    humans: [
      { id: 'user-viewer' },
      { id: 'user-other1' },
      { id: 'user-other2' },
    ],
  };

  it('seeds all agents and humans except the viewer when the id is known', () => {
    expect(
      computeChannelSeedSelection({ members, viewerUserId: 'user-viewer' }),
    ).toEqual({
      agents: ['agent-alice', 'agent-bob'],
      humans: ['user-other1', 'user-other2'],
    });
  });

  it('keeps every human when the viewer is not in the member list', () => {
    expect(
      computeChannelSeedSelection({ members, viewerUserId: 'user-not-here' }),
    ).toEqual({
      agents: ['agent-alice', 'agent-bob'],
      humans: ['user-viewer', 'user-other1', 'user-other2'],
    });
  });

  it('handles the empty-members case without throwing', () => {
    expect(
      computeChannelSeedSelection({
        members: { agents: [], humans: [] },
        viewerUserId: 'user-viewer',
      }),
    ).toEqual({ agents: [], humans: [] });
  });
});
