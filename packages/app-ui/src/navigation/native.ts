import { modalScope } from "@/lib/modal-scope";
import { useCallback, useEffect } from "react";
import { getPlatform } from "@/platform";
import { useCompactLayout } from "./layout";
import { showsTabBar, isMoreDestination } from "./presentation";
import type { NavigationStore } from "./store";
import type { MainTab } from "./history";

export function useNativeNavigation(store: NavigationStore, allowed: () => boolean) {
  const native = getPlatform().navigation;
  const compact = useCompactLayout();
  const run = useCallback(
    async (commit: () => void, nativeIntent = false) => {
      const modalVersion = modalScope.version;
      const modalAllows = () =>
        !nativeIntent || (!modalScope.blocked && modalScope.version === modalVersion);
      if (!modalAllows()) return false;
      if (!store.active || !allowed()) return false;
      const before = store.getSnapshot();
      if (native) {
        // Capture the outgoing page before React commits the destination. Failure
        // only removes the visual preview; it must not disable ordinary navigation.
        await native.capture({ session: store.session, key: before.location.key }).catch(() => {});
        if (!store.active || store.getSnapshot() !== before || !modalAllows() || !allowed())
          return false;
      }
      commit();
      return store.getSnapshot() !== before;
    },
    [store, native, allowed],
  );

  useEffect(() => {
    if (!native) return;
    let alive = true;
    const sync = async () => {
      const snapshot = store.getSnapshot();
      const { location, tab, back } = snapshot;
      const parent = back?.url.split("?");
      const result = await native
        .sync({
          session: store.session,
          key: location.key,
          tab: isMoreDestination(location.pathname) ? "more" : tab,
          blocked: modalScope.blocked,
          modalVersion: modalScope.version,
          visible: compact && showsTabBar(location.pathname, location.search),
          backKey: back?.key,
          backVisible: compact && parent ? showsTabBar(parent[0]!, parent[1] ?? "") : false,
        })
        .catch(() => null);
      if (alive && result && snapshot === store.getSnapshot())
        document.documentElement.style.setProperty(
          "--native-navigation-inset",
          `${result.bottomInset}px`,
        );
    };
    void sync();
    const offModal = modalScope.subscribe(() => {
      void sync();
    });
    const off = store.subscribe(() => {
      void sync();
    });
    const requests = new Set<string>();
    const listening = native.subscribe((intent) => {
      if (!alive || intent.session !== store.session) return;
      if (intent.request) {
        if (requests.has(intent.request)) return;
        requests.add(intent.request);
      }
      if (
        intent.modalVersion !== modalScope.version ||
        (intent.kind === "back" && intent.key !== store.getSnapshot().location.key)
      ) {
        if (intent.request)
          void native.finish({ session: store.session, request: intent.request, accepted: false });
        return;
      }
      const commit =
        intent.kind === "back"
          ? store.back
          : intent.kind === "tab" && ["chat", "activity", "tasks"].includes(intent.target ?? "")
            ? () => store.selectTab(intent.target as MainTab)
            : intent.kind === "more" &&
                ["members", "computers", "settings"].includes(intent.target ?? "")
              ? () => store.go(`/${intent.target}`)
              : undefined;
      if (!commit) return;
      void run(commit, true).then(async (accepted) => {
        if (!alive || !intent.request) return;
        await sync();
        // Allow the new page to paint underneath the native transition image.
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        if (alive)
          await native.finish({ session: store.session, request: intent.request, accepted });
      });
    });
    return () => {
      alive = false;
      off();
      offModal();
      void listening.then((remove) => remove());
      void native.reset(store.session);
      document.documentElement.style.removeProperty("--native-navigation-inset");
    };
  }, [store, native, run, compact]);
  return run;
}
