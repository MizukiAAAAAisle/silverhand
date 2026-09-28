// ─── ⌘W contextual close — main-side coordinator (single interception owner) ──
//
// The File menu's "Close" item (⌘W) does NOT act on the window directly. Main
// asks the *triggering* window's renderer to resolve the press against its
// current authoritative router state; the renderer runs its close ladder
// (?files > ?side > ?thread > ?threads > nothing) and replies with an outcome.
// Modals are deliberately NOT part of the ladder — ⌘W ignores them entirely
// (it neither closes a modal nor is blocked by one; the modal keeps its state
// and the press falls through to the topmost closable panel beneath it). When
// nothing in-app consumed the press the renderer answers `background-app` and
// main sends the whole app to the background (macOS Hide — the window is
// preserved, never destroyed, so drafts / scroll survive and the app returns
// instantly). Any other outcome, a timeout, or an unreachable renderer is
// fail-closed: main does nothing.
//
// The terminal action is app-level (Hide the application), not window-level, so
// it is injected as `sendToBackground` rather than a method on the per-window
// target. The captured window still owns request routing + sender auth.
//
// This module is the pure coordinator: request registry, reqId correlation,
// sender authentication, timeout fail-close, and outcome gating — with zero
// Electron imports so the security/race contract is unit-testable. `index.ts`
// injects the real `webContents.send` / `app.hide()` / `setTimeout` behind the
// `CloseTarget` + `sendToBackground` seams.
//
// Wire channels (`shortcut:contextual-close` / `shortcut:contextual-close-result`,
// positional args) + `ContextualCloseOutcome` are the main↔renderer contract —
// SSOT lives in the renderer's `features/app-shell/keyboard-shortcuts.ts`; the
// type below is the main-side twin.

export type ContextualCloseOutcome = "closed-panel" | "background-app";

/** The only outcome that triggers the app-level action; every other value
 *  (in-app surface handled it, or junk) is a no-op. */
const BACKGROUND_APP: ContextualCloseOutcome = "background-app";

/**
 * The window a single ⌘W press is bound to. Captured at press time and never
 * re-derived (focus can move during the async round-trip — we must act on the
 * window the user actually invoked). `webContentsId` doubles as the sender
 * credential: only a reply from this exact webContents is honored.
 */
export interface CloseTarget {
  readonly webContentsId: number;
  isDestroyed(): boolean;
  /** Ask this window's renderer to resolve the press (carries the reqId). */
  sendRequest(reqId: string): void;
}

interface PendingRequest {
  readonly target: CloseTarget;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class ContextualCloseCoordinator {
  #seq = 0;
  readonly #pending = new Map<string, PendingRequest>();

  constructor(
    private readonly timeoutMs: number,
    /** App-level "send to background" (macOS Hide). Called at most once per
     *  press, only on a validated `background-app` outcome. */
    private readonly sendToBackground: () => void,
  ) {}

  /**
   * Menu "Close" / ⌘W handler. Binds the request to the triggering window and
   * asks its renderer to resolve the press. No-op if the window is already
   * gone. Each press mints a fresh reqId so concurrent presses (e.g. after a
   * focus switch) never collide.
   */
  begin(target: CloseTarget): void {
    if (target.isDestroyed()) return;
    const reqId = `close-${++this.#seq}`;
    const timer = setTimeout(() => {
      // Fail closed: renderer never answered → drop, do NOT background.
      this.#pending.delete(reqId);
    }, this.timeoutMs);
    timer.unref?.();
    this.#pending.set(reqId, { target, timer });
    try {
      target.sendRequest(reqId);
    } catch {
      // Fail closed on a transport race: the webContents can be torn
      // down/crash between the liveness check above and this send, and
      // Electron's `send` throws. Roll the pending+timer back immediately and
      // swallow — nothing should happen, and no stale entry should sit until
      // the timeout. "Renderer unavailable" covers this, not just a missing
      // reply.
      clearTimeout(timer);
      this.#pending.delete(reqId);
    }
  }

  /**
   * The renderer's authoritative answer. Honored only when it matches a
   * still-pending reqId AND comes from the exact webContents we asked.
   * Everything else — late / replayed / unknown reqId, wrong sender, or any
   * non-`background-app` outcome — is a silent no-op.
   */
  resolve(senderWebContentsId: number, reqId: string, outcome: unknown): void {
    const pending = this.#pending.get(reqId);
    if (!pending) return; // late / replay / unknown reqId
    if (senderWebContentsId !== pending.target.webContentsId) return; // wrong sender
    // A matched reqId is consumed regardless of outcome: cancel the timer and
    // drop it so a replay can't re-trigger.
    clearTimeout(pending.timer);
    this.#pending.delete(reqId);
    if (outcome !== BACKGROUND_APP) return; // closed-panel / junk → no-op
    this.sendToBackground();
  }
}
