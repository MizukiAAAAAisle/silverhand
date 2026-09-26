import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from "electron";
import { pathToFileURL } from "node:url";
import type { RendererEntry } from "../renderer-entry.js";

export interface GuardedIpcLogger {
  warn(payload: Record<string, unknown>, message: string): void;
}

export interface GuardedIpcRegistrarDeps {
  /** The app renderer's WebContents; null before the window exists. */
  resolveRendererWebContents: () => WebContents | null;
  /**
   * The ALREADY-RESOLVED renderer entry — the very value the window loader
   * was handed. This module deliberately reads neither `process.env` nor
   * `__dirname`: re-resolving here would make "allowed target" a second
   * computation that merely happens to agree with the load target under the
   * current bundle shape.
   */
  entry: RendererEntry;
  log?: GuardedIpcLogger | null;
}

export interface GuardedIpcRegistrar {
  handle<Args extends unknown[], Result>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: Args) => Result,
  ): void;
  on<Args extends unknown[]>(
    channel: string,
    listener: (event: IpcMainEvent, ...args: Args) => void,
  ): void;
}

type SenderVerdict =
  | { ok: true }
  | {
      ok: false;
      reason: "no_renderer" | "foreign_web_contents" | "not_top_frame" | "url_mismatch";
    };

/** The two fields the guard reads off an Electron ipc event. */
interface SenderLike {
  sender: WebContents;
  senderFrame: { url: string } | null;
}

export function createGuardedIpcRegistrar(deps: GuardedIpcRegistrarDeps): GuardedIpcRegistrar {
  const validate = (event: SenderLike): SenderVerdict => {
    const expected = deps.resolveRendererWebContents();
    if (!expected) return { ok: false, reason: "no_renderer" };
    if (event.sender !== expected) {
      return { ok: false, reason: "foreign_web_contents" };
    }
    const frame = event.senderFrame;
    // A null frame means the sender is gone or unknown — refuse rather than
    // fall through to a URL check we cannot perform.
    if (!frame) return { ok: false, reason: "not_top_frame" };
    if (frame !== (event.sender as unknown as { mainFrame: unknown }).mainFrame) {
      return { ok: false, reason: "not_top_frame" };
    }
    return matchesRendererEntry(frame.url, deps.entry)
      ? { ok: true }
      : { ok: false, reason: "url_mismatch" };
  };

  const logRejection = (
    channel: string,
    verdict: SenderVerdict & { ok: false },
    event: SenderLike,
  ): void => {
    deps.log?.warn(
      {
        action: "ipc_sender_rejected",
        channel,
        reason: verdict.reason,
        // Ids only — never the URL itself (its hash/query name workspaces
        // and channels).
        sender_id: safeSenderId(event.sender),
        top_frame: event.senderFrame
          ? event.senderFrame === (event.sender as unknown as { mainFrame: unknown }).mainFrame
          : false,
        // Normalized protocol class only — enough to tell a stray `file:`
        // page from a wrong dev origin, with no path/hash/query.
        source_kind: normalizeSourceKind(event.senderFrame?.url),
      },
      "ipc sender validation rejected a message",
    );
  };

  return {
    handle<Args extends unknown[], Result>(
      channel: string,
      listener: (event: IpcMainInvokeEvent, ...args: Args) => Result,
    ): void {
      ipcMain.handle(channel, (event, ...args) => {
        const verdict = validate(event);
        if (!verdict.ok) {
          logRejection(channel, verdict, event);
          throw new Error(`ipc sender validation failed for ${channel}`);
        }
        // The one cast in the seam: Electron hands us untyped varargs, the
        // caller declared the tuple it expects.
        return listener(event, ...(args as Args));
      });
    },
    on<Args extends unknown[]>(
      channel: string,
      listener: (event: IpcMainEvent, ...args: Args) => void,
    ): void {
      ipcMain.on(channel, (event, ...args) => {
        const verdict = validate(event);
        if (!verdict.ok) {
          logRejection(channel, verdict, event);
          return;
        }
        listener(event, ...(args as Args));
      });
    },
  };
}

/**
 * URL half of the IPC sender contract.
 *
 * dev: same origin as the dev server (path/hash free to change with the
 * router). packaged: the resolved `file:` path must equal the renderer entry
 * path exactly — the HashRouter fragment and any query are stripped first,
 * so `index.html#/c/abc?x=1` is the same document as `index.html`.
 */
function matchesRendererEntry(frameUrl: string, entry: RendererEntry): boolean {
  let url: URL;
  try {
    url = new URL(frameUrl);
  } catch {
    return false;
  }
  if (entry.kind === "dev-server") {
    let expected: URL;
    try {
      expected = new URL(entry.url);
    } catch {
      return false;
    }
    // Only real origins can be compared; an opaque origin (`null`) would
    // otherwise match any other opaque-origin page.
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (expected.protocol !== "http:" && expected.protocol !== "https:") {
      return false;
    }
    return url.origin === expected.origin;
  }
  if (url.protocol !== "file:") return false;
  return url.pathname === pathToFileURL(entry.filePath).pathname;
}

/**
 * Coarse protocol class of the sender frame for diagnostics. Never derived
 * from the path, so it cannot leak workspace/channel ids.
 */
function normalizeSourceKind(
  url: string | undefined,
): "file" | "http" | "other" | "malformed" | "missing" {
  if (url === undefined) return "missing";
  try {
    const protocol = new URL(url).protocol;
    if (protocol === "file:") return "file";
    if (protocol === "http:" || protocol === "https:") return "http";
    return "other";
  } catch {
    return "malformed";
  }
}

function safeSenderId(sender: WebContents): number | null {
  try {
    return sender.id;
  } catch {
    return null;
  }
}
