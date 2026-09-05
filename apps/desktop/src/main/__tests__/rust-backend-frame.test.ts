import { describe, expect, it } from 'vitest';

import {
  BOUND_FRAME_KIND,
  BOUND_FRAME_MAX_BYTES,
  BoundFrameReader,
  STARTUP_PROTOCOL_VERSION,
  parseBoundFrame,
} from '../rust-backend-frame.js';

const GEN = 'gen-abc-123';

function frameLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: STARTUP_PROTOCOL_VERSION,
    kind: BOUND_FRAME_KIND,
    generation: GEN,
    url: 'http://127.0.0.1:51763',
    port: 51763,
    ...overrides,
  });
}

describe('parseBoundFrame — the hardened frame contract', () => {
  it('decodes UTF-8 only after reassembling byte chunks, and bounds post-bound unterminated data', () => {
    const generation = '你好';
    const bytes = Buffer.from(`${frameLine({ generation })}\n`);
    const split = bytes.indexOf(Buffer.from(generation)) + 1;
    const reader = preparedReader(generation);
    expect(reader.push(bytes.subarray(0, split))).toEqual({ status: 'prepared' });
    expect(reader.push(bytes.subarray(split))).toMatchObject({ status: 'bound' });
    expect(reader.push(Buffer.alloc(BOUND_FRAME_MAX_BYTES, 97))).toEqual({ status: 'invalid', reason: 'oversize' });
  });
  it('accepts the exact contract frame and surfaces url + resolved port', () => {
    const result = parseBoundFrame(frameLine(), GEN);
    expect(result).toEqual({
      status: 'bound',
      frame: { url: 'http://127.0.0.1:51763', port: 51763 },
    });
  });

  it('accepts an ipv6 loopback url whose port matches', () => {
    const result = parseBoundFrame(
      frameLine({ url: 'http://[::1]:40001', port: 40001 }),
      GEN,
    );
    expect(result).toEqual({
      status: 'bound',
      frame: { url: 'http://[::1]:40001', port: 40001 },
    });
  });

  it('rejects a wrong protocol version (no fallback across an incompatible frame)', () => {
    expect(parseBoundFrame(frameLine({ v: 1 }), GEN)).toEqual({
      status: 'invalid',
      reason: 'unknown-version',
    });
  });

  it('rejects a non-bound kind', () => {
    expect(parseBoundFrame(frameLine({ kind: 'ready' }), GEN)).toEqual({
      status: 'invalid',
      reason: 'wrong-kind',
    });
  });

  it('rejects a generation that is not the exact minted value', () => {
    expect(parseBoundFrame(frameLine({ generation: 'other' }), GEN)).toEqual({
      status: 'invalid',
      reason: 'generation-mismatch',
    });
    expect(parseBoundFrame(frameLine({ generation: 123 }), GEN)).toEqual({
      status: 'invalid',
      reason: 'generation-mismatch',
    });
  });

  it('rejects extra/unknown keys (a padded frame does not become bound)', () => {
    expect(parseBoundFrame(frameLine({ secret: 'leak' }), GEN)).toEqual({
      status: 'invalid',
      reason: 'extra-keys',
    });
  });

  it('rejects a url whose port disagrees with the reported port', () => {
    expect(
      parseBoundFrame(frameLine({ url: 'http://127.0.0.1:9999', port: 51763 }), GEN),
    ).toEqual({ status: 'invalid', reason: 'bad-url' });
  });

  it('rejects a non-loopback url', () => {
    expect(
      parseBoundFrame(frameLine({ url: 'http://10.0.0.5:51763', port: 51763 }), GEN),
    ).toEqual({ status: 'invalid', reason: 'bad-url' });
  });

  it('rejects an https url or one carrying a path/query', () => {
    expect(
      parseBoundFrame(frameLine({ url: 'https://127.0.0.1:51763', port: 51763 }), GEN),
    ).toEqual({ status: 'invalid', reason: 'bad-url' });
    expect(
      parseBoundFrame(frameLine({ url: 'http://127.0.0.1:51763/x', port: 51763 }), GEN),
    ).toEqual({ status: 'invalid', reason: 'bad-url' });
  });

  it('rejects a non-integer / out-of-range port', () => {
    expect(parseBoundFrame(frameLine({ port: 0 }), GEN)).toEqual({
      status: 'invalid',
      reason: 'bad-port',
    });
    expect(parseBoundFrame(frameLine({ port: 70000 }), GEN)).toEqual({
      status: 'invalid',
      reason: 'bad-port',
    });
    expect(parseBoundFrame(frameLine({ port: 1.5 }), GEN)).toEqual({
      status: 'invalid',
      reason: 'bad-port',
    });
  });

  it('rejects non-JSON, non-object, and oversize lines', () => {
    expect(parseBoundFrame('not json', GEN)).toEqual({
      status: 'invalid',
      reason: 'not-json',
    });
    expect(parseBoundFrame('[1,2,3]', GEN)).toEqual({
      status: 'invalid',
      reason: 'not-object',
    });
    const oversize = JSON.stringify({
      v: STARTUP_PROTOCOL_VERSION,
      kind: BOUND_FRAME_KIND,
      generation: 'g'.repeat(BOUND_FRAME_MAX_BYTES),
      url: 'http://127.0.0.1:1',
      port: 1,
    });
    expect(parseBoundFrame(oversize, GEN)).toEqual({
      status: 'invalid',
      reason: 'oversize',
    });
  });
});

