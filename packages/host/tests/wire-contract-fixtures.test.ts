import { describe, expect, it } from 'vitest';
import { ParsedEventKindSchema } from '@silverhand/shared';
import {
  AnyFrameSchema,
  encodeFrame,
  HostOutboundReloadFailureReasonSchema,
  HostOutboundReloadResultSchema,
  intentSchemas,
  LooseAnyFrameSchema,
  MAX_FRAME_BYTES,
  ResponseErrorCodeSchema,
  ResponseErrorSchema,
  RuntimeStartResultSchema,
  RuntimeStopParamsSchema,
  RuntimeStopResultSchema,
  RuntimeDeliverRefusedResultSchema,
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

/**
 * Per-intent typed error codes — the union arm of `intentSchemas[intent]
 * .error.code` that is NOT the generic `ResponseErrorCodeSchema`. Returns
 * [] for intents with no `error` schema or whose code schema is the bare
 * generic enum (no extra typed taxonomy). Single source: the schema, not
 * a hand-coded per-intent list (Cindy D4.e P1-2).
 */
function intentTypedErrorCodes(intent: IntentName): readonly string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entry = intentSchemas[intent] as any;
  const errorSchema = entry?.error;
  if (!errorSchema) return [];
  const codeSchema = errorSchema.shape?.code;
  if (!codeSchema) return [];
  // ZodUnion of [ResponseErrorCodeSchema, <TypedCodeSchema>].
  const arms = codeSchema._def?.options;
  if (!Array.isArray(arms)) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const typedArm = arms.find((a: any) => a !== ResponseErrorCodeSchema);
  return (typedArm?.options as string[] | undefined) ?? [];
}

