// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ commits: [] as any[], markRead: vi.fn(), pending: [] as ((value: any) => void)[] }));
vi.mock("./hooks", () => ({
  useMarkMessageChannelRead: () => ({ mutate: h.markRead }),
  usePrimeConversationMessages: () => ({ primeAround: (_c: string, _m: string, options: any) => {
    h.commits.push(options); return new Promise((resolve) => h.pending.push(resolve));
  } }),
}));
import { useMessageJumpController } from "./use-message-jump-controller";
let current: ReturnType<typeof useMessageJumpController>, root: ReturnType<typeof createRoot>, div: HTMLDivElement;
function Probe() { current = useMessageJumpController(); return null; }
beforeEach(async () => { h.commits=[];h.pending=[];h.markRead.mockClear();(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;div=document.createElement("div");document.body.append(div);root=createRoot(div);await act(async()=>root.render(React.createElement(Probe))); });
afterEach(async () => { await act(async()=>root.unmount());div.remove(); });
it("owns fresh generations for same-ID requests and invalidates stale prime commits", async () => {
  await act(async()=>current.requestJump({channelId:"c",messageId:"e",attemptId:900}));const first=current.jumpTarget!.attemptId;
  await act(async()=>current.requestJump({channelId:"c",messageId:"e",attemptId:900}));const second=current.jumpTarget!.attemptId;
  expect(first).toBe(1);expect(second).toBe(2);expect(h.commits[0].shouldCommit()).toBe(false);expect(h.commits[1].shouldCommit()).toBe(true);
  await act(async()=>h.pending[0]!({committed:true}));expect(current.jumpTarget!.attemptId).toBe(2);
  await act(async()=>h.pending[1]!({committed:true}));expect(current.primePhaseFor("c","e")).toBe("committed");expect(h.markRead.mock.calls).toEqual([["c"],["c"]]);
});
it("clears the active owner on cancellation without accepting a late prime", async () => {
  await act(async()=>current.requestJump({channelId:"c",messageId:"e"}));await act(async()=>current.clearJump());
  expect(h.commits[0].shouldCommit()).toBe(false);await act(async()=>h.pending[0]!({committed:true}));expect(current.jumpTarget).toBeNull();expect(current.primePhaseFor("c","e")).toBeNull();
});
