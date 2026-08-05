import { describe, expect, it } from 'vitest';
import {
  HandleSchema,
  ParticipantNameSchema,
  WorkspaceNameSchema,
  extractMentions,
} from '../src/index.js';

describe('participant name grammar (#task:1826)', () => {
  it('requires stored participant names to start with a letter', () => {
    expect(ParticipantNameSchema.safeParse('agent-2b').success).toBe(true);
    expect(ParticipantNameSchema.safeParse('2b').success).toBe(false);
  });

  it('keeps the workspace grammar independent', () => {
    // The participant cut must not leak into workspace labels: a
    // numeric-first workspace name stays legal (see workspace-name.test.ts
    // for that grammar in full).
    expect(WorkspaceNameSchema.safeParse('2b').success).toBe(true);
  });

  it('wraps the same participant grammar for command handles', () => {
    expect(HandleSchema.safeParse('@agent-2b').success).toBe(true);
    expect(HandleSchema.safeParse('@2b').success).toBe(false);
  });

  it('makes every accepted participant example mentionable in message text', () => {
    for (const name of ['alice', 'Agent_2', 'x-y']) {
      expect(ParticipantNameSchema.safeParse(name).success).toBe(true);
      expect(extractMentions(`hello @${name}`)).toEqual([name]);
    }
  });
});
