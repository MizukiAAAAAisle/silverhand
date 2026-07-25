import { describe, expect, it } from 'vitest';
import { localWorkspacePathMap } from './local-paths';

describe('localWorkspacePathMap', () => {
  it('indexes only daemon-local entries', () => {
    expect(
      localWorkspacePathMap({
        ok: true,
        entries: [
          { workspace_id: 'w1', path: '/local/w1' },
          { workspace_id: 'w2', path: '/local/w2' },
        ],
      }),
    ).toEqual(
      new Map([
        ['w1', '/local/w1'],
        ['w2', '/local/w2'],
      ]),
    );
  });

  it('returns no paths when local authority is unavailable', () => {
    expect(
      localWorkspacePathMap({ ok: false, reason: 'registry_unavailable' }),
    ).toEqual(new Map());
  });
});
