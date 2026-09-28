export interface BackendProxyRequest {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  bodyText?: string;
  responseType?: "text" | "arrayBuffer";
}

export interface BackendProxyResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyText?: string;
  bodyBytes?: Uint8Array;
}

export interface BackendUploadField {
  name: string;
  value: string;
}

export interface BackendUploadFile {
  fieldName: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface BackendUploadRequest {
  path: string;
  fields: BackendUploadField[];
  files: BackendUploadFile[];
}

export type EventWsDiagnosticKind =
  | "socket_open"
  | "socket_close"
  | "authenticated"
  | "subscribed"
  | "message_event"
  | "live_gap"
  | "resume_sent"
  | "snapshot_required"
  | "orphan_frame"
  | "markSatisfied_no_floor"
  | "satisfied_pending_overflow";

export interface EventWsDiagnostic {
  kind: EventWsDiagnosticKind;
  scope?: string;
  eventKind?: string;
  seq?: number;
  lastSeq?: number;
  expectedSeq?: number;
  epoch?: string;
  reason?: string;
  code?: number;
  wasClean?: boolean;
}

/** An authenticated text-frame socket. Credentials stay inside the platform adapter. */
export interface EventSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener<K extends keyof EventSocketEvents>(
    type: K,
    listener: (event: EventSocketEvents[K]) => void,
  ): void;
}

export interface EventSocketEvents {
  open: unknown;
  message: { data: unknown };
  close: { code: number; wasClean: boolean };
  error: unknown;
}
