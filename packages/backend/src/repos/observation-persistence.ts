import type { Database as Db } from 'better-sqlite3';
import type {
  NotificationClearOutcome,
  ObservationKey,
  ObservationPersistence,
  ObservationTxScope,
  ObservedStream,
  ViewerObservationTxPort,
} from '../application/observation-ports.js';
import { ConversationReadRepo } from './conversation-read-repo.js';
import { NotificationRepo } from './notification-repo.js';
import { ConversationRepo } from './conversation-repo.js';

interface ObservationRepos {
  reads: ConversationReadRepo;
  notifications: NotificationRepo;
  conversations: ConversationRepo;
}

/**
 * The single implementation of the viewer-bound observation face. Every method
 * closes over `viewerUserId` from the scope's key, so the viewer is not a
 * parameter anything can get wrong.
 */
function viewerFace(
  repos: ObservationRepos,
  viewerUserId: string,
): ViewerObservationTxPort {
  return {
    advanceStreamCursor(stream: ObservedStream): boolean {
      const current = repos.reads.getLastReadSeq(
        viewerUserId,
        stream.conversationId,
        stream.threadRootId,
      );
      // The compare is BOOKKEEPING, not a precondition: the upsert keeps
      // max(existing, new), so a concurrent higher cursor survives whichever
      // branch this takes. See the port doc's per-write justification.
      if (stream.targetSeq <= current) return false;
      repos.reads.markRead({
        viewerUserId,
        conversationId: stream.conversationId,
        threadRootId: stream.threadRootId,
        seq: stream.targetSeq,
      });
      return true;
    },
    clearStreamMentions(stream: ObservedStream): string[] {
      return repos.notifications.markStreamMentionsRead({
        userId: viewerUserId,
        conversationId: stream.conversationId,
        threadRootId: stream.threadRootId,
        uptoSeq: stream.targetSeq,
      });
    },
    clearNotification(notificationId: string): NotificationClearOutcome {
      // Read BEFORE the write: `markRead` reports only WHETHER it flipped, and
      // the badge attribution needs the row's kind and anchor. The read is
      // viewer-scoped like the write, so a foreign row cannot even be projected
      // — previously the use case read any row by id and relied on the
      // user-scoped write to gate what it did with it.
      const row = repos.notifications.get(notificationId);
      if (!row || row.user_id !== viewerUserId) return { cleared: false };
      if (!repos.notifications.markRead(notificationId, viewerUserId)) {
        return { cleared: false };
      }
      // The CONVERSATION's workspace, deliberately — not the denormalized
      // `notifications.workspace_id` copy (see NotificationClearOutcome).
      const conversation = row.conversation_id
        ? repos.conversations.get(row.conversation_id)
        : null;
      return {
        cleared: true,
        kind: row.kind,
        anchorWorkspaceId: conversation?.workspace_id ?? null,
      };
    },
  };
}

/**
 * Persistence for the observation batch (#task:1987 E).
 *
 * DEFERRED on purpose. Not because nothing reads before writing — the cursor face
 * does read the current cursor — but because no write here DECIDES from that
 * value in a way any invariant depends on: the cursor upsert is monotone, so a
 * stale pre-read can only cost a redundant upsert or a stale `changed` boolean,
 * and both clears are conditional. There is therefore nothing for a
 * `BEGIN IMMEDIATE` to protect — and a read-only batch, which is the common case
 * for an idle re-observe, then never touches the write lock at all. The
 * obligation that comes with that policy is stated on
 * `application/observation-ports.ts`: keep the cursor write monotone and the
 * clears conditional, in every engine.
 *
 * Nesting is not refused: a deferred transaction degrading to a savepoint loses
 * no claim this port makes (unlike the immediate axes, whose lock silently
 * disappears). Today the only caller is the observe use case, at the top of a
 * request.
 */
export function createSqliteObservationPersistence(db: Db): ObservationPersistence {
  const repos: ObservationRepos = {
    reads: new ConversationReadRepo(db),
    notifications: new NotificationRepo(db),
    conversations: new ConversationRepo(db),
  };

  return {
    uow: {
      atomicallyForViewer<T>(
        key: ObservationKey,
        fn: (tx: ObservationTxScope) => T,
      ): T {
        const scope: ObservationTxScope = {
          viewer: viewerFace(repos, key.viewerUserId),
        };
        return db.transaction(() => fn(scope))();
      },
    },
  };
}
