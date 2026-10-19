import { type ReactNode, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  ArrowDownIcon,
  ArrowRightToLineIcon,
  ArrowUpIcon,
  ClockIcon,
  EnterIcon,
  HashIcon,
  LockIcon,
  MembersIcon,
  MessageResultIcon,
  SearchIcon,
} from "@/icons";
import type { TitlebarCapability } from "@silverhand/client";
import type { AgentDto, SearchIdentity, SearchResultDto } from "@silverhand/shared";

import { AVATAR_PX } from "@/components/avatar-scale";
import { Button } from "@/components/ui/button";
import { ChannelIcon } from "@/components/channel-icon";
import { useSidebarStyle } from "@/features/conversation-shell/use-sidebar-style";
import { CollectionItemCard } from "@/components/layout/collection-item-card";
import { ChannelAvatar } from "@/features/conversations/components/channel-avatar";
import { recentTimeLabel } from "@/features/conversations/latest/recent-rows";
import {
  useRecentConversations,
  type RecentConversation,
} from "@/features/conversations/latest/use-recent-conversations";
import {
  collectCounterpartAvatarSources,
  presentCounterpart,
} from "@/features/direct-pairs/counterpart-presentation";
import { AuthorAvatarView } from "@/features/messages/components/author-avatar-view";
import { useUserAvatarObjectUrls } from "@/features/users/avatar-hooks";
import { useAuthorAvatarObjectUrls } from "@/features/messages/hooks/author-avatar-hooks";
import { cn } from "@/lib/cn";
import { useAgents } from "@/features/agents/hooks/hooks";
import { useAgentAvatarObjectUrls } from "@/features/agents/hooks/avatar-hooks";
import { useDirectPairs } from "@/features/direct-pairs/hooks";
import type { DirectMessageTarget } from "@/features/direct-pairs/target";
import { useMessageSearch } from "@/features/search/hooks";
import { SearchResultItem, type SearchItem } from "@/features/search/search-result-item";

export interface TitlebarSearchNav {
  onJumpMessage: (params: {
    workspaceId?: string;
    channelId: string;
    threadRootId?: string | null;
    messageId: string;
  }) => void;
  onOpenConversation: (workspaceId: string, channelId: string) => void;
  onOpenWorkspace: (workspaceId: string) => void;
  onOpenDirectPair: (conversationId: string) => void;
  onOpenDirectDraft: (target: DirectMessageTarget) => void;
  onOpenAdvanced: (query: string) => void;
}

type FlatRow =
  | { kind: "recent"; key: string; conversation: RecentConversation }
  | { kind: "channel"; key: string; result: Extract<SearchResultDto, { type: "conversation" }> }
  | { kind: "workspace"; key: string; result: Extract<SearchResultDto, { type: "workspace" }> }
  | { kind: "identity"; key: string; candidate: SearchIdentity }
  | { kind: "message"; key: string; result: Extract<SearchResultDto, { type: "message" }> };

type FilterKind = "all" | "channels" | "people" | "messages";

const FILTER_TABS: Array<{ value: FilterKind; label: string }> = [
  { value: "all", label: "All" },
  { value: "people", label: "Human & Agents" },
  { value: "channels", label: "Channels" },
  { value: "messages", label: "Messages" },
];

/**
 * Slack-style global search anchored in the titlebar (#task:2557). Reuses the
 * sidebar's search capability (`useMessageSearch` + server identity results);
 * the advanced Search panel keeps the workspace / sender / time axes.
 */
