import { describe, it, expect } from 'vitest';
import {
  type MessageSeq,
  type TransportSeq,
  type ReadSeq,
  type ObservedSeq,
  type TransportEpoch,
  asReadSeq,
  asObservedSeq,
  advanceTransportSeq,
  decodeMessageSeq,
  decodeTransportSeq,
  decodeReadSeq,
  decodeObservedSeq,
  decodeTransportEpoch,
} from '../src/seq.js';

// Brands are erased at runtime; these tests pin the two legal `number → brand`
// routes (mint at origin, decode at a boundary) and the compile-time Axis-A wall.
// See docs/brand-typed-seq-v1.md §3/§4/§4.1.

describe('mint helpers (doc §4)', () => {
  it('asReadSeq mints a ReadSeq from a MessageSeq, value-preserving', () => {
    const m = decodeMessageSeq(7);
    const r: ReadSeq = asReadSeq(m);
    expect(r).toBe(7);
  });

  it('asObservedSeq mints an ObservedSeq from a MessageSeq, value-preserving', () => {
    const m = decodeMessageSeq(42);
    const o: ObservedSeq = asObservedSeq(m);
    expect(o).toBe(42);
  });
});

describe('decode boundaries (doc §4.1)', () => {
  it('decodes non-negative integers for each numeric brand', () => {
    expect(decodeMessageSeq(0)).toBe(0); // allocator base / empty stream head
    expect(decodeMessageSeq(1)).toBe(1); // first real message
    expect(decodeTransportSeq(0)).toBe(0); // never-published scope high-water
    expect(decodeReadSeq(0)).toBe(0); // never-read cursor
    expect(decodeObservedSeq(5)).toBe(5);
  });

  it.each([
    ['decodeMessageSeq', decodeMessageSeq],
    ['decodeTransportSeq', decodeTransportSeq],
    ['decodeReadSeq', decodeReadSeq],
    ['decodeObservedSeq', decodeObservedSeq],
  ])('%s rejects negative / non-integer / non-finite garbage', (_name, decode) => {
    expect(() => decode(-1)).toThrow(RangeError);
    expect(() => decode(1.5)).toThrow(RangeError);
    expect(() => decode(NaN)).toThrow(RangeError);
    expect(() => decode(Infinity)).toThrow(RangeError);
  });

  it('decodeTransportEpoch accepts a non-empty string, rejects empty', () => {
    const e: TransportEpoch = decodeTransportEpoch('550e8400-e29b-41d4-a716-446655440000');
    expect(e).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(() => decodeTransportEpoch('')).toThrow(RangeError);
  });
});

describe('advanceTransportSeq (doc §4) — the single +1 boundary', () => {
  it('advances a TransportSeq by one, staying branded and value-correct', () => {
    const t0: TransportSeq = decodeTransportSeq(0); // never-published origin
    const t1: TransportSeq = advanceTransportSeq(t0);
    const t2: TransportSeq = advanceTransportSeq(t1);
    expect(t1).toBe(1);
    expect(t2).toBe(2);
  });

  it('takes only a TransportSeq — a raw number or other brand must not compile', () => {
    // @ts-expect-error advance is +1 on a TransportSeq, not a raw number.
    advanceTransportSeq(5);
    // @ts-expect-error a MessageSeq is not a transport ordinal (no cross-space advance).
    advanceTransportSeq(decodeMessageSeq(5));
  });
});

describe('Axis-A compile-time wall (doc §3) — these must NOT compile', () => {
  it('a MessageSeq is never assignable to a TransportSeq (and vice versa)', () => {
    const m: MessageSeq = decodeMessageSeq(3);
    const t: TransportSeq = decodeTransportSeq(3);

    // @ts-expect-error MessageSeq ↔ TransportSeq: no conversion exists (the hard wall).
    const _bad1: TransportSeq = m;
    // @ts-expect-error TransportSeq → MessageSeq is always a bug.
    const _bad2: MessageSeq = t;
    // @ts-expect-error a raw number cannot become a branded seq without decode/mint.
    const _bad3: MessageSeq = 3;
    // @ts-expect-error asReadSeq takes a PRESENT MessageSeq — no asReadSeq(undefined).
    asReadSeq(undefined);
    // @ts-expect-error a TransportSeq is not a MessageSeq, so it cannot be minted to ReadSeq.
    asReadSeq(t);

    expect(m).toBe(3);
    expect(t).toBe(3);
  });
});
