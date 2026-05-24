import { describe, expect, it } from 'vitest';
import {
  AnyFrameSchema,
  encodeFrame,
  intentSchemas,
  MAX_FRAME_BYTES,
  type IntentName,
} from '../src/protocol.js';
import {
  schemaForFixture,
  wireFixtures,
  type WireFixture,
} from './fixtures/wire/wire-fixtures.js';

/**
 * Wire-contract acceptance suite. The fixtures committed under
 * `tests/fixtures/wire/` are the byte-level source of truth for the
 * daemon ↔ HostClient NDJSON socket. This test asserts every
 * registered fixture:
 *
 *  1. Parses as valid JSON.
 *  2. Validates against the frame schema implied by `kind`.
 *  3. Validates against the inner `params` / `result` schema, when
 *     applicable.
 *  4. Round-trips through `encodeFrame`: the re-emitted line, when
 *     parsed, deep-equals the original parsed value. JSON.stringify is
 *     not byte-stable across object key orderings, so we deliberately
 *     compare structures rather than bytes here. Cross-language
 *     consumers should layer canonical-key encoding on top.
 *  5. Stays under `MAX_FRAME_BYTES` (the daemon will refuse anything
 *     larger).
 *
 * It also enforces catalogue invariants: fixture names are unique,
 * every intent has both a request and a response_success fixture, and
 * every event discriminator arm has at least one fixture.
 */

const ALL_INTENTS: readonly IntentName[] = Object.keys(intentSchemas) as IntentName[];

// EventFrameSchema is a discriminatedUnion('event', [...]); pull the
// canonical event names out of the schema itself so the coverage check
// stays in lockstep with whatever protocol.ts ratifies, not a snapshot.
const ALL_EVENT_NAMES: readonly string[] = (() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const evt = AnyFrameSchema as any;
  // AnyFrameSchema is a union of [Request, Response, Event]; navigate to
  // the EventFrameSchema discriminator option list.
  const eventUnion = evt._def.options[2];
  const opts = eventUnion._def.options as ReadonlyArray<{
    shape: { event: { value: string } };
  }>;
  return opts.map((o) => o.shape.event.value);
})();

function describeFixture(f: WireFixture): string {
  return `${f.name} — ${f.description}`;
}

describe('wire contract — every fixture is JSON + schema valid', () => {
  for (const fixture of wireFixtures) {
    it(describeFixture(fixture), () => {
      // (1) JSON.
      const parsed = JSON.parse(fixture.frame);

      // (2) Frame-level schema.
      const { frame: frameSchema, inner } = schemaForFixture(fixture.kind);
      const frameResult = frameSchema.safeParse(parsed);
      expect(
        frameResult.success,
        frameResult.success
          ? ''
          : `frame schema rejected ${fixture.name}: ${JSON.stringify(
              frameResult.error.issues,
              null,
              2,
            )}`,
      ).toBe(true);

      // (3) Inner params / result.
      if (inner !== undefined) {
        if (fixture.kind.kind === 'request') {
          // RequestFrame.params
          const innerResult = inner.safeParse(
            (parsed as { params: unknown }).params,
          );
          expect(
            innerResult.success,
            innerResult.success
              ? ''
              : `params schema rejected ${fixture.name}: ${JSON.stringify(
                  innerResult.error.issues,
                  null,
                  2,
                )}`,
          ).toBe(true);
        } else if (fixture.kind.kind === 'response_success') {
          // ResponseFrame success arm carries `.result`. response_error
          // fixtures don't have an inner schema (kind.kind === 'response_error').
          const innerResult = inner.safeParse(
            (parsed as { result: unknown }).result,
          );
          expect(
            innerResult.success,
            innerResult.success
              ? ''
              : `result schema rejected ${fixture.name}: ${JSON.stringify(
                  innerResult.error.issues,
                  null,
                  2,
                )}`,
          ).toBe(true);
        }
      }

      // (4) Round-trip via encodeFrame. encodeFrame appends a single
      // trailing newline; strip it before parsing back.
      const reEmitted = encodeFrame(parsed);
      expect(reEmitted.endsWith('\n')).toBe(true);
      const reParsed = JSON.parse(reEmitted.slice(0, -1));
      expect(reParsed).toEqual(parsed);

      // (5) Size cap.
      expect(Buffer.byteLength(fixture.frame, 'utf8')).toBeLessThanOrEqual(
        MAX_FRAME_BYTES,
      );
    });
  }
});