export function TitlebarSearch({ nav }: { nav: TitlebarSearchNav }): JSX.Element {
  const [open, setOpen] = useState(false);
  const search = useTitlebarSearchModel(nav, () => setOpen(false));
  const inputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== "k") return;
      const meta = event.metaKey || event.ctrlKey;
      if (!meta || event.altKey || event.shiftKey) return;
      event.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    // While an IME composition is active, Enter / arrows belong to the
    // candidate window, not the result list (`keyCode === 229` covers the
    // browsers that fire keydown before `compositionend`).
    if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    const key =
      event.key === "ArrowDown"
        ? "down"
        : event.key === "ArrowUp"
          ? "up"
          : event.key === "Tab"
            ? event.shiftKey
              ? "backtab"
              : "tab"
            : event.key === "Enter"
              ? "enter"
              : null;
    if (key && search.press(key)) event.preventDefault();
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) search.setActiveIndex(0);
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Search"
          className={cn(
            "no-drag flex h-6 w-full items-center gap-2 rounded-(--control-radius) px-2.5 text-left text-xs outline-none",
            "bg-text-primary/10 text-text-muted transition-colors hover:bg-text-primary/[0.14]",
          )}
        >
          <SearchIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Search everything</span>
          <kbd className="shrink-0 rounded-(--chip-radius) bg-text-primary/[0.16] px-1.5 py-0.5 font-sans text-(length:--text-badge) leading-none text-text-secondary">
            ⌘K
          </kbd>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="center"
          sideOffset={6}
          data-popover-frame
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
          }}
          className={RESULTS_FRAME}
        >
          <div
            data-search-divider="b"
            className="flex items-center gap-2 border-b border-border px-3 py-2.5"
          >
            <SearchIcon className="size-4 shrink-0 text-text-muted" />
            <input
              ref={inputRef}
              value={search.query}
              onChange={(e) => search.setQuery(e.target.value)}
              onKeyDown={onInputKeyDown}
              onCompositionStart={() => {
                composingRef.current = true;
              }}
              onCompositionEnd={() => {
                composingRef.current = false;
              }}
              placeholder="Search messages, channels, humans"
              className="min-w-0 flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
            />
            {search.isFetching ? (
              <span className="shrink-0 text-xs text-text-muted">Searching…</span>
            ) : null}
          </div>
          <TitlebarSearchResults search={search} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * The same search for a native titlebar (iOS wide layout): the system search
 * field there sends its text and keys; the results open below it while the
 * field is in use.
 */
export function NativeTitlebarSearch({
  nav,
  titlebar,
}: {
  nav: TitlebarSearchNav;
  titlebar: TitlebarCapability;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const close = (clear: boolean): void => {
    setOpen(false);
    void titlebar.endSearch({ clear }).catch(() => {});
  };
  const search = useTitlebarSearchModel(nav, () => close(true));
  const pressRef = useRef(search.press);
  pressRef.current = search.press;
  const { setQuery } = search;

  useEffect(() => {
    const listening = titlebar.subscribe((event) => {
      if (event.kind === "searchFocus") {
        setOpen(true);
      } else if (event.kind === "searchQuery") {
        setQuery(event.query);
        setOpen(true);
      } else if (event.kind === "searchKey") {
        if (event.key === "escape") {
          setOpen(false);
          void titlebar.endSearch({ clear: false }).catch(() => {});
        } else {
          pressRef.current(event.key);
        }
      }
    });
    return () => {
      void listening.then((remove) => remove());
    };
  }, [titlebar, setQuery]);

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) close(false);
      }}
    >
      {/* Stands where the native field ends, so the results open beneath it. */}
      <Popover.Anchor className="pointer-events-none fixed top-(--native-bar-bottom,env(safe-area-inset-top,0px)) left-1/2 h-0 w-[clamp(420px,52vw,720px)] -translate-x-1/2" />
      <Popover.Portal>
        <Popover.Content
          align="center"
          sideOffset={6}
          data-popover-frame
          // The native field keeps the keyboard focus.
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          className={RESULTS_FRAME}
        >
          <TitlebarSearchResults search={search} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

const RESULTS_FRAME =
  "z-(--z-popover) w-(--radix-popover-trigger-width) overflow-hidden bg-bg-floating shadow-popover outline-none";

type SearchKey = "up" | "down" | "tab" | "backtab" | "enter";

type TitlebarSearchModel = ReturnType<typeof useTitlebarSearchModel>;

