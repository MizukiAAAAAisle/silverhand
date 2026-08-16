/**
 * #task:2036 part ② — the owner-audit read DTOs for an agent's chats.
 *
 * These live apart from `agent.ts` on purpose. They are the OWNER's view of the
 * agent's conversations (the list and the full transcript), not the core
 * `AgentDto`, and they need `MessageDto` and the DM counterpart shape. Importing
 * `message.js` into `agent.ts` would close a module cycle — `agent → message →
 * task → workspace → agent` — and `workspace.ts` evaluates `z.array(AgentDtoSchema)`
 * at module load, so the cycle surfaces as a TDZ `ReferenceError` the moment the
 * barrel is loaded in dependency order (subprocess/e2e entry points). Keeping the
 * audit face in its own module leaves `agent.ts` a leaf and breaks the cycle.
 */
import { z } from 'zod';
import {
  ConversationRosterPolicySchema,
  WorkspaceKindSchema,
} from '../db/schema.js';
import { DirectPairCounterpartSchema } from './conversation.js';
import { MessageDtoSchema } from './message.js';

/**
 * One row of the owner-audit chats list — `GET /api/agents/:id/chats`
 * (#task:2036 part ②): the conversations the agent's OWNER may read in full,
 * read-only, because the owner bears the agent's runtime and can already see the
 * same content through it (@shiki's ruling), so hiding it in the UI protects
 * nothing.
 *
 * Heterogeneous by placement, discriminated on `placement_kind`, and that is the
 * whole reason it is a union: a workspace-placed conversation draws by its title
 * and workspace coordinates; a `direct_pair` stores no title and draws by its
 * COUNTERPART — the endpoint that is NOT the audited agent (who the agent is
 * talking to), resolved server-side for the same reason the DM list resolves it
 * there (which slot is "the other one" is a storage rule a client must not
 * reimplement). The AgentInbox never appears — it is the agent's own private
 * queue, outside the audit face's declared scope.
 *
 * `created_at` is the list's ORDER (oldest first), the same base order every
 * sibling conversation list uses; no conversation row carries a last-activity
 * timestamp.
 */
export const AgentAuditChatSummarySchema = z.discriminatedUnion('placement_kind', [
  z.object({
    placement_kind: z.literal('workspace'),
    conversation_id: z.string(),
    roster_policy: ConversationRosterPolicySchema,
    title: z.string(),
    workspace_id: z.string(),
    workspace_name: z.string(),
    workspace_kind: WorkspaceKindSchema,
    archived_at: z.number().nullable(),
    created_at: z.number().int(),
  }),
  z.object({
    placement_kind: z.literal('direct_pair'),
    conversation_id: z.string(),
    counterpart: DirectPairCounterpartSchema,
    /** The survivor read-only state of the LINE itself (a DM whose other side is
     *  gone), so a row renders its state without opening it. Independent of the
     *  audit face being read-only — that is a property of the VIEWER, this is a
     *  property of the conversation. */
    read_only: z.boolean(),
    archived_at: z.number().nullable(),
    created_at: z.number().int(),
  }),
]);
export type AgentAuditChatSummary = z.infer<typeof AgentAuditChatSummarySchema>;

export const AgentAuditChatListResponseSchema = z.object({
  chats: z.array(AgentAuditChatSummarySchema),
});
export type AgentAuditChatListResponse = z.infer<
  typeof AgentAuditChatListResponseSchema
>;

/**
 * The read-only full transcript of one of the agent's chats — `GET
 * /api/agents/:id/chats/:conversationId/messages` (#task:2036 part ②).
 *
 * The SAME shape as `MessageRepo.listWindowForConversation` (`mode: 'all'` —
 * mainline and thread replies interleaved into one stream), windowed, and
 * NOTHING more. Deliberately absent, because an audit read is a pure read that
 * touches no per-viewer state: no `reactions` (a personal relation), no
 * `stream_head_seq` (the audit read advances no cursor), no reply-preview
 * sidecars. `reply_counts_by_root` stays — it is a structural fact about the
 * transcript, not a relation to any viewer.
 */
export const AgentAuditTranscriptResponseSchema = z.object({
  messages: z.array(MessageDtoSchema),
  reply_counts_by_root: z.record(z.string(), z.number().int().nonnegative()),
  has_more_before: z.boolean(),
  has_more_after: z.boolean(),
});
export type AgentAuditTranscriptResponse = z.infer<
  typeof AgentAuditTranscriptResponseSchema
>;