function preparedReader(generation: string): BoundFrameReader {
  const reader = new BoundFrameReader(generation);
  for (const kind of ['preparing', 'prepared']) reader.push(`${JSON.stringify({ v: STARTUP_PROTOCOL_VERSION, kind, generation })}\n`);
  return reader;
}

describe('BoundFrameReader — ordered startup stdout semantics', () => {
  it('rejects missing, repeated, reordered and wrong-generation preparation phases', () => {
    const phase = (kind: string, generation = GEN) => `${JSON.stringify({v: STARTUP_PROTOCOL_VERSION, kind, generation})}\n`;
    for (const lines of [frameLine() + '\n', phase('prepared'), phase('preparing') + phase('preparing'), phase('preparing') + phase('prepared', 'wrong')]) {
      const reader = new BoundFrameReader(GEN);
      expect(reader.push(lines)).toMatchObject({status: 'invalid'});
    }
  });
  it('settles bound on the first complete line, ignoring blank lines', () => {
    const reader = new BoundFrameReader(GEN);
    expect(reader.push('\n')).toBeNull(); // blank ignored
    expect(reader.push(`${JSON.stringify({v: STARTUP_PROTOCOL_VERSION, kind: 'preparing', generation: GEN})}\n${JSON.stringify({v: STARTUP_PROTOCOL_VERSION, kind: 'prepared', generation: GEN})}\n${frameLine()}\n`)).toEqual({
      status: 'bound',
      frame: { url: 'http://127.0.0.1:51763', port: 51763 },
    });
  });

  it('assembles a frame split across chunks', () => {
    const reader = preparedReader(GEN);
    const line = frameLine();
    const mid = Math.floor(line.length / 2);
    expect(reader.push(line.slice(0, mid))).toEqual({ status: 'prepared' });
    expect(reader.push(line.slice(mid))).toEqual({ status: 'prepared' }); // no newline yet
    expect(reader.push('\n')).toEqual({
      status: 'bound',
      frame: { url: 'http://127.0.0.1:51763', port: 51763 },
    });
  });

  it('flips to duplicate when a second non-blank line arrives after a frame', () => {
    const reader = preparedReader(GEN);
    reader.push(`${frameLine()}\n`);
    expect(reader.push('anything\n')).toEqual({ status: 'duplicate' });
  });

  it('keeps an invalid first line invalid (never a silent recovery from a later line)', () => {
    const reader = new BoundFrameReader(GEN);
    expect(reader.push('garbage\n')).toEqual({
      status: 'invalid',
      reason: 'not-json',
    });
    // A subsequent valid-looking line does NOT rescue it — it is a duplicate.
    expect(reader.push(`${frameLine()}\n`)).toEqual({ status: 'duplicate' });
  });

  it('#task:2343 P1-9: rejects a line whose byte length REACHES the cap (exact-boundary, same as Rust `>=`)', () => {
    // A single line whose UTF-8 byte length is exactly BOUND_FRAME_MAX_BYTES is over the
    // limit on BOTH sides (`>=`). Build a line of exactly the cap length.
    const line = 'a'.repeat(BOUND_FRAME_MAX_BYTES);
    expect(Buffer.byteLength(line, 'utf8')).toBe(BOUND_FRAME_MAX_BYTES);
    expect(parseBoundFrame(line, GEN)).toEqual({ status: 'invalid', reason: 'oversize' });
    // One byte under the cap is NOT rejected for length (it fails as not-json instead).
    const under = 'a'.repeat(BOUND_FRAME_MAX_BYTES - 1);
    expect(parseBoundFrame(under, GEN)).toEqual({ status: 'invalid', reason: 'not-json' });
  });

  it('#task:2343 P1-9: streaming byte bound — an unterminated buffer reaching the cap is rejected WITHOUT a newline (no unbounded accumulation)', () => {
    const reader = new BoundFrameReader(GEN);
    // Feed a huge chunk with NO newline; the reader must reject by byte growth rather than
    // accumulate forever waiting for a `\n` that never comes.
    const huge = 'x'.repeat(BOUND_FRAME_MAX_BYTES + 10);
    expect(reader.push(huge)).toEqual({ status: 'invalid', reason: 'oversize' });
  });

  it('#task:2343 P1-9: streaming byte bound accumulates ACROSS chunks with no newline', () => {
    const reader = new BoundFrameReader(GEN);
    const half = 'y'.repeat(Math.floor(BOUND_FRAME_MAX_BYTES / 2) + 1);
    expect(reader.push(half)).toBeNull(); // under cap so far, no newline
    // Second chunk pushes the unterminated buffer over the cap.
    expect(reader.push(half)).toEqual({ status: 'invalid', reason: 'oversize' });
  });

  it('#task:2343 P1-9: a valid frame with multibyte UTF-8 under the byte cap still parses', () => {
    const reader = new BoundFrameReader(GEN);
    // The generation echo carries multibyte characters; the frame is well under the cap.
    const gen = '世界-🌍';
    const r2 = preparedReader(gen);
    const line = `${JSON.stringify({
      v: STARTUP_PROTOCOL_VERSION,
      kind: BOUND_FRAME_KIND,
      generation: gen,
      url: 'http://127.0.0.1:51763',
      port: 51763,
    })}\n`;
    expect(r2.push(line)).toEqual({
      status: 'bound',
      frame: { url: 'http://127.0.0.1:51763', port: 51763 },
    });
    void reader;
  });
});
