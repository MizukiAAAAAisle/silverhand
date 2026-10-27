// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UserDto } from "@silverhand/shared";
import { useUploadAvatar } from "./hooks";
import { clearCurrentUser, getCurrentUserId, setCurrentUserId } from "./current-user";

const mocked = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  apiUpload: mocked.upload,
}));
const user = (id = "u1", avatar = "old"): UserDto => ({
  id,
  name: id,
  display_name: id,
  avatar_url: avatar,
  created_at: 1,
  updated_at: 2,
});
let root: Root;
let qc: QueryClient;
let hook: ReturnType<typeof useUploadAvatar>;
let unmounted = false;
const deferred = () => {
  let resolve!: (value: { user: UserDto; avatar_url: string }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ user: UserDto; avatar_url: string }>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
async function start() {
  let promise!: ReturnType<typeof hook.mutateAsync>;
  await act(async () => {
    promise = hook.mutateAsync({ file: new File(["png"], "avatar.png", { type: "image/png" }) });
  });
  return { promise };
}
async function finish(pending: ReturnType<typeof deferred>, avatar: string) {
  await act(async () => {
    pending.resolve({ user: user("u1", avatar), avatar_url: avatar });
  });
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocked.upload.mockReset();
  qc = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  setCurrentUserId("u1");
  qc.setQueryData(["me"], user());
  qc.setQueryData(["avatar-design", "me"], "old-design");
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  unmounted = false;
  function Editor() {
    hook = useUploadAvatar();
    return null;
  }
  await act(async () =>
    root.render(createElement(QueryClientProvider, { client: qc }, createElement(Editor))),
  );
});
afterEach(async () => {
  if (!unmounted) await act(async () => root.unmount());
  qc.clear();
  clearCurrentUser();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
it("only seats the latest upload when responses complete in reverse order", async () => {
  const old = deferred(),
    fresh = deferred();
  mocked.upload.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const first = await start(),
    second = await start();
  await finish(fresh, "new");
  await second.promise;
  await finish(old, "stale");
  await first.promise;
  expect(qc.getQueryData(["me"])).toEqual(user("u1", "new"));
  expect(qc.getQueryData(["avatar-design", "me"])).toBeUndefined();
});
it("does not restore an old identity after a viewer switch", async () => {
  const pending = deferred();
  mocked.upload.mockReturnValue(pending.promise);
  const first = await start();
  setCurrentUserId("u2");
  qc.setQueryData(["me"], user("u2"));
  await finish(pending, "stale");
  await first.promise;
  expect(getCurrentUserId()).toBe("u2");
  expect(qc.getQueryData(["me"])).toEqual(user("u2"));
  expect(qc.getQueryData(["avatar-design", "me"])).toBe("old-design");
});
it("does not apply an upload after the editor unmounts", async () => {
  const pending = deferred();
  mocked.upload.mockReturnValue(pending.promise);
  const first = await start();
  await act(async () => root.unmount());
  unmounted = true;
  await finish(pending, "stale");
  await first.promise;
  expect(qc.getQueryData(["me"])).toEqual(user());
});
it("rejects the old result after logout/relogin to the same id", async () => {
  const pending = deferred();
  mocked.upload.mockReturnValue(pending.promise);
  const first = await start();
  clearCurrentUser();
  qc.setQueryData(["me"], null);
  setCurrentUserId("u1");
  qc.setQueryData(["me"], user("u1", "relogin"));
  await finish(pending, "stale");
  await first.promise;
  expect(qc.getQueryData(["me"])).toEqual(user("u1", "relogin"));
});
it("a current upload still succeeds after an earlier failure", async () => {
  mocked.upload.mockRejectedValueOnce(new Error("Upload denied"));
  let failed!: Promise<unknown>;
  await act(async () => {
    failed = hook.mutateAsync({ file: new File(["x"], "bad.png") }).catch((error) => error);
  });
  expect(await failed).toEqual(new Error("Upload denied"));
  expect(qc.getQueryData(["me"])).toEqual(user());
  const pending = deferred();
  mocked.upload.mockReturnValue(pending.promise);
  const next = await start();
  await finish(pending, "fresh");
  await next.promise;
  expect(qc.getQueryData(["me"])).toEqual(user("u1", "fresh"));
});
it("does not seat a response whose user does not match its request owner", async () => {
  const pending = deferred();
  mocked.upload.mockReturnValue(pending.promise);
  const next = await start();
  await act(async () => pending.resolve({ user: user("u2", "foreign"), avatar_url: "foreign" }));
  await next.promise;
  expect(getCurrentUserId()).toBe("u1");
  expect(qc.getQueryData(["me"])).toEqual(user());
});

it("seats the successful upload after a normal same-viewer profile refresh", async () => {
  const pending = deferred();
  mocked.upload.mockReturnValue(pending.promise);
  const next = await start();
  qc.setQueryData(["me"], { ...user(), display_name: "Refreshed profile", updated_at: 3 });
  await finish(pending, "fresh");
  await next.promise;
  expect(qc.getQueryData(["me"])).toEqual(user("u1", "fresh"));
  expect(qc.getQueryData(["avatar-design", "me"])).toBeUndefined();
});
