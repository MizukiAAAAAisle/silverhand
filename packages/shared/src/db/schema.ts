import { z } from 'zod';

export const RuntimeKindSchema = z.enum(['claude', 'codex', 'cursor', 'gemini']);
export type RuntimeKind = z.infer<typeof RuntimeKindSchema>;

export const HostKindSchema = z.enum(['local', 'remote']);
export type HostKind = z.infer<typeof HostKindSchema>;

export const ChannelKindSchema = z.enum(['regular', 'dm']);
export type ChannelKind = z.infer<typeof ChannelKindSchema>;

export const SessionStatusSchema = z.enum([
  'starting',
  'active',
  'idle',
  'archived',
  'crashed',
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionAgentStatusSchema = z.enum([
  'idle',
  'starting',
  'active',
  'crashed',
]);
export type SessionAgentStatus = z.infer<typeof SessionAgentStatusSchema>;

export const FromKindSchema = z.enum(['user', 'agent', 'system']);
export type FromKind = z.infer<typeof FromKindSchema>;

export const SessionEventKindSchema = z.enum([
  'session_init',
  'tool_call',
  'tool_output',
  'file_change',
  'shell',
  'stderr',
  'compaction_started',
  'compaction_finished',
  'turn_end',
]);
export type SessionEventKind = z.infer<typeof SessionEventKindSchema>;

export interface HostRow {
  id: string;
  name: string;
  kind: HostKind;
  created_at: number;
}

export interface AgentRow {
  id: string;
  name: string;
  display_name: string;
  runtime: RuntimeKind;
  model: string | null;
  reasoning_effort: string | null;
  host_id: string;
  description: string | null;
  created_at: number;
  updated_at: number;
}

export interface ChannelRow {
  id: string;
  name: string;
  description: string | null;
  kind: ChannelKind;
  workspace_path: string;
  workspace_host_id: string;
  dm_agent_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface ChannelMemberRow {
  channel_id: string;
  agent_id: string;
  joined_at: number;
}

export interface SessionRow {
  id: string;
  channel_id: string;
  title: string;
  status: SessionStatus;
  parent_session_id: string | null;
  spawned_by_agent_id: string | null;
  closed_at: number | null;
  close_summary: string | null;
  created_at: number;
  updated_at: number;
}

export interface SessionAgentRow {
  session_id: string;
  agent_id: string;
  cli_session_id: string | null;
  pid: number | null;
  status: SessionAgentStatus;
  joined_at: number;
}

export interface MessageRow {
  id: string;
  session_id: string;
  from_kind: FromKind;
  from_agent_id: string | null;
  from_user_id: string | null;
  content: string;
  metadata: string | null;
  seq: number;
  created_at: number;
}

export interface AgentInboxRow {
  id: number;
  session_id: string;
  agent_id: string;
  message_id: string;
  delivered_at: number | null;
  created_at: number;
}

export interface SessionEventRow {
  id: number;
  session_id: string;
  agent_id: string | null;
  kind: SessionEventKind;
  payload: string | null;
  created_at: number;
}

export interface SavedMessageRow {
  id: string;
  message_id: string;
  session_id: string;
  channel_id: string;
  saved_at: number;
}

export const NotificationKindSchema = z.enum(['mention_external']);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

export interface NotificationRow {
  id: string;
  kind: NotificationKind;
  /** Reserved for multi-user. v1 always writes NULL. */
  user_id: string | null;
  /** The agent the notification is *about* (e.g. mentioned agent). */
  agent_id: string | null;
  /** Where the notification "lives" — for mention_external this is
   *  the recipient agent's DM channel. */
  channel_id: string | null;
  /** Session where the notification's CC message lives. */
  session_id: string | null;
  /** The CC message itself. */
  message_id: string | null;
  /** Origin pointers (where the user actually typed the mention). */
  source_channel_id: string | null;
  source_session_id: string | null;
  source_message_id: string | null;
  /** JSON; kind-specific extra fields. */
  payload: string | null;
  read_at: number | null;
  created_at: number;
}
