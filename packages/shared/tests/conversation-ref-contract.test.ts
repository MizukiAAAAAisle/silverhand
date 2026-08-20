// `ConversationRef` is the WORKSPACE ARM ONLY (#task:2038, ruling A) — and since
// this commit that is a wire contract, not a comment. Before it, the DTO used the
// full `ConversationPlacementKindSchema`, so `direct_pair` paired with a
// NON-NULL `workspace_id` was a legal value of the type: an
// impossible state, and one a renderer fixture was really consuming.
//
// These assertions are the falsifiers for that narrowing. Widening
// `placement_kind` back to the enum, or relaxing `workspace_id` to nullable to
// "support DMs", reddens exactly this file — which is the point: option B is a
// deliberate contract change (see `DirectPairListResponseSchema` for its one
// legitimate trigger), not something that can drift back in.
import { describe, expect, it } from 'vitest';
import {
  ConversationRefSchema,
  type ConversationRef,
} from '../src/api/conversation.js';
import { ConversationPlacementKindSchema } from '../src/db/schema.js';

const workspaceRef: ConversationRef = {
  id: 'c-1',
  placement_kind: 'workspace',
  roster_policy: 'open',
  title: 'planning',
  workspace_id: 'w-1',
  closed_at: null,
  archived_at: null,
};

describe('ConversationRef — workspace-arm narrowing', () => {
  it("accepts the workspace arm, including an agent home's fixed-roster channel", () => {
    expect(ConversationRefSchema.safeParse(workspaceRef).success).toBe(true);
    // An agent home's channel on this face is workspace-PLACED with a fixed
    // roster, and that is the ONLY thing distinguishing it here: since
    // #task:2075's stop-publish step the ref carries no container word, so which
    // KIND of container it sits in is not a fact this face states at all.
    expect(
      ConversationRefSchema.safeParse({
        ...workspaceRef,
        roster_policy: 'fixed',
      }).success,
    ).toBe(true);
  });

  it('rejects every workspace-less placement, even with a workspace_id present', () => {
    // Enumerated from the placement enum rather than hardcoded, so a NEW
    // workspace-less placement kind cannot be added without landing here.
    const workspaceLess = ConversationPlacementKindSchema.options.filter(
      kind => kind !== 'workspace',
    );
    expect(workspaceLess).toEqual(['direct_pair']);
    for (const placement_kind of workspaceLess) {
      expect(
        ConversationRefSchema.safeParse({ ...workspaceRef, placement_kind })
          .success,
      ).toBe(false);
    }
  });

  it('rejects a null workspace coordinate (the pseudo-coordinate #task:2035 removed)', () => {
    expect(
      ConversationRefSchema.safeParse({ ...workspaceRef, workspace_id: null })
        .success,
    ).toBe(false);
  });

  it('narrows the static type too, not just the parse', () => {
    // The literal flows through to consumers: no runtime check needed to know
    // a resolved ref has a workspace coordinate.
    const coordinate: 'workspace' = workspaceRef.placement_kind;
    expect(coordinate).toBe('workspace');
    const pair: ConversationRef = {
      ...workspaceRef,
      // @ts-expect-error a workspace-less placement is unnameable on this DTO.
      placement_kind: 'direct_pair',
    };
    void pair;
  });
});
