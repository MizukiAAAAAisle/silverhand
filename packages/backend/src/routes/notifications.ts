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
import { requireViewerUserId } from '../auth/principal.js';
import { timedRouteSpan } from '../observability/route-span.js';

export interface NotificationsRouteDeps {
  ctx: BackendContext;
  notifications: NotificationRepo;
}

export function createNotificationsApp(
  deps: NotificationsRouteDeps,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { ctx, notifications } = deps;

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
