import { describe, expect, it } from 'vitest';
import {
  ENTITY_NAME_MAX_LENGTH,
  HandleSchema,
  ParticipantNameSchema,
  WorkspaceNameSchema,
  extractMentions,
  suggestParticipantNameFromEmail,
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

describe('email → handle suggestion (#task:1830)', () => {
  it('suggests the readable form of an email local-part', () => {
    expect(suggestParticipantNameFromEmail('alice.smith@example.com')).toBe(
      'alice-smith',
    );
    expect(suggestParticipantNameFromEmail('  Alice@Example.COM ')).toBe('alice');
    expect(suggestParticipantNameFromEmail('2.New.User@example.com')).toBe(
      'new-user',
    );
  });

  it('never suggests a value the stored grammar would reject', () => {
    // The suggestion is only a prefill, but it feeds a field whose value is
    // permanent, so "the user has to fix the prefill before submitting" is a
    // defect. Includes every shape that used to need special-casing in the old
    // server-side deriver: digit-first, punctuation-only, non-ASCII, empty
    // local-part, and an over-long one.
    const emails = [
      'alice@example.com',
      '2b@example.com',
      '2@example.com',
      '...@example.com',
      '___@example.com',
      '-@example.com',
      '张三@example.com',
      '@example.com',
      '',
      'no-at-sign',
      `${'a'.repeat(200)}@example.com`,
      `${'a'.repeat(200)}-@example.com`,
    ];
    for (const email of emails) {
      const suggested = suggestParticipantNameFromEmail(email);
      expect(
        ParticipantNameSchema.safeParse(suggested).success,
        `suggestion ${JSON.stringify(suggested)} for ${JSON.stringify(email)}`,
      ).toBe(true);
      expect(suggested.length).toBeLessThanOrEqual(ENTITY_NAME_MAX_LENGTH);
      // A prefill that is not addressable would be worse than none.
      expect(extractMentions(`hi @${suggested}`)).toEqual([suggested]);
    }
  });

  it('falls back to a usable handle when nothing survives normalization', () => {
    expect(suggestParticipantNameFromEmail('...@example.com')).toBe('user');
    expect(suggestParticipantNameFromEmail('@example.com')).toBe('user');
  });
});
