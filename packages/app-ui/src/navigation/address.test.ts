import { expect, it, vi } from "vitest";
import { connectAddress } from "./address";
import { NavigationStore } from "./store";

it("projects without a loop and treats external browser navigation as one intent", () => {
  const store = new NavigationStore("/chat/d/c");
  let address = "/chat/d/c";
  let listener: (() => void) | undefined;
  const replace = vi.fn((url: string) => {
    address = url;
  });
  let allowed = true;
  const off = connectAddress(
    store,
    {
      read: () => address,
      replace,
      subscribe: (fn) => {
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
    },
    () => allowed,
  );
  store.go("/chat/d/c?settings=c");
  expect(address).toBe("/chat/d/c?settings=c");
  expect(replace).toHaveBeenCalledTimes(2);
  address = "/tasks?task=t";
  listener!();
  expect(store.getSnapshot().tab).toBe("tasks");
  expect(store.getSnapshot().location.search).toBe("?task=t");
  allowed = false;
  address = "/chat/private";
  listener!();
  expect(address).toBe("/tasks?task=t");
  off();
  store.dispose();
  store.go("/chat/private");
  expect(address).toBe("/tasks?task=t");
  expect(listener).toBeUndefined();
});
