import { describe, expect, it } from 'vitest';
import {
  HOST_CONNECTION_CHANGED_EVENT,
  type ServerFrame,
} from '@silverhand/shared';
import { decideHostConnectionSyncAction } from './host-connection-sync';

const isViewerScope = (scope: string): boolean => scope === 'viewer:u1';

function evt(scope: string, kind: string, payload: unknown): ServerFrame {
  return {
    type: 'event',
    scope,
    seq: 1,
    epoch: 'e',
    kind,
    payload,
  } as ServerFrame;
}

describe('decideHostConnectionSyncAction', () => {
  it('invalidates one host for valid current-viewer host connection events', () => {
    expect(
      decideHostConnectionSyncAction(
        evt('viewer:u1', HOST_CONNECTION_CHANGED_EVENT, { host_id: 'h1' }),
        isViewerScope,
      ),
    ).toEqual({ kind: 'invalidate-host', hostId: 'h1' });
  });

  it('ignores malformed host connection payloads', () => {
    expect(
      decideHostConnectionSyncAction(
        evt('viewer:u1', HOST_CONNECTION_CHANGED_EVENT, { host_id: 42 }),
        isViewerScope,
      ),
    ).toBeNull();
  });

  it('ignores other viewer scopes and other event kinds', () => {
    expect(
      decideHostConnectionSyncAction(
        evt('viewer:u2', HOST_CONNECTION_CHANGED_EVENT, { host_id: 'h1' }),
        isViewerScope,
      ),
    ).toBeNull();
    expect(
      decideHostConnectionSyncAction(
        evt('viewer:u1', 'notification', { host_id: 'h1' }),
        isViewerScope,
      ),
    ).toBeNull();
  });

  it('invalidates all host projections on current-viewer snapshot_required', () => {
    expect(
      decideHostConnectionSyncAction(
        {
          type: 'snapshot_required',
          scope: 'viewer:u1',
          reason: 'epoch_mismatch',
        } as ServerFrame,
        isViewerScope,
      ),
    ).toEqual({ kind: 'invalidate-all' });
  });

  it('ignores snapshot_required on non-viewer scopes', () => {
    expect(
      decideHostConnectionSyncAction(
        {
          type: 'snapshot_required',
          scope: 'app',
          reason: 'epoch_mismatch',
        } as ServerFrame,
        isViewerScope,
      ),
    ).toBeNull();
  });
});
