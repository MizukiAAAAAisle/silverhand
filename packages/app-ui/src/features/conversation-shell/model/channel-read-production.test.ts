import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MutationObserver, QueryClient, type MutationObserverOptions } from "@tanstack/react-query";
import { decodeMessageSeq } from "@silverhand/shared";
import { streamSourceAtSeq, mainlineStreamSourceHead } from "../../attention/observe";
import { useMarkMessageChannelRead } from "../../channels/hooks";

const harness = vi.hoisted(() => ({
  qc: null as QueryClient | null,
  observe: vi.fn(),
  settle: vi.fn(),
}));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => harness.qc,
  useMutation: (options: MutationObserverOptions<unknown, Error, unknown, unknown>) => {
    const observer = new MutationObserver(harness.qc!, options);
    return { mutateAsync: (vars: unknown) => observer.mutate(vars) };
  },
}));
vi.mock("../../attention/observe", async (original) => ({
  ...(await original<typeof import("../../attention/observe")>()),
  postObserve: (...args: unknown[]) => harness.observe(...args),
}));
vi.mock("../../attention/observe-cache-fallback", () => ({
  reconcileUnreadAfterObserveIfRealtimeUnavailable: vi.fn(),
  settleStreamUnreadAfterObserve: (...args: unknown[]) => harness.settle(...args),
}));
beforeEach(() => {
  vi.resetAllMocks();
  harness.qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  harness.observe.mockResolvedValue({});
});
afterEach(() => harness.qc?.clear());

it("pins the request and cache settlement to the seen tail", async () => {
  const sources = [streamSourceAtSeq("channel", null, decodeMessageSeq(22))];
  await useMarkMessageChannelRead().mutateAsync({
    id: "channel",
    snapshotSeq: decodeMessageSeq(22),
  });
  expect(harness.observe).toHaveBeenCalledExactlyOnceWith(sources);
  expect(harness.settle).toHaveBeenCalledExactlyOnceWith(harness.qc, sources, {});
});
it("uses the server head only when no seen-tail snapshot was supplied", async () => {
  await useMarkMessageChannelRead().mutateAsync("channel");
  expect(harness.observe).toHaveBeenCalledExactlyOnceWith([mainlineStreamSourceHead("channel")]);
});
it("a failed observation does not settle the cache", async () => {
  harness.observe.mockRejectedValue(new Error("offline"));
  await expect(useMarkMessageChannelRead().mutateAsync("channel")).rejects.toThrow("offline");
  expect(harness.settle).not.toHaveBeenCalled();
});
