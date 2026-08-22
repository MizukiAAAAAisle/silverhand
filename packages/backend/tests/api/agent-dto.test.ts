import { describe, expect, it } from 'vitest';

import {
  AgentDtoSchema,
  AgentOnHostDtoSchema,
  CreateAgentInputSchema,
  UpdateAgentInputSchema,
} from '@silverhand/shared';

describe('agent reasoning_effort validation', () => {
  it('accepts any structurally-valid reasoning token on update (legality is per-runtime, enforced downstream)', () => {
    // `reasoning_effort` is a bounded opaque token, NOT a closed enum: the
    // shared type only bounds structure. PATCH has no reasoning superRefine, so
    // it accepts every well-formed token here — including a product-unknown
    // `giga` — and the per-runtime/model legality gate is `normalizeRuntimeTuning`
    // at the service boundary. The historical values plus an unknown one all
    // round-trip structurally.
    for (const effort of [
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
      'giga',
    ]) {
      expect(
        UpdateAgentInputSchema.safeParse({ reasoning_effort: effort }).success,
      ).toBe(true);
    }
  });

  it('round-trips a structurally-valid but product-unknown token through the read DTO', () => {
    // The AgentDto is the READ projection with no superRefine: a token a FUTURE
    // backend persisted must parse on an older-but-widened reader rather than
    // crash the whole DTO. `giga` is not in any runtime's catalog, yet it must
    // survive the structural parse.
    const parsed = AgentDtoSchema.safeParse({
      id: 'a1',
      name: 'alice',
      display_name: 'Alice',
      runtime: 'codex',
      session_scope: 'conversation',
      model: 'gpt-5.6-sol',
      reasoning_effort: 'giga',
      fast_mode: null,
      host_id: 'h1',
      host_label: 'MacBook Pro',
      description: null,
      created_by_user_id: 'u1',
      avatar_url: null,
      materialization_status: 'active',
      materialization_failed_code: null,
      materialization_failed_at: null,
      deletion_started_at: null,
      created_at: 1,
      updated_at: 1,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.reasoning_effort).toBe('giga');
  });

  it('rejects structurally-invalid reasoning tokens before persistence', () => {
    // "Open" is not "arbitrary string": uppercase, spaces, a leading digit/dash,
    // and an over-length (>32) token all fail the bounded token shape, at every
    // write boundary, before any per-runtime check.
    for (const effort of ['HIGH', 'a b', '9x', '-x', 'x'.repeat(33)]) {
      expect(
        CreateAgentInputSchema.safeParse({
          name: 'bad-effort',
          runtime: 'codex',
          reasoning_effort: effort,
        }).success,
      ).toBe(false);
      expect(
        UpdateAgentInputSchema.safeParse({ reasoning_effort: effort }).success,
      ).toBe(false);
    }
  });

  it('rejects a reasoning token not valid for the chosen runtime on create', () => {
    // Without a compatible model, `max` (needs a verified 5.6 model), `none`
    // (qoder-only), and `giga` (structurally valid but in NO runtime's catalog)
    // are all out of codex's baseline — create must reject them at the schema
    // (route + CLI get this for free). This is the write-boundary counterpart to
    // the read DTO round-trip above: unknown tokens survive a read, never a write.
    for (const effort of ['max', 'none', 'giga']) {
      const res = CreateAgentInputSchema.safeParse({
        name: 'codex-agent',
        runtime: 'codex',
        reasoning_effort: effort,
      });
      expect(res.success).toBe(false);
    }
  });

  it('accepts Codex Max on every verified 5.6 model, rejects without a compatible model (#task:1492)', () => {
    for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      expect(
        CreateAgentInputSchema.safeParse({
          name: 'max-ok',
          runtime: 'codex',
          model,
          reasoning_effort: 'max',
        }).success,
      ).toBe(true);
    }
    // Non-5.6 / unlisted / default models keep the conservative baseline.
    for (const model of ['gpt-5.5', 'my-proxy-model', undefined]) {
      expect(
        CreateAgentInputSchema.safeParse({
          name: 'max-bad',
          runtime: 'codex',
          model,
          reasoning_effort: 'max',
        }).success,
      ).toBe(false);
    }
  });

  it('accepts qoder create with any of its six allowed reasoning values', () => {
    for (const effort of ['none', 'low', 'medium', 'high', 'xhigh', 'max']) {
      expect(
        CreateAgentInputSchema.safeParse({
          name: 'qoder-agent',
          runtime: 'qoder',
          reasoning_effort: effort,
        }).success,
      ).toBe(true);
    }
  });

  it('accepts codex create with its four baseline reasoning values', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh']) {
      expect(
        CreateAgentInputSchema.safeParse({
          name: 'codex-agent',
          runtime: 'codex',
          reasoning_effort: effort,
        }).success,
      ).toBe(true);
    }
  });

  it('accepts Codex Ultra only with a compatible model', () => {
    expect(
      CreateAgentInputSchema.safeParse({
        name: 'ultra-sol',
        runtime: 'codex',
        model: 'gpt-5.6-sol',
        reasoning_effort: 'ultra',
      }).success,
    ).toBe(true);
    for (const model of ['gpt-5.6-luna', 'gpt-5.5', undefined]) {
      expect(
        CreateAgentInputSchema.safeParse({
          name: 'bad-ultra',
          runtime: 'codex',
          model,
          reasoning_effort: 'ultra',
        }).success,
      ).toBe(false);
    }
  });
});

