import { describe, expect, it } from 'vitest';
import type { AgentRow } from '@silverhand/shared';

import { AgentServiceError, normalizeRuntimeTuning } from '../../src/services/agent-service.js';

/**
 * `normalizeRuntimeTuning` is the write-boundary guard for reasoning/runtime
 * compatibility on the PATCH path (Cindy #task:1328 P1; #task:1492). Reasoning
 * effort is a bounded opaque token with NO global legality — the sole allowlist
 * is per-runtime/model in the catalog. PATCH has no reasoning superRefine, so a
 * structurally-valid token this runtime/model does not support (e.g. qoder's
 * `none` or a product-unknown `giga` on codex) parses at the schema and, if it
 * reached the row, `CodexDriver.buildArgs` would forward it verbatim — so this
 * service check is the authoritative gate. Runtime transitions have their own
 * command; ordinary updates validate explicit tuning against the current runtime.
 */
function row(overrides: Partial<AgentRow>): AgentRow {
  return {
    id: 'a1',
    name: 'alice',
    display_name: 'Alice',
    runtime: 'qoder',
    model: null,
    reasoning_effort: null,
    fast_mode: null,
    host_id: 'h1',
    description: null,
    created_by_user_id: 'u1',
    avatar_storage_key: null,
    avatar_content_type: null,
    materialization_status: 'active',
    materialization_failed_code: null,
    materialization_failed_at: null,
    idempotency_key: null,
    runtime_transition_target: null,
    runtime_transition_started_at: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  } as AgentRow;
}

describe('normalizeRuntimeTuning — reasoning valid for the agent runtime', () => {
  it('rejects an explicit reasoning value the current runtime does not support', () => {
    expect(() =>
      normalizeRuntimeTuning(row({ runtime: 'codex' }), { reasoning_effort: 'max' }),
    ).toThrow(AgentServiceError);
    // `none` is qoder-only too — codex must reject it.
    expect(() =>
      normalizeRuntimeTuning(row({ runtime: 'codex' }), { reasoning_effort: 'none' }),
    ).toThrow(/not valid for runtime 'codex'/);
    // A structurally-valid but product-unknown token (in no runtime catalog)
    // survives the DTO parse but the service gate still rejects it.
    expect(() =>
      normalizeRuntimeTuning(row({ runtime: 'codex' }), { reasoning_effort: 'giga' }),
    ).toThrow(/not valid for runtime 'codex'/);
  });

  it('accepts an explicit reasoning value the runtime supports', () => {
    expect(normalizeRuntimeTuning(row({ runtime: 'codex' }), { reasoning_effort: 'high' })).toEqual(
      { reasoning_effort: 'high' },
    );
    // qoder takes its full allowed set.
    for (const v of ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(normalizeRuntimeTuning(row({ runtime: 'qoder' }), { reasoning_effort: v })).toEqual({
        reasoning_effort: v,
      });
    }
  });

  it('validates the effective Codex model + effort pair', () => {
    const sol = row({
      runtime: 'codex',
      model: 'gpt-5.6-sol',
      reasoning_effort: 'high',
    });
    expect(normalizeRuntimeTuning(sol, { reasoning_effort: 'ultra' })).toEqual({
      reasoning_effort: 'ultra',
    });
    expect(() =>
      normalizeRuntimeTuning(sol, {
        model: 'gpt-5.6-luna',
        reasoning_effort: 'ultra',
      }),
    ).toThrow(/model 'gpt-5.6-luna'/);

    const ultra = row({
      runtime: 'codex',
      model: 'gpt-5.6-sol',
      reasoning_effort: 'ultra',
    });
    expect(() => normalizeRuntimeTuning(ultra, { model: 'gpt-5.5' })).toThrow(
      /reasoning_effort 'ultra'/,
    );
  });

  it('accepts GPT-6 Ultra updates and rejects switching that effort to an unsupported model', () => {
    const current = row({ runtime: 'codex', model: 'gpt-6-astra', reasoning_effort: 'high' });
    expect(normalizeRuntimeTuning(current, { reasoning_effort: 'ultra' })).toEqual({
      reasoning_effort: 'ultra',
    });
    const ultra = row({ runtime: 'codex', model: 'gpt-6-astra', reasoning_effort: 'ultra' });
    expect(() => normalizeRuntimeTuning(ultra, { model: 'gpt-5.6-terra' })).toThrow(
      /reasoning_effort 'ultra'/,
    );
  });

  it('accepts Codex Max on a verified 5.6 model, rejects it off one (#task:1492)', () => {
    for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      const r = row({ runtime: 'codex', model, reasoning_effort: 'high' });
      expect(normalizeRuntimeTuning(r, { reasoning_effort: 'max' })).toEqual({
        reasoning_effort: 'max',
      });
    }
    // Switching the effective model off the 5.6 family invalidates a stored Max.
    const sol = row({
      runtime: 'codex',
      model: 'gpt-5.6-sol',
      reasoning_effort: 'max',
    });
    expect(() => normalizeRuntimeTuning(sol, { model: 'gpt-5.5' })).toThrow(
      /reasoning_effort 'max'/,
    );
    // Max with no model at all stays rejected (conservative baseline).
    expect(() =>
      normalizeRuntimeTuning(row({ runtime: 'codex' }), { reasoning_effort: 'max' }),
    ).toThrow(/not valid for runtime 'codex'/);
  });

  it('allows explicit null (clearing) on any runtime', () => {
    expect(normalizeRuntimeTuning(row({ runtime: 'codex' }), { reasoning_effort: null })).toEqual({
      reasoning_effort: null,
    });
  });

  it('leaves non-reasoning updates untouched', () => {
    expect(normalizeRuntimeTuning(row({ runtime: 'codex' }), { display_name: 'New' })).toEqual({
      display_name: 'New',
    });
  });

  it('allows non-null fast mode only on runtimes that support it', () => {
    expect(normalizeRuntimeTuning(row({ runtime: 'codex' }), { fast_mode: true })).toEqual({
      fast_mode: true,
    });
    expect(() => normalizeRuntimeTuning(row({ runtime: 'claude' }), { fast_mode: false })).toThrow(
      /fast_mode is not valid for runtime 'claude'/,
    );
    expect(normalizeRuntimeTuning(row({ runtime: 'claude' }), { fast_mode: null })).toEqual({
      fast_mode: null,
    });
  });
});
