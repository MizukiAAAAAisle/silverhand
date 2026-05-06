import { describe, expect, it } from 'vitest';

import {
  CreateAgentInputSchema,
  UpdateAgentInputSchema,
} from '@silverhand/shared';

describe('agent reasoning_effort validation', () => {
  it('accepts the Codex reasoning effort values supported by the bundled catalog', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh']) {
      expect(
        UpdateAgentInputSchema.safeParse({ reasoning_effort: effort }).success,
      ).toBe(true);
    }
  });

  it('rejects unsupported reasoning effort values before persistence', () => {
    expect(
      CreateAgentInputSchema.safeParse({
        name: 'bad-effort',
        runtime: 'codex',
        reasoning_effort: 'minimal',
      }).success,
    ).toBe(false);
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
