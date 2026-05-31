/**
 * In-memory intent dispatcher.
 *
 * Split from socket transport so:
 *
 *  - Unit tests can drive `dispatch(intent, params)` with raw JSON
 *    and assert the typed response without spinning up `node:net`.
 *  - PR-2 can slot in `runtime_*` handlers here without touching the
 *    socket loop.
 *
 * The dispatcher owns:
 *
 *  - The daemon's `started_at` (set on construction, surfaced via
 *    `ping` / `status`)
 *  - `intent_count` — number of intents handled this lifetime, used
 *    by reconnect tests to assert "second batch actually re-issued".
 *  - `shuttingDown` flag — once set, every further intent returns
 *    `{ code: 'shutting_down' }` instead of executing the handler.
 *
 * It does NOT own:
 *
 *  - The socket. The transport layer (server.ts) calls `dispatch` per
 *    decoded frame and writes the returned `ResponseFrame` back.
 *  - The pid file or signal handlers (lifecycle.ts).
 *  - Logging policy. The transport hands a logger in via the ctor; the
 *    dispatcher only logs errors that handlers throw.
 */
import {
  type HelloResult,
  intentErrorSchema,
  intentSchemas,
  type AgentMaterializeParams,
  type AgentMaterializeResult,
  type AgentWorkspaceIndexParams,
  type AgentWorkspaceIndexResult,
  type AgentWorkspaceReadParams,
  type AgentWorkspaceReadResult,
  type ConversationLogDebugParams,
  type HostOutboundAttachParams,
  type HostOutboundAttachResult,
  type HostOutboundDetachResult,
  type HostOutboundReloadResult,
  type IntentName,
  type ResponseError,
  type ResponseFrame,
  type RuntimeClearSessionParams,
  type RuntimeCloseActivityLogParams,
  type RuntimeOutputPauseParams,
  type RuntimeOutputResumeParams,
  type RuntimeStartParams,
  type RuntimeStatusParams,
  type RuntimeStopAllParams,
  type RuntimeStopParams,
  type RuntimeWakeParams,
  type WorkspaceProvisionParams,
  type WorkspaceProvisionResult,
} from '../protocol.js';
import { DAEMON_VERSION, createDaemonHelloResult } from './version.js';
import type { DaemonLogger } from './logger.js';
import type { SupervisorContract } from './supervisor-contract.js';
import { logIntent } from './daemon-logging.js';
import { DaemonTypedError } from './typed-error.js';

