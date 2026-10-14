import type { EventFrame } from "@silverhand/shared";

/** Resource policy shared by the native runner and its bounded renderer bridge. */
export const HOOK_LIMITS = {
  eventBytes: 64 * 1024,
  batchSize: 8,
  forwardingQueue: 128,
  concurrency: 4,
  queue: 128,
  history: 100,
  outputBytes: 64 * 1024,
  configBytes: 256 * 1024,
  rules: 100,
  defaultTimeoutMs: 15000,
  maxTimeoutMs: 300000,
} as const;

/** Product events only. This catalog is shared by the editor and command matcher. */
export const HOOK_EVENTS = {
  notification: {
    label: "Notifications",
    description: "Mentions delivered to you in Silverhand.",
    fields: { kind: ["mention_self", "mention_external"], conversation_id: [] },
  },
  task_changed: {
    label: "Task changes",
    description: "Creation, claims, edits and status changes in your conversations.",
    fields: {
      kind: ["create", "claim", "unclaim", "status", "edit"],
      status: ["todo", "in_progress", "in_review", "done", "closed"],
      conversation_id: [],
      workspace_id: [],
    },
  },
} as const;
export type HookEvent = keyof typeof HOOK_EVENTS;
export interface HookRule {
  id: string;
  name: string;
  enabled: boolean;
  event: HookEvent;
  match?: Record<string, string | null>;
  action: {
    type: "command";
    command: string;
    cwd?: string;
    timeoutMs?: number;
    async?: true;
    env?: Record<string, string>;
  };
}
export interface HookSettingsSnapshot {
  path: string;
  revision: string;
  error?: string;
  sources: Array<{ path: string; revision: string; error?: string }>;
  entries: Array<{
    source: string;
    revision: string;
    index: number;
    rule: HookRule | null;
    error?: string;
  }>;
}
export interface DesktopPreferencesSnapshot {
  notificationSound?: import("./notification-sounds.js").NotificationSoundFile | null;
  path: string;
  revision: string;
  error?: string;
  notificationSoundEnabled: boolean;
}
export interface HookToggle {
  source: string;
  revision: string;
  index: number;
  enabled: boolean;
}
export type HookRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "rejected";
export interface HookRun {
  id: string;
  ruleId: string;
  name: string;
  status: HookRunStatus;
  createdAt: number;
  finishedAt?: number;
  exitCode?: number | null;
  reason?: string;
  stdout: string;
  stderr: string;
  truncated: boolean;
}
/** beginFeed returns an opaque lease tied to the current native auth/renderer generation. */
export interface EventHooksCapability {
  loadHooks(): Promise<HookSettingsSnapshot>;
  setHookEnabled(input: HookToggle): Promise<HookSettingsSnapshot>;
  openSource(source: string): Promise<void>;
  openDirectory(): Promise<void>;
  loadPreferences(): Promise<DesktopPreferencesSnapshot>;
  savePreferences(
    input: import("./notification-sounds.js").NotificationSoundEdit,
  ): Promise<DesktopPreferencesSnapshot>;
  openConfig(kind: "hooks" | "preferences"): Promise<void>;
  beginFeed(): Promise<string | null>;
  endFeed(lease: string): Promise<void>;
  deliver(input: { lease: string; frames: EventFrame[] }): Promise<void>;
  runs(): Promise<HookRun[]>;
  cancel(id: string): Promise<void>;
}
