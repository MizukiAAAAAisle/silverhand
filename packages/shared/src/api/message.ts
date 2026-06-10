// AUTO-SPLIT from the former monolithic api/dto.ts (#task:963).
// Bounded context: message. Re-exported via api/index.ts → @silverhand/shared.
import { z } from 'zod';
import {
  ConversationKindSchema,
  FromKindSchema,
  TaskStatusSchema,
} from '../db/schema.js';
import { SearchOptionalStringSchema } from './_zod-helpers.js';
import { AttachmentSnapshotSchema } from './attachment.js';
import { TaskAssigneeDtoSchema } from './task.js';

export const MessageDtoSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  from_kind: FromKindSchema,
  from_agent_id: z.string().nullable(),
  from_user_id: z.string().nullable(),
  content: z.string(),
  metadata: z.record(z.unknown()).nullable(),
  /** Attachment snapshots attached to this message (null when none).
   *  Mirrored from `metadata.attachments` for typed access. */
  attachments: z.array(AttachmentSnapshotSchema).nullable(),
  seq: z.number(),
  created_at: z.number(),
  /** Task metadata — all null when this message is not a task. */
  task_number: z.number().nullable(),
  task_status: TaskStatusSchema.nullable(),
  task_title: z.string().nullable(),
  task_workspace_id: z.string().nullable(),
  task_closed_at: z.number().nullable(),
  task_assignee: TaskAssigneeDtoSchema.nullable(),
});
export type MessageDto = z.infer<typeof MessageDtoSchema>;

export const ConversationMessagesDtoSchema = z.object({
  messages: z.array(MessageDtoSchema),
  has_more_before: z.boolean(),
  /** True when at least one message exists with seq > max(messages.seq).
   *  For the default "latest" window this is always false; for an
   *  anchored window (`before_seq` / `after_seq` / `around_message_id`)
   *  it reflects the real DB state, so a bidirectional infinite query
   *  knows whether to issue a `getNextPageParam`. */
  has_more_after: z.boolean(),
});
export type ConversationMessagesDto = z.infer<typeof ConversationMessagesDtoSchema>;

export const SendMessageInputSchema = z.object({
  content: z.string().min(1),
  /** Optional attachment ids previously returned by the upload endpoint.
   *  Server validates each id belongs to the same channel as the
   *  destination conversation. */
  attachment_ids: z.array(z.string().min(1)).max(20).optional(),
});
export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;

export const MarkConversationReadInputSchema = z.object({
  /** Optional explicit target cursor. Omitted = backend uses MAX(messages.seq). */
  seq: z.number().int().nonnegative().optional(),
});
export type MarkConversationReadInput = z.infer<
  typeof MarkConversationReadInputSchema
>;

export const MarkConversationReadDtoSchema = z.object({
  last_read_seq: z.number(),
});
export type MarkConversationReadDto = z.infer<typeof MarkConversationReadDtoSchema>;

export const MessageUnreadByConversationDtoSchema = z.object({
  by_conversation: z.record(z.string(), z.number()),
  total: z.number(),
});
export type MessageUnreadByConversationDto = z.infer<
  typeof MessageUnreadByConversationDtoSchema
>;

export const MessageUnreadSummaryDtoSchema = z.object({
  by_workspace: z.record(z.string(), z.number()),
});
export type MessageUnreadSummaryDto = z.infer<
  typeof MessageUnreadSummaryDtoSchema
>;

const SearchOptionalMillisSchema = z.preprocess(
  value => (value === '' || value === undefined ? undefined : value),
  z.coerce.number().int().nonnegative().optional(),
);

export const SearchScopeSchema = z.enum(['all', 'regular', 'dm']);
export type SearchScope = z.infer<typeof SearchScopeSchema>;

export const SearchQueryInputSchema = z
  .object({
    q: z.string().trim().max(200).optional().default(''),
    scope: SearchScopeSchema.optional().default('all'),
    workspace_id: SearchOptionalStringSchema,
    conversation_id: SearchOptionalStringSchema,
    user_id: SearchOptionalStringSchema,
    agent_id: SearchOptionalStringSchema,
    from: SearchOptionalMillisSchema,
    to: SearchOptionalMillisSchema,
    limit: z.coerce.number().int().positive().max(200).optional().default(80),
  })
  .refine(v => !(v.user_id && v.agent_id), {
    message: 'user_id and agent_id cannot both be set',
    path: ['user_id'],
  });
export type SearchQueryInput = z.infer<typeof SearchQueryInputSchema>;

export const SearchWorkspaceRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['regular', 'dm']),
});
export type SearchWorkspaceRef = z.infer<typeof SearchWorkspaceRefSchema>;

export const SearchConversationRefSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: ConversationKindSchema,
  channel_id: z.string(),
  thread_id: z.string().nullable(),
  parent_conversation_id: z.string().nullable(),
  closed_at: z.number().nullable(),
  created_at: z.number(),
});
export type SearchConversationRef = z.infer<typeof SearchConversationRefSchema>;

export const SearchResultDtoSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('workspace'),
    workspace: SearchWorkspaceRefSchema.extend({
      description: z.string().nullable(),
      archived_at: z.number().nullable(),
      created_at: z.number(),
      updated_at: z.number(),
    }),
  }),
  z.object({
    type: z.literal('conversation'),
    workspace: SearchWorkspaceRefSchema,
    conversation: SearchConversationRefSchema,
  }),
  z.object({
    type: z.literal('message'),
    workspace: SearchWorkspaceRefSchema,
    conversation: SearchConversationRefSchema,
    message: MessageDtoSchema,
    agent_name: z.string().nullable(),
  }),
]);
export type SearchResultDto = z.infer<typeof SearchResultDtoSchema>;

export const SearchDtoSchema = z.object({
  query: SearchQueryInputSchema,
  results: z.array(SearchResultDtoSchema),
});
export type SearchDto = z.infer<typeof SearchDtoSchema>;

//
// One global flat list — no per-channel grouping, no tags. Each entry
// joins back to the source message + its workspace/conversation so the Saved
// view can render content + jump back to the conversation.
export const SavedMessageDtoSchema = z.object({
  id: z.string(),
  message: MessageDtoSchema,
  workspace_id: z.string(),
  workspace_name: z.string(),
  conversation_id: z.string(),
  conversation_title: z.string(),
  channel_id: z.string(),
  thread_id: z.string().nullable(),
  /** Display name of the message author at save time. `null` for user messages. */
  agent_name: z.string().nullable(),
  saved_at: z.number(),
});
export type SavedMessageDto = z.infer<typeof SavedMessageDtoSchema>;

//
// Single source of truth for what "@name" means in a message body.
// Mirrors the renderer-side regex in `Markdown.tsx` and the
// composer-side detector — the boundary check rejects emails (`me@x`)
// and paths (`a/@b`), and the alpha-first requirement rejects issue
// refs like `@123`. Aligned with auth-signup generated user names
// (alpha-first by design: `users.name` is the permanent mention
// anchor). `CreateAgentInputSchema.name` is intentionally broader
// (`/^[a-zA-Z0-9_-]+$/`, allows numeric-first); a numeric-first
// agent name will not be `@`-mentionable until/unless that schema
// is tightened — out of scope for the registration rewrite.
const MENTION_RE = /(?<![\w/])@([a-zA-Z][a-zA-Z0-9_-]*)/g;

/** Returns the unique set of @-names referenced in `text`, in
 *  first-occurrence order. */
export function extractMentions(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const name = m[1]!;
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}
