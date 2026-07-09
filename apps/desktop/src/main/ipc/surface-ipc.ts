import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSafeOpenExtension } from '@silverhand/shared';

export interface ActiveConversationInfo {
  workspaceId: string | null;
  conversationId: string | null;
}

export function registerSurfaceIpcHandlers(opts: {
  setActiveConversation: (next: ActiveConversationInfo) => void;
  pushActiveConversationToEvents: () => void;
}): void {
  // Live OS notifications keyed by the renderer-supplied notification id (the
  // backend notification row id). Retained so `notification:dismiss` can
  // `.close()` the exact alert when the backend reports it was read
  // (#task:1431). Entries self-evict on the Notification's own `close` event.
  const shownNotifications = new Map<string, Notification>();

  ipcMain.handle('dialog:pickDirectory', async (event, options?: { defaultPath?: string }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: options?.defaultPath,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  });

  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    if (typeof url !== 'string') return;
    // Refuse anything that isn't an http(s) link — preload is a security
    // boundary; agent-rendered content can hand us arbitrary strings.
    if (!/^https?:\/\//i.test(url)) return;
    await shell.openExternal(url);
  });

  /**
   * Hand an attachment off to the OS default app for that MIME (e.g. open
   * `.html` in the user's browser, `.pdf` in Preview). The renderer
   * fetches the bytes via the authenticated backend route and ships them
   * here over IPC; we write to a per-app temp dir and call
   * `shell.openPath`. macOS resolves the default handler from the
   * extension on disk.
   *
   * Security gate — extension allowlist (`isSafeOpenExtension` in
   * `@silverhand/shared`):
   *   - The attachment system accepts arbitrary files (image, doc,
   *     archive, ...). On macOS, `shell.openPath` goes through Launch
   *     Services, which dispatches on the on-disk extension. A `.command`
   *     would open in Terminal; a `.pkg` in Installer; a `.app` would
   *     launch. None of those are acceptable for "click a chat
   *     attachment to view it".
   *   - We therefore allow only viewer / sandboxed extensions
   *     (html, htm, pdf, txt, log, md, markdown, json, csv, plus image
   *     types). Anything outside that list returns `unsafe_extension` and
   *     the renderer surfaces an error — the user can still download via
   *     a follow-up flow if we add one.
   *   - We deliberately do NOT trust the renderer-supplied MIME as the
   *     primary check: pre-existing attachment rows can carry
   *     `application/octet-stream` from before the MIME contract landed,
   *     so MIME-only gating would either break legitimate `.html` opens
   *     or require a DB backfill.
   *
   * Why not `window.open(blob_url)` in the renderer? Electron's
   * `setWindowOpenHandler` redirects new-window opens to
   * `shell.openExternal`, which can't resolve `blob:` URLs (they're
   * scoped to the renderer process). The result was: clicking any
   * non-image attachment silently did nothing — the symptom that
   * surfaced as the original `.html` bug (`#task:383`).
   *
   * Why not load HTML in a fresh BrowserWindow? Even with sandboxing,
   * keeping untrusted HTML out of any Electron-controlled WebContents is
   * simpler — the OS browser already provides the right sandbox, CSP,
   * and origin isolation. So HTML files leave Electron entirely.
   */
  ipcMain.handle(
    'attachment:openExternal',
    async (
      _event,
      input: { filename?: unknown; bytes?: unknown },
    ): Promise<{ ok: true } | { ok: false; reason: string }> => {
      const filenameRaw = input?.filename;
      if (typeof filenameRaw !== 'string' || filenameRaw.length === 0) {
        return { ok: false, reason: 'invalid_filename' };
      }
      const bytesRaw = input?.bytes;
      if (!(bytesRaw instanceof Uint8Array) && !Buffer.isBuffer(bytesRaw)) {
        return { ok: false, reason: 'invalid_payload' };
      }
      const buffer = Buffer.isBuffer(bytesRaw) ? bytesRaw : Buffer.from(bytesRaw);
      if (buffer.length === 0) {
        return { ok: false, reason: 'empty_payload' };
      }
      // Strip path separators / control chars; keep the original
      // extension because that's what the OS uses to pick a handler.
      const safeName = filenameRaw
        .replace(/[\\/]/g, '_')
        .replace(/[\x00-\x1f]+/g, '')
        .trim()
        .slice(0, 255);
      if (!safeName) return { ok: false, reason: 'invalid_filename' };
      // Security gate: refuse extensions that Launch Services would hand
      // to a shell, installer, or runtime. See `isSafeOpenExtension`.
      if (!isSafeOpenExtension(safeName)) {
        return { ok: false, reason: 'unsafe_extension' };
      }
      let dir: string;
      try {
        dir = mkdtempSync(join(tmpdir(), 'silverhand-att-'));
      } catch (err) {
        return {
          ok: false,
          reason: `mkdtemp_failed:${err instanceof Error ? err.message : String(err)}`,
        };
      }
      const fullPath = join(dir, safeName);
      try {
        writeFileSync(fullPath, buffer, { mode: 0o600 });
      } catch (err) {
        return {
          ok: false,
          reason: `write_failed:${err instanceof Error ? err.message : String(err)}`,
        };
      }
      const openErr = await shell.openPath(fullPath);
      if (openErr) {
        return { ok: false, reason: `open_failed:${openErr}` };
      }
      return { ok: true };
    },
  );

  ipcMain.handle('shell:showItemInFolder', (_event, fullPath: string) => {
    // Reveal a file/dir in Finder/Explorer. Used by the agent profile's
    // "Reveal in Finder" buttons. Path validity is enforced by Electron;
    // an unknown path simply opens the home dir, which is harmless.
    if (typeof fullPath !== 'string' || fullPath.length === 0) return;
    shell.showItemInFolder(fullPath);
  });

  ipcMain.handle('window:setAlwaysOnTop', (event, pinned: boolean) => {
    // Pin the *sender's* window — works for any future window without
    // hard-wiring a reference here. The Events window uses this to
    // expose Pin as an in-titlebar toggle (see EventsApp).
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.setAlwaysOnTop(!!pinned);
  });

  ipcMain.handle('active-conversation:set', (_event, next: unknown) => {
    opts.setActiveConversation(normalizeActiveConversation(next));
    opts.pushActiveConversationToEvents();
  });

  ipcMain.handle('badge:setCount', (_event, value: unknown) => {
    // macOS dock badge. n=0 clears it; non-finite / negative values are
    // coerced to 0 so a buggy renderer can't paint nonsense on the icon.
    // Renderer drives this from `useMessageUnreadSummary` (sum across
    // workspaces) — no other source feeds the badge.
    const count =
      typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? Math.floor(value)
        : 0;
    app.setBadgeCount(count);
  });

  ipcMain.handle('notification:show', (event, opts: unknown) => {
    if (!opts || typeof opts !== 'object') return;
    const { title, body, force, notificationId } = opts as Partial<
      Record<string, unknown>
    >;
    if (typeof title !== 'string' || typeof body !== 'string') return;
    // Fire ordinary system notifications only when no Electron window is
    // focused. Direct human mentions opt into `force` so an active-but-
    // different channel still produces an OS notification instead of only
    // changing the unread dot.
    if (force !== true && BrowserWindow.getFocusedWindow() !== null) return;
    const n = new Notification({ title, body });
    // Click handler — only wired when the renderer attached a
    // `notificationId`. Bring a window forward (the user clicked, that's
    // the intent) and forward the id back so the renderer can navigate
    // to the right conversation. Without an id this is just an alert and
    // we keep the legacy "show only" behavior.
    if (typeof notificationId === 'string' && notificationId.length > 0) {
      // Retain so a later `notification:dismiss` (backend reported it read) can
      // close this exact alert; self-evict when the OS closes it.
      shownNotifications.set(notificationId, n);
      n.on('close', () => {
        if (shownNotifications.get(notificationId) === n) {
          shownNotifications.delete(notificationId);
        }
      });
      n.on('click', () => {
        // Prefer the sender's window (the renderer that called us); fall
        // back to any visible window. macOS keeps windows around in the
        // dock even when minimized, so showing the first one is safe.
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        const target =
          senderWindow ??
          BrowserWindow.getAllWindows().find(w => !w.isDestroyed()) ??
          null;
        if (target) {
          if (target.isMinimized()) target.restore();
          target.show();
          target.focus();
        }
        // Best-effort focus the app itself (e.g. when another app is
        // frontmost). On macOS this nudges Silverhand to the foreground.
        if (process.platform === 'darwin') app.focus({ steal: true });
        if (!event.sender.isDestroyed()) {
          event.sender.send('notification:clicked', notificationId);
        }
      });
    }
    n.show();
  });

  ipcMain.handle('notification:dismiss', (_event, notificationIds: unknown) => {
    // Close OS notifications the backend reported as read (#task:1431). The
    // renderer forwards the exact ids from the viewer-scoped "notification read"
    // fact — main never re-derives read state. Unknown / already-closed ids are
    // silently ignored (best-effort: OS alerts are transient).
    if (!Array.isArray(notificationIds)) return;
    for (const id of notificationIds) {
      if (typeof id !== 'string') continue;
      const n = shownNotifications.get(id);
      if (n) {
        n.close();
        shownNotifications.delete(id);
      }
    }
  });
}

function normalizeActiveConversation(value: unknown): ActiveConversationInfo {
  if (!value || typeof value !== 'object') {
    return { workspaceId: null, conversationId: null };
  }
  const v = value as Partial<Record<keyof ActiveConversationInfo, unknown>>;
  return {
    workspaceId: typeof v.workspaceId === 'string' ? v.workspaceId : null,
    conversationId: typeof v.conversationId === 'string' ? v.conversationId : null,
  };
}
