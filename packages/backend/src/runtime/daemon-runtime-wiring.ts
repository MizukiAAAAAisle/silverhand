import type { Database } from 'better-sqlite3';
import type { HostClient } from '@silverhand/host';
import type { BackendContext, BackendLogger, SilverhandCliLauncher } from '../context.js';
import { AgentRepo } from '../repos/agent-repo.js';
import { ConversationInboxRepo } from '../repos/conversation-inbox-repo.js';
import { ConversationRepo } from '../repos/conversation-repo.js';
import { MessageRepo } from '../repos/message-repo.js';
import { SETTINGS_KEYS, SettingsRepo } from '../repos/settings-repo.js';
import { UserRepo } from '../repos/user-repo.js';
import { WorkspaceRepo } from '../repos/workspace-repo.js';
import { MembershipService } from '../services/membership-service.js';
import { JsonlActivityLogWriter } from './activity-log-writer.js';
import type { AgentRuntimeHost } from './agent-runtime-host.js';
import { DaemonAgentRuntimeHost } from './daemon-agent-runtime-host.js';
import { RuntimeDeliveryCoordinator } from './delivery-coordinator.js';
import { RuntimeEventHandler, type InboxAckSink } from './event-handler.js';
import { RuntimeBridge } from './bridge.js';
import { RunStateCache } from './run-state-cache.js';
import { DbRuntimeStatusProjector } from './status-projector.js';
import { combineGatedBatch } from './stdin-format.js';

export interface CreateDaemonRuntimeHostOptions {
  ctx: BackendContext;
  db: Database;
  hostClient: HostClient;
  logger: BackendLogger;
  silverhandDir: string;
  workspacesRoot: string;
  silverhandCliLauncher: SilverhandCliLauncher;
}

export function createDaemonRuntimeHost(
  opts: CreateDaemonRuntimeHostOptions,
): AgentRuntimeHost {
  const { ctx, db, hostClient, logger, workspacesRoot } = opts;
  const bridge = new RuntimeBridge(hostClient);
  const cache = new RunStateCache();
  const activityLog = new JsonlActivityLogWriter({
    logDir: ctx.logDir,
    logger,
  });
  const inboxRepo = new ConversationInboxRepo(db);
  const settings = new SettingsRepo(db);
  const inboxAck: InboxAckSink = {
    markDelivered: (deliveryIds: readonly number[]) =>
      inboxRepo.markDelivered([...deliveryIds]),
    markUndelivered: () => {},
  };
  const coordinator = new RuntimeDeliveryCoordinator({
    bridge: {
      runtimeWake: params => hostClient.runtimeWake(params),
    },
    cache,
    inboxAck,
    callbacks: {
      respawn: (cid, aid) => ctx.runtimeHost.start(cid, aid),
      hasPendingInbox: (cid, aid) =>
        inboxRepo.listPending(cid, aid).length > 0,
      // `combineGated` is invoked with UN-ENCODED message texts BEFORE
      // the per-driver encode step. The lifted helper keeps daemon
      // mode byte-identical to the original CM stdin formatter.
      combineGated: texts =>
        combineGatedBatch(texts, 'silverhand message send'),
      publishActivity: state => {
        ctx.events.publish(state.conversationId, {
          kind: 'agent_activity',
          payload: state,
        });
        activityLog.write(state);
      },
    },
    logger: {
      info: (meta, msg) => logger.info(meta, msg),
      warn: (meta, msg) => logger.warn(meta, msg),
      error: (meta, msg) => logger.error(meta, msg),
    },
  });
  const eventHandler = new RuntimeEventHandler({
    client: hostClient,
    bridge,
    cache,
    events: ctx.events,
    inboxAck,
    statusProjector: new DbRuntimeStatusProjector(
      new ConversationRepo(db),
      ctx.events,
    ),
    onParsedEvent: (cid, aid, ev) =>
      coordinator.onParsedEvent(cid, aid, ev),
    onRuntimeExit: (cid, aid, meta) =>
      coordinator.onRuntimeExit(cid, aid, meta),
    onInitTimeout: (cid, aid) =>
      coordinator.clearWakeWatchdog(cid, aid, 'timeout'),
    activityLog,
    onReadyForDrain: (cid, aid) => {
      const host = daemonHostRef;
      if (!host) {
        logger.warn(
          { kind: 'runtime', conversationId: cid, agent_id: aid },
          'drain: ready_for_drain fired before DaemonHost wired; skipping',
        );
        return;
      }
      return host.drainPending(cid, aid);
    },
    logger,
  });
  let daemonHostRef: DaemonAgentRuntimeHost | null = null;
  const runtimeHost = new DaemonAgentRuntimeHost({
    client: hostClient,
    bridge,
    cache,
    eventHandler,
    events: ctx.events,
    conversations: new ConversationRepo(db),
    agents: new AgentRepo(db),
    messages: new MessageRepo(db),
    inboxes: inboxRepo,
    users: new UserRepo(db),
    coordinator,
    workspaces: new WorkspaceRepo(db, { workspacesRoot }),
    placement: ctx.placement,
    membership: new MembershipService({
      agents: new AgentRepo(db),
      users: new UserRepo(db),
      conversations: new ConversationRepo(db),
    }),
    silverhandDir: opts.silverhandDir,
    silverhandCli: opts.silverhandCliLauncher,
    agentTokens: ctx.agentTokens,
    proxyPolicy: () => ({
      url: settings.get(SETTINGS_KEYS.PROXY_URL),
      allowlist: settings.getProxyRuntimes(),
    }),
    // serverConfig is read fresh on every start() so it picks up the
    // bound port after the Hono server listens (ctx.serverConfig is
    // mutated mid-boot from placeholder to the real URL).
    serverConfig: () => ctx.serverConfig,
    activityLog,
    db,
    logger,
  });
  daemonHostRef = runtimeHost;
  return runtimeHost;
}