describe('agent fast_mode validation', () => {
  it('accepts boolean fast_mode on create / update', () => {
    expect(
      CreateAgentInputSchema.safeParse({
        name: 'with-fast',
        runtime: 'codex',
        fast_mode: true,
      }).success,
    ).toBe(true);
    expect(
      UpdateAgentInputSchema.safeParse({ fast_mode: false }).success,
    ).toBe(true);
    expect(
      UpdateAgentInputSchema.safeParse({ fast_mode: null }).success,
    ).toBe(true);
  });

  it('rejects non-boolean fast_mode values', () => {
    expect(
      UpdateAgentInputSchema.safeParse({ fast_mode: 'on' }).success,
    ).toBe(false);
    expect(
      UpdateAgentInputSchema.safeParse({ fast_mode: 1 }).success,
    ).toBe(false);
  });
});

describe('agent update validation', () => {
  it('rejects runtime changes through generic PATCH', () => {
    expect(
      UpdateAgentInputSchema.safeParse({ runtime: 'codex' }).success,
    ).toBe(false);
    expect(
      UpdateAgentInputSchema.safeParse({
        runtime: 'codex',
        display_name: 'Alice',
      }).success,
    ).toBe(false);
  });
});

describe('agent materialization fields (D4.d v33)', () => {
  const baseAgent = {
    id: 'a1',
    name: 'alice',
    display_name: 'Alice',
    runtime: 'claude' as const,
    session_scope: 'conversation' as const,
    model: null,
    reasoning_effort: null,
    fast_mode: null,
    host_id: 'h1',
    host_label: null,
    description: null,
    created_by_user_id: 'u1',
    avatar_url: null,
    deletion_started_at: null,
    created_at: 1,
    updated_at: 1,
  };

  it('requires materialization_status and the two failed-row diagnostic fields', () => {
    // Active (default-list) row: status='active', no failure.
    expect(
      AgentDtoSchema.safeParse({
        ...baseAgent,
        materialization_status: 'active',
        materialization_failed_code: null,
        materialization_failed_at: null,
      }).success,
    ).toBe(true);
    // Failed row: management view (§7.3 Q6.a) needs the diagnostics.
    expect(
      AgentDtoSchema.safeParse({
        ...baseAgent,
        materialization_status: 'failed',
        materialization_failed_code: 'agent_dir_collision',
        materialization_failed_at: 1700000000000,
      }).success,
    ).toBe(true);
    // pending_materialization is a legal in-flight status (visible
    // to creator briefly between row reserve and L3a/L3b).
    expect(
      AgentDtoSchema.safeParse({
        ...baseAgent,
        materialization_status: 'pending_materialization',
        materialization_failed_code: null,
        materialization_failed_at: null,
      }).success,
    ).toBe(true);
  });

  it('rejects unknown materialization_status values', () => {
    expect(
      AgentDtoSchema.safeParse({
        ...baseAgent,
        materialization_status: 'archived',
        materialization_failed_code: null,
        materialization_failed_at: null,
      }).success,
    ).toBe(false);
  });

  it('exposes the durable deletion timestamp to management readers', () => {
    const parsed = AgentDtoSchema.parse({
      ...baseAgent,
      materialization_status: 'active',
      materialization_failed_code: null,
      materialization_failed_at: null,
      deletion_started_at: 1_700_000_000_000,
    });
    expect(parsed.deletion_started_at).toBe(1_700_000_000_000);
  });

  it('does NOT expose idempotency_key on the default DTO (Cindy round-2 P2)', () => {
    // The DTO schema is strict-by-default (no z.passthrough); adding
    // an unknown key should be silently dropped by parse, not surface
    // it. The negative pin here is structural: type-level absence
    // is enforced by `AgentDto` not having the field.
    const parsed = AgentDtoSchema.parse({
      ...baseAgent,
      materialization_status: 'active',
      materialization_failed_code: null,
      materialization_failed_at: null,
    });
    expect('idempotency_key' in parsed).toBe(false);
  });
});

describe('AgentOnHostDto avatar_url skew tolerance (#task:809)', () => {
  // shiki dogfood `xAro_4AQQApUJG7H` / Cindy `r96u1vc8awdjfnVT`:
  // `avatar_url` is additive display enrichment, not a required wire
  // field. The shared schema must default missing → null so a dev
  // hot-reload window (renderer ahead of backend) or any future
  // producer/consumer skew can't break the whole `HostStatusResponse`
  // parse and crash the detail pane. New backend always emits the
  // field as canonical producer; this regression locks the receive-
  // side safety net.
  const baseAgentRow = {
    agent_id: 'a-1',
    display_name: 'Helper',
    handle: '@helper',
    runtime: 'claude',
    online: 'online' as const,
  };

  it('parses a row that omits avatar_url and normalizes it to null', () => {
    const parsed = AgentOnHostDtoSchema.parse({ ...baseAgentRow });
    expect(parsed.avatar_url).toBeNull();
  });

  it('parses a row with explicit null avatar_url', () => {
    const parsed = AgentOnHostDtoSchema.parse({
      ...baseAgentRow,
      avatar_url: null,
    });
    expect(parsed.avatar_url).toBeNull();
  });

  it('parses a row with a real avatar_url string', () => {
    const parsed = AgentOnHostDtoSchema.parse({
      ...baseAgentRow,
      avatar_url: '/api/agents/a-1/avatar?v=1',
    });
    expect(parsed.avatar_url).toBe('/api/agents/a-1/avatar?v=1');
  });

  it('rejects a non-string avatar_url that is not null/undefined', () => {
    expect(
      AgentOnHostDtoSchema.safeParse({
        ...baseAgentRow,
        avatar_url: 42,
      }).success,
    ).toBe(false);
  });
});
