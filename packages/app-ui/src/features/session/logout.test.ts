import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { clearLoggedOutSession, type ViewerState } from "./hooks";
import { getCurrentUserId, setCurrentUserId } from "./current-user";

const user = {
  id: "old-user",
  name: "old",
  display_name: "Old",
  avatar_url: null,
  created_at: 1,
  updated_at: 1,
};
const signedOut = {
  registration_required: true as const,
  suggested_name: "",
};
const clients: QueryClient[] = [];
afterEach(() => {
  for (const qc of clients.splice(0)) qc.clear();
});

function observe(queryFn: () => Promise<ViewerState>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(qc);
  qc.setQueryData(["me"], user);
  qc.setQueryData(["messages", "private"], ["old message"]);
  setCurrentUserId(user.id);
  const observer = new QueryObserver<ViewerState>(qc, {
    queryKey: ["me"],
    queryFn,
    staleTime: Infinity,
  });
  const seen: Array<ViewerState | undefined> = [];
  const unsubscribe = observer.subscribe((result) => seen.push(result.data));
  return { qc, observer, seen, unsubscribe };
}

describe("logout with mounted auth observers (no renderer reload)", () => {
  it("publishes loading then signed-out policy, removes private data and supports the next login", async () => {
    let resolve!: (state: ViewerState) => void;
    const state = observe(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const query = state.qc.getQueryCache().find({ queryKey: ["me"] });
    const pending = clearLoggedOutSession(state.qc);

    expect(state.observer.getCurrentResult().data).toBeUndefined();
    expect(state.seen).toContain(undefined);
    expect(getCurrentUserId()).toBeNull();
    expect(state.qc.getQueryData(["messages", "private"])).toBeUndefined();
    expect(state.qc.getQueryCache().find({ queryKey: ["me"] })).toBe(query);

    resolve(signedOut);
    await pending;
    expect(state.observer.getCurrentResult().data).toEqual(signedOut);
    const next = { ...user, id: "next-user" };
    state.qc.setQueryData(["me"], next);
    expect(state.observer.getCurrentResult().data).toEqual(next);
    state.unsubscribe();
  });

  it("discards an old in-flight viewer result after logout", async () => {
    let finishOld!: (state: ViewerState) => void;
    let finishNew!: (state: ViewerState) => void;
    const queryFn = vi
      .fn<() => Promise<ViewerState>>()
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            finishOld = r;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            finishNew = r;
          }),
      );
    const state = observe(queryFn);
    const oldFetch = state.observer.refetch();
    const logout = clearLoggedOutSession(state.qc);
    finishNew(signedOut);
    await logout;
    finishOld(user);
    await oldFetch;
    expect(state.observer.getCurrentResult().data).toEqual(signedOut);
    expect(state.qc.getQueryData(["me"])).toEqual(signedOut);
    state.unsubscribe();
  });

  it("does not retain the signed-in viewer when reading signed-out policy fails", async () => {
    const state = observe(async () => {
      throw new Error("offline");
    });
    await clearLoggedOutSession(state.qc);
    expect(state.observer.getCurrentResult().data).toBeUndefined();
    expect(state.observer.getCurrentResult().isError).toBe(true);
    expect(state.qc.getQueryData(["messages", "private"])).toBeUndefined();
    state.unsubscribe();
  });
});
