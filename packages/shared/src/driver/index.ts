/**
 * Driver-side type contracts shared between backend and (optionally)
 * renderer for typing event payloads. The actual `Driver` interface
 * and concrete implementations live in `@silverhand/backend` since they
 * use Node-only APIs (`crypto`, `child_process`, `NodeJS.ProcessEnv`).
 */

/**
 * Unified event union emitted by a driver's `parseLine`. ConversationManager
 * converts these to realtime UI broadcasts and `session_events` rows.
 */
export type ParsedEvent =
  | { kind: 'session_init'; sessionId: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool_call'; name: string; input: unknown; toolCallId?: string }
  | { kind: 'tool_output'; name?: string; toolCallId?: string }
  | { kind: 'turn_end'; sessionId?: string }
  | { kind: 'compaction_started' }
  | { kind: 'compaction_finished' }
  | { kind: 'error'; message: string; code?: string; fatal?: boolean }
  | { kind: 'unknown'; raw: string };
