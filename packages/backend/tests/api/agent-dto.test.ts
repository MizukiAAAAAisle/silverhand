import { describe, expect, it } from 'vitest';

import {
  AgentDtoSchema,
  AgentOnHostDtoSchema,
  CreateAgentInputSchema,
  UpdateAgentInputSchema,
} from '@silverhand/shared';

describe('agent reasoning_effort validation', () => {
  it('accepts every canonical reasoning effort value in the shared enum', () => {
    // Union of codex (low/medium/high/xhigh) and qoder (none/…/max); the
    // per-runtime catalog gates which subset each picker offers.
    for (const effort of ['none', 'low', 'medium', 'high', 'xhigh', 'max']) {
      expect(
        UpdateAgentInputSchema.safeParse({ reasoning_effort: effort }).success,
      ).toBe(true);
    }
  });

  it('rejects unsupported reasoning effort values before persistence', () => {
    for (const effort of ['minimal', 'off', 'HIGH', 'ultra']) {
      expect(
        CreateAgentInputSchema.safeParse({
          name: 'bad-effort',
          runtime: 'codex',
          reasoning_effort: effort,
        }).success,
      ).toBe(false);
    }
  });

  it('rejects a reasoning value not valid for the chosen runtime on create', () => {
    // `max`/`none` are valid enum members but qoder-only — codex create
    // must reject them at the schema (route + CLI get this for free).
    for (const effort of ['max', 'none']) {
      const res = CreateAgentInputSchema.safeParse({
        name: 'codex-agent',
        runtime: 'codex',
        reasoning_effort: effort,
      });
      expect(res.success).toBe(false);
    }
  });

  it('accepts qoder create with any of its six canonical reasoning values', () => {
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

  it('accepts codex create with its four supported reasoning values', () => {
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

describe('agent materialization fields (D4.d v33)', () => {
  const baseAgent = {
    id: 'a1',
    name: 'alice',
    display_name: 'Alice',
    runtime: 'claude' as const,
    model: null,
    reasoning_effort: null,
    fast_mode: null,
    host_id: 'h1',
    description: null,
    created_by_user_id: 'u1',
    avatar_url: null,
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
