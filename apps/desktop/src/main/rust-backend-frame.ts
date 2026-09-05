// #task:2343 — the launcher-side dual of the Rust backend's stdout startup handoff
// frame. The prebuilt `silverhand-backend` child writes EXACTLY ONE line to stdout the
// instant its listener is bound and the app is composed:
//
//   {"v":1,"kind":"bound","generation":"<echo>","url":"http://127.0.0.1:<port>","port":<port>}
//
// This module parses that line under the hardened acceptance boundary (shiki+Cindy):
// strict protocol version, length bound, single frame, and generation echo matching the
// value THIS spawn minted. Anything unknown / malformed / oversize / duplicated / with a
// wrong generation is a startup FAILURE — the launcher never falls back to the TS
// backend. The frame carries ONLY these fields (no token/path/secret/product-version);
// wire compatibility is the independent `api_epoch`, artifact identity is the sidecar
// manifest, and this frame's `generation` is only process correlation.

/** The startup protocol version this launcher understands. Must match the Rust
 * `STARTUP_PROTOCOL_VERSION`; a frame with any other `v` is rejected. */
export const STARTUP_PROTOCOL_VERSION = 1;

/** The only frame kind the child emits: bound (listener up, app composed) — NOT yet
 * `/readyz`-confirmed. The launcher still polls `/readyz` before publishing. */
export const BOUND_FRAME_KIND = 'bound';

/** Hard cap on a single stdout frame line (bytes, matching the Rust
 * `BOUND_FRAME_MAX_BYTES`). A line whose byte length REACHES this cap (`>=`) is rejected
 * rather than buffered — the SAME boundary the Rust emitter enforces (`>= 4096` fails),
 * so a line of exactly 4096 bytes is over the limit on both sides (#task:2343 P1-9). */
export const BOUND_FRAME_MAX_BYTES = 4096;

/** The validated bound frame: the effective loopback URL + resolved port the launcher
 * targets. `generation` is intentionally not surfaced — it was already checked against
 * the minted value during parse, so callers cannot re-derive trust from it. */
export interface ParsedBoundFrame {
  url: string;
  port: number;
}

export type BoundFrameParse =
  | { status: 'bound'; frame: ParsedBoundFrame }
  | { status: 'invalid'; reason: BoundFrameRejectReason };

/** Why a candidate stdout line was rejected. Every arm is a hard startup failure with an
 * actionable, surfaced reason — never a silent fallback. */
export type BoundFrameRejectReason =
  | 'oversize'
  | 'not-json'
  | 'not-object'
  | 'unknown-version'
  | 'wrong-kind'
  | 'generation-mismatch'
  | 'bad-url'
  | 'bad-port'
  | 'extra-keys';

const EXPECTED_KEYS = ['v', 'kind', 'generation', 'url', 'port'] as const;

/**
 * Parse ONE candidate stdout line against the frame contract, checking the `generation`
 * echo against the value this spawn minted. `raw` is a single line WITHOUT its trailing
 * newline (the reader splits on `\n`). Never throws.
 */
export function parseBoundFrame(
  raw: string,
  expectedGeneration: string,
): BoundFrameParse {
  // Length bound measured on the raw bytes BEFORE JSON.parse (cheap hostile-input guard,
  // mirrored with the Rust emitter's byte bound: `>= BOUND_FRAME_MAX_BYTES` is over).
  if (Buffer.byteLength(raw, 'utf8') >= BOUND_FRAME_MAX_BYTES) {
    return { status: 'invalid', reason: 'oversize' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'invalid', reason: 'not-json' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 'invalid', reason: 'not-object' };
  }
  const record = parsed as Record<string, unknown>;
  // Reject unknown/extra keys (strict shape) — a padded frame does not become `bound`.
  const keys = Object.keys(record);
  if (
    keys.length !== EXPECTED_KEYS.length ||
    !EXPECTED_KEYS.every((key) => Object.prototype.hasOwnProperty.call(record, key))
  ) {
    return { status: 'invalid', reason: 'extra-keys' };
  }
  if (record.v !== STARTUP_PROTOCOL_VERSION) {
    return { status: 'invalid', reason: 'unknown-version' };
  }
  if (record.kind !== BOUND_FRAME_KIND) {
    return { status: 'invalid', reason: 'wrong-kind' };
  }
  // Generation must be the exact value this spawn minted — a child that echoes a
  // different (or missing) token cannot be correlated to this spawn and is rejected.
  if (
    typeof record.generation !== 'string' ||
    record.generation !== expectedGeneration
  ) {
    return { status: 'invalid', reason: 'generation-mismatch' };
  }
  const port = record.port;
  if (
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    return { status: 'invalid', reason: 'bad-port' };
  }
  if (typeof record.url !== 'string' || !isLoopbackHttpUrl(record.url, port)) {
    return { status: 'invalid', reason: 'bad-url' };
  }
  return { status: 'bound', frame: { url: record.url, port } };
}