// EventFrameSchema is a discriminatedUnion('event', [...]); pull the
// canonical event names out of the schema itself so the coverage check
// stays in lockstep with whatever protocol.ts ratifies, not a snapshot.
const ALL_EVENT_NAMES: readonly string[] = (() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const evt = AnyFrameSchema as any;
  // AnyFrameSchema is a union of [Request, Response, Event]; navigate to
  // the EventFrameSchema discriminator option list.
  const eventUnion = evt._def.options[2];
  const discriminatedEventUnion = eventUnion.innerType?.() ?? eventUnion;
  const opts = discriminatedEventUnion._def.options as ReadonlyArray<{
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

      // (3) Inner params / result / typed-error.
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
        } else if (fixture.kind.kind === 'response_error_typed') {
          // Per-intent typed error arm carries `.error`. The inner
          // schema is the intent's `error` entry (Cindy D2 P2-1).
          const innerResult = inner.safeParse(
            (parsed as { error: unknown }).error,
          );
          expect(
            innerResult.success,
            innerResult.success
              ? ''
              : `typed-error schema rejected ${fixture.name}: ${JSON.stringify(
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

  it('D2.g runtime_start fixtures do not carry derived fs artifacts or env maps', () => {
    const forbiddenKeys = [
      'cwd',
      'workspace_path',
      'system_prompt_path',
      'spawn_dir',
      'system_prompt',
      'memory_text',
      'consensus_text',
      'env',
    ];
    const runtimeStartFixtures = wireFixtures.filter(
      f => f.kind.kind === 'request' && f.kind.intent === 'runtime_start',
    );
    expect(runtimeStartFixtures.length).toBeGreaterThan(0);
    for (const fixture of runtimeStartFixtures) {
      const parsed = JSON.parse(fixture.frame) as { params: unknown };
      const paramsJson = JSON.stringify(parsed.params);
      for (const key of forbiddenKeys) {
        expect(
          paramsJson.includes(`"${key}"`),
          `${fixture.name} contains forbidden runtime_start key ${key}`,
        ).toBe(false);
      }
      expect(paramsJson.includes('/spawn-'), fixture.name).toBe(false);
    }
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
    // Derived from ResponseErrorSchema so adding a new code there
    // immediately fails this assertion until a fixture is added — no
    // hand-coded list to drift against the schema (Cindy review of
    // initial fixture-set lifted this from a static array).
    const expectedCodes = ResponseErrorSchema.shape.code.options;
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
    // Derived from ParsedEventKindSchema (single source of truth in
    // shared) so any new kind triggers this catalogue test without
    // editing the test (Cindy review of initial fixture-set: removed
    // the hand-coded array that would silently miss schema growth).
    const expectedKinds = ParsedEventKindSchema.options;
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

  it('AnyFrameSchema accepts every non-typed fixture frame', () => {
    // Sanity: every fixture (other than per-intent typed-error frames)
    // must also pass through the catch-all AnyFrameSchema — that is the
    // strict generic envelope. Typed-error fixtures intentionally use
    // codes outside the generic ResponseError enum, so we exempt them
    // here and verify them against LooseAnyFrameSchema below
    // (Cindy D2 P1-1 / P2-1: typed codes must survive at transport).
    const failures: string[] = [];
    for (const f of wireFixtures) {
      if (f.kind.kind === 'response_error_typed') continue;
      const parsed = JSON.parse(f.frame);
      if (!AnyFrameSchema.safeParse(parsed).success) failures.push(f.name);
    }
    expect(
      failures,
      `AnyFrameSchema rejected: ${failures.join(', ')}`,
    ).toEqual([]);
  });

  it('LooseAnyFrameSchema accepts every fixture frame (including typed-error)', () => {
    // The transport layer parses with LooseAnyFrameSchema so per-intent
    // typed error codes (e.g. agent_dir_collision) survive intact until
    // the intent-aware HostClient.handleFrame admission. This pin proves
    // every typed-error fixture passes the loose envelope.
    const failures: string[] = [];
    for (const f of wireFixtures) {
      const parsed = JSON.parse(f.frame);
      if (!LooseAnyFrameSchema.safeParse(parsed).success) failures.push(f.name);
    }
    expect(
      failures,
      `LooseAnyFrameSchema rejected: ${failures.join(', ')}`,
    ).toEqual([]);
  });

  it('every typed intent has a fixture for each of its typed error codes', () => {
    // Generalized from the prior agent_materialize-only pin (Cindy D4.e
    // P1-2): derive the per-intent typed taxonomy straight from
    // `intentSchemas[intent].error` — the union arm that is NOT the
    // generic `ResponseErrorCodeSchema`. Any intent that declares a typed
    // error schema (agent_materialize + the D4.e workspace intents, plus
    // any future one) is covered automatically; a new typed code or a new
    // typed intent fails this until a byte-level fixture lands. No
    // hard-coded intent list to drift.
    const missing: string[] = [];
    for (const intent of ALL_INTENTS) {
      for (const code of intentTypedErrorCodes(intent)) {
        const has = wireFixtures.some(f => {
          if (f.kind.kind !== 'response_error_typed') return false;
          if (f.kind.intent !== intent) return false;
          const parsed = JSON.parse(f.frame) as { error?: { code?: string } };
          return parsed.error?.code === code;
        });
        if (!has) missing.push(`${intent}:${code}`);
      }
    }
    expect(
      missing,
      `typed intents missing a typed-error fixture: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('every response_error_typed fixture targets an intent with a declared error schema', () => {
    // Cindy D2 round-2 P2: structural pin paired with the
    // `schemaForFixture` throw. The kind `response_error_typed`
    // means "this intent has a per-intent typed taxonomy"; using
    // it for an intent without an `error` entry in `intentSchemas`
    // would silently fall back to no inner validation. This test
    // catches misuse at test-discovery time so a wrong-intent
    // fixture cannot land even if a developer skips running
    // `schemaForFixture` in isolation.
    const offenders: string[] = [];
    for (const f of wireFixtures) {
      if (f.kind.kind !== 'response_error_typed') continue;
      const entry = intentSchemas[f.kind.intent] as {
        error?: unknown;
      };
      if (entry.error === undefined) {
        offenders.push(`${f.name} (intent='${f.kind.intent}')`);
      }
    }
    expect(
      offenders,
      `response_error_typed fixtures pointing at intents with no 'error' schema: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  // ── Discriminated-union arm coverage ────────────────────────────
  //
  // The above per-intent / per-event coverage assertions are not
  // enough on their own: nested discriminated unions and enum fields
  // would silently grow new arms without any fixture forcing them
  // onto the wire (Cindy review). The tests below derive their
  // expected arm sets directly from the zod schemas so adding a new
  // arm in protocol.ts immediately fails the matching catalogue test.

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unwrapEffects = (schema: any): any =>
    schema?._def?.schema ?? schema;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const literalValue = (schema: any): unknown => schema?._def?.value;

  it('runtime_start.result covers every `started` arm (success/cooldown)', () => {
    const arms = RuntimeStartResultSchema.options.map((o) =>
      String(literalValue(o.shape.started)),
    );
    const missing = arms.filter(
      (arm) =>
        !wireFixtures.some((f) => {
          if (
            f.kind.kind !== 'response_success' ||
            f.kind.intent !== 'runtime_start'
          )
            return false;
          const parsed = JSON.parse(f.frame) as {
            result?: { started?: boolean };
          };
          return String(parsed.result?.started) === arm;
        }),
    );
    expect(
      missing,
      `runtime_start result arms missing fixture: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('runtime_stop.params has a hard-mode fixture (mode narrowed to literal since #task:1558)', () => {
    const inner = unwrapEffects(RuntimeStopParamsSchema);
    const mode = String(literalValue(inner.shape.mode));
    expect(mode).toBe('hard');
    const covered = wireFixtures.some((f) => {
      if (f.kind.kind !== 'request' || f.kind.intent !== 'runtime_stop')
        return false;
      const parsed = JSON.parse(f.frame) as { params?: { mode?: string } };
      return parsed.params?.mode === mode;
    });
    expect(covered, 'runtime_stop hard param fixture missing').toBe(true);
  });

  it('runtime_stop.result has a hard-mode fixture (single arm since #task:1558)', () => {
    const inner = unwrapEffects(RuntimeStopResultSchema);
    const mode = String(literalValue(inner.shape.mode));
    expect(mode).toBe('hard');
    const covered = wireFixtures.some((f) => {
      if (
        f.kind.kind !== 'response_success' ||
        f.kind.intent !== 'runtime_stop'
      )
        return false;
      const parsed = JSON.parse(f.frame) as { result?: { mode?: string } };
      return parsed.result?.mode === mode;
    });
    expect(covered, 'runtime_stop hard result fixture missing').toBe(true);
  });

  it('runtime_deliver.result covers every `disposition` arm (spawning/admitted/refused)', () => {
    // #task:1417 Stage 2c — `runtime_deliver` is the sole delivery command
    // (absorbed the retired `runtime_wake` coverage). The outer result is a
    // z.union([spawning, admitted, refusedUnion]); a new top-level
    // disposition must land a fixture or this fails.
    const dispositions = ['spawning', 'admitted', 'refused'];
    const missing = dispositions.filter(
      (disposition) =>
        !wireFixtures.some((f) => {
          if (
            f.kind.kind !== 'response_success' ||
            f.kind.intent !== 'runtime_deliver'
          )
            return false;
          const parsed = JSON.parse(f.frame) as {
            result?: { disposition?: string };
          };
          return parsed.result?.disposition === disposition;
        }),
    );
    expect(
      missing,
      `runtime_deliver disposition arms missing fixture: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('runtime_deliver.result covers every refused `reason` enum slot', () => {
    // Derived from RuntimeDeliverRefusedResultSchema directly — single
    // source of truth. Adding a new refuse reason in protocol.ts fails this
    // test until a fixture lands (this is the most-likely silent-drift axis,
    // inherited from the retired `runtime_wake` reason-coverage guard).
    const reasons = RuntimeDeliverRefusedResultSchema.options.map((o) =>
      String(literalValue(o.shape.reason)),
    );
    const missing = reasons.filter(
      (reason) =>
        !wireFixtures.some((f) => {
          if (
            f.kind.kind !== 'response_success' ||
            f.kind.intent !== 'runtime_deliver'
          )
            return false;
          const parsed = JSON.parse(f.frame) as {
            result?: { disposition?: string; reason?: string };
          };
          return (
            parsed.result?.disposition === 'refused' &&
            parsed.result?.reason === reason
          );
        }),
    );
    expect(
      missing,
      `runtime_deliver refused reasons missing fixture: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  // ── host_outbound_reload arm coverage (D3.c Commit 2) ────────────
  //
  // Mirrors the runtime_deliver reason-derived test: arms / reasons are
  // pulled directly from the protocol schema so a new arm or failure
  // reason added in protocol.ts immediately fails this test until a
  // fixture lands. Cindy's Commit 2 review explicitly named
  // `reloaded / unchanged / not_attached` as the load-bearing trio;
  // these tests pin all four reasons too so the validate-first-then-
  // swap failure surface stays observable on the wire.

  it('host_outbound_reload.result covers every `reloaded` arm (true/false)', () => {
    const arms = HostOutboundReloadResultSchema.options.map((o) =>
      String(literalValue(o.shape.reloaded)),
    );
    const missing = arms.filter(
      (arm) =>
        !wireFixtures.some((f) => {
          if (
            f.kind.kind !== 'response_success' ||
            f.kind.intent !== 'host_outbound_reload'
          )
            return false;
          const parsed = JSON.parse(f.frame) as {
            result?: { reloaded?: boolean };
          };
          return String(parsed.result?.reloaded) === arm;
        }),
    );
    expect(
      missing,
      `host_outbound_reload reloaded arms missing fixture: ${missing.join(
        ', ',
      )}`,
    ).toEqual([]);
  });

  it('host_outbound_reload.result success arm covers every `action` slot (reloaded/unchanged)', () => {
    // The success arm's `action` is `z.enum(['reloaded', 'unchanged'])`.
    // New action value here => mandatory new fixture.
    const successArm = HostOutboundReloadResultSchema.options.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (o: any) => literalValue(o.shape.reloaded) === true,
    );
    const actions: readonly string[] = (successArm as { shape: { action: { options: readonly string[] } } }).shape.action.options;
    const missing = actions.filter(
      (action) =>
        !wireFixtures.some((f) => {
          if (
            f.kind.kind !== 'response_success' ||
            f.kind.intent !== 'host_outbound_reload'
          )
            return false;
          const parsed = JSON.parse(f.frame) as {
            result?: { reloaded?: boolean; action?: string };
          };
          return (
            parsed.result?.reloaded === true &&
            parsed.result?.action === action
          );
        }),
    );
    expect(
      missing,
      `host_outbound_reload success actions missing fixture: ${missing.join(
        ', ',
      )}`,
    ).toEqual([]);
  });

  it('host_outbound_reload.result failure arm covers every `reason` slot (incl. not_attached)', () => {
    // Derived from HostOutboundReloadFailureReasonSchema — Cindy's
    // Commit 2 review point 4 ("wire fixtures 覆盖 reloaded /
    // unchanged / not_attached"). Including the validation-failure
    // reasons (config_unreadable / parse_failed / invalid_server_url)
    // makes the validate-first-then-swap surface observable on the
    // wire too.
    const reasons = HostOutboundReloadFailureReasonSchema.options;
    const missing = reasons.filter(
      (reason) =>
        !wireFixtures.some((f) => {
          if (
            f.kind.kind !== 'response_success' ||
            f.kind.intent !== 'host_outbound_reload'
          )
            return false;
          const parsed = JSON.parse(f.frame) as {
            result?: { reloaded?: boolean; reason?: string };
          };
          return (
            parsed.result?.reloaded === false && parsed.result?.reason === reason
          );
        }),
    );
    expect(
      missing,
      `host_outbound_reload failure reasons missing fixture: ${missing.join(
        ', ',
      )}`,
    ).toEqual([]);
  });
});
