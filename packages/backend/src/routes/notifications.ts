// Viewer notification surface: list (unread / limit filters), unread summary
// (total + per-workspace counts + latest pointer), and mark-read (by id /
// conversation / workspace / all) with the `viewer:<id>` `unread_updated` event
// that fires only when the unread counter actually changed. `parseLimit` is
// module-private because only the list route uses it.
import { Hono } from 'hono';
import { apiPaths, MarkNotificationsReadInputSchema } from '@silverhand/shared';
import type { AppEnv } from '../auth/principal.js';
import type { BackendContext } from '../context.js';
import type { NotificationRepo } from '../repos/notification-repo.js';
import type { AttentionBadgeRepo } from '../repos/attention-badge-repo.js';
import { requireViewerUserId } from '../auth/principal.js';
import { timedRouteSpan } from '../observability/route-span.js';
import { publishAttentionBadgeUpdated } from '../viewer-scope.js';

export interface NotificationsRouteDeps {
  ctx: BackendContext;
  notifications: NotificationRepo;
  /** Tiered-badge projection (#task:1870): a directed notification going read is
   *  the third source that moves the badge without moving any unread cursor. */
  attentionBadges: AttentionBadgeRepo;
}

export function createNotificationsApp(
  deps: NotificationsRouteDeps,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { ctx, notifications, attentionBadges } = deps;

  // ── Notifications ────────────────────────────────────────────────
  app.get(apiPaths.notifications, c => {
    const unread = c.req.query('unread') === '1';
    const limit = parseLimit(c.req.query('limit'), 100);
    const viewerUserId = requireViewerUserId(c);
    return c.json({
      notifications: notifications.list({ userId: viewerUserId, unread, limit }),
    });
  });

  // Lightweight endpoint: total unread + per-sidebar-scope counts + the
  // most recent unread pointer so the renderer can jump straight there.
  app.get(apiPaths.notificationsUnread, c => {
    const viewerUserId = requireViewerUserId(c);
    const total = timedRouteSpan(
      ctx,
      'notifications.unreadCount',
      { viewerUserId },
      () => notifications.unreadCount(viewerUserId),
      result => ({ total: result }),
    );
    const byWorkspace = Object.fromEntries(
      timedRouteSpan(
        ctx,
        'notifications.unreadCountsByWorkspace',
        { viewerUserId },
        () => notifications.unreadCountsByWorkspace(viewerUserId),
        result => ({ workspaceCount: result.size }),
      ).entries(),
    );
    const latestByWorkspace = Object.fromEntries(
      timedRouteSpan(
        ctx,
        'notifications.latestUnreadByWorkspace',
        { viewerUserId },
        () => notifications.latestUnreadByWorkspace(viewerUserId),
        result => ({ workspaceCount: result.size }),
      ).entries(),
    );
    return c.json({
      total,
      by_workspace: byWorkspace,
      latest_by_workspace: latestByWorkspace,
    });
  });

  // Mark-read with three modes: by id, by conversation/workspace, or all. Validation
  // mirrors `MarkNotificationsReadInputSchema` in shared/dto.ts.
  app.post(apiPaths.notificationsRead, async c => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = MarkNotificationsReadInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const { id, workspace_id, conversation_id, all } = parsed.data;
    const viewerUserId = requireViewerUserId(c);
    // Tiered badge (#task:1870) BEFORE the write. Diffing two absolute maps is
    // what lets this route emit exactly the workspaces that moved — including one
    // that dropped to 0, which an "affected workspaces" set derived from the
    // cleared rows would report identically but which each of the four filters
    // would have to compute its own way. Attribution therefore comes from the
    // badge projection itself (the conversation's workspace), never from
    // `notifications.workspace_id`, and no filter logic is duplicated here.
    // This is a user-initiated panel action, not the per-message arrival path, so
    // the second roll-up scan is affordable.
    const badgeBefore = attentionBadges.badgeCountsByWorkspace(viewerUserId);
    let marked = 0;
    if (id) {
      const ok = notifications.markRead(id, viewerUserId);
      marked = ok ? 1 : 0;
    } else if (workspace_id) {
      marked = notifications.markWorkspaceRead(
        workspace_id,
        viewerUserId,
      );
    } else if (conversation_id) {
      marked = notifications.markConversationRead(
        conversation_id,
        viewerUserId,
      );
    } else if (all) {
      marked = notifications.markAllRead(viewerUserId);
    } else {
      // Unreachable thanks to the schema refine, but TS doesn't narrow.
      return c.json({ error: 'invalid input' }, 400);
    }
    // Push to the resolved viewer's private scope only when unread
    // notification counters changed.
    if (marked > 0) {
      ctx.events.publishToScope(
        `viewer:${viewerUserId}`,
        'unread_updated',
        { marked },
      );
      const badgeAfter = attentionBadges.badgeCountsByWorkspace(viewerUserId);
      for (const workspaceId of new Set([
        ...Object.keys(badgeBefore),
        ...Object.keys(badgeAfter),
      ])) {
        if ((badgeBefore[workspaceId] ?? 0) === (badgeAfter[workspaceId] ?? 0)) {
          continue;
        }
        publishAttentionBadgeUpdated(
          ctx.events,
          attentionBadges,
          workspaceId,
          viewerUserId,
        );
      }
    }
    return c.json({ marked });
  });

  return app;
}

function parseLimit(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 500);
}
