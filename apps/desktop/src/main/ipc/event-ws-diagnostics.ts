import type { GuardedIpcRegistrar } from "./guarded-ipc.js";

interface EventWsDiagnosticLogger {
  info(fields: Record<string, unknown>, message: string): void;
}

const EVENT_WS_DIAGNOSTIC_KINDS: ReadonlySet<string> = new Set([
  "socket_open",
  "socket_close",
  "authenticated",
  "subscribed",
  "message_event",
  "live_gap",
  "resume_sent",
  "snapshot_required",
  "orphan_frame",
  "markSatisfied_no_floor",
  "satisfied_pending_overflow",
] as const);

interface RendererEventWsDiagnostic {
  kind: string;
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

export function registerEventWsDiagnosticIpcHandler(opts: {
  getLogger: () => EventWsDiagnosticLogger | null;
  ipc: GuardedIpcRegistrar;
}): void {
  opts.ipc.handle("eventWs:diagnostic", (_event, input: unknown) => {
    const diagnostic = normalizeRendererEventWsDiagnostic(input);
    if (!diagnostic) return;
    opts.getLogger()?.info(
      {
        category: "event_ws.renderer",
        source: "renderer",
        ...diagnostic,
        conversationId: conversationIdFromWsDiagnosticScope(diagnostic.scope),
      },
      "event ws renderer diagnostic",
    );
  });
}

function normalizeRendererEventWsDiagnostic(input: unknown): RendererEventWsDiagnostic | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const kind = boundedString(record.kind, 64);
  if (!kind || !EVENT_WS_DIAGNOSTIC_KINDS.has(kind)) return null;
  const out: RendererEventWsDiagnostic = { kind };
  out.scope = boundedString(record.scope, 200);
  out.eventKind = boundedString(record.eventKind, 100);
  out.epoch = boundedString(record.epoch, 100);
  out.reason = boundedString(record.reason, 100);
  out.seq = safeInteger(record.seq);
  out.lastSeq = safeInteger(record.lastSeq);
  out.expectedSeq = safeInteger(record.expectedSeq);
  out.code = safeInteger(record.code);
  if (typeof record.wasClean === "boolean") out.wasClean = record.wasClean;
  return out;
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length === 0) return undefined;
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function conversationIdFromWsDiagnosticScope(scope: string | undefined): string | undefined {
  return scope?.startsWith("conversation:") ? scope.slice("conversation:".length) : undefined;
}
