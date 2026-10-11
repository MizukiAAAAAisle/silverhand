import { showsTabBar } from "@/navigation/presentation";
import { useLocation } from "react-router-dom";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useMobileHeaderActionRef, useMobileHeaderTarget } from "./mobile-header-slot";
import { getPlatform } from "@/platform";
import type { CSSProperties } from "react";
import { ActivityIcon, ChatsIcon, ChevronLeftIcon, TaskIcon } from "@/icons";
import { UserAvatar } from "@/components/user-avatar";
import { AVATAR_PX } from "@/components/avatar-scale";
import { useNavigationDriver } from "@/navigation/provider";
import { usePageBarClaim } from "@/navigation/page-bar";
import { useNativeBarPlatform } from "./native-page-bar";
import { useNav, useRouteState } from "@/router";
import type { AppSection } from "./nav-rail";

/** The section's header, for a page that draws none: Back and the section
 * name. With a native bar it is the bar's fallback, which a page's own
 * declaration replaces. */
export function MobileHeader({ hideFallback = false }: { hideFallback?: boolean }) {
  const native = useNativeBarPlatform();
  const target = useMobileHeaderTarget();
  const actionRef = useMobileHeaderActionRef();
  const { back, canBack } = useNavigationDriver();
  const route = useRouteState();
  const windowChrome = Boolean(getPlatform().shell);
  const title =
    route.section === "chat" ? "Chats" : route.section[0]!.toUpperCase() + route.section.slice(1);
  usePageBarClaim(
    native ? { title, titleAction: null, actions: [], tabs: null, addTabs: null } : null,
    {},
    { fallback: true },
  );
  if (native) {
    return null;
  }
  const backButton = canBack ? (
    <button
      type="button"
      className="mobile-back no-drag focus-outline"
      aria-label="Back"
      onClick={back}
    >
      <span className="mobile-back-icon">
        <ChevronLeftIcon size={22} strokeWidth={2.25} />
      </span>
    </button>
  ) : null;
  if (hideFallback && !windowChrome) return null;
  if (target && !windowChrome) return createPortal(backButton, target);
  return (
    <header
      className="mobile-header"
      style={
        windowChrome
          ? ({
              WebkitAppRegion: "drag",
              paddingLeft: "var(--titlebar-controls-safe-width)",
            } as CSSProperties)
          : undefined
      }
    >
      <span className="mobile-header-leading">{backButton}</span>
      <span className="mobile-header-title">{title}</span>
      <span ref={actionRef ?? undefined} className="mobile-header-trailing" />
    </header>
  );
}

export function MobileTabBar({
  dots,
  avatarObjectUrl,
}: {
  dots?: Partial<Record<AppSection, boolean>>;
  avatarObjectUrl: string | null;
}) {
  const navigation = useNavigationDriver();
  const nav = useNav();
  const location = useLocation();
  useEffect(() => {
    void getPlatform().navigation?.badges({
      session: navigation.session,
      chat: dots?.chat,
      activity: dots?.activity,
      tasks: dots?.tasks,
    });
  }, [navigation.session, dots]);
  useEffect(() => {
    const native = getPlatform().navigation;
    if (!native) {
      return;
    }

    let cancelled = false;
    void readAvatarBase64(avatarObjectUrl).then((base64) => {
      if (!cancelled) {
        void native.avatar(base64).catch(() => {});
      }
    });

    return () => {
      cancelled = true;
    };
  }, [avatarObjectUrl]);
  if (getPlatform().navigation || !showsTabBar(location.pathname, location.search)) return null;
  return (
    <nav className="mobile-tabbar" aria-label="Main navigation">
      {(
        [
          { tab: "chat", label: "Chats", Icon: ChatsIcon },
          { tab: "activity", label: "Activity", Icon: ActivityIcon },
          { tab: "tasks", label: "Tasks", Icon: TaskIcon },
        ] as const
      ).map(({ tab, label, Icon }) => (
        <button
          type="button"
          className="mobile-tab focus-outline"
          key={tab}
          aria-current={navigation.tab === tab ? "page" : undefined}
          onClick={() => nav.navigate({ kind: "tab", tab })}
        >
          <span className="relative">
            <Icon size={20} />
            {dots?.[tab] && <span className="mobile-attention" aria-label="Unread" />}
          </span>
          <span>{label}</span>
        </button>
      ))}
      <button
        type="button"
        className="mobile-tab focus-outline"
        aria-current={navigation.tab === "me" ? "page" : undefined}
        onClick={() => nav.navigate({ kind: "tab", tab: "me" })}
      >
        <UserAvatar
          size={AVATAR_PX.sm}
          avatarObjectUrl={avatarObjectUrl}
          className="rounded-full"
        />
        <span>Me</span>
      </button>
    </nav>
  );
}

/** Object URLs are local to this page, so native receives the pixels instead.
 * WKWebView cannot `fetch` a blob URL; an image element can still decode it. */
async function readAvatarBase64(objectUrl: string | null): Promise<string | undefined> {
  if (!objectUrl) {
    return undefined;
  }

  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();

    // Three times the native 26pt tab image keeps the bridge payload small.
    const side = 78;
    const scale = side / Math.min(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = side;
    canvas.height = side;
    canvas
      .getContext("2d")
      ?.drawImage(
        image,
        (side - image.naturalWidth * scale) / 2,
        (side - image.naturalHeight * scale) / 2,
        image.naturalWidth * scale,
        image.naturalHeight * scale,
      );
    return canvas.toDataURL("image/png").split(",")[1];
  } catch {
    return undefined;
  }
}
