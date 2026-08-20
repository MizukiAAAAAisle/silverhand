import { describe, expect, it } from 'vitest';
import {
  ActivityItemDtoSchema,
  AgentRuntimeParticipationSchema,
} from '../src/api/index.js';
import { ConversationPlacementKindSchema } from '../src/db/schema.js';

/**
 * The Activity face carries NO conversation-classification bit (#task:2076).
 *
 * WHY THIS NEEDS A CELL. The mis-keying it forbids is not a wrong branch, it is a
 * FIELD: while `ActivityItemDto` carried `conversation_roster_policy` — with a
 * docblock instructing the renderer to derive a "Channel / DM" label from it — the
 * only way to draw the row-1 glyph was to classify the conversation by its roster,
 * so an agent home's DM channel and its Onboarding channel (workspace-placed,
 * fixed roster) were drawn as private lines. Removing the field is what makes the
 * wrong glyph unrepresentable; this cell is what stops it from coming back, in
 * either spelling.
 *
 * WHY NEITHER FIELD IS THE FIX. Both Activity sources restrict themselves to
 * WORKSPACE placements (`read-model/activity.ts`: one `WORKSPACE_PLACED` conjunct
 * each, and each is individually falsifier-gated by
 * `backend/tests/routes/activity-placement-domain.test.ts`), so every producible
 * item is a workspace conversation = a channel (#task:1373). The identity question
 * has no branch on this face at all — a `conversation_placement_kind` here would
 * be the constant `'workspace'`, i.e. a type-level branch nothing can reach.
 * Roster survives as a CAPABILITY input, but only server-side: the §5.1 salience
 * grade (fixed-roster ambient unread is directed-grade) is decided in the read
 * model off the SQL row and reaches the client as `salience`, already answered.
 *
 * The keying rule itself is written once, on
 * {@link ConversationPlacementKindSchema}; this file is its enforcement for one
 * face. The route-level counterpart (`backend/tests/routes/activity.test.ts`)
 * asserts the absence on a PARSED HTTP BODY and fails differently: nothing
 * re-validates the response against this schema on the way out, so that cell
 * catches EMITTING the field while this one catches DECLARING it.
 */
describe('ActivityItemDto carries no conversation-classification bit (#task:2076)', () => {
  // Written out rather than derived, for the same reason as the workspace key
  // ledger: adding a field to this DTO becomes a decision recorded HERE. An
  // exhaustive equality is also the only form that catches BOTH forbidden
  // spellings plus any third one someone invents — a pair of `not.toContain`
  // assertions on two known names would go green on `conversation_kind`.
  const ACTIVITY_ITEM_KEYS = [
    'id',
    'kind',
    'salience',
    'workspace_id',
    'conversation_id',
    'thread_root_id',
    'message_id',
    'notification_id',
    'title',
    'thread_root_preview',
    'preview',
    'preview_sender',
    'timestamp',
    'unread_count',
  ];

  it('publishes exactly this key set', () => {
    expect(Object.keys(ActivityItemDtoSchema.shape).sort()).toEqual(
      [...ACTIVITY_ITEM_KEYS].sort(),
    );
  });

  // The DIFFERENTIAL control. Without it this file would also pass if the
  // placement word were deleted from the wire everywhere — i.e. if the fix had
  // been "stop publishing placement" rather than "publish it where the face
  // genuinely admits more than one placement". The agent-participation face reads
  // roster ∪ inbox arc ∪ direct_pair arc, so there the word is a live
  // discriminator, and the ASYMMETRY between the two faces is the rule.
  it('keeps the placement word on the face that genuinely admits every placement', () => {
    expect(AgentRuntimeParticipationSchema.shape.conversation_placement_kind).toBe(
      ConversationPlacementKindSchema,
    );
  });
});
