import { describe, expect, it } from 'vitest';
import type { AgentRow } from '@silverhand/shared';

import {
  AgentServiceError,
  normalizeRuntimeTuning,
} from '../../src/services/agent-service.js';

/**
 * `normalizeRuntimeTuning` is the write-boundary guard for reasoning/runtime
 * compatibility (Cindy #task:1328 P1): the shared ReasoningEffort enum is the
 * union across runtimes, so a value like qoder's `max` parses structurally but
 * is meaningless for codex and, if it reached the row, `CodexDriver.buildArgs`
 * would forward it verbatim. Runtime itself is create-time immutable; update
 * validation here only checks explicit reasoning against the current runtime.
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
  });

  it('accepts an explicit reasoning value the runtime supports', () => {
    expect(
      normalizeRuntimeTuning(row({ runtime: 'codex' }), { reasoning_effort: 'high' }),
    ).toEqual({ reasoning_effort: 'high' });
    // qoder takes the full canonical set.
    for (const v of ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(
        normalizeRuntimeTuning(row({ runtime: 'qoder' }), { reasoning_effort: v }),
      ).toEqual({ reasoning_effort: v });
    }
  });

  it('allows explicit null (clearing) on any runtime', () => {
    expect(
      normalizeRuntimeTuning(row({ runtime: 'codex' }), { reasoning_effort: null }),
    ).toEqual({ reasoning_effort: null });
  });

  it('leaves non-reasoning updates untouched', () => {
    expect(
      normalizeRuntimeTuning(row({ runtime: 'codex' }), { display_name: 'New' }),
    ).toEqual({ display_name: 'New' });
  });
});
