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
 *   conversation:{conversationId} — per-conversation events
 *   viewer:{userId}               — viewer-private (notifications, unread)
 */

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
   * position for each scope it wants to resume.
   */
  scopes: Record<string, { epoch: string; lastSeq: number }>;
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
  epoch: string;
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
  epoch: string;
  /** Current seq for this scope at subscription time. */
  seq: number;
}

/** A scoped real-time event pushed by the server. */
export interface EventFrame {
  type: 'event';
  scope: string;
  /** Monotonic sequence number per scope (resets on backend restart / epoch change). */
  seq: number;
  /** Server epoch — client detects restarts when this changes. */
  epoch: string;
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
 */
export interface SnapshotRequiredFrame {
  type: 'snapshot_required';
  scope: string;
  reason: 'epoch_mismatch' | 'gap_too_large';
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