export interface DispatcherOptions {
  logger: DaemonLogger;
  /** Epoch ms; injected so tests can pin time. Default: Date.now(). */
  startedAt?: number;
  /** Epoch ms supplier; injected so tests can pin time. Default: Date.now. */
  now?: () => number;
  /** Daemon hello payload bound to this daemon process generation. */
  helloResult?: HelloResult;
  /**
   * SupervisorContract backing the runtime_* intents. `null` keeps the
   * protocol-only PR-1 surface for tests; production wires the
   * concrete `Supervisor`.
   */
  supervisor?: SupervisorContract;
  /**
   * Stage D3.a Commit 3 — handler for the `host_outbound_attach`
   * intent. The daemon's `OutboundSupervisor.attach` is the
   * production wiring; tests pass a stub. `undefined` means the
   * intent is not wired and the dispatcher throws (translated to
   * `internal_error` by the catch arm). This shape mirrors the
   * `supervisor` field rather than passing the supervisor object
   * directly so the dispatcher stays free of `OutboundSupervisor`'s
   * concrete dependencies (filesystem, ws, etc.).
   */
  hostOutboundAttachHandler?: (
    params: HostOutboundAttachParams,
  ) => HostOutboundAttachResult | Promise<HostOutboundAttachResult>;
  /**
   * Stage D3.b Commit 3 — handler for the `host_outbound_detach`
   * intent. Production wiring: `OutboundSupervisor.detach`. Mirrors
   * the `hostOutboundAttachHandler` slot pattern so the dispatcher
   * stays free of supervisor concrete dependencies. `undefined`
   * means the intent is not wired and the dispatcher throws
   * (translated to `internal_error` by the catch arm).
   */
  hostOutboundDetachHandler?: () =>
    | HostOutboundDetachResult
    | Promise<HostOutboundDetachResult>;
  /**
   * Stage D3.c Commit 2 — handler for the `host_outbound_reload`
   * intent. Production wiring: `OutboundSupervisor.reload`. Same
   * slot pattern as attach/detach so the dispatcher stays free of
   * supervisor concrete dependencies. Reload is a daemon-control
   * intent (not a runtime_* intent), so it has its own slot.
   * `undefined` means the intent is not wired and the dispatcher
   * throws (translated to `internal_error` by the catch arm).
   */
  hostOutboundReloadHandler?: () =>
    | HostOutboundReloadResult
    | Promise<HostOutboundReloadResult>;
  /**
   * D4.d D2 — handler for the `agent_materialize` intent. Unlike
   * the runtime_* family (local supervisor / control) and the
   * host_outbound_* family (transport plumbing), agent_materialize
   * is formal server↔daemon semantics: the server asks the
   * daemon-owning host to seed an agent's L1 home dir. Production
   * wiring: `materializeAgent` from
   * `./agent-materialize/handler.ts`. Tests pass a stub.
   *
   * `undefined` means the slot is not wired and the dispatcher
   * throws (translated to `internal_error` by the catch arm), same
   * pattern as the host_outbound_* slots.
   *
   * Typed error preservation (Cindy D2 pre-gate #3): the handler
   * may throw `AgentMaterializeError` carrying a typed code
   * (`fs_quota_exceeded` / `fs_unavailable` / `agent_dir_collision`
   * / `unsupported_template` / `unsupported_runtime` /
   * `internal_error`). The dispatcher's `DaemonTypedError` catch arm
   * recognises it and emits the typed code on the wire instead of
   * collapsing to `internal_error` — but only after re-validating
   * the code against `intentErrorSchema(intent)`, so the typed
   * surface stays decided by protocol schema, not the class. The
   * outbound layer's per-command error schema
   * (`AgentMaterializeWireErrorSchema`) already permits this widened
   * code set; the D4.e workspace intents (`workspace_provision` /
   * `agent_workspace_index`) are likewise typed, while
   * runtime/default commands keep the narrow `ResponseError` enum.
   */
  agentMaterializeHandler?: (
    params: AgentMaterializeParams,
  ) => AgentMaterializeResult | Promise<AgentMaterializeResult>;
  /**
   * D4.e-1 — handler for `workspace_provision`. Like agent_materialize,
   * this is server↔daemon formal data-plane semantics: the server asks
   * the daemon to bind a regular workspace into its local registry and
   * create the `.silverhand/` skeleton. Production wiring:
   * `provisionWorkspace` from `./workspace-registry/`. Typed errors
   * (`WorkspaceProvisionError`) are projected with their code by the
   * catch arm after per-intent schema validation. `undefined` → the
   * dispatcher throws (→ `internal_error`).
   */
  workspaceProvisionHandler?: (
    params: WorkspaceProvisionParams,
  ) => WorkspaceProvisionResult | Promise<WorkspaceProvisionResult>;
  /**
   * D4.e-1 — handler for `agent_workspace_index` (route-time `agent_dir`
   * resolver). Production wiring: `indexAgentWorkspaces`. Typed errors
   * (`AgentWorkspaceIndexError`) projected as above. `undefined` → the
   * dispatcher throws (→ `internal_error`).
   */
  agentWorkspaceIndexHandler?: (
    params: AgentWorkspaceIndexParams,
  ) => AgentWorkspaceIndexResult | Promise<AgentWorkspaceIndexResult>;
  /**
   * D4.e-2 — handler for `agent_workspace_read` (host-local L1/agent-home
   * read proxy for `GET /api/agents/:id/workspace`). Production wiring:
   * `readAgentWorkspace`. Typed errors (`AgentWorkspaceReadError`) are
   * projected with their code by the catch arm after per-intent schema
   * validation. `undefined` → the dispatcher throws (→ `internal_error`).
   */
  agentWorkspaceReadHandler?: (
    params: AgentWorkspaceReadParams,
  ) => AgentWorkspaceReadResult | Promise<AgentWorkspaceReadResult>;
}

