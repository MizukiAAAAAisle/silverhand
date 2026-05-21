/**
 * `DaemonAgentRuntimeHost` — daemon-mode implementation of
 * `AgentRuntimeHost`.
 *
 * # ⚠️ SCAFFOLDING — daemon mode is NOT YET USABLE
 *
 * Sub-commit 2a only ships the dispatch shape and the rollback gate so
 * Electron main can refuse to spawn the daemon in the default
 * `SILVERHAND_RUNTIME_HOST=legacy` mode. Every lifecycle / delivery /
 * run-state method here currently throws a labelled error pointing the
 * operator at the rollback recipe. The real wiring (RuntimeBridge +
 * RunStateCache + RuntimeEventHandler delegations, snapshot-aware
 * `reconcileOnBoot`, `deliverMessage` parity with CM) lands in
 * sub-commit 2b, gated on Cindy's review of the `deliverMessage`
 * parity sub-plan.
 *
 * # Why throws, not no-ops
 *
 * Cindy `0G5uJBydO_4qt_2r`: "daemon mode 对这类未覆盖场景 fail
 * loudly / 明确保留 pending，不能假装 delivered、也不能改变
 * markDelivered 时点." A silent no-op here would silently lose
 * messages / orphan UI state when an operator switches to daemon mode
 * prematurely. A loud throw with the exact rollback command surfaces
 * the misconfiguration immediately.
 *
 * # Default safety
 *
 * The instantiation site (`packages/backend/src/index.ts` boot
 * dispatch) only constructs this class when
 * `SILVERHAND_RUNTIME_HOST=daemon` is set explicitly. The default —
 * unset or `=legacy` — still resolves to `ConversationManager`, which
 * is the canonical, fully-implemented path. Setting daemon mode in
 * this commit is an explicit opt-in to the throw.
 */
import type {
  AgentRunState,
  AgentRunTerminalReason,
} from '@silverhand/shared';
import type { HostClient } from '@silverhand/host';
import type {
  ClearSessionResult,
  StartOptions,
} from '../conversation-manager.js';
import type { AgentRuntimeHost } from './agent-runtime-host.js';
import type { RuntimeBridge } from './bridge.js';
import type { RuntimeEventHandler } from './event-handler.js';
import type { RunStateCache } from './run-state-cache.js';
import { SILVERHAND_RUNTIME_HOST_ENV } from './runtime-host-mode.js';

/**
 * Dependencies for the daemon-mode runtime host. All three commit-4
 * modules are required even in 2a's throw-only shape — the
 * constructor accepts them so 2b's flesh-out is a body-only change,
 * not a signature change.
 */
export interface DaemonAgentRuntimeHostDeps {
  client: HostClient;
  bridge: RuntimeBridge;
  cache: RunStateCache;
  eventHandler: RuntimeEventHandler;
}

/**
 * Standard error message body shared by every not-yet-implemented
 * method. Centralised so the rollback recipe phrasing cannot drift
 * between methods.
 */
function notImplemented(method: string): Error {
  return new Error(
    `${SILVERHAND_RUNTIME_HOST_ENV}=daemon: ${method}() is not yet implemented (sub-commit 2a is dispatch-and-gate scaffolding only). ` +
      `To roll back, restart with ${SILVERHAND_RUNTIME_HOST_ENV}=legacy (or unset the variable). ` +
      `The legacy in-process ConversationManager path remains the canonical, fully-supported runtime.`,
  );
}

/**
 * Daemon-mode runtime host. **All methods throw in 2a** — see file
 * docstring. 2b replaces each body with the real delegation.
 */
export class DaemonAgentRuntimeHost implements AgentRuntimeHost {
  // The deps are held but unused in 2a. Marked readonly so 2b's
  // implementation can rely on stable identity, and prefixed with the
  // underscore convention used elsewhere in the codebase for
  // intentionally-unread-yet-needed-for-future fields would conflict
  // with tooling expectations — instead we just leave them as plain
  // fields and accept the "unused private member" lint until 2b.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly _deps: DaemonAgentRuntimeHostDeps) {}

  // ── lifecycle ───────────────────────────────────────────────────
  async start(
    _conversationId: string,
    _agentId: string,
    _opts?: StartOptions,
  ): Promise<void> {
    throw notImplemented('start');
  }

  async stop(
    _conversationId: string,
    _agentId: string,
    _mode?: 'soft' | 'hard',
    _softDirective?: string,
  ): Promise<void> {
    throw notImplemented('stop');
  }

  async clearSession(
    _conversationId: string,
    _agentId: string,
    _actorUserId?: string | null,
  ): Promise<ClearSessionResult> {
    throw notImplemented('clearSession');
  }

  async stopAll(): Promise<void> {
    throw notImplemented('stopAll');
  }

  async closeActivityLog(): Promise<void> {
    throw notImplemented('closeActivityLog');
  }

  // ── delivery ────────────────────────────────────────────────────
  async deliverMessage(
    _conversationId: string,
    _agentId: string,
    _messageId: string,
  ): Promise<void> {
    throw notImplemented('deliverMessage');
  }

  // ── boot recovery ───────────────────────────────────────────────
  reconcileOnBoot(): void {
    throw notImplemented('reconcileOnBoot');
  }

  // ── run-state surface ───────────────────────────────────────────
  getAgentRunStates(_conversationId: string): AgentRunState[] {
    throw notImplemented('getAgentRunStates');
  }

  resolveRun(
    _conversationId: string,
    _agentId: string,
    _reason: AgentRunTerminalReason,
    _runId?: string,
  ): void {
    throw notImplemented('resolveRun');
  }

  resolveConversationRuns(
    _conversationId: string,
    _reason?: AgentRunTerminalReason,
  ): void {
    throw notImplemented('resolveConversationRuns');
  }
}
