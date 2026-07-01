/**
 * WebSocket frame type definitions for the Silverhand single-connection event bus.
 *
 * Transport contract:
 * - Client connects with the main-owned session cookie scoped to the
 *   websocket path.
 * - Server validates the upgrade and immediately sends AuthenticatedFrame
 *   (viewerId, epoch).
 * - Client then sends SubscribeFrame / UnsubscribeFrame / ResumeFrame.
 * - Server pushes EventFrame for each scoped event; PingFrame every 30s.
 * - Client replies PongFrame within 5s or server closes the connection.
 *
 * Scope naming:
 *   app                           — global, no private data
 *   workspace:{workspaceId}       — workspace-level public facts
 *   conversation:{conversationId} — per-conversation MESSAGE-STREAM events
 *                                   (message / reaction / task_changed) —
 *                                   resume-governed, feeds the message cursor.
 *   conversation-side:{conversationId} — per-conversation SIDE-CHANNEL events
 *                                   (agent_status / agent_activity /
 *                                   conversation_activity / members_changed) —
 *                                   cursor-inert, self-healing via own REST /
 *                                   invalidate (Stage-2, docs/event-ws-recovery-class-scope-v1.md).
 *   viewer:{userId}               — viewer-private (notifications, unread)
 */

import type { TransportSeq, TransportEpoch } from './seq.js';

// ── Client → Server ──────────────────────────────────────────────────────────

/** Legacy frame retained so old clients are rejected explicitly. C.4
 *  authenticates the websocket upgrade from the main-owned session
 *  cookie; new clients must not send a bearer in-band. */
export interface AuthFrame {
  type: 'auth';
  /** Deprecated; ignored/rejected by the server. */
  token: string;
}

/** Subscribe to a scope. Server responds with SubscribedFrame or ErrorFrame. */
export interface SubscribeFrame {
  type: 'subscribe';
  /**
   * Scope string: 'app' | 'workspace:{id}' | 'conversation:{id}' | 'viewer:{userId}'.
   * Use 'viewer:self' to subscribe to the authenticated viewer's private scope —
   * server rewrites it to 'viewer:{resolvedViewerId}'.
   */
  scope: string;
}

/** Unsubscribe from a scope. */
export interface UnsubscribeFrame {
  type: 'unsubscribe';
  scope: string;
}

/**
 * After reconnect: inform the server of the last seq seen per scope so it can
 * replay missed events from the replay buffer.
 *
 * Send one ResumeFrame per scope (or bundle multiple in scopes map).
 * Server replies with EventFrames for missed events, then normal stream continues.
 * If epoch mismatches or gap > buffer, server sends SnapshotRequiredFrame.
 */
export interface ResumeFrame {
  type: 'resume';
  /**
   * Map of scope → { epoch, lastSeq } describing the client's last known
   * position for each scope it wants to resume. Both are transport-space
   * (per-scope replay ordinal + restart generation), never message-space —
   * the server decodes them at ingress before touching the replay buffer.
   */
  scopes: Record<string, { epoch: TransportEpoch; lastSeq: TransportSeq }>;
}

/** Heartbeat reply to PingFrame. Must be sent within 5 s of receiving Ping. */
export interface PongFrame {
  type: 'pong';
}

export type ClientFrame = AuthFrame | SubscribeFrame | UnsubscribeFrame | ResumeFrame | PongFrame;

// ── Server → Client ──────────────────────────────────────────────────────────

/**
 * Sent after a successful AuthFrame. Provides the resolved viewerId and the
 * current server epoch (used for resume validation).
 */
export interface AuthenticatedFrame {
  type: 'authenticated';
  viewerId: string;
  /** UUID generated at backend process startup. Changes on restart. */
  epoch: TransportEpoch;
}

