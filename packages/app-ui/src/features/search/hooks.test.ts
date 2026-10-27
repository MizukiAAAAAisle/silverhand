import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMessageSearch } from "./hooks";
const state = vi.hoisted(() => ({
  options: null as null | { queryFn: () => Promise<unknown>; queryKey: readonly unknown[]; staleTime: number; enabled: boolean },
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


// Real queryFn/options and real QueryObserver; only the API transport is deferred.
// No React success-state stub or setQueryData is used to manufacture a result.
const actualQuery = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
const clients: InstanceType<typeof actualQuery.QueryClient>[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.clear(); });
const answer = (q: string) => ({ query: { q, include_identities: true }, results: [], total: 0, truncated: false,
  identities: { status: "searched", humans: { results: [], total: 0, truncated: false }, agents: { results: [], total: 0, truncated: false } } });
function queryOptions(q: string) {
  useMessageSearch({ q, include_identities: true, limit: 100 });
  return state.options!;
}
function realClient() {
  const client = new actualQuery.QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 5000, refetchOnWindowFocus: false } } });
  clients.push(client); return client;
}

it("consumes late A through the real queryFn while the current observer remains B", async () => {
  let finishA!: (value: unknown) => void;
  state.api.mockImplementation((path: string) => new URL("https://host.test" + path).searchParams.get("q") === "old-A"
    ? new Promise(resolve => { finishA = resolve; }) : Promise.resolve(answer("new-B")));
  const client = realClient(), a = queryOptions("old-A"), b = queryOptions("new-B");
  const observer = new actualQuery.QueryObserver(client, a);
  const stop = observer.subscribe(() => {});
  const old = client.getQueryCache().find({ queryKey: a.queryKey })!.fetch();
  observer.setOptions(b);
  await vi.waitFor(() => expect(observer.getCurrentResult().data).toMatchObject({ query: { q: "new-B" } }));
  finishA(answer("old-A"));
  await old; // Client promise consumption, not merely server write completion.
  expect(client.getQueryData(a.queryKey)).toMatchObject({ query: { q: "old-A" } });
  expect(observer.getCurrentResult().data).toMatchObject({ query: { q: "new-B" } });
  expect(state.api).toHaveBeenCalledTimes(2);
  stop();
});

it("unsubscribing an unconsumed-signal query permits its pending response to cache", async () => {
  let finish!: (value: unknown) => void;
  state.api.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const client = realClient(), options = queryOptions("detached");
  const observer = new actualQuery.QueryObserver(client, options);
  const stop = observer.subscribe(() => {});
  const pending = client.getQueryCache().find({ queryKey: options.queryKey })!.fetch();
  stop(); finish(answer("detached")); await pending;
  expect(client.getQueryData(options.queryKey)).toMatchObject({ query: { q: "detached" } });
  expect(state.api).toHaveBeenCalledTimes(1);
});

it("fresh five-second cache does not issue a new request, explicit refetch does", async () => {
  state.api.mockResolvedValue(answer("cached"));
  const client = realClient(), options = queryOptions("cached");
  expect(options.staleTime).toBe(5000);
  const first = new actualQuery.QueryObserver(client, options), stopFirst = first.subscribe(() => {});
  await vi.waitFor(() => expect(first.getCurrentResult().isSuccess).toBe(true));
  stopFirst();
  const second = new actualQuery.QueryObserver(client, options), stopSecond = second.subscribe(() => {});
  expect(second.getCurrentResult().isSuccess).toBe(true);
  expect(state.api).toHaveBeenCalledTimes(1);
  await second.refetch();
  expect(state.api).toHaveBeenCalledTimes(2);
  stopSecond();
});

it("real retry1 produces two failed transports before explicit Retry succeeds", async () => {
  state.api.mockRejectedValueOnce(Error("controlled503-1")).mockRejectedValueOnce(Error("controlled503-2")).mockResolvedValue(answer("retry"));
  const client = realClient(), observer = new actualQuery.QueryObserver(client, queryOptions("retry"));
  const stop = observer.subscribe(() => {});
  await vi.waitFor(() => expect(observer.getCurrentResult().isError).toBe(true), { timeout: 2500 });
  expect(state.api).toHaveBeenCalledTimes(2);
  await observer.refetch();
  expect(observer.getCurrentResult().isSuccess).toBe(true);
  expect(state.api).toHaveBeenCalledTimes(3);
  stop();
});
