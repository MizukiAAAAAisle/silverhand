import { describe, expect, it, vi } from 'vitest';
import { decodeTransportEpoch, decodeTransportSeq } from '@silverhand/shared';
import { isCurrentViewerScope } from '@/lib/ws-client';
import { isViewerAttentionFrame } from './hooks';
vi.mock('@/lib/ws-client', async orig => ({
  ...await orig<typeof import('@/lib/ws-client')>(),
  isCurrentViewerScope: vi.fn((scope: string) => scope === 'viewer:u'),
}));
describe('attention scope admission', () => {
  it('only resolves the viewer for content-bearing scoped variants', () => {
    expect(isViewerAttentionFrame({ type: 'error', code: 'auth_required', message: '' })).toBe(false);
    expect(isViewerAttentionFrame({ type: 'ping' })).toBe(false);
    expect(isViewerAttentionFrame({ type: 'error', code: 'forbidden', scope: 'agent:a', message: '' })).toBe(false);
    expect(isCurrentViewerScope).not.toHaveBeenCalled();
    const event = { type: 'event' as const, scope: 'viewer:u', epoch: decodeTransportEpoch('e'), seq: decodeTransportSeq(1), kind: 'notification', payload: {} };
    expect(isViewerAttentionFrame(event)).toBe(true);
    expect(isViewerAttentionFrame({ ...event, scope: 'agent:a' })).toBe(false);
    expect(isViewerAttentionFrame({ type: 'snapshot_required', scope: 'viewer:u', epoch: event.epoch, currentSeq: event.seq, reason: 'gap_too_large' })).toBe(true);
  });
});
