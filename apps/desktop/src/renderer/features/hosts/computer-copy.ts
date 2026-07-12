/**
 * #task:1348 — single source of truth for user-facing copy in the
 * user-managed computer flow. shiki copy gate: formal product language,
 * no colloquial placeholders, and never leak internal concepts
 * (`daemon` / `host` / `remote` / `connect-token`) into prose — those
 * appear only inside the literal connection command string.
 *
 * Two orthogonal axes must not collapse into one word set (Alice §3.2/§4):
 *   - LIFECYCLE (setup state, DTO `status`): pending | active | revoked.
 *       active carries no standalone label — it's just a normal computer.
 *   - AVAILABILITY (realtime, `/status`): online | offline | unreachable —
 *       only meaningful for an active computer. "Connected" belongs HERE,
 *       never as a lifecycle label.
 */
export const computerCopy = {
  /** Header `+` action + create confirm. */
  addComputer: 'Add computer',

  // ── Create / connection flow ───────────────────────────────────────
  dialogTitle: 'Add a computer',
  dialogIntro: 'Run this command on the computer you want to add.',
  connectionCommandLabel: 'Connection command',
  reveal: 'Reveal',
  hide: 'Hide',
  copy: 'Copy',
  copied: 'Copied',
  /** Reveal-once security notice — prose never says "token". */
  revealOnceNotice:
    'This command is shown once and cannot be retrieved later. Copy it before closing.',
  waitingForConnection: 'Waiting for connection',
  /** Availability moment: the computer just attached. */
  connectedTo: (hostname: string) => `Connected to ${hostname}`,
  nameLabel: 'Computer name',
  namePlaceholder: 'e.g. Studio Mini',
  finish: 'Done',
  cancel: 'Cancel',
  createFailed: "Couldn't start adding this computer. Please try again.",
  /** Finalize (name + confirm) failed — the setup is not yet a real
   *  computer, so the user stays in the dialog to retry. */
  finalizeFailed: "Couldn't finish setting up this computer. Please try again.",

  // ── Lifecycle labels (DTO `status`) ────────────────────────────────
  lifecyclePending: 'Waiting for connection',
  lifecycleRevoked: 'Revoked',

  // ── Availability labels (realtime) ─────────────────────────────────
  // Single source for the availability/lifecycle words shared across
  // surfaces: `describeHostStatus` (user-managed /status) AND
  // `connection-state.ts` (the local embedded-host supervisor pill) both
  // read these — the Unified Computer model forbids one surface saying
  // "Connected" while another says "Ready" for the same availability fact
  // (Alice §7.1 / no source-fork). Context-unique supervisor states
  // (Connecting… / Stopped) stay local to connection-state.ts.
  availabilityConnected: 'Connected',
  availabilityOffline: 'Offline',
  availabilityUnreachable: 'Unreachable',

  // ── Target-page Connection section (Phase 2) ───────────────────────
  connectionSectionTitle: 'Connection',
  connectionSectionIntro:
    'Generate a connection command to reconnect this computer, move it to another machine, or replace a lost one.',
  generateCommand: 'Generate connection command',
  /** Rotate consequence — the previous command dies and the live
   *  connection is dropped. Users must not read rotate as "just fetch
   *  another copy". */
  regenerateWarning:
    'Generating a new command invalidates the previous one and disconnects any machine currently using it.',
  rotateFailed:
    "Couldn't generate a new connection command. Please try again.",
  disconnectCurrent: 'Disconnect current connection',
  /** Disconnect is availability-axis only — reversible, non-destructive.
   *  Copy must make clear the command still works, so it never reads like
   *  revoke. */
  disconnectIntro:
    'Drops the current connection without invalidating the connection command — the same command reconnects it later.',
  disconnectFailed: "Couldn't disconnect this computer. Please try again.",

  // ── Diagnostics (manual copy, #task:1445) ─────────────────────────
  /** Footer utility: copies a redacted, plain-text diagnostics report for
   *  this computer to the clipboard (no upload). The report body is built
   *  by the shared `buildHostDiagnosticsText`; this is the only UI prose. */
  copyDiagnostics: 'Copy diagnostics',

  // ── Badges ─────────────────────────────────────────────────────────
  appManaged: 'App managed',

  // ── Concurrency rejection (target page, Phase 2) ───────────────────
  /** N1: `connected_host_name` may be null before the first `ready`
   *  event lands — never render a bare null. */
  alreadyConnected: (hostname: string | null): string =>
    hostname
      ? `This computer is already connected from ${hostname}.`
      : 'This computer is already connected from another machine.',

  // ── Delete (user-managed, terminal) ────────────────────────────────
  // The user-managed removal verb (#task:1354; `docs/user-managed-
  // computer-v1.md` §5.3). Distinct from Revoke: Delete is terminal
  // (hard-deletes the row, invalidates the connect-token, subject to
  // dependency check + optional agent cascade). Revoke is soft
  // (`revoked_at` set, credential invalidated, agents/workspaces
  // preserved). The two never share a component, mutation, or copy.
  deleteComputer: 'Delete computer',
  deleteConfirmTitle: 'Delete this computer?',
  /** One line of consequence — deleting invalidates the connection command
   *  and drops the computer from the list. Recoverable by adding it again. */
  deleteConfirmBody:
    "Its connection command stops working and it's removed from your computers. This can't be undone.",
  deleteConfirm: 'Delete',
  deleting: 'Deleting…',
  deleteFailed: "Couldn't delete this computer. Please try again.",
  /** Agent-cascade confirm (#task:1380, backend `409 has_dependents` with
   *  `can_cascade_agents: true`). The computer's only dependents are agents,
   *  so deleting it removes them too. shiki interaction gate (2026-07-07): the
   *  second confirm does NOT replace the first — it keeps the standard delete
   *  copy and adds a pale-amber impact block below it, headed by this line and
   *  followed by the list of agents that go with it. Naming the consequence +
   *  showing exactly who is affected carries the weight; no extra prose. */
  deleteCascadeImpactTitle: 'Agents will be removed',
  /** Transient pending-agents block (#task:1380, backend `409
   *  has_pending_agents`). An agent on this computer is still being created —
   *  a state that clears on its own — so this is a wait-and-retry hint, NOT a
   *  cascade confirm or a hard block. shiki copy gate: short, no internal
   *  terms (no "materialize" / "daemon"). */
  deletePendingTitle: 'Agent creation in progress',
  deletePendingBody: 'An agent is still being set up. Try again in a moment.',
  deletePendingRetry: 'Try again',
  /** Dependency-block state (backend `409 has_dependents`). We can't delete
   *  a computer that still owns agents / workspaces — the user clears those
   *  in their own context first. */
  deleteBlockedTitle: "This computer is still in use",
  deleteBlockedBody: (agents: number, workspaces: number): string => {
    const parts: string[] = [];
    if (agents > 0) parts.push(`${agents} ${agents === 1 ? 'agent' : 'agents'}`);
    if (workspaces > 0)
      parts.push(
        `${workspaces} ${workspaces === 1 ? 'workspace' : 'workspaces'}`,
      );
    const list = parts.join(' and ');
    return `It still has ${list}. Remove them first, then delete the computer.`;
  },
  deleteBlockedDismiss: 'OK',

  /* ── Proxy ─────────────────────────────────────────────────────── */
  /** Section heading for the per-computer network-proxy editor. */
  proxyTitle: 'Network proxy',
  /** Offline gate. Proxy config is host-local truth — it can only be read
   *  or written while the computer is connected, so an offline computer
   *  collapses the whole section to this one short line (shiki-frozen copy;
   *  do not expand into "readable but locked" — offline means neither). */
  proxyOfflineHint: 'Please connect first',

  /* ── Refresh credentials (app-managed, current-machine only) ──── */
  /** Section heading. Refresh rotates the backend-issued host token in
   *  local daemon config — token bytes stay in main-process memory and
   *  never enter the renderer. Independent of the user-managed
   *  `Generate connection command` flow; do not merge the copy. */
  refreshCredentialsTitle: 'Credentials',
  refreshCredentialsBody:
    "This computer's connection credentials update in place. Agents keep running.",
  refreshCredentials: 'Refresh credentials',
  refreshingCredentials: 'Refreshing…',
  refreshCredentialsSuccess: 'Credentials refreshed.',
  refreshCredentialsFailed:
    "Couldn't refresh credentials. Try again in a moment.",

  /* ── Revoke (app-managed, soft) ────────────────────────────────── */
  /** Soft revoke: writes `revoked_at`, invalidates the credential, and
   *  force-drops the live connection. Agents and workspaces are
   *  preserved (per doc §5.3). Never bundled with sign-out — user
   *  sessions are user-level and independent of Computer lifecycle.
   *
   *  Confirm copy is three user-visible consequences, in dependency
   *  order: what disappears (the live connection), what that costs
   *  right now (running agents stop), and what does NOT disappear
   *  (records/workspaces/messages). Anything less than all three lets
   *  the user click Revoke without seeing the durability boundary. */
  revokeComputer: 'Revoke computer',
  revokeConfirmTitle: 'Revoke this computer?',
  revokeConfirmFacts: [
    'The computer disconnects and cannot reconnect.',
    'Running agents stop.',
    'Agent records, workspaces, and messages are preserved.',
  ] as const,
  revokeConfirm: 'Revoke',
  revoking: 'Revoking…',
  revokeFailed: "Couldn't revoke this computer. Please try again.",
} as const;
