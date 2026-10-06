import { showsTabBar } from "@/navigation/presentation";
import { useLocation } from "react-router-dom";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useMobileHeaderActionRef, useMobileHeaderTarget } from "./mobile-header-slot";
import { getPlatform } from "@/platform";
import type { CSSProperties } from "react";
import {
  ActivityIcon,
  ChatsIcon,
  ChevronLeftIcon,
  ComputerIcon,
  MembersIcon,
  MoreIcon,
  SettingsIcon,
  TaskIcon,
} from "@/icons";
import { AppDropdownMenu, AppDropdownMenuItem } from "@/components/menus/app-context-menu";
import { useNavigationDriver } from "@/navigation/provider";
import { useNav, useRouteState } from "@/router";
import type { AppSection } from "./nav-rail";

export function MobileHeader({ hideFallback = false }: { hideFallback?: boolean }) {
  const target = useMobileHeaderTarget();
  const actionRef = useMobileHeaderActionRef();
  const { back, canBack } = useNavigationDriver();
  const route = useRouteState();
  const windowChrome = Boolean(getPlatform().shell);
  const title =
    route.section === "chat" ? "Chats" : route.section[0]!.toUpperCase() + route.section.slice(1);
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

export function MobileTabBar({ dots }: { dots?: Partial<Record<AppSection, boolean>> }) {
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
      <AppDropdownMenu
        side="top"
        contentClassName="mobile-more-menu"
        trigger={
          <button type="button" className="mobile-tab focus-outline">
            <MoreIcon size={20} />
            <span>More</span>
          </button>
        }
      >
        <AppDropdownMenuItem icon={<MembersIcon size={18} />} onSelect={() => nav.toMembers()}>
          Members
        </AppDropdownMenuItem>
        <AppDropdownMenuItem icon={<ComputerIcon size={18} />} onSelect={() => nav.toComputers()}>
          Computers
        </AppDropdownMenuItem>
        <AppDropdownMenuItem icon={<SettingsIcon size={18} />} onSelect={() => nav.toSettings()}>
          Settings
        </AppDropdownMenuItem>
      </AppDropdownMenu>
    </nav>
  );
}