describe('wire contract — fixture catalogue invariants', () => {
  it('fixture names are unique', () => {
    const seen = new Set<string>();
    const dup: string[] = [];
    for (const f of wireFixtures) {
      if (seen.has(f.name)) dup.push(f.name);
      seen.add(f.name);
    }
    expect(dup, `duplicate fixture names: ${dup.join(', ')}`).toEqual([]);
  });

  it('every intent has at least one request fixture', () => {
    const missing: IntentName[] = [];
    for (const intent of ALL_INTENTS) {
      const has = wireFixtures.some(
        (f) => f.kind.kind === 'request' && f.kind.intent === intent,
      );
      if (!has) missing.push(intent);
    }
    expect(
      missing,
      `intents missing a request fixture: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('every intent has at least one response_success fixture', () => {
    const missing: IntentName[] = [];
    for (const intent of ALL_INTENTS) {
      const has = wireFixtures.some(
        (f) =>
          f.kind.kind === 'response_success' && f.kind.intent === intent,
      );
      if (!has) missing.push(intent);
    }
    expect(
      missing,
      `intents missing a response_success fixture: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('every ResponseError code has at least one fixture', () => {
    const expectedCodes = [
      'unknown_intent',
      'invalid_params',
      'internal_error',
      'shutting_down',
      'request_too_large',
    ] as const;
    const missing: string[] = [];
    for (const code of expectedCodes) {
      const has = wireFixtures.some((f) => {
        if (f.kind.kind !== 'response_error') return false;
        const parsed = JSON.parse(f.frame) as {
          error?: { code?: string };
        };
        return parsed.error?.code === code;
      });
      if (!has) missing.push(code);
    }
    expect(
      missing,
      `error codes missing a fixture: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('every EventFrame discriminator arm has at least one fixture', () => {
    const missing: string[] = [];
    for (const name of ALL_EVENT_NAMES) {
      const has = wireFixtures.some((f) => {
        if (f.kind.kind !== 'event') return false;
        const parsed = JSON.parse(f.frame) as { event?: string };
        return parsed.event === name;
      });
      if (!has) missing.push(name);
    }
    expect(
      missing,
      `event arms missing a fixture: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('each ParsedEvent kind has a runtime_parsed_event fixture', () => {
    // The parsed-event fanout is a discriminated union nested inside an
    // EventFrame arm. A consumer that only sees the fixture catalogue
    // should still find one example per kind so it can table-drive its
    // own parser.
    const expectedKinds = [
      'session_init',
      'thinking',
      'text',
      'tool_call',
      'tool_output',
      'turn_end',
      'compaction_started',
      'compaction_finished',
      'error',
      'unknown',
    ] as const;
    const missing: string[] = [];
    for (const kind of expectedKinds) {
      const has = wireFixtures.some((f) => {
        if (f.kind.kind !== 'event') return false;
        const parsed = JSON.parse(f.frame) as {
          event?: string;
          parsed?: { kind?: string };
        };
        return (
          parsed.event === 'runtime_parsed_event' &&
          parsed.parsed?.kind === kind
        );
      });
      if (!has) missing.push(kind);
    }
    expect(
      missing,
      `ParsedEvent kinds missing a fixture: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('AnyFrameSchema accepts every fixture frame', () => {
    // Sanity: every fixture must also pass through the catch-all
    // AnyFrameSchema — that is what daemon and client actually use to
    // reject unknown shapes at the read site.
    const failures: string[] = [];
    for (const f of wireFixtures) {
      const parsed = JSON.parse(f.frame);
      if (!AnyFrameSchema.safeParse(parsed).success) failures.push(f.name);
    }
    expect(
      failures,
      `AnyFrameSchema rejected: ${failures.join(', ')}`,
    ).toEqual([]);
  });
});