/** Query, results and the keyboard cursor shared by both search fields. */
function useTitlebarSearchModel(nav: TitlebarSearchNav, onDone: () => void) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKind>("all");
  const [activeIndex, setActiveIndex] = useState(0);

  const trimmed = query.trim();
  const deferredQuery = useDeferredValue(query);

  const { data: agents = [] } = useAgents();
  const { data, isFetching, isError, refetch } = useMessageSearch({
    q: deferredQuery,
    limit: 30,
    include_identities: true,
  });
  const identities = isError ? undefined : data?.identities;
  const results = useMemo(() => data?.results ?? [], [data]);

  const channels = useMemo(
    () =>
      results.filter(
        (r): r is Extract<SearchResultDto, { type: "conversation" }> => r.type === "conversation",
      ),
    [results],
  );
  const workspaces = useMemo(
    () =>
      results.filter(
        (r): r is Extract<SearchResultDto, { type: "workspace" }> => r.type === "workspace",
      ),
    [results],
  );
  const messages = useMemo(
    () =>
      results.filter(
        (r): r is Extract<SearchResultDto, { type: "message" }> => r.type === "message",
      ),
    [results],
  );
  const identityRows = useMemo(
    () => (identities ? [...identities.humans.results, ...identities.agents.results] : []),
    [identities],
  );

  // Byline avatar bytes come strictly from each message hit's own author DTO,
  // never a directory join (#task:1792 B2).
  const messageAuthors = useMemo(() => messages.map((m) => m.message.author), [messages]);
  const { agentAvatarUrls, humanAvatarUrls } = useAuthorAvatarObjectUrls(messageAuthors);

  // Before a query the field lists where the viewer was last, so a known
  // conversation is one arrow and Enter away in every sidebar mode.
  const allRecent = useRecentConversations();
  const recent = useMemo(() => allRecent.slice(0, RECENT_LIMIT), [allRecent]);
  const recentSources = useMemo(
    () =>
      collectCounterpartAvatarSources(
        recent.flatMap((row) => (row.kind === "direct" ? [row] : [])),
      ),
    [recent],
  );
  const recentAgentAvatars = useAgentAvatarObjectUrls(recentSources.agents);
  const recentHumanAvatars = useUserAvatarObjectUrls(recentSources.users);

  // One flat ordered list drives both the sections and the arrow-key cursor, so
  // the highlighted row and the row Enter opens can never disagree.
  const sections = useMemo(
    () =>
      trimmed.length === 0
        ? recentSection(recent)
        : buildSections(filter, channels, workspaces, identityRows, messages),
    [trimmed.length, recent, filter, channels, workspaces, identityRows, messages],
  );
  const flatRows = useMemo(() => sections.flatMap((section) => section.rows), [sections]);

  useEffect(() => {
    setActiveIndex(0);
  }, [deferredQuery, filter]);

  useEffect(() => {
    if (activeIndex >= flatRows.length) setActiveIndex(Math.max(0, flatRows.length - 1));
  }, [activeIndex, flatRows.length]);

  const pairs = useDirectPairs();

  const finish = (): void => {
    setQuery("");
    onDone();
  };

  const runRow = (row: FlatRow): void => {
    if (row.kind === "recent") {
      const conversation = row.conversation;
      if (conversation.kind === "channel") {
        nav.onOpenConversation(conversation.workspaceId, conversation.id);
      } else {
        nav.onOpenDirectPair(conversation.id);
      }
    } else if (row.kind === "message") {
      const place = row.result.conversation;
      if (place.placement_kind === "workspace") {
        nav.onJumpMessage({
          workspaceId: place.workspace.id,
          channelId: place.channel_id,
          threadRootId: row.result.message.thread_root_id,
          messageId: row.result.message.id,
        });
      } else {
        nav.onJumpMessage({
          channelId: place.channel_id,
          threadRootId: row.result.message.thread_root_id,
          messageId: row.result.message.id,
        });
      }
    } else if (row.kind === "channel") {
      if (row.result.conversation.placement_kind === "workspace") {
        nav.onOpenConversation(
          row.result.conversation.workspace.id,
          row.result.conversation.channel_id,
        );
      }
    } else if (row.kind === "workspace") {
      nav.onOpenWorkspace(row.result.workspace.id);
    } else {
      const identity = row.candidate;
      const target: DirectMessageTarget = { kind: row.candidate.kind, id: identity.id };
      const existing = pairs.find(
        (pair) => pair.counterpart.kind === target.kind && pair.counterpart.id === target.id,
      );

      if (existing) nav.onOpenDirectPair(existing.conversation_id);
      else nav.onOpenDirectDraft(target);
    }

    finish();
  };

  const openAdvanced = (): void => {
    nav.onOpenAdvanced(trimmed);
    finish();
  };

  /** Moves the cursor, switches the filter or opens the active row; returns
   *  whether the key was used. */
  const press = (key: SearchKey): boolean => {
    if (key === "down") {
      setActiveIndex((i) => Math.min(i + 1, Math.max(0, flatRows.length - 1)));
      return true;
    }
    if (key === "up") {
      setActiveIndex((i) => Math.max(i - 1, 0));
      return true;
    }
    if (key === "tab" || key === "backtab") {
      if (trimmed.length === 0) return false;
      const current = FILTER_TABS.findIndex((tab) => tab.value === filter);
      const step = key === "backtab" ? -1 : 1;
      const nextTab = FILTER_TABS[(current + step + FILTER_TABS.length) % FILTER_TABS.length];
      if (nextTab) setFilter(nextTab.value);
      return true;
    }
    const row = flatRows[activeIndex];
    if (!row) return false;
    runRow(row);
    return true;
  };

  const agentsById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  // Owner-avatar bytes for agent-space hits; without them WorkspaceIcon resolves
  // the owner but falls back to the runtime glyph.
  const ownerAgentAvatars = useAgentAvatarObjectUrls(agents);
  const identityHumanAvatars = useAgentAvatarObjectUrls(
    identityRows.flatMap((c) => (c.kind === "human" ? [c] : [])),
  );
  const identityAgentAvatars = useAgentAvatarObjectUrls(
    identityRows.flatMap((c) => (c.kind === "agent" ? [c] : [])),
  );

  return {
    query,
    setQuery,
    trimmed,
    deferredQuery,
    filter,
    setFilter,
    activeIndex,
    setActiveIndex,
    counts: {
      all: channels.length + workspaces.length + identityRows.length + messages.length,
      channels: channels.length + workspaces.length,
      people: identityRows.length,
      messages: messages.length,
    } satisfies Record<FilterKind, number>,
    identities,
    sections,
    flatRows,
    isFetching,
    isError,
    refetch,
    runRow,
    openAdvanced,
    press,
    avatars: {
      recentAgentAvatars,
      recentHumanAvatars,
      agentsById,
      ownerAgentAvatars,
      agentAvatarUrls,
      humanAvatarUrls,
      identityHumanAvatars,
      identityAgentAvatars,
    },
  };
}

