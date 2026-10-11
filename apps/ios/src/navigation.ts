import type { ClientPlatform } from "@silverhand/client";
import type { NativeBridge } from "./bridge";

/** Serializes native presentation commands without owning navigation state. */
export function createIOSNavigation(
  bridge: NativeBridge,
): NonNullable<ClientPlatform["navigation"]> {
  let navigationQueue: Promise<unknown> = Promise.resolve();
  const navigationCall = <T>(call: () => Promise<T>): Promise<T> => {
    const result = navigationQueue.then(call);
    navigationQueue = result.catch(() => {});
    return result;
  };

  return {
    badges: (input) => navigationCall(() => bridge.navigationBadges(input)),
    sync: (state) => navigationCall(() => bridge.navigationSync(state)),
    reset: (session) => navigationCall(() => bridge.navigationReset({ session })),
    avatar: (base64) => navigationCall(() => bridge.navigationAvatar({ base64 })),
    subscribe: async (handler) => {
      const listener = await bridge.addListener("navigation", handler);
      return () => {
        void listener.remove();
      };
    },
  };
}
