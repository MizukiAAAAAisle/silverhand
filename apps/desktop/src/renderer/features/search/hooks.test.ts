import { beforeEach, expect, it, vi } from "vitest";
import { useMessageSearch } from "./hooks";
const state = vi.hoisted(() => ({
  options: null as null | { queryFn: () => Promise<unknown> },
  api: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: typeof state.options) => {
    state.options = options;
    return {};
  },
}));
vi.mock("@/lib/api", () => ({ api: state.api }));
beforeEach(() => {
  vi.clearAllMocks();
  state.options = null;
});
it("selects identities in the same request and rejects missing identity fields", async () => {
  state.api.mockResolvedValue({ query: { q: "alice" }, results: [], total: 0, truncated: false });
  useMessageSearch({ q: "alice", include_identities: true });
  await expect(state.options!.queryFn()).rejects.toThrow();
  expect(state.api).toHaveBeenCalledWith(expect.stringContaining("include_identities=true"));
});
it("inline content search neither selects nor requires identities", async () => {
  const body = { query: { q: "alice" }, results: [], total: 0, truncated: false };
  state.api.mockResolvedValue(body);
  useMessageSearch({ q: "alice", conversation_id: "channel" });
  await expect(state.options!.queryFn()).resolves.toEqual(body);
  expect(state.api).toHaveBeenCalledWith(expect.not.stringContaining("include_identities"));
});