export class IntentDispatcher {
  private readonly logger: DaemonLogger;
  private readonly startedAt: number;
  private readonly now: () => number;
  private readonly helloResult: HelloResult;
  private readonly supervisor: SupervisorContract | undefined;
  private readonly hostOutboundAttachHandler:
    | ((
        params: HostOutboundAttachParams,
      ) => HostOutboundAttachResult | Promise<HostOutboundAttachResult>)
    | undefined;
  private readonly hostOutboundDetachHandler:
    | (() => HostOutboundDetachResult | Promise<HostOutboundDetachResult>)
    | undefined;
  private readonly hostOutboundReloadHandler:
    | (() => HostOutboundReloadResult | Promise<HostOutboundReloadResult>)
    | undefined;
  private readonly agentMaterializeHandler:
    | ((
        params: AgentMaterializeParams,
      ) => AgentMaterializeResult | Promise<AgentMaterializeResult>)
    | undefined;
  private readonly workspaceProvisionHandler:
    | ((
        params: WorkspaceProvisionParams,
      ) => WorkspaceProvisionResult | Promise<WorkspaceProvisionResult>)
    | undefined;
  private readonly agentWorkspaceIndexHandler:
    | ((
        params: AgentWorkspaceIndexParams,
      ) => AgentWorkspaceIndexResult | Promise<AgentWorkspaceIndexResult>)
    | undefined;
  private readonly agentWorkspaceReadHandler:
    | ((
        params: AgentWorkspaceReadParams,
      ) => AgentWorkspaceReadResult | Promise<AgentWorkspaceReadResult>)
    | undefined;
  private intentCount = 0;
  private shuttingDown = false;

  constructor(opts: DispatcherOptions) {
    this.logger = opts.logger;
    this.now = opts.now ?? Date.now;
    this.startedAt = opts.startedAt ?? this.now();
    // The fallback `helloResult` exists for the protocol-only test
    // matrix where the dispatcher is exercised in isolation. Prod
    // wiring goes through `runDaemon`, which always passes a fully
    // materialised `helloResult` (real `instance_id`, real identity).
    // `'__test_instance__'` is the grep-friendly sentinel — if it
    // ever shows up on the wire in prod logs, something forgot to
    // pass `helloResult`.
    this.helloResult =
      opts.helloResult ?? createDaemonHelloResult('__test_instance__');
    this.supervisor = opts.supervisor;
    this.hostOutboundAttachHandler = opts.hostOutboundAttachHandler;
    this.hostOutboundDetachHandler = opts.hostOutboundDetachHandler;
    this.hostOutboundReloadHandler = opts.hostOutboundReloadHandler;
    this.agentMaterializeHandler = opts.agentMaterializeHandler;
    this.workspaceProvisionHandler = opts.workspaceProvisionHandler;
    this.agentWorkspaceIndexHandler = opts.agentWorkspaceIndexHandler;
    this.agentWorkspaceReadHandler = opts.agentWorkspaceReadHandler;
  }