/**
 * A stateful single-frame reader over the child's stdout. The child emits EXACTLY ONE
 * frame; a SECOND non-blank line after a frame is a protocol violation (`duplicate`),
 * and blank lines are ignored. Feed decoded stdout chunks; the first complete line
 * resolves to `bound | invalid`, and any further non-blank line flips to `duplicate`.
 */
export class BoundFrameReader {
  private buffer = Buffer.alloc(0);
  private settled: BoundFrameParse | { status: 'duplicate' } | null = null;

  constructor(private readonly expectedGeneration: string) {}

  /**
   * Push a stdout chunk. Returns the settled outcome the first time a complete line is
   * seen, then `duplicate` if any further non-blank line arrives; `null` while still
   * waiting for the first line. The caller stops the child on any non-`bound` outcome.
   *
   * #task:2343 P1-9 — streaming byte bound: if the UNTERMINATED pending buffer reaches
   * `BOUND_FRAME_MAX_BYTES` WITHOUT a newline, the frame is rejected IMMEDIATELY (as
   * `oversize`) rather than accumulated unboundedly — a child that never emits `\n` cannot
   * grow launcher memory without limit. The bound is on the pending line only; already
   * consumed lines do not count.
   */
  push(chunk: string | Buffer): BoundFrameParse | { status: 'duplicate' } | null {
    if (this.settled?.status === 'duplicate') return this.settled;
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset);
      const end = newline < 0 ? bytes.length : newline;
      if (this.buffer.length + end - offset >= BOUND_FRAME_MAX_BYTES) {
        this.buffer = Buffer.alloc(0);
        this.settled = this.settled ? { status: 'duplicate' } : { status: 'invalid', reason: 'oversize' };
        return this.settled;
      }
      this.buffer = Buffer.concat([this.buffer, bytes.subarray(offset, end)]);
      if (newline < 0) break;
      const line = this.buffer.toString('utf8');
      this.buffer = Buffer.alloc(0);
      if (line.trim() !== '') this.settleLine(line);
      if (this.outcome()?.status === 'duplicate') return this.settled;
      offset = end + 1;
    }
    return this.settled;
  }

  private settleLine(line: string): void {
    if (this.settled === null) {
      this.settled = parseBoundFrame(line, this.expectedGeneration);
    } else {
      // A frame (valid or not) was already seen; a second non-blank line is a
      // protocol violation. stdout carries ONLY the one frame.
      this.settled = { status: 'duplicate' };
    }
  }

  /** The settled outcome, or `null` if no complete line has arrived yet. */
  outcome(): BoundFrameParse | { status: 'duplicate' } | null {
    return this.settled;
  }
}

/** The frame's `url` must be an `http://` loopback authority whose port equals the
 * reported `port` — so a child cannot report one port and a URL pointing elsewhere. */
function isLoopbackHttpUrl(value: string, port: number): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:') return false;
  if (url.pathname !== '' && url.pathname !== '/') return false;
  if (url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    return false;
  }
  if (Number(url.port) !== port) return false;
  const host = url.hostname;
  const isIpv4Loopback = host === '127.0.0.1';
  const isIpv6Loopback = host === '::1' || host === '[::1]';
  return isIpv4Loopback || isIpv6Loopback;
}
