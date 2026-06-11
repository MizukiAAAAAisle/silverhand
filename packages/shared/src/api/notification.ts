// AUTO-SPLIT from the former monolithic api/dto.ts (#task:963).
// Bounded context: notification. Re-exported via api/index.ts → @silverhand/shared.
import { z } from 'zod';
import {
  NotificationKindSchema,
} from '../db/schema.js';

//
// v1 only emits `mention_external`: a user @-mentioned an agent who
// wasn't a member of the originating conversation. The mention was CC'd
// into that agent's DM channel (a dedicated `Mentions` conversation); a
// notification points the user at it.
//
// `payload` is open-ended JSON for kind-specific extras. For
// mention_external we stash:
//   - source_workspace_name: string  (denormalized for list rendering)
//   - source_conversation_title: string
//   - mention_excerpt: string  (first ~120 chars of the original)
// mention_self stashes:
//   - conversation_title: string
//   - trigger_name: string  (display label of the sender who mentioned viewer)
//   - mentioned_name: string
//   - mention_excerpt: string

export const NotificationDtoSchema = z.object({
  id: z.string(),
  kind: NotificationKindSchema,
  user_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  workspace_id: z.string().nullable(),
  conversation_id: z.string().nullable(),
  message_id: z.string().nullable(),
  /** Reply-cluster root for `message_id` when the notification points
   *  at a message inside a thread cluster. NULL = main-line / legacy. */
  thread_root_id: z.string().nullable().optional(),
  /** Legacy isolated-thread conversation id when `conversation_id`
   *  points at a fossil thread. New reply clusters use
   *  `thread_root_id` instead. */
  legacy_thread_conversation_id: z.string().nullable().optional(),
  source_workspace_id: z.string().nullable(),
  source_conversation_id: z.string().nullable(),
  source_message_id: z.string().nullable(),
  payload: z.record(z.unknown()).nullable(),
  read_at: z.number().nullable(),
  created_at: z.number(),
});
export type NotificationDto = z.infer<typeof NotificationDtoSchema>;

export const MarkNotificationsReadInputSchema = z
  .object({
    /** Mark a specific id; omit to use channel/all selectors. */
    id: z.string().optional(),
    /** Mark all unread notifications scoped to this workspace/sidebar item. */
    workspace_id: z.string().optional(),
    /** Mark all unread notifications scoped to a single conversation. */
    conversation_id: z.string().optional(),
    /** Mark every unread notification (for the current user). */
    all: z.boolean().optional(),
  })
  .refine(v => !!(v.id || v.workspace_id || v.conversation_id || v.all), {
    message: 'must specify id, workspace_id, conversation_id, or all',
  });
export type MarkNotificationsReadInput = z.infer<
  typeof MarkNotificationsReadInputSchema
>;
