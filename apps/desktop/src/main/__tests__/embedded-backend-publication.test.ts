import { describe, expect, it, vi } from "vitest";
import {
  persistEmbeddedBackend,
  invalidateEmbeddedRuntime,
} from "../embedded-backend-publication.js";
import type {
  EmbeddedRustBackendHandle,
  EmbeddedRustBackendTerminalReason,
} from "../embedded-rust-backend.js";

describe("embedded URL publication owner", () => {
  for (const reason of [
    { kind: "child-exited", code: 1, signal: null },
    { kind: "protocol-violation", detail: "duplicate" },
  ] as const) {
    it(`runtime ${reason.kind} invalidates backend, URLs and visible state exactly once`, async () => {
      let alive = true;
      let url: string | null = "http://127.0.0.1:12";
      const close = vi.fn(async () => {});
      const report = vi.fn();
      const owner = {
        isCurrent: () => alive,
        invalidate: () => {
          alive = false;
        },
        clearUrls: () => {
          url = null;
        },
        report,
        close,
      };
      const first = invalidateEmbeddedRuntime(reason, owner);
      expect(alive).toBe(false);
      expect(url).toBeNull();
      await Promise.all([first, invalidateEmbeddedRuntime(reason, owner)]);
      expect(close).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenCalledWith(reason);
      expect(report).toHaveBeenCalledTimes(1);
    });
  }
  for (const fault of ["config", "controlUrl", "crash", "duplicate"] as const) {
    it(`${fault}: closes the child and invalidates both URL records before rejecting`, async () => {
      let listener: (reason: EmbeddedRustBackendTerminalReason) => void = () => {};
      const order: string[] = [];
      let configUrl: string | null = null;
      let controlUrl: string | null = null;
      const handle: EmbeddedRustBackendHandle = {
        url: "http://127.0.0.1:1234",
        port: 1234,
        onTerminal: (fn) => {
          listener = fn;
        },
        close: async () => {
          order.push("close");
        },
      };
      const publish = vi.fn();
      const startup = persistEmbeddedBackend(
        handle,
        {
          config: async () => {
            configUrl = handle.url;
            if (fault === "config") throw new Error("config write failed after partial write");
            if (fault === "crash") listener({ kind: "child-exited", code: 1, signal: null });
            if (fault === "duplicate")
              listener({ kind: "protocol-violation", detail: "second frame" });
          },
          controlUrl: () => {
            controlUrl = handle.url;
            if (fault === "controlUrl") throw new Error("URL write failed");
          },
          invalidate: async () => {
            order.push("invalidate");
            configUrl = null;
            controlUrl = null;
          },
        },
        new AbortController().signal,
      ).then(publish);
      await expect(startup).rejects.toThrow();
      expect(publish).not.toHaveBeenCalled();
      expect(order).toEqual(["close", "invalidate"]);
      expect(configUrl).toBeNull();
      expect(controlUrl).toBeNull();
    });
  }
});
