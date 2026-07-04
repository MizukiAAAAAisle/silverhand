import { describe, expect, it } from 'vitest';

import { normalizeCreateAgentInput } from '../../src/application/create-agent.js';

describe('normalizeCreateAgentInput', () => {
  it('applies qoder Ultimate when model is omitted or blank', () => {
    expect(
      normalizeCreateAgentInput({ name: 'qoder-a', runtime: 'qoder' }).model,
    ).toBe('Ultimate');
    expect(
      normalizeCreateAgentInput({
        name: 'qoder-b',
        runtime: 'qoder',
        model: '',
      }).model,
    ).toBe('Ultimate');
  });

  it('preserves explicit qoder model ids', () => {
    expect(
      normalizeCreateAgentInput({
        name: 'qoder-custom',
        runtime: 'qoder',
        model: 'Qwen3.7-Max',
      }).model,
    ).toBe('Qwen3.7-Max');
  });

  it('does not invent defaults for runtimes without catalog defaultModel', () => {
    expect(
      normalizeCreateAgentInput({ name: 'claude-a', runtime: 'claude' }).model,
    ).toBeUndefined();
    expect(
      normalizeCreateAgentInput({ name: 'codex-a', runtime: 'codex' }).model,
    ).toBeUndefined();
  });
});
