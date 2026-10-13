import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { PageBarCapability, PageBarEvent, PageBarState } from "@silverhand/client";
import { getPlatform } from "@/platform";
import { NavigationContext } from "./provider";

/*
 * The page/native boundary for the compact header. A page declares its header
 * as data, including every string, and keeps every handler:
 *
 *   page ──claim(declaration)──▶ PageBarHub ──sync──▶ native draws
 *   page ◀──handlers[kind]────── PageBarHub ◀──event── native tap
 *
 * The hub shows the latest-mounted claim still standing; the shell's fallback
 * claims below every page. Pages claim only while on screen, so one page hands
 * the bar to the next within a commit, and the hub sends once, after it.
 * Native code draws and reports which control was used; it decides nothing.
 */

/** The page header the shared UI declares; Back is added from navigation. */
export type PageBarDeclaration = Omit<PageBarState, "back">;
/** A declaration, or `"none"` for no bar. */
export type PageBarClaim = PageBarDeclaration | "none";
export type PageBarHandlers = {
  [K in Exclude<PageBarEvent["kind"], "back">]?: (
    event: Extract<PageBarEvent, { kind: K }>,
  ) => void;
};

type Claim = { bar: PageBarDeclaration | null; handlers: () => PageBarHandlers };

/** The order of the shell's fallback, below every page's. */
export const FALLBACK_ORDER = 0;

/** Decides what the native bar shows and where its events go. `flush` sends
 * the outcome of every change since the last one. */
export class PageBarHub {
  private readonly claims = new Map<number, Claim>();
  private next = FALLBACK_ORDER;
  private sent = "null";
  private synced: Promise<void> = Promise.resolve();
  private swipeLeft: string | null = null;
  private navigation = { canBack: false, page: null as string | null, back: () => {} };

  constructor(
    private readonly bar: PageBarCapability,
    private readonly changed: () => void,
  ) {}

  order(): number {
    return ++this.next;
  }

  claim(order: number, claim: Claim | null): void {
    if (claim) {
      this.claims.set(order, claim);
    } else {
      this.claims.delete(order);
    }
    this.changed();
  }

  navigate(navigation: { canBack: boolean; page: string | null; back: () => void }): void {
    this.navigation = navigation;
  }

  /** An edge swipe carries the page `share` of the way off; the bar fades with it. */
  swipeProgress(share: number): void {
    void this.bar.backProgress(share).catch(() => {});
  }

  /** The finger let go. After Back from `left`, the fade ends once the next
   * page's bar has been sent, so the faded bar never shows again. */
  swipeEnd(left: string | null): void {
    if (left === null) {
      void this.bar.backProgress(null).catch(() => {});
      return;
    }
    this.swipeLeft = left;
    this.changed();
  }

  flush(): void {
    const bar = this.standing()?.bar ?? null;
    const { canBack } = this.navigation;
    // A pushed page's title is never large.
    const state = bar
      ? { ...bar, back: canBack ? "Back" : null, largeTitle: canBack ? undefined : bar.largeTitle }
      : null;
    const serialized = JSON.stringify(state);
    if (serialized !== this.sent) {
      this.sent = serialized;
      this.synced = this.bar.sync(state).catch(() => {});
    }
    if (this.swipeLeft !== null && this.swipeLeft !== this.navigation.page) {
      this.swipeLeft = null;
      void this.synced.then(() => this.bar.backProgress(null)).catch(() => {});
    }
  }

  dispatch(event: PageBarEvent): void {
    if (event.kind === "back") {
      this.navigation.back();
      return;
    }
    const handler = this.standing()?.handlers()[event.kind] as
      | ((e: PageBarEvent) => void)
      | undefined;
    handler?.(event);
  }

  private standing(): Claim | null {
    return this.claims.get(Math.max(-1, ...this.claims.keys())) ?? null;
  }
}

const HubContext = createContext<PageBarHub | null>(null);

/** Hosts the hub for the platform's native page bar, if it has one. */
export function PageBarHost({ children }: { children: ReactNode }): JSX.Element {
  const pageBar = getPlatform().pageBar;
  const driver = useContext(NavigationContext);
  const [version, setVersion] = useState(0);
  const [hub] = useState(() =>
    pageBar ? new PageBarHub(pageBar, () => setVersion((v) => v + 1)) : null,
  );

  const canBack = driver?.canBack ?? false;
  const page = driver?.page ?? null;
  const back = driver?.back;
  useEffect(() => {
    hub?.navigate({ canBack, page, back: () => void back?.() });
    hub?.flush();
  }, [hub, version, canBack, page, back]);

  useEffect(() => {
    if (!pageBar || !hub) {
      return;
    }

    const listening = pageBar.subscribe((event) => hub.dispatch(event));
    return () => {
      void listening.then((remove) => remove());
      // The shell leaves (a session lost to the sign-in gate) without a last
      // flush, so the bar would keep the previous page.
      void pageBar.sync(null).catch(() => {});
    };
  }, [pageBar, hub]);

  return <HubContext.Provider value={hub}>{children}</HubContext.Provider>;
}

/** Shows `bar` in the native bar while it is set; taps come back to
 * `handlers`. A `fallback` claim shows only while no page claims the bar. */
export function usePageBarClaim(
  bar: PageBarClaim | null,
  handlers: PageBarHandlers,
  { fallback = false }: { fallback?: boolean } = {},
): void {
  const hub = useContext(HubContext);
  const [order] = useState(() => (fallback ? FALLBACK_ORDER : (hub?.order() ?? FALLBACK_ORDER)));
  const latest = useRef(handlers);
  latest.current = handlers;
  const serialized = bar ? JSON.stringify(bar) : null;

  useEffect(() => {
    if (!hub || serialized === null) {
      return;
    }

    const claimed = JSON.parse(serialized) as PageBarClaim;
    hub.claim(order, {
      bar: claimed === "none" ? null : claimed,
      handlers: () => latest.current,
    });
    return () => hub.claim(order, null);
  }, [hub, order, serialized]);
}

/** The bar's side of an edge swipe; null without a native bar. */
export function usePageBarSwipe(): PageBarHub | null {
  return useContext(HubContext);
}
