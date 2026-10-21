import { t } from "@/lib/i18n";
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
export const computerCopy = () =>
  ({
    /** Header `+` action + create confirm. */
    addComputer: t("computers.addComputer"),

    // ── Create / connection flow ───────────────────────────────────────
    dialogTitle: t("computers.addAComputer"),
    dialogIntro: t("computers.runThisCommandOn"),
    connectionCommandLabel: t("computers.connectionCommand"),
    /** The published package a user-managed computer installs to connect
     *  (`npx <name>@latest connect …`). Named in prose only where the user
     *  must act on it — currently `describeAdmissionFailure`, where "update
     *  Silverhand on that machine" would not say what to run. Version-free
     *  on purpose: the server owns the pinned spec
     *  (`SILVERHAND_DAEMON_NPM_SPEC`), and every published copy of this
     *  package is reached by the same name. */
    connectionPackageName: "@silverhand-ai/daemon",
    reveal: t("computers.reveal"),
    hide: t("computers.hide"),
    copy: t("computers.copy"),
    copied: t("computers.copied"),
    /** Reveal-once security notice — prose never says "token". */
    revealOnceNotice: t("computers.thisCommandIsShown"),
    waitingForConnection: t("computers.waitingForConnection"),
    /** Availability moment: the computer just attached. */
    connectedTo: (hostname: string) => t("computers.connectedTo", { hostname }),
    nameLabel: t("computers.computerName"),
    namePlaceholder: t("computers.eGStudioMini"),
    finish: t("computers.done"),
    cancel: t("common.cancel"),
    createFailed: t("computers.couldntStartAddingThis"),
    /** Finalize (name + confirm) failed — the setup is not yet a real
     *  computer, so the user stays in the dialog to retry. */
    finalizeFailed: t("computers.couldntFinishSettingUp"),

    // ── Lifecycle labels (DTO `status`) ────────────────────────────────
    lifecyclePending: t("computers.waitingForConnection"),
    lifecycleRevoked: t("computers.revoked"),

    // ── Availability labels (realtime) ─────────────────────────────────
    // Single source for the availability/lifecycle words shared across
    // surfaces: `describeHostStatus` (user-managed /status) AND the
    // Desktop→Server pill in `settings/ConnectionPane.tsx` both read these —
    // the Unified Computer model forbids one surface saying "Connected"
    // while another says "Ready" for the same availability fact (Alice §7.1
    // / no source-fork). Words with no availability equivalent (the pill's
    // `Connecting…` attach window) stay literal at their one call site
    // rather than being minted into this lexicon.
    availabilityConnected: t("computers.connected"),
    availabilityOffline: t("computers.offline"),
    availabilityUnreachable: t("computers.unreachable"),

    // ── Target-page Connection section (Phase 2) ───────────────────────
    connectionSectionTitle: t("computers.connection"),
    connectionSectionIntro: t("computers.generateAConnectionCommand"),
    generateCommand: t("computers.generateConnectionCommand"),
    /** Rotate consequence — the previous command dies and the live
     *  connection is dropped. Users must not read rotate as "just fetch
     *  another copy". */
    regenerateWarning: t("computers.generatingANewCommand"),
    rotateFailed: t("computers.couldntGenerateANew"),
    disconnectCurrent: t("computers.disconnectCurrentConnection"),
    /** Disconnect is availability-axis only — reversible, non-destructive.
     *  Copy must make clear the command still works, so it never reads like
     *  revoke. */
    disconnectIntro: t("computers.dropsTheCurrentConnection"),
    disconnectFailed: t("computers.couldntDisconnectThisComputer"),

    // ── Diagnostics (manual copy, #task:1445) ─────────────────────────
    /** Footer utility: copies a redacted, plain-text diagnostics report for
     *  this computer to the clipboard (no upload). The report body is built
     *  by the shared `buildHostDiagnosticsText`; this is the only UI prose. */
    copyDiagnostics: t("computers.copyDiagnostics"),

    // ── Badges ─────────────────────────────────────────────────────────
    appManaged: t("computers.appManaged"),

    // ── Concurrency rejection (target page, Phase 2) ───────────────────
    /** N1: `connected_host_name` may be null before the first `ready`
     *  event lands — never render a bare null. */
    alreadyConnected: (hostname: string | null): string =>
      hostname
        ? t("computers.alreadyConnectedFrom", { hostname })
        : t("computers.thisComputerIsAlready"),

    // ── Delete (user-managed, terminal) ────────────────────────────────
    // The user-managed removal verb (#task:1354; `docs/user-managed-
    // computer-v1.md` §5.3). Distinct from Revoke: Delete is terminal
    // (hard-deletes the row, invalidates the connect-token, subject to
    // dependency check + optional agent cascade). Revoke is soft
    // (`revoked_at` set, credential invalidated, agents/workspaces
    // preserved). The two never share a component, mutation, or copy.
    deleteComputer: t("computers.deleteComputer"),
    deleteConfirmTitle: t("computers.deleteThisComputer"),
    /** The umbrella consequence, and deliberately NOT on the connection axis
     *  (shiki 2026-07-26): the old line led with "its connection command stops
     *  working", which framed a terminal delete as a credential event, said the
     *  same thing whether or not the computer was connected, and buried the part
     *  that actually matters — everything the computer holds goes with it.
     *  Availability wording belongs to Disconnect/Revoke, never here.
     *
     *  Wording is shiki's (2026-07-26). "Associated resources" stays generic on
     *  purpose: the named impact block below lists the agents, so restating that
     *  noun here would duplicate it, and an empty computer would be described by
     *  a list of things that aren't there. Irreversibility rides on
     *  "permanently" — do not re-add a separate "This can't be undone."
     *  sentence beside it. Still accurate after #task:1809: what goes with the
     *  computer is its own agents (homes, DM bytes), and shared workspaces were
     *  never its resources. */
    deleteConfirmBody: t("computers.thisComputerAndIts"),
    deleteConfirm: t("computers.delete"),
    deleting: t("computers.deleting"),
    deleteFailed: t("computers.couldntDeleteThisComputer"),
    /** Shared retry label for the two recoverable delete screens (impact read
     *  failed / an agent is still materializing). */
    deleteRetry: t("computers.tryAgain"),
    /** Agent-cascade impact block (#task:1380). The computer's agents go with it,
     *  so the confirm names them. shiki interaction gate (2026-07-07): the impact
     *  does NOT replace the standard delete copy — it keeps it and adds a
     *  pale-amber block below, headed by this line and followed by the list.
     *  Naming the consequence + showing exactly who is affected carries the
     *  weight; no extra prose. */
    deleteCascadeImpactTitle: t("computers.agentsWillBeRemoved"),
    /** #task:1618 — the impact read (`GET /hosts/:id/resources`) failed. Fail
     *  closed: the dialog offers no Delete at all, because "we couldn't check" is
     *  not "there's nothing on it". Copy says which of the two it is, so the user
     *  doesn't read a missing impact list as an empty computer. */
    deleteImpactUnavailable: t("computers.couldntCheckWhatThis"),
    /** Transient pending-agents block (#task:1380, backend `409
     *  has_pending_agents`). An agent on this computer is still being created —
     *  a state that clears on its own — so this is a wait-and-retry hint, NOT a
     *  cascade confirm or a hard block. shiki copy gate: short, no internal
     *  terms (no "materialize" / "daemon"). */
    deletePendingTitle: t("computers.agentCreationInProgress"),
    deletePendingBody: t("computers.anAgentIsStill"),

    /* ── Proxy ─────────────────────────────────────────────────────── */
    /** Section heading for the per-computer network-proxy editor. */
    proxyTitle: t("computers.networkProxy"),
    /** Offline gate. Proxy config is host-local truth — it can only be read
     *  or written while the computer is connected, so an offline computer
     *  collapses the whole section to this one short line (shiki-frozen copy;
     *  do not expand into "readable but locked" — offline means neither). */
    proxyOfflineHint: t("computers.pleaseConnectFirst"),

    /* ── Refresh credentials (app-managed, current-machine only) ──── */
    /** Section heading. Refresh rotates the backend-issued host token in
     *  local daemon config — token bytes stay in main-process memory and
     *  never enter the renderer. Independent of the user-managed
     *  `Generate connection command` flow; do not merge the copy. */
    refreshCredentialsTitle: t("computers.credentials"),
    refreshCredentialsBody: t("computers.thisComputersConnectionCredentials"),
    refreshCredentials: t("computers.refreshCredentials"),
    refreshingCredentials: t("computers.refreshing"),
    refreshCredentialsSuccess: t("computers.credentialsRefreshed"),
    refreshCredentialsFailed: t("computers.couldntRefreshCredentialsTry"),

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
    revokeComputer: t("computers.revokeComputer"),
    revokeConfirmTitle: t("computers.revokeThisComputer"),
    revokeConfirmFacts: [
      t("computers.theComputerDisconnectsAnd"),
      t("computers.runningAgentsStop"),
      t("computers.agentRecordsWorkspacesAnd"),
    ] as const,
    revokeConfirm: t("computers.revoke"),
    revoking: t("computers.revoking"),
    revokeFailed: t("computers.couldntRevokeThisComputer"),
  }) as const;
