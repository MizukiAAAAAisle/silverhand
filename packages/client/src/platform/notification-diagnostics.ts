/** Current, non-sensitive observations only. No credentials, business IDs or payloads. */
export const NOTIFICATION_DIAGNOSTICS_FOREGROUND_EVENT = "silverhand:notification-diagnostics-foreground";
export type NotificationSendStatus =
  | "waiting-session" | "sending" | "missing-session" | "invalidated"
  | "posted" | "suppressed-focused" | "channel-disabled" | "notifications-disabled"
  | "not-authorized-or-undecided" | "session-expired" | "permission-request-busy"
  | "diagnostic-unavailable" | "diagnostic-invalid" | "NOTIFICATION_FAILED"
  | "BRIDGE_ERROR" | "UNKNOWN_STATUS";

export interface NotificationSendObservation {
  status: NotificationSendStatus;
  /** Start time of this observation, not a delivery timestamp. */
  at: number;
}

export interface NotificationSystemSnapshot {
  runtimePermission: "granted" | "not-granted" | "not-required" | "unknown";
  appEnabled: boolean | null;
  channel: "present" | "absent" | "unknown";
  channelBlocked: boolean | null;
}

export interface NotificationLocalSnapshot {
  session: "present" | "absent" | "unknown";
  lastSend: NotificationSendObservation | null;
}

export interface NotificationDiagnosticsCapability {
  /** Optional passive shared-hook observation, currently supplied only by Android. */
  hook?: NotificationHookDiagnostics;
  readSystem(): Promise<NotificationSystemSnapshot>;
  getLocalSnapshot(): NotificationLocalSnapshot;
  subscribeLocal(listener: () => void): () => void;
  /** Supplied only by the acceptance bundle. Removing its host disposes the control. */
  mountTestControl?(host: HTMLElement): () => void;
}

/** What the shared hook observed, not WebSocket delivery or notification posting. */
export type NotificationHookDecision =
  | "suppressed-conversation" | "initiated"
  | "initial-list" | "already-seen" | "no-mention" | "no-capability" | "not-evaluated";
export type NotificationHookEvent =
  | { kind: "list"; mentionSelfCount: number }
  | { kind: "decision"; decision: NotificationHookDecision };
export interface NotificationHookSnapshot {
  list: { mentionSelfCount: number; at: number } | null;
  decision: NotificationHookDecision;
}
export interface NotificationHookDiagnostics {
  /** A generation-bound sink: stale callbacks are rejected after account reset. */
  createObserver(): { isCurrent(): boolean; record(event: NotificationHookEvent): void };
  getSnapshot(): NotificationHookSnapshot;
  subscribe(listener: () => void): () => void;
}
