import { describe, expect, it } from 'vitest';
import { describeLocalHostWsAttachment } from '../local-host-ws-attachment';

describe('describeLocalHostWsAttachment (#task:1630)', () => {
  it('embedded with nothing attached is observable-but-empty, NOT unobservable', () => {
    // The falsifier for shortcut (2): deriving `observable` from the
    // timestamp. If this returned `{ observable: false }` the renderer
    // would stop polling the connecting window and the pill would sit
    // on a wrong steady state forever (`#task:1010` from the other
    // side). "Nothing attached yet" is a value INSIDE the observable
    // arm.
    expect(
      describeLocalHostWsAttachment({ backendKind: 'embedded', attachedAt: null }),
    ).toEqual({ observable: true, attached_at: null });
  });

  it('embedded with an attach timestamp surfaces it', () => {
    expect(
      describeLocalHostWsAttachment({ backendKind: 'embedded', attachedAt: 1_700 }),
    ).toEqual({ observable: true, attached_at: 1_700 });
  });

  it('remote is unobservable and never leaks a timestamp', () => {
    // The registry lives in the remote backend process. Even if a
    // caller hands us a number (stale read, test fixture, future
    // refactor that threads the wrong value), the remote arm must not
    // promote to observable: consumers read `observable: true` as
    // permission to treat `attached_at` as authoritative.
    expect(
      describeLocalHostWsAttachment({ backendKind: 'remote', attachedAt: null }),
    ).toEqual({ observable: false });
    expect(
      describeLocalHostWsAttachment({ backendKind: 'remote', attachedAt: 1_700 }),
    ).toEqual({ observable: false });
  });

  it('observability tracks the handle kind alone', () => {
    // Same timestamp, two kinds, two different observability answers —
    // the property this producer exists to hold.
    const attachedAt = 42;
    expect(
      describeLocalHostWsAttachment({ backendKind: 'embedded', attachedAt }).observable,
    ).toBe(true);
    expect(
      describeLocalHostWsAttachment({ backendKind: 'remote', attachedAt }).observable,
    ).toBe(false);
  });
});
