/**
 * #task:1983 W2 — the read side's assembly point.
 *
 * Every module under `read-model/` projects rows for one surface and needs
 * nothing but the connection to do it. Before this file each of them took the
 * whole `BackendContext` per call and reached for `ctx.db`, which made a pure
 * projection look like it could touch the runtime host, the event bus or the
 * logger — and it is what kept `BackendContext.db` alive as an ambient
 * capability (W5 deletes that field).
 *
 * So the handle is bound HERE, once, at composition time. Route modules declare
 * the individual read model they use in their existing `*RouteDeps`; nothing
 * below the composition root takes `BackendReadModels` as a whole, for the same
 * reason nothing takes `BackendPersistence` as a whole — a handler holding the
 * bag can read surfaces it never declared.
 *
 * This file is a SUB-composition, not a second root: it is reached only from
 * `persistence/root.ts`, exactly like `repos/conversation-persistence.ts` and
 * `repos/task-persistence.ts`. That is why its driver-import ledger zone is
 * `repository` and not `composition` — the `composition` zone is pinned to the
 * single root by the cardinality assertion in `import-ratchet.test.ts`.
 *
 * `host-resources.ts` is deliberately absent: it projects from an `AgentRepo`
 * and never had a query of its own, so there is no handle to bind.
 */
import type { Database as Db } from 'better-sqlite3';

import { createActivityReadModel, type ActivityReadModel } from './activity.js';
import { createAgentReadModel, type AgentReadModel } from './agent-read.js';
import {
  createAgentAuditChatsReadModel,
  type AgentAuditChatsReadModel,
} from './agent-audit-chats.js';
import {
  createDirectPairsReadModel,
  type DirectPairsReadModel,
} from './direct-pairs.js';
import {
  createFavoritesReadModel,
  type FavoritesReadModel,
} from './favorites.js';
import {
  createMessageReactionsReadModel,
  type MessageReactionsReadModel,
} from './message-reactions.js';

export interface BackendReadModels {
  /** `GET /api/activity` (§13.2 assembly over the registered sources). */
  readonly activity: ActivityReadModel;
  /** The agent-facing history / channel-list / search projections. */
  readonly agent: AgentReadModel;
  /** `GET /api/agents/:id/chats` — the owner-audit list of the agent's chats
   *  (#task:2036 part ②). Owner-only, read-only; distinct from `agent`, which is
   *  the AGENT's own runtime read faces. */
  readonly agentAuditChats: AgentAuditChatsReadModel;
  /** `GET /api/direct-pairs` — the viewer's existing DM lines (#task:2035).
   *  Viewer-scoped and workspace-free, because a `direct_pair` has no workspace
   *  coordinate to list it under. */
  readonly directPairs: DirectPairsReadModel;
  /** `GET /api/favorites` — the viewer's flat starred list + ordering state. */
  readonly favorites: FavoritesReadModel;
  /** Reaction aggregates for a message window + the lazy reactor detail. */
  readonly reactions: MessageReactionsReadModel;
}

export function createReadModels(db: Db): BackendReadModels {
  return {
    activity: createActivityReadModel(db),
    agent: createAgentReadModel(db),
    agentAuditChats: createAgentAuditChatsReadModel(db),
    directPairs: createDirectPairsReadModel(db),
    favorites: createFavoritesReadModel(db),
    reactions: createMessageReactionsReadModel(db),
  };
}
