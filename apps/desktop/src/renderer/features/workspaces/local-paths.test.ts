import { describe, expect, it } from 'vitest';
import { localWorkspacePathMap } from './local-paths';

describe('localWorkspacePathMap', () => {
  it('indexes only daemon-local entries', () => {
    expect(
      localWorkspacePathMap({
        entries: [
          { workspace_id: 'w1', path: '/local/w1' },
          { workspace_id: 'w2', path: '/local/w2' },
        ],
        unavailable_workspace_ids: [],
      }),
    ).toEqual(
      new Map([
        ['w1', '/local/w1'],
        ['w2', '/local/w2'],
      ]),
    );
  });

  it('returns no paths when every daemon-local path is unavailable', () => {
    expect(
      localWorkspacePathMap({
        entries: [],
        unavailable_workspace_ids: ['w1'],
      }),
    ).toEqual(new Map());
  });
});