/** Filter tabs, result sections and the footer below either search field. */
function TitlebarSearchResults({ search }: { search: TitlebarSearchModel }): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const { activeIndex, flatRows, identities, sections, trimmed } = search;

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>("[data-active]");
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <>
      {trimmed.length > 0 ? (
        <div className="flex gap-1.5 px-3 py-2">
          {FILTER_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              onClick={() => search.setFilter(tab.value)}
              className={cn(
                "rounded-(--pill-radius) border-(length:--control-border-width) px-2.5 py-0.5 text-xs transition-colors",
                search.filter === tab.value
                  ? "border-(--border-row-selected) bg-(--bg-row-selected) text-text-on-selected"
                  : "border-border text-text-secondary hover:border-(--border-control-hover) hover:bg-bg-hover",
              )}
            >
              {tab.label}
              <span
                className={cn(
                  "ml-1 text-(length:--text-badge)",
                  search.filter === tab.value ? "text-text-on-selected/70" : "text-text-muted",
                )}
              >
                {search.counts[tab.value]}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {search.isError ? (
        <div role="alert" className="px-3 py-2 text-sm text-text-muted">
          Search failed.{" "}
          <button type="button" onClick={() => void search.refetch()}>
            Retry
          </button>
        </div>
      ) : null}
      {identities && (identities.humans.truncated || identities.agents.truncated) ? (
        <p className="px-3 py-2 text-xs text-text-muted">
          Showing up to 20 matches per people category. Refine your search for more results.
        </p>
      ) : null}
      <div
        ref={listRef}
        className="search-list scrollbar-hide max-h-[min(60vh,440px)] overflow-y-auto p-2"
      >
        {trimmed.length === 0 && sections.length === 0 ? (
          <SearchEmptyState text="Search across your project" />
        ) : sections.length === 0 && !search.isFetching && !search.isError ? (
          <SearchEmptyState text="No results" />
        ) : (
          sections.map((section) => (
            <section key={section.key} className="mb-3 last:mb-0">
              <header className="flex items-center gap-2 px-1 pb-1.5 text-(length:--text-badge) font-semibold uppercase tracking-wider text-text-muted">
                {section.icon}
                <span>{section.label}</span>
                <span className="text-text-muted/70">{section.rows.length}</span>
              </header>
              <ul className="space-y-1.5">
                {section.rows.map((row) => {
                  const index = flatRows.indexOf(row);
                  return (
                    <li key={row.key}>
                      {row.kind === "recent" ? (
                        <RecentConversationRow
                          conversation={row.conversation}
                          active={index === activeIndex}
                          agentAvatarUrls={search.avatars.recentAgentAvatars}
                          humanAvatarUrls={search.avatars.recentHumanAvatars}
                          onMouseEnter={() => search.setActiveIndex(index)}
                          onClick={() => search.runRow(row)}
                        />
                      ) : (
                        <TitlebarSearchRow
                          row={row}
                          query={search.deferredQuery}
                          active={index === activeIndex}
                          {...search.avatars}
                          onMouseEnter={() => search.setActiveIndex(index)}
                          onClick={() => search.runRow(row)}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>

      <div
        data-search-divider="t"
        className="flex items-center justify-between gap-3 border-t border-border px-3 py-2 text-(length:--text-meta) text-text-muted"
      >
        <span className="flex items-center gap-3">
          <FooterHint keys={[<EnterIcon className="size-3" />]} label="Open" />
          <FooterHint
            keys={[<ArrowUpIcon className="size-3" />, <ArrowDownIcon className="size-3" />]}
            label="Navigate"
          />
          <FooterHint keys={[<ArrowRightToLineIcon className="size-3" />]} label="Switch type" />
          <FooterHint keys={["esc"]} label="Close" />
        </span>
        <Button
          type="button"
          variant="soft"
          size="xs"
          data-sticker
          data-sticker-size="md"
          data-sticker-tone="neutral"
          onClick={search.openAdvanced}
        >
          Advanced search
        </Button>
      </div>
    </>
  );
}

const RECENT_LIMIT = 8;

function recentSection(recent: readonly RecentConversation[]): Section[] {
  if (recent.length === 0) {
    return [];
  }

  return [
    {
      key: "recent",
      label: "Recent",
      icon: <ClockIcon className="size-3" />,
      rows: recent.map((conversation): FlatRow => ({
        kind: "recent",
        key: `recent:${conversation.id}`,
        conversation,
      })),
    },
  ];
}

/** A conversation the viewer was last in: its face, its name, where it lives and
 *  when it last moved; one line, so the list stays short enough to scan. */
function RecentConversationRow({
  conversation,
  active,
  agentAvatarUrls,
  humanAvatarUrls,
  onMouseEnter,
  onClick,
}: {
  conversation: RecentConversation;
  active: boolean;
  agentAvatarUrls: ReadonlyMap<string, string | null>;
  humanAvatarUrls: ReadonlyMap<string, string | null>;
  onMouseEnter: () => void;
  onClick: () => void;
}): JSX.Element {
  // Each conversation wears the face the sidebar gives it, so a row read here is
  // recognised there: the tree's `#` and small avatar, or the Recent list's tiles.
  const tree = useSidebarStyle() === "tree";
  const counterpart =
    conversation.kind === "direct" ? presentCounterpart(conversation.counterpart) : null;
  const title = conversation.kind === "channel" ? conversation.title : counterpart!.label;
  const at = conversation.latest?.created_at ?? null;

  return (
    <CollectionItemCard
      as="button"
      type="button"
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      data-active={active ? "" : undefined}
      className="flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left"
    >
      {tree ? (
        <span className="flex size-5.5 shrink-0 items-center justify-center">
          {conversation.kind === "direct" ? (
            <AuthorAvatarView
              avatar={counterpart!.avatar}
              size={AVATAR_PX.xs}
              label={counterpart!.label}
              agentAvatarUrls={agentAvatarUrls}
              humanAvatarUrls={humanAvatarUrls}
            />
          ) : (
            <ChannelIcon variant="sticker" visibility={conversation.visibility} />
          )}
        </span>
      ) : (
        <span data-recent-avatar className="flex shrink-0">
          {counterpart ? (
            <AuthorAvatarView
              avatar={counterpart.avatar}
              size={AVATAR_PX.md}
              label={counterpart.label}
              agentAvatarUrls={agentAvatarUrls}
              humanAvatarUrls={humanAvatarUrls}
            />
          ) : (
            <ChannelAvatar id={conversation.id} title={title} size={AVATAR_PX.md} />
          )}
        </span>
      )}
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="min-w-0 truncate text-sm font-medium text-text-primary">{title}</span>
        {!tree && conversation.kind === "channel" && conversation.visibility === "private" ? (
          <LockIcon
            role="img"
            aria-label="Private"
            className="-mx-0.5 size-3 shrink-0 self-center text-text-muted"
          />
        ) : null}
        {conversation.kind === "channel" ? (
          <span className="min-w-0 shrink-[999] truncate text-xs text-text-muted">
            {conversation.workspaceName}
          </span>
        ) : null}
      </span>
      {at !== null ? (
        <span className="shrink-0 text-xs tabular-nums text-text-muted">
          {recentTimeLabel(at, Date.now())}
        </span>
      ) : null}
    </CollectionItemCard>
  );
}

interface Section {
  key: string;
  label: string;
  icon: JSX.Element;
  rows: FlatRow[];
}

function SearchEmptyState({ text }: { text: string }): JSX.Element {
  return (
    <div className="flex min-h-55 items-center justify-center gap-2 px-4 text-center text-sm text-text-muted">
      <SearchIcon className="size-4 shrink-0 opacity-60" />
      {text}
    </div>
  );
}

function FooterHint({ keys, label }: { keys: ReactNode[]; label: string }): JSX.Element {
  return (
    <span className="flex items-center gap-1">
      {keys.map((key, i) => (
        <kbd
          key={i}
          className="inline-flex h-4 min-w-4.5 items-center justify-center rounded-(--chip-radius) bg-text-primary/10 px-1 font-sans text-(length:--text-meta) leading-none text-text-secondary"
        >
          {key}
        </kbd>
      ))}
      <span>{label}</span>
    </span>
  );
}

function buildSections(
  filter: FilterKind,
  channels: Array<Extract<SearchResultDto, { type: "conversation" }>>,
  workspaces: Array<Extract<SearchResultDto, { type: "workspace" }>>,
  identityRows: SearchIdentity[],
  messages: Array<Extract<SearchResultDto, { type: "message" }>>,
): Section[] {
  const showChannels = filter === "all" || filter === "channels";
  const showPeople = filter === "all" || filter === "people";
  const showMessages = filter === "all" || filter === "messages";

  const sections: Section[] = [];

  if (showPeople && identityRows.length > 0) {
    sections.push({
      key: "people",
      label: "Human & Agents",
      icon: <MembersIcon className="size-3" />,
      rows: identityRows.map((candidate): FlatRow => ({
        kind: "identity",
        key: `identity:${candidate.kind}:${candidate.id}`,
        candidate,
      })),
    });
  }

  if (showChannels && (channels.length > 0 || workspaces.length > 0)) {
    sections.push({
      key: "channels",
      label: "Channels",
      icon: <HashIcon className="size-3" />,
      rows: [
        ...channels.map((result): FlatRow => ({
          kind: "channel",
          key: `channel:${result.conversation.id}`,
          result,
        })),
        ...workspaces.map((result): FlatRow => ({
          kind: "workspace",
          key: `workspace:${result.workspace.id}`,
          result,
        })),
      ],
    });
  }

  if (showMessages && messages.length > 0) {
    sections.push({
      key: "messages",
      label: "Messages",
      icon: <MessageResultIcon className="size-3" />,
      rows: messages.map((result): FlatRow => ({
        kind: "message",
        key: `message:${result.message.id}`,
        result,
      })),
    });
  }

  return sections;
}

function TitlebarSearchRow({
  row,
  query,
  active,
  agentsById,
  ownerAgentAvatars,
  agentAvatarUrls,
  humanAvatarUrls,
  identityHumanAvatars,
  identityAgentAvatars,
  onMouseEnter,
  onClick,
}: {
  row: Exclude<FlatRow, { kind: "recent" }>;
  query: string;
  active: boolean;
  agentsById: ReadonlyMap<string, AgentDto>;
  ownerAgentAvatars: ReadonlyMap<string, string | null>;
  agentAvatarUrls: Map<string, string | null>;
  humanAvatarUrls: Map<string, string | null>;
  identityHumanAvatars: Map<string, string | null>;
  identityAgentAvatars: Map<string, string | null>;
  onMouseEnter: () => void;
  onClick: () => void;
}): JSX.Element {
  const item: SearchItem =
    row.kind === "channel"
      ? { kind: "conversation", result: row.result }
      : row.kind === "workspace"
        ? { kind: "workspace", result: row.result }
        : row.kind === "identity"
          ? { kind: "identity", candidate: row.candidate }
          : { kind: "message", result: row.result };
  return (
    <SearchResultItem
      item={item}
      query={query}
      active={active}
      agentsById={agentsById}
      ownerAgentAvatarUrls={ownerAgentAvatars}
      agentAvatarUrls={agentAvatarUrls}
      userAvatarUrls={humanAvatarUrls}
      identityAgentAvatars={identityAgentAvatars}
      identityHumanAvatars={identityHumanAvatars}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
    />
  );
}
