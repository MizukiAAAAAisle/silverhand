import { describe, expect, it } from 'vitest';
import {
  ENTITY_NAME_MAX_LENGTH,
  HandleSchema,
  ParticipantNameSchema,
  WorkspaceNameSchema,
  formatReferenceToken,
  suggestParticipantNameFromEmail,
} from '../src/index.js';
import { extractMessageReferences } from '../src/reference-markdown.js';

/** Every stored name must be ADDRESSABLE: spelled as a canonical reference in
 *  prose, it must resolve back to itself. A name the grammar admits but no
 *  message can address is a participant nobody can reach (#task:2000). */
function addressable(name: string): boolean {
  const refs = extractMessageReferences(
    `hello ${formatReferenceToken({ kind: 'agent', handle: name })}`,
  );
  return refs.length === 1 && refs[0]!.handle === name;
}

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

  it('makes every accepted participant example addressable in message text', () => {
    for (const name of ['alice', 'Agent_2', 'x-y']) {
      expect(ParticipantNameSchema.safeParse(name).success).toBe(true);
      expect(addressable(name), name).toBe(true);
    }
  });
});

describe('email → handle suggestion (#task:1830)', () => {
  it('suggests the readable form of an email local-part', () => {
    expect(suggestParticipantNameFromEmail('alice.smith@example.com')).toBe('alice-smith');
    expect(suggestParticipantNameFromEmail('  Alice@Example.COM ')).toBe('alice');
    expect(suggestParticipantNameFromEmail('2.New.User@example.com')).toBe('new-user');
  });

  it('never suggests a value the stored grammar would reject', () => {
    // The suggestion is only a prefill, but it feeds a field whose value is
    // permanent, so "the user has to fix the prefill before submitting" is a
    // defect. Includes every shape that used to need special-casing in the old
    // server-side deriver: digit-first, punctuation-only, non-ASCII, empty
    // local-part, and an over-long one. Empty is the one other admissible
    // outcome — the field is required, so an empty prefill asks the question
    // instead of answering it wrongly.
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
      const label = `suggestion ${JSON.stringify(suggested)} for ${JSON.stringify(email)}`;
      if (suggested === '') continue;
      expect(ParticipantNameSchema.safeParse(suggested).success, label).toBe(true);
      expect(suggested.length, label).toBeLessThanOrEqual(ENTITY_NAME_MAX_LENGTH);
      // A prefill that is not addressable would be worse than none.
      expect(addressable(suggested), label).toBe(true);
    }
  });

  it('suggests nothing when no part of the local-part survives', () => {
    // Not a `user` placeholder: on the one field that can never be changed, a
    // plausible-looking default gets accepted unread (@Norman, #task:1830).
    for (const email of ['...@example.com', '@example.com', '张三@example.com', '']) {
      expect(suggestParticipantNameFromEmail(email), email).toBe('');
    }
  });
});
