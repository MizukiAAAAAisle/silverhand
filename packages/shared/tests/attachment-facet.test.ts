import { describe, expect, it } from 'vitest';
import { AttachmentSenderFacetSchema } from '../src/api/index.js';

// The sender-facet DTO is a precise discriminated union: a facet must be
// directly usable as a list sender filter, so each variant carries only its own
// non-empty id and the other actor id must be null. This is the runtime guard
// behind the backend's SQL wire-expressibility filter — a cross-shaped or
// null-id actor must never round-trip as a selectable facet.

describe('AttachmentSenderFacetSchema', () => {
  it('accepts the three canonical shapes', () => {
    expect(
      AttachmentSenderFacetSchema.parse({
        from_kind: 'user',
        from_user_id: 'u1',
        from_agent_id: null,
      }),
    ).toEqual({ from_kind: 'user', from_user_id: 'u1', from_agent_id: null });
    expect(
      AttachmentSenderFacetSchema.parse({
        from_kind: 'agent',
        from_user_id: null,
        from_agent_id: 'a1',
      }),
    ).toEqual({ from_kind: 'agent', from_user_id: null, from_agent_id: 'a1' });
    expect(
      AttachmentSenderFacetSchema.parse({
        from_kind: 'system',
        from_user_id: null,
        from_agent_id: null,
      }),
    ).toEqual({ from_kind: 'system', from_user_id: null, from_agent_id: null });
  });

  it('rejects cross-shaped and null-id actors', () => {
    // user carrying an agent id
    expect(
      AttachmentSenderFacetSchema.safeParse({
        from_kind: 'user',
        from_user_id: 'u1',
        from_agent_id: 'a1',
      }).success,
    ).toBe(false);
    // agent carrying a user id
    expect(
      AttachmentSenderFacetSchema.safeParse({
        from_kind: 'agent',
        from_user_id: 'u1',
        from_agent_id: 'a1',
      }).success,
    ).toBe(false);
    // system carrying an id
    expect(
      AttachmentSenderFacetSchema.safeParse({
        from_kind: 'system',
        from_user_id: 'u1',
        from_agent_id: null,
      }).success,
    ).toBe(false);
    // user with a null id (dangling / hard-deleted actor)
    expect(
      AttachmentSenderFacetSchema.safeParse({
        from_kind: 'user',
        from_user_id: null,
        from_agent_id: null,
      }).success,
    ).toBe(false);
    // agent with an empty-string id
    expect(
      AttachmentSenderFacetSchema.safeParse({
        from_kind: 'agent',
        from_user_id: null,
        from_agent_id: '',
      }).success,
    ).toBe(false);
  });
});
