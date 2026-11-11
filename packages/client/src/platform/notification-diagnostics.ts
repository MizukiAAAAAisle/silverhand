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
  readSystem(): Promise<NotificationSystemSnapshot>;
  getLocalSnapshot(): NotificationLocalSnapshot;
  subscribeLocal(listener: () => void): () => void;
  /** Supplied only by the acceptance bundle. Removing its host disposes the control. */
  mountTestControl?(host: HTMLElement): () => void;
}