  /** Signal that subsequent intents should be rejected with
   *  `shutting_down`. Idempotent. */
  markShuttingDown(): void {
    this.shuttingDown = true;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  getStartedAt(): number {
    return this.startedAt;
  }

  getIntentCount(): number {
    return this.intentCount;
  }

  getHelloResult(): HelloResult {
    return {
      ...this.helloResult,
      host_descriptor: { ...this.helloResult.host_descriptor },
      capabilities: [...this.helloResult.capabilities],
    };
  }

  /**
   * Dispatch a single intent. Always returns a well-formed
   * `ResponseFrame` — never throws. Handlers that throw are caught
   * and projected as `internal_error`; the caller writes the frame
   * to the socket as-is.
   */
  async dispatch(
    requestId: string,
    intent: string,
    rawParams: unknown,
  ): Promise<ResponseFrame> {
    const startedAtMs = this.now();
    // Extract conversationId / agent_id from params (when present) for the log
    // line — strictly read-only, never modifies params. Other fields
    // (notably `payload`) MUST NOT be logged per §3.4.
    const convId =
      typeof rawParams === 'object' && rawParams !== null && 'conversation_id' in rawParams
        ? String((rawParams as { conversation_id: unknown }).conversation_id)
        : undefined;
    const agentId =
      typeof rawParams === 'object' && rawParams !== null && 'agent_id' in rawParams
        ? String((rawParams as { agent_id: unknown }).agent_id)
        : undefined;
    logIntent(this.logger, {
      intent,
      request_id: requestId,
      status: 'received',
      conversationId: convId,
      agent_id: agentId,
    });
    const finish = (frame: ResponseFrame): ResponseFrame => {
      const isError = 'error' in frame;
      logIntent(this.logger, {
        intent,
        request_id: requestId,
        status: isError ? 'error' : 'ok',
        conversationId: convId,
        agent_id: agentId,
        error_code: isError ? frame.error.code : undefined,
        duration_ms: this.now() - startedAtMs,
      });
      return frame;
    };
    if (this.shuttingDown) {
      return finish(
        this.errorFrame(requestId, {
          code: 'shutting_down',
          message: 'daemon is shutting down',
        }),
      );
    }
    const schema = intentSchemas[intent as IntentName];
    if (!schema) {
      return finish(
        this.errorFrame(requestId, {
          code: 'unknown_intent',
          message: `unknown intent: ${intent}`,
        }),
      );
    }
    const parsed = schema.params.safeParse(rawParams);
    if (!parsed.success) {
      return finish(
        this.errorFrame(requestId, {
          code: 'invalid_params',
          message: parsed.error.errors
            .map(e => `${e.path.join('.')}: ${e.message}`)
            .join('; '),
        }),
      );
    }
    this.intentCount += 1;
    try {
      const result = await this.runHandler(intent as IntentName, parsed.data);
      // Validate the handler's own result against the declared schema
      // BEFORE sending it on the wire. If a handler ever drifts from
      // the contract (e.g. a refactor accidentally drops a field, or
      // the schema gets tightened without updating the handler), we
      // want to catch it at the IPC boundary on the *daemon* side
      // rather than ship malformed bytes the client has to puzzle out.
      //
      // The mirror check on the client (HostClient.handleFrame) is a
      // second line of defense against version skew between a newer
      // daemon and older client (or vice versa).
      const resultValidated = schema.result.safeParse(result);
      if (!resultValidated.success) {
        this.logger.error(
          {
            intent,
            issues: resultValidated.error.errors
              .map(e => `${e.path.join('.')}: ${e.message}`)
              .join('; '),
          },
          'daemon emitted result that does not match schema',
        );
        return finish(
          this.errorFrame(requestId, {
            code: 'internal_error',
            message: `daemon result drift for intent ${intent}`,
          }),
        );
      }
      return finish({ id: requestId, result: resultValidated.data });
    } catch (err) {
      // D4.d D2 (Cindy pre-gate #3 + P1-1): preserve typed daemon-
      // business errors from `agent_materialize` (fs_quota_exceeded
      // / fs_unavailable / agent_dir_collision / unsupported_template
      // / unsupported_runtime / internal_error). Without this branch
      // the catch arm below would squash all six codes into
      // `internal_error`, which would lose the recoverable /
      // unrecoverable / collision distinction the route layer needs
      // to decide retry / 503 / 507 / 409.
      //
      // P1-1 closes the loop on the EMITTING side too: the typed
      // code is validated against `intentErrorSchema(intent)` before
      // being put on the wire, so a handler that drifts (throws a
      // code the intent's error taxonomy doesn't cover) still gets
      // surfaced as `internal_error` — preventing daemon-side drift
      // from reaching the wire as it did during the bare-cast era.
      // D4.d D2 / D4.e-1: preserve typed daemon-business errors thrown by
      // a handler (any `DaemonTypedError` subclass: AgentMaterializeError,
      // WorkspaceProvisionError, AgentWorkspaceIndexError). Without this
      // branch the generic catch below would squash the typed code into
      // `internal_error`, losing the recoverable / unrecoverable /
      // collision / unresolved distinctions the route layer needs.
      //
      // Boundary (Cindy): the base class does NOT decide the typed
      // surface — the code is validated against `intentErrorSchema(intent)`
      // before going on the wire, so a code that is not in the dispatching
      // intent's error taxonomy still collapses to `internal_error`. This
      // keeps the wire-error scope per-intent: only intents whose schema
      // widens (agent_materialize / workspace_provision /
      // agent_workspace_index) can carry their typed codes; a runtime_*
      // intent (defaulting to the 5 generic codes) rejects any foreign
      // typed code here.
      if (err instanceof DaemonTypedError) {
        const errorSchema = intentErrorSchema(intent as IntentName);
        const validated = errorSchema.safeParse({
          code: err.code,
          message: err.message,
        });
        if (validated.success) {
          this.logger.warn(
            {
              intent,
              err: err.message,
              code: err.code,
            },
            'intent handler returned typed error',
          );
          return finish(this.typedErrorFrame(requestId, err.code, err.message));
        }
        this.logger.error(
          {
            intent,
            err: err.message,
            code: err.code,
            issues: validated.error.errors
              .map(e => `${e.path.join('.')}: ${e.message}`)
              .join('; '),
          },
          'intent handler returned a code not in its IPC error taxonomy; emitting internal_error',
        );
        return finish(
          this.errorFrame(requestId, {
            code: 'internal_error',
            message: `drift: code "${err.code}" not in ${intent} error taxonomy`,
          }),
        );
      }
      this.logger.error(
        {
          intent,
          err: err instanceof Error ? err.message : String(err),
        },
        'intent handler threw',
      );
      return finish(
        this.errorFrame(requestId, {
          code: 'internal_error',
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  private errorFrame(id: string, error: ResponseError): ResponseFrame {
    return { id, error };
  }

  /**
   * Build an error frame carrying a typed code that is NOT in the
   * standard `ResponseError` enum. The IPC `ResponseFrame` type
   * narrows `error.code` to the 5 generic codes; this helper
   * bypasses that narrowing so daemon-business typed codes
   * (the `AgentMaterializeErrorCode` values plus the D4.e
   * `WorkspaceProvisionErrorCode` / `AgentWorkspaceIndexErrorCode`
   * values) can travel through to:
   *   - The outbound WS layer, which validates them against the
   *     wider per-command wire error schema for that intent.
   *   - The local IPC transport, which uses `LooseAnyFrameSchema`
   *     so the typed code is not dropped at frame-decode time.
   *     `HostClient.handleFrame` then validates the code against
   *     `intentErrorSchema(intent)` and surfaces a typed
   *     `HostClientError` (Cindy D2 P1-1).
   *
   * The cast is honest: this helper IS the place the typed
   * widening happens. The caller side has already validated the
   * code against the per-intent error schema, so we know it's
   * legitimate within the per-intent contract.
   */
  private typedErrorFrame(
    id: string,
    code: string,
    message: string,
  ): ResponseFrame {
    return {
      id,
      error: { code, message } as unknown as ResponseError,
    };
  }

  /**
   * Per-intent business logic. PR-1's lifecycle intents
   * (ping / status / echo) are handled inline; PR-2's runtime_*
   * intents are routed to the injected `SupervisorContract` when one is
   * provided, and reported as `unknown_intent` (via the schema
   * registry already rejecting unknown names) when no supervisor
   * is wired — that keeps backward-compatibility with PR-1 tests
   * that construct a dispatcher without a supervisor.
   *
   * `protected` so a test-only subclass can override one intent's
   * output to verify the result-drift guard in `dispatch()` (without
   * monkey-patching production code). Production callers go through
   * `dispatch()` and never see this method directly.
   */
  protected async runHandler(
    intent: IntentName,
    params: unknown,
  ): Promise<unknown> {
    switch (intent) {
      case 'hello':
        return this.getHelloResult();
      case 'ping':
        return {
          pong: true as const,
          daemon_pid: process.pid,
          daemon_version: DAEMON_VERSION,
          started_at: this.startedAt,
        };
      case 'status':
        return {
          daemon_pid: process.pid,
          daemon_version: DAEMON_VERSION,
          started_at: this.startedAt,
          uptime_ms: this.now() - this.startedAt,
          intent_count: this.intentCount,
          runtimes: this.supervisor
            ? (await this.supervisor.status({})).runtimes
            : [],
        };
      case 'echo': {
        const p = params as { message: string };
        return { echoed: p.message };
      }
      case 'conversation_log_debug': {
        const p = params as ConversationLogDebugParams;
        if (p.enabled) {
          this.logger.logControl.enableConversationDebug(p.conversation_id, p.expires_at);
          return { ok: true, enabled: true, expires_at: p.expires_at };
        }
        this.logger.logControl.disableConversationDebug(p.conversation_id);
        return { ok: true, enabled: false, expires_at: null };
      }
      // ── runtime_* family ────────────────────────────────────────
      // Each case below requires `this.supervisor` to be set; when
      // it isn't, we throw — `dispatch()` catches and projects as
      // `internal_error`. Production daemons always wire a
      // supervisor, so this is only reachable via misconfigured
      // test setups.
      case 'runtime_start':
        return this.requireSupervisor().start(params as RuntimeStartParams);
      case 'runtime_stop':
        return this.requireSupervisor().stop(params as RuntimeStopParams);
      case 'runtime_wake':
        return this.requireSupervisor().wake(params as RuntimeWakeParams);
      case 'runtime_status':
        return this.requireSupervisor().status(
          params as RuntimeStatusParams,
        );
      case 'runtime_clear_session':
        return this.requireSupervisor().clearSession(
          params as RuntimeClearSessionParams,
        );
      case 'runtime_stop_all':
        return this.requireSupervisor().stopAll(
          params as RuntimeStopAllParams,
        );
      case 'runtime_close_activity_log':
        return this.requireSupervisor().closeActivityLog(
          params as RuntimeCloseActivityLogParams,
        );
      // ── output flow control ─────────────────────────────────────
      // Cindy `_YD0KJF-YAQXlcki`: route through the SupervisorContract
      // interface instead of emitting from the dispatcher. The
      // concrete supervisor owns both flow-control state and the
      // `runtime_output_paused` / `_resumed` ack event.
      case 'runtime_output_pause':
        return this.requireSupervisor().pauseOutput(
          params as RuntimeOutputPauseParams,
        );
      case 'runtime_output_resume':
        return this.requireSupervisor().resumeOutput(
          params as RuntimeOutputResumeParams,
        );
      case 'host_outbound_attach':
        // Late-attach is a daemon-control intent, not a runtime_*
        // intent, so it has its own handler slot. When a daemon is
        // launched in the protocol-only test surface no handler is
        // wired; the require helper throws, the catch arm in
        // `dispatch()` projects that as `internal_error`.
        return this.requireHostOutboundAttachHandler()(
          params as HostOutboundAttachParams,
        );
      case 'host_outbound_detach':
        // Detach is the symmetric daemon-control intent. No params
        // (validated to `{}` by the schema before reaching here).
        // Same protocol-only-surface caveat as attach.
        return this.requireHostOutboundDetachHandler()();
      case 'host_outbound_reload':
        // Reload is the third daemon-control intent (D3.c Commit 2).
        // No params — daemon re-reads its currently-attached
        // configPath. Hard-rejects `not_attached` via a typed result
        // arm, not via `ResponseError` (business state vs transport).
        return this.requireHostOutboundReloadHandler()();
      case 'agent_materialize':
        // D4.d D2 — server↔daemon formal semantics. The slot is
        // wired by `runDaemon` to `materializeAgent` from
        // `./agent-materialize/handler.ts`. Typed errors thrown by
        // the handler (AgentMaterializeError) are caught in
        // `dispatch()` and projected with their typed code; other
        // throws still flow through the generic `internal_error`
        // path.
        return this.requireAgentMaterializeHandler()(
          params as AgentMaterializeParams,
        );
      case 'workspace_provision':
        // D4.e-1 — server↔daemon data-plane. Slot wired by `runDaemon`
        // to `provisionWorkspace`. Typed errors (WorkspaceProvisionError)
        // are projected by the DaemonTypedError catch arm.
        return this.requireWorkspaceProvisionHandler()(
          params as WorkspaceProvisionParams,
        );
      case 'agent_workspace_index':
        // D4.e-1 — route-time agent_dir resolver. Slot wired to
        // `indexAgentWorkspaces`.
        return this.requireAgentWorkspaceIndexHandler()(
          params as AgentWorkspaceIndexParams,
        );
      case 'agent_workspace_read':
        // D4.e-2 — host-local L1/agent-home read proxy. Slot wired to
        // `readAgentWorkspace`. Typed errors (AgentWorkspaceReadError)
        // are projected by the DaemonTypedError catch arm.
        return this.requireAgentWorkspaceReadHandler()(
          params as AgentWorkspaceReadParams,
        );
    }
  }

  /** Internal helper for runtime_* handlers. Throws a typed error
   *  the dispatcher's catch arm will project as `internal_error`. */
  private requireSupervisor(): SupervisorContract {
    if (!this.supervisor) {
      throw new Error(
        'runtime_* intent reached dispatcher with no supervisor wired',
      );
    }
    return this.supervisor;
  }

  private requireHostOutboundAttachHandler(): (
    params: HostOutboundAttachParams,
  ) => HostOutboundAttachResult | Promise<HostOutboundAttachResult> {
    if (!this.hostOutboundAttachHandler) {
      throw new Error(
        'host_outbound_attach intent reached dispatcher with no handler wired',
      );
    }
    return this.hostOutboundAttachHandler;
  }

  private requireHostOutboundDetachHandler(): () =>
    | HostOutboundDetachResult
    | Promise<HostOutboundDetachResult> {
    if (!this.hostOutboundDetachHandler) {
      throw new Error(
        'host_outbound_detach intent reached dispatcher with no handler wired',
      );
    }
    return this.hostOutboundDetachHandler;
  }

  private requireHostOutboundReloadHandler(): () =>
    | HostOutboundReloadResult
    | Promise<HostOutboundReloadResult> {
    if (!this.hostOutboundReloadHandler) {
      throw new Error(
        'host_outbound_reload intent reached dispatcher with no handler wired',
      );
    }
    return this.hostOutboundReloadHandler;
  }

  private requireAgentMaterializeHandler(): (
    params: AgentMaterializeParams,
  ) => AgentMaterializeResult | Promise<AgentMaterializeResult> {
    if (!this.agentMaterializeHandler) {
      throw new Error(
        'agent_materialize intent reached dispatcher with no handler wired',
      );
    }
    return this.agentMaterializeHandler;
  }

  private requireWorkspaceProvisionHandler(): (
    params: WorkspaceProvisionParams,
  ) => WorkspaceProvisionResult | Promise<WorkspaceProvisionResult> {
    if (!this.workspaceProvisionHandler) {
      throw new Error(
        'workspace_provision intent reached dispatcher with no handler wired',
      );
    }
    return this.workspaceProvisionHandler;
  }

  private requireAgentWorkspaceIndexHandler(): (
    params: AgentWorkspaceIndexParams,
  ) => AgentWorkspaceIndexResult | Promise<AgentWorkspaceIndexResult> {
    if (!this.agentWorkspaceIndexHandler) {
      throw new Error(
        'agent_workspace_index intent reached dispatcher with no handler wired',
      );
    }
    return this.agentWorkspaceIndexHandler;
  }

  private requireAgentWorkspaceReadHandler(): (
    params: AgentWorkspaceReadParams,
  ) => AgentWorkspaceReadResult | Promise<AgentWorkspaceReadResult> {
    if (!this.agentWorkspaceReadHandler) {
      throw new Error(
        'agent_workspace_read intent reached dispatcher with no handler wired',
      );
    }
    return this.agentWorkspaceReadHandler;
  }
}
