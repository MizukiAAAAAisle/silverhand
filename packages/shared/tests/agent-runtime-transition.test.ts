import { describe, expect, it } from 'vitest';
import {
  CreateAgentInputSchema,
  SwitchAgentRuntimeInputSchema,
} from '../src/index.js';

describe('SwitchAgentRuntimeInputSchema', () => {
  it('requires every tuning key while accepting explicit null defaults', () => {
    expect(
      SwitchAgentRuntimeInputSchema.parse({
        runtime: 'claude',
        model: null,
        reasoning_effort: null,
        fast_mode: null,
      }),
    ).toEqual({
      runtime: 'claude',
      model: null,
      reasoning_effort: null,
      fast_mode: null,
    });
    expect(
      SwitchAgentRuntimeInputSchema.safeParse({
        runtime: 'claude',
        model: null,
        reasoning_effort: null,
      }).success,
    ).toBe(false);
  });

  it('validates tuning against the target runtime', () => {
    expect(
      SwitchAgentRuntimeInputSchema.safeParse({
        runtime: 'codex',
        model: 'gpt-5-codex',
        reasoning_effort: 'high',
        fast_mode: true,
      }).success,
    ).toBe(true);
    expect(
      SwitchAgentRuntimeInputSchema.safeParse({
        runtime: 'claude',
        model: null,
        reasoning_effort: 'high',
        fast_mode: null,
      }).success,
    ).toBe(false);
    expect(
      SwitchAgentRuntimeInputSchema.safeParse({
        runtime: 'opencode',
        model: null,
        reasoning_effort: null,
        fast_mode: false,
      }).success,
    ).toBe(false);
  });

  it('validates model-specific Codex Ultra capability', () => {
    const input = {
      runtime: 'codex' as const,
      reasoning_effort: 'ultra' as const,
      fast_mode: null,
    };
    expect(
      SwitchAgentRuntimeInputSchema.safeParse({
        ...input,
        model: 'gpt-5.6-sol',
      }).success,
    ).toBe(true);
    expect(
      SwitchAgentRuntimeInputSchema.safeParse({
        ...input,
        model: 'gpt-5.6-luna',
      }).success,
    ).toBe(false);
    expect(
      SwitchAgentRuntimeInputSchema.safeParse({ ...input, model: null }).success,
    ).toBe(false);
  });

  it('distinguishes explicit driver default from an empty custom model', () => {
    expect(
      SwitchAgentRuntimeInputSchema.safeParse({
        runtime: 'codex',
        model: '',
        reasoning_effort: null,
        fast_mode: null,
      }).success,
    ).toBe(false);
  });
});

describe('CreateAgentInputSchema runtime tuning', () => {
  it('rejects fast mode outside runtimes that support it', () => {
    expect(
      CreateAgentInputSchema.safeParse({
        name: 'claude-fast',
        runtime: 'claude',
        fast_mode: true,
      }).success,
    ).toBe(false);
    expect(
      CreateAgentInputSchema.safeParse({
        name: 'codex-fast',
        runtime: 'codex',
        fast_mode: true,
      }).success,
    ).toBe(true);
  });
});