/**
 * Confirms a subscription was registered. The seq here is the high-watermark
 * for this scope at the moment of registration.
 *
 * This seq is a baseline of LAST RESORT, not a re-baseline: the client adopts
 * it only when it holds no usable same-epoch cursor for the scope. A retained
 * client cursor is authoritative (the client pairs a `resume` from it on
 * subscribe), so the ack must not advance the cursor to head — doing so would
 * skip events replayed for the gap. See `docs/event-ws-transport-v1.md` §3.
 */
export interface SubscribedFrame {
  type: 'subscribed';
  scope: string;
  epoch: TransportEpoch;
  /** Current seq for this scope at subscription time. */
  seq: TransportSeq;
}

/** A scoped real-time event pushed by the server. */
export interface EventFrame {
  type: 'event';
  scope: string;
  /** Monotonic sequence number per scope (resets on backend restart / epoch change). */
  seq: TransportSeq;
  /** Server epoch — client detects restarts when this changes. */
  epoch: TransportEpoch;
  /** Event kind (e.g. 'message', 'agent_activity', 'task_changed', 'unread_updated'). */
  kind: string;
  payload: unknown;
}

/** Server heartbeat — client must reply PongFrame within 5 s. */
export interface PingFrame {
  type: 'ping';
}

/**
 * Informs the client it must do a full REST snapshot for this scope.
 * Triggered when: epoch mismatch (backend restarted) or replay gap > buffer.
 *
 * `epoch` + `currentSeq` carry the server's current transport position for the
 * scope at emit time — the **transport-seq baseline** the client re-cold-starts
 * from once its REST reconcile commits (Stage-2 §6). This makes the frame
 * isomorphic to `SubscribedFrame` / `EventFrame` (all three position-bearing
 * server frames carry `epoch` + a transport seq). The baseline is a transport
 * seq **only** — never `stream_head_seq` (a message seq; the §3.1 reboot proof
 * forbids conflating the two spaces). See `docs/event-ws-transport-v1.md` §6.
 */
export interface SnapshotRequiredFrame {
  type: 'snapshot_required';
  scope: string;
  reason: 'epoch_mismatch' | 'gap_too_large';
  /** Server epoch for this scope at emit time (matches the post-snapshot fanout). */
  epoch: TransportEpoch;
  /**
   * Server's current transport seq for this scope at emit time. The client
   * commits its resume floor to this value **after** its REST reconcile settles
   * (apply-gated, not on receipt). Transport-seq space only.
   */
  currentSeq: TransportSeq;
}

/** Server-side error (auth failure, permission denied, invalid frame, etc.). */
export interface ErrorFrame {
  type: 'error';
  code:
    | 'auth_required'
    | 'auth_failed'
    | 'forbidden'
    | 'invalid_frame'
    | 'unknown_scope';
  message: string;
}

export type ServerFrame =
  | AuthenticatedFrame
  | SubscribedFrame
  | EventFrame
  | PingFrame
  | SnapshotRequiredFrame
  | ErrorFrame;

// ── Scope helpers ────────────────────────────────────────────────────────────
//
// One grammar for conversation transport scopes, shared by backend publish and
// renderer subscribe so the two never drift (ubiquitous language). The two
// prefixes are disjoint: `"conversation-side:x".startsWith("conversation:")` is
// false (char 12 is `-` vs `:`), so a `conversation:` parser never captures a
// side scope.

/** Message-stream scope for a conversation (message / reaction / task_changed). */
export function conversationScope(conversationId: string): string {
  return `conversation:${conversationId}`;
}

/** Side-channel scope for a conversation (agent_status / activity / members). */
export function conversationSideScope(conversationId: string): string {
  return `conversation-side:${conversationId}`;
}

/** Extract the conversationId from a message-stream scope, or null. */
export function parseConversationScope(scope: string): string | null {
  return scope.startsWith('conversation:')
    ? scope.slice('conversation:'.length)
    : null;
}

/** Extract the conversationId from a side-channel scope, or null. */
export function parseConversationSideScope(scope: string): string | null {
  return scope.startsWith('conversation-side:')
    ? scope.slice('conversation-side:'.length)
    : null;
}
