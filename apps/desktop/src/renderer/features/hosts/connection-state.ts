/**
 * D3.d — Outbound connection state presentation mapper.
 *
 * What this is and isn't:
 *
 *   - This file maps the (server-defined `local_host_status`,
 *     diagnostic `local_host_ws_attached_at`) pair to a UI-only
 *     presentation label. It does NOT mint a new status word — the
 *     5-value `local_host_status` enum from
 *     `BackendInfo.local_host_status` stays the single source of
 *     truth server-side. The "Connecting" vs "Connected" split here
 *     is a presentation hint derived from whether a fresh outbound
 *     WS attachment has been observed yet (D3.a Commit 4 docstring:
 *     "Renderer can surface as 'connected since' but must NOT derive
 *     a new status word").
 *   - All branches are exhaustively pinned by a `never` assertion so
 *     adding a new value to `local_host_status` on the server (e.g.
 *     a future "stale" arm) fails the typecheck here loud-and-early
 *     instead of falling through to a confusing default label.
 *   - Theme adapter contract: every state returns a `tone` key into
 *     the existing status token set (`accent` / `success` / `muted`
 *     / `warning` / `error`). The token set has AA-safe values
 *     defined in both `warm-script.css` and `forza6.css`, so the
 *     mapper itself is theme-agnostic — the consumer just picks the
 *     matching Tailwind utility (`text-success` / `text-error` / …).
 *
 * Labels are product-oriented ("This computer is …"): the pane renders
 * this pill next to the "This computer" heading, so the words describe
 * what the machine can do, not the daemon/attachment plumbing
 * underneath.
 *
 * Six-state matrix (status × attachedAt):
 *
 *   | status     | attachedAt | label              | tone     |
 *   |------------|------------|--------------------|----------|
 *   | unclaimed  | (n/a)      | (no pill rendered) | hidden   |
 *   | claimed    | null       | Connecting…        | accent   |
 *   | claimed    | number     | Ready              | success  |
 *   | revoked    | (n/a)      | Removed            | muted    |
 *   | error      | (n/a)      | Offline            | warning  |
 *   | failed     | (n/a)      | Stopped            | error    |
 *
 * Why `error` is "Offline" (warning) but `failed` is "Stopped"
 * (error): `error` is a transient claim-side failure (network blip
 * while talking to the backend), expected to self-heal on the next
 * refresh; `failed` is the supervisor's hard-fail signal after the
 * restart budget is exhausted (`local-host-failure.ts`), which requires
 * explicit user action (relaunch the app). They MUST stay distinct
 * labels so the two different user actions don't read identically.
 */
import type { BackendInfoSnapshot } from './hooks';

export type ConnectionTone =
  | 'hidden'
  | 'accent'
  | 'success'
  | 'muted'
  | 'warning'
  | 'error';

export interface ConnectionStateView {
  /** Whether to render a pill at all. `unclaimed` returns false so
   *  pre-claim users don't see a misleading "Disconnected" before they
   *  sign in. */
  visible: boolean;
  /** Presentation label. Empty string when `visible: false`. */
  label: string;
  /** Token-key picked off the shared status palette. Consumer maps to
   *  `text-{tone}` / `border-{tone}` classes that already exist in
   *  both themes. */
  tone: ConnectionTone;
  /** Optional secondary line — currently used only for "since X" on
   *  the Connected arm. `null` when not applicable. */
  detail: string | null;
}

export type LocalHostStatus = BackendInfoSnapshot['local_host_status'];

/**
 * Format an `attached_at` ms timestamp as a relative "since" string.
 * Pulled out so tests can substitute a fixed `now()` and pin the
 * exact phrasing per duration bucket.
 */
export function formatAttachedSince(
  attachedAt: number,
  nowMs: number,
): string {
  const deltaMs = Math.max(0, nowMs - attachedAt);
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export interface DescribeConnectionOpts {
  /**
   * Remote-mode readiness signal. In an embedded deployment the
   * outbound WS attachment is observable in-process and surfaces as
   * `attachedAt` (a number) — that's the primary "Ready" proof. But in
   * a remote-server deployment the attachment registry
   * (`HostWsServerController`) lives in the *remote* backend process,
   * so desktop main's in-process `getEmbeddedHostWsController()` returns
   * `null` and `attachedAt` is structurally always `null` even when the
   * daemon is genuinely attached (agents communicate fine). Without a
   * second source the pill would be stuck on "Connecting…" forever
   * (#task:1010).
   *
   * This flag is that second source: the caller derives it from the
   * remote backend's HTTP host-status (`availability === 'available'`),
   * the same authority every other remote-mode fact flows through. When
   * `true` we promote a `claimed + attachedAt===null` host to "Ready" —
   * but with `detail: null`, since `availability` carries no attach
   * timestamp to render a "since X" string. The embedded `attachedAt`
   * path still wins when present (keeps "since").
   *
   * Defaults to `false` so every existing call site (and the
   * exhaustiveness tests) keep the strict "no attachedAt ⇒ Connecting"
   * behavior unchanged.
   */
  remoteAttached?: boolean;
}

export function describeConnectionState(
  status: LocalHostStatus,
  attachedAt: number | null,
  nowMs: number,
  opts?: DescribeConnectionOpts,
): ConnectionStateView {
  switch (status) {
    case 'unclaimed':
      return { visible: false, label: '', tone: 'hidden', detail: null };
    case 'claimed':
      if (attachedAt === null) {
        // Remote mode: no local `attachedAt`, but the remote backend
        // confirmed the outbound attachment via host-status. Promote to
        // Ready (no "since" — `availability` has no attach timestamp).
        if (opts?.remoteAttached) {
          return {
            visible: true,
            label: 'Ready',
            tone: 'success',
            detail: null,
          };
        }
        return {
          visible: true,
          label: 'Connecting…',
          tone: 'accent',
          detail: null,
        };
      }
      return {
        visible: true,
        label: 'Ready',
        tone: 'success',
        detail: `since ${formatAttachedSince(attachedAt, nowMs)}`,
      };
    case 'revoked':
      return {
        visible: true,
        label: 'Removed',
        tone: 'muted',
        detail: null,
      };
    case 'error':
      return {
        visible: true,
        label: 'Offline',
        tone: 'warning',
        detail: null,
      };
    case 'failed':
      return {
        visible: true,
        label: 'Stopped',
        tone: 'error',
        detail: null,
      };
    default: {
      // Exhaustiveness gate — adding a new `local_host_status` value
      // server-side fails the renderer typecheck here on purpose, so
      // the new arm has to be considered for UI presentation in the
      // same change instead of falling through to silent default copy.
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}
