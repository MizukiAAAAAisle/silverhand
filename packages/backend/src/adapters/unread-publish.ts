// Post-commit unread publication adapter (#task:1981). The named place where
// the `unread_updated` + tiered-badge effect gets its raw DB access, so no
// application service has to hold one to publish.
//
// This is deliberately NOT part of `repos/conversation-persistence.ts`: an
// effect composed alongside the transaction ports is an effect a transaction
// callback can eventually reach. Here, the only thing a service holds is a
// one-method port.
import type { Database as Db } from 'better-sqlite3';
import { AttentionBadgeRepo } from '../repos/attention-badge-repo.js';
import { ConversationReadRepo } from '../repos/conversation-read-repo.js';
import { ConversationRepo } from '../repos/conversation-repo.js';
import type {
  ConversationUnreadPublishPort,
  ConversationViewerUnreadPublishPort,
} from '../services/conversation/unread-publish-port.js';
import {
  publishUnreadUpdatedToConversationViewers,
  publishUnreadUpdatedToViewer,
} from '../viewer-scope.js';
import type { ScopeEventBus } from '../ws/scope-event-bus.js';

/** Wrap the viewer-scope publisher's read-model dependencies. The 5-parameter
 *  publisher itself is unchanged: the badge payload builder stays module-private
 *  in `viewer-scope.ts` so `unread_updated` can never be emitted without its
 *  co-emitted badge (#task:1870). */
export function createUnreadPublishAdapter(deps: {
  db: Db;
  events: ScopeEventBus;
}): ConversationUnreadPublishPort {
  const conversations = new ConversationRepo(deps.db);
  const conversationReads = new ConversationReadRepo(deps.db);
  const attentionBadges = new AttentionBadgeRepo(deps.db);
  return {
    publishUnreadUpdatedToConversationViewers(conversationId) {
      publishUnreadUpdatedToConversationViewers(
        deps.events,
        attentionBadges,
        conversations,
        conversationReads,
        conversationId,
      );
    },
  };
}

/** The viewer-directed variant, for a writer that already knows whose unread
 *  moved. Same two read models, same co-emitting publisher — only the audience
 *  differs, so it is wired here rather than growing a second DB-holding site. */
export function createViewerUnreadPublishAdapter(deps: {
  db: Db;
  events: ScopeEventBus;
}): ConversationViewerUnreadPublishPort {
  const conversationReads = new ConversationReadRepo(deps.db);
  const attentionBadges = new AttentionBadgeRepo(deps.db);
  return {
    publishUnreadUpdatedToViewer(conversationId, workspaceId, viewerUserId) {
      publishUnreadUpdatedToViewer(
        deps.events,
        attentionBadges,
        conversationReads,
        conversationId,
        workspaceId,
        viewerUserId,
      );
    },
  };
}
