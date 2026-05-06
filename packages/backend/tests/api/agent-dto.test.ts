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
