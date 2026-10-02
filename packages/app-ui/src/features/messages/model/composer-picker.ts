import type { AgentDto, ChannelConversationDto, Locator, ReferenceKind } from "@silverhand/shared";
import {
  canonicalizeStoredConversationTitle,
  canonicalizeStoredWorkspaceName,
  formatLocatorToken,
} from "@silverhand/shared";
import {
  findShorthandCandidates,
  type ShorthandResolver,
} from "@silverhand/shared/reference-markdown";
import {
  type ChannelListItem,
  type WorkspaceHumanMember,
  type WorkspaceMemberLists,
} from "@/features/workspaces/hooks";
import type { MentionAgent } from "@/features/conversations/pane-mode";

export const EMPTY_PICKER: PickerResult = { items: [], hiddenCount: 0 };

// ── trigger detection ─────────────────────────────────────────────

export interface ActiveTrigger {
  kind: "@" | "#";
  /** Index in `text` of the trigger character itself. */
  pos: number;
  /** Substring between trigger and caret (the live query). */
  query: string;
}

// The scanner needs TWO different character classes, and conflating them
// is what made `你好@norman` unmentionable until #task:1822.
//
// `HANDLE_CHAR` — "can this char sit inside the query the user is still
// typing". Unicode-aware (`\p{L}` letters, `\p{N}` numbers, `\p{M}`
// combining marks, plus `_` and `-`) so a CJK query (`#设计`, `@张三`)
// keeps the menu open instead of bailing on the first non-ASCII char
export const HANDLE_CHAR = /[\p{L}\p{N}\p{M}_-]/u;

// `TOKEN_TAIL_CHAR` — "does the char BEFORE the sigil extend some other
// token", i.e. is this `@` the tail of an email / a `page#anchor` rather
// than a fresh mention. This one must stay ASCII (`\w`, no `u` flag)
// because it mirrors the two parsers that decide what a bare `@handle`
// BECOMES: `PLAIN_MENTION_PATTERN` in `packages/shared/src/api/message.ts`
// (`(?<![\w/])@…`, which the send-time rewrite uses to pick the runs it
// turns into canonical references — #task:2001) and `canStartRef` in
// `markdown.tsx` (`!/[\w]/.test(prev)`, the render authority). Both treat a
// preceding CJK char as a boundary and DO produce a mention there — so a
// Unicode class here made the picker strictly stricter than the product: in
// prose without spaces (`谢谢@alice`) the menu refused to open even though
// the sent message would have referenced Alice correctly. Keep this class
// equal to the parsers' `\w`; widening it silently hides candidates whose
// handles the rewrite would still convert.
export const TOKEN_TAIL_CHAR = /\w/;

/**
 * Walks left from the caret looking for the nearest `@` or `#` that
 * could plausibly start an autocomplete token. Bails on whitespace or
 * anything not in the handle character class — so `path/@x` and `2#3`
 * don't open the menu. The handle class is Unicode-aware, so a CJK
 * query (`#设计`, `@张三`) keeps walking instead of stopping at the
 * first non-ASCII char.
 *
 * Boundary check on the trigger char itself: the char before the
 * trigger must not be the tail of another token — ASCII word char or
 * `/` — so `me@example.com` and `path/@thing` stay quiet while CJK
 * prose (`谢谢@alice`) opens the menu with no space needed. Mirrors
 * `canStartRef` in `markdown.tsx` and `PLAIN_MENTION_PATTERN` in
 * `packages/shared/src/api/message.ts`; see `TOKEN_TAIL_CHAR`.
 *
 * Exported for unit tests (pure function; no DOM).
 */
export function detectTrigger(text: string, caret: number): ActiveTrigger | null {
  if (caret < 1 || caret > text.length) return null;
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i]!;
    if (ch === "@" || ch === "#") {
      const prev = i === 0 ? "" : text[i - 1]!;
      const boundary = prev === "" || (!TOKEN_TAIL_CHAR.test(prev) && prev !== "/");
      if (!boundary) return null;
      return {
        kind: ch as "@" | "#",
        pos: i,
        query: text.slice(i + 1, caret),
      };
    }
    if (!HANDLE_CHAR.test(ch)) return null;
  }
  return null;
}

// ── filtering ─────────────────────────────────────────────────────

export interface HumanMentionCandidate {
  id: string;
  name: string;
  display_name: string;
  avatar_url: string | null;
}

export type PickerItem =
  | { kind: "agent"; agent: MentionAgent; inConversation: boolean }
  | { kind: "human"; human: HumanMentionCandidate; inConversation: boolean }
  | {
      kind: "channel";
      channel: ChannelConversationDto;
      /** The channel's OWN workspace name, stamped when the candidate is built
       *  from its own `workspace_id` — NEVER the ambient pane workspace. The
       *  viewer arm's `#` list spans workspaces, so a locator must spell the
       *  channel's real coordinate; `null` when the name can't be spelled (Agent
       *  Space, or an unresolved workspace) → `#conv:<id>` fallback in
       *  {@link formatPickInsertion}. */
      workspaceName: string | null;
    };

/** A filtered picker page: the visible (capped) items plus how many matched
 *  candidates the cap dropped, so the menu can surface a "+N more" hint
 *  instead of truncating silently. */
export interface PickerResult {
  items: PickerItem[];
  hiddenCount: number;
}

/** The `@` mention directory for the CURRENT arm, assembled once and read by all
 *  three consumers — the picker, the send-time shorthand rewrite, and its settle
 *  gate — so a candidate the picker offers is exactly one the send path can
 *  resolve (#task:2147). See the `mentionSource` memo for the per-arm derivation
 *  of `sourceKnown` (the three-value authority fact). */
export interface ComposerMentionSource {
  /** Whether this arm's authority has ANSWERED. Feeds
   *  {@link canResolveShorthandNow}: false ⇒ a hand-typed `@handle` stays PENDING
   *  (undetermined, never "answered empty"). */
  sourceKnown: boolean;
  select: (query: string) => PickerResult;
  resolveShorthand: ShorthandResolver;
}

export interface ComposerChannelSource {
  offersChannels: boolean;
  select: (query: string) => ChannelPickerResult;
}

export type ChannelSourceStatus = "complete" | "loading" | "partial_error";

export interface ChannelPickerResult extends PickerResult {
  status: ChannelSourceStatus;
}

/**
 * Which bare handles the send-time shorthand rewrite may turn into canonical
 * references, and with which kind (#task:2001). Pure, and exported for the
 * fence, because two BEHAVIOURS live here and both fail silently:
 *
 *  - **Membership is the admission test.** Only this workspace's members
 *    resolve, so `@someone-elsewhere` is left as authored — a chip that
 *    addresses nobody, which is the truth. Same candidate boundary as the
 *    picker (#task:1720). The arrays must therefore be AUTHORITATIVE: `null`
 *    from this resolver means "nobody here by that name", and a still-loading
 *    member query would make it mean "I don't know yet" instead — see
 *    {@link canResolveShorthandNow}, which is what keeps the two apart.
 *  - **Agent wins a handle collision**, matching the renderer's alias arm
 *    (`agentsByName` is consulted before `humansByName`). If the two
 *    disagreed, a colliding handle would draw an agent's chip while the stored
 *    reference names a human — the exact chip-says-one-thing /
 *    addressing-says-another split the reference grammar exists to remove.
 *
 * The viewer is deliberately NOT filtered out, unlike {@link buildMentionHumans}:
 * the picker hides your own row because self-mentioning is noise, but a handle
 * you typed anyway must still become a reference so the stored body says who you
 * named. Suppressing your own notification is the server's job and it already
 * does it.
 */
export function buildShorthandResolver(
  agents: AgentDto[],
  humans: WorkspaceHumanMember[],
): ShorthandResolver {
  const kinds = new Map<string, ReferenceKind>();
  for (const human of humans) kinds.set(human.name, "human");
  // Second, so a collision resolves to the agent.
  for (const agent of agents) kinds.set(agent.name, "agent");
  return (handle) => kinds.get(handle) ?? null;
}

export function canResolveShorthandNow(content: string, rosterKnown: boolean): boolean {
  return rosterKnown || findShorthandCandidates(content).length === 0;
}

export function buildMentionHumans(
  humans: WorkspaceHumanMember[],
  viewerId: string | null,
): HumanMentionCandidate[] {
  const out: HumanMentionCandidate[] = [];
  for (const human of humans) {
    if (viewerId && human.id === viewerId) continue;
    out.push({
      id: human.id,
      name: human.name,
      display_name: human.display_name,
      avatar_url: human.avatar_url ?? null,
    });
  }
  return out;
}

export function filterMentionPeople(
  agents: AgentDto[],
  humans: HumanMentionCandidate[],
  agentMemberIds: ReadonlySet<string>,
  humanMemberIds: ReadonlySet<string>,
  query: string,
): PickerResult {
  const q = query.toLowerCase();
  const matchedAgents = q
    ? agents.filter(
        (a) => a.name.toLowerCase().includes(q) || (a.display_name ?? "").toLowerCase().includes(q),
      )
    : agents;
  const matchedHumans = q
    ? humans.filter(
        (h) => h.name.toLowerCase().includes(q) || h.display_name.toLowerCase().includes(q),
      )
    : humans;
  // Build the two sections. Each section orders humans before agents
  // (mirrors the previous single-section ordering rule for empty
  // queries) so user-attention lines up across both groups.
  const inHumans: PickerItem[] = matchedHumans
    .filter((h) => humanMemberIds.has(h.id))
    .map((human) => ({ kind: "human", human, inConversation: true }));
  const inAgents: PickerItem[] = matchedAgents
    .filter((a) => agentMemberIds.has(a.id))
    .map((agent) => ({ kind: "agent", agent, inConversation: true }));
  const outHumans: PickerItem[] = matchedHumans
    .filter((h) => !humanMemberIds.has(h.id))
    .map((human) => ({ kind: "human", human, inConversation: false }));
  const outAgents: PickerItem[] = matchedAgents
    .filter((a) => !agentMemberIds.has(a.id))
    .map((agent) => ({ kind: "agent", agent, inConversation: false }));
  const PER_SECTION_CAP = 5;
  const inItems = [...inHumans, ...inAgents];
  const outItems = [...outHumans, ...outAgents];
  const items = [...inItems.slice(0, PER_SECTION_CAP), ...outItems.slice(0, PER_SECTION_CAP)];
  return {
    items,
    hiddenCount: inItems.length + outItems.length - items.length,
  };
}

/**
 * Resolve the `@` mention picker's candidate set from the workspace
 * member lists + this conversation's roster. Fails CLOSED to no
 * candidates until BOTH have resolved (#task:1720 review):
 *
 * - No `memberLists` → the workspace hasn't resolved (or `workspaceId`
 *   is still null). Falling back to a global user/agent directory here
 *   would briefly leak candidates from OUTSIDE this workspace.
 * - `!rosterResolved` → conversation membership is UNKNOWN, not
 *   "confirmed nobody". Emitting now would file in-channel members under
 *   "Other channels", then jump them into "In this channel" the instant
 *   the roster arrives.
 *
 * Once ready it drops the viewer, then defers ordering/grouping to
 * `filterMentionPeople` — the caller's `agentMemberIds` / `humanMemberIds`
 * decide the In-this-channel / Other-channels split. Pure (no hooks/DOM)
 * so the candidate boundary and both fail-closed windows are testable.
 */
export function selectMentionCandidates(
  memberLists: WorkspaceMemberLists | null | undefined,
  rosterResolved: boolean,
  agentMemberIds: ReadonlySet<string>,
  humanMemberIds: ReadonlySet<string>,
  viewerId: string | null,
  query: string,
): PickerResult {
  if (!memberLists || !rosterResolved) return { items: [], hiddenCount: 0 };
  const humans = buildMentionHumans(memberLists.humans, viewerId);
  return filterMentionPeople(memberLists.agents, humans, agentMemberIds, humanMemberIds, query);
}

export function filterChannels(
  channels: ChannelListItem[],
  workspaceName: string | null,
  query: string,
): PickerResult {
  const q = query.toLowerCase();
  const onlyLive = channels.filter(
    (c): c is ChannelConversationDto =>
      c.roster_policy === "open" && c.archived_at === null && c.closed_at === null,
  );
  const matched = q ? onlyLive.filter((c) => c.title.toLowerCase().includes(q)) : onlyLive;
  const items: PickerItem[] = matched
    .slice(0, CHANNEL_PICKER_CAP)
    // One workspace's list, so every row carries that one ambient name — the
    // viewer arm's cross-workspace list (below) stamps each row's OWN name
    // instead.
    .map((channel) => ({ kind: "channel", channel, workspaceName }));
  return { items, hiddenCount: matched.length - items.length };
}

/** Both `#` pickers cap at the same depth — short and scannable, narrow by typing
 *  rather than scroll. */
export const CHANNEL_PICKER_CAP = 8;

/**
 * The viewer arm's `@` candidate set: the DM's counterpart agent — offered even
 * when the viewer does not own it — merged with the viewer's canonical-owned
 * agents, deduped by id with the counterpart first. A null counterpart (human /
 * deleted / unresolved) yields the owned list unchanged. Agents-only. The one merge
 * both the picker and the send-time resolver read (#task:2147). */
export function mergeViewerMentionAgents(
  counterpartAgent: MentionAgent | null,
  ownedAgents: MentionAgent[],
): MentionAgent[] {
  if (!counterpartAgent) return ownedAgents;
  return [counterpartAgent, ...ownedAgents.filter((a) => a.id !== counterpartAgent.id)];
}

/**
 * The viewer arm's `@` picker sections over the pre-merged set: split by agent id,
 * the counterpart row (`counterpartId`) files under "In this channel", the rest
 * under "Other channels". A null counterpart leaves the in-section empty and
 * `PickerMenu` renders one flat list (#task:2147).
 */
export function selectViewerMentionCandidates(
  agents: MentionAgent[],
  counterpartId: string | null,
  query: string,
): PickerResult {
  const q = query.toLowerCase();
  const matched = q
    ? agents.filter(
        (a) => a.name.toLowerCase().includes(q) || (a.display_name ?? "").toLowerCase().includes(q),
      )
    : agents;
  const inAgents: PickerItem[] = matched
    .filter((a) => a.id === counterpartId)
    .map((agent) => ({ kind: "agent", agent, inConversation: true }));
  const outAgents: PickerItem[] = matched
    .filter((a) => a.id !== counterpartId)
    .map((agent) => ({ kind: "agent", agent, inConversation: false }));
  const VIEWER_MENTION_CAP = 10;
  // The counterpart (at most one) always shows; the rest fill up to the cap.
  const items = [...inAgents, ...outAgents.slice(0, VIEWER_MENTION_CAP)];
  return {
    items,
    hiddenCount: inAgents.length + outAgents.length - items.length,
  };
}

/**
 * The viewer arm's send-time shorthand resolver: every agent in the merged set (the
 * same one the picker offered) resolves as `agent`; a handle outside it is left as
 * authored. No human arm — a `direct_pair` names no humans (#task:2147).
 */
export function buildViewerShorthandResolver(agents: MentionAgent[]): ShorthandResolver {
  const kinds = new Map<string, ReferenceKind>();
  for (const agent of agents) kinds.set(agent.name, "agent");
  return (handle) => kinds.get(handle) ?? null;
}

/** The per-workspace query slice {@link filterViewerChannels} reads — just the
 *  fields the fail-closed classification needs, so the seam is testable without a
 *  real React Query result. Structurally satisfied by one entry of
 *  `useChannelsAcrossWorkspaces`. */
export interface ChannelSlice {
  status: "pending" | "error" | "success";
  data?: ChannelListItem[];
}

export function filterViewerChannels(
  slices: readonly ChannelSlice[],
  workspaceNameById: ReadonlyMap<string, string>,
  query: string,
): PickerResult {
  const q = query.toLowerCase();
  const items: PickerItem[] = [];
  let matchedCount = 0;
  for (const slice of slices) {
    if (slice.status !== "success" || !slice.data) continue;
    for (const c of slice.data) {
      if (c.is_member !== true) continue;
      if (c.roster_policy !== "open" || c.archived_at !== null || c.closed_at !== null) {
        continue;
      }
      if (q && !c.title.toLowerCase().includes(q)) continue;
      matchedCount += 1;
      if (items.length >= CHANNEL_PICKER_CAP) continue;
      items.push({
        kind: "channel",
        channel: c,
        workspaceName: c.workspace_id ? (workspaceNameById.get(c.workspace_id) ?? null) : null,
      });
    }
  }
  return { items, hiddenCount: matchedCount - items.length };
}

/** Collapse a single React Query settledness onto a {@link ChannelSourceStatus}
 *  (the workspace arm's one channel query). Pure. */
export function channelSourceStatusOf(
  queryStatus: "pending" | "error" | "success",
): ChannelSourceStatus {
  return queryStatus === "error"
    ? "partial_error"
    : queryStatus === "success"
      ? "complete"
      : "loading";
}

/**
 * The viewer arm's `#` channel-source page — the SINGLE authority for both the
 * candidates and the fan-out's settledness (#task:2148). Candidates come from
 * {@link filterViewerChannels}; settledness is projected here onto a THREE-valued
 * {@link ChannelSourceStatus}, so pending and error never re-fold to one bit:
 *
 *  - every slice AND the workspace list settled → `complete`;
 *  - any slice or the workspace list still pending, none errored → `loading`;
 *  - any error DOMINATES → `partial_error`. An unavailable workspace is terminal,
 *    so it wins over a still-pending sibling (monotonic, decidable) rather than a
 *    "still loading" that would never resolve.
 */
export function viewerChannelPickerResult(
  slices: readonly ChannelSlice[],
  workspacesStatus: "pending" | "error" | "success",
  workspaceNameById: ReadonlyMap<string, string>,
  query: string,
): ChannelPickerResult {
  const { items, hiddenCount } = filterViewerChannels(slices, workspaceNameById, query);
  const status: ChannelSourceStatus =
    workspacesStatus === "error" || slices.some((s) => s.status === "error")
      ? "partial_error"
      : workspacesStatus === "pending" || slices.some((s) => s.status === "pending")
        ? "loading"
        : "complete";
  return { items, hiddenCount, status };
}

/** The picker memo's per-trigger projection, extracted so the seam that carries a
 *  channel source's {@link ChannelSourceStatus} into the render is fenced, not
 *  merely inlined. `#` carries the settledness (loading / partial_error / complete);
 *  `@` is always `complete` — its own completeness drives the SEND gate
 *  (`sourceKnown`), never the render (#task:2147/#task:2148). Pure. */
export function selectPickerView(
  trigger: { kind: "@" | "#"; query: string } | null,
  mentionSource: Pick<ComposerMentionSource, "select">,
  channelSource: Pick<ComposerChannelSource, "select">,
): { items: PickerItem[]; hiddenCount: number; channelStatus: ChannelSourceStatus } {
  if (!trigger) return { ...EMPTY_PICKER, channelStatus: "complete" };
  if (trigger.kind === "@") {
    return { ...mentionSource.select(trigger.query), channelStatus: "complete" };
  }
  const r = channelSource.select(trigger.query);
  return { items: r.items, hiddenCount: r.hiddenCount, channelStatus: r.status };
}

/**
 * Build the text to splice in when the user picks a row from the
 * mention popover. Exported for the regression test that locks the
 * branches the renderer always resolves:
 *
 *   - `agent`   → `@<name>` — ParticipantNameSchema is alpha-first and
 *                 shares the renderer's `@<handle>` grammar, so the parser
 *                 always matches every stored agent name.
 *   - `channel` → the SEMANTIC LOCATOR `<silverhand://workspace/<ws>/<title>>`
 *                 (#task:2126). This is PROSE authoring, so the picker spells the
 *                 coordinate the shared grammar defines rather than the
 *                 `#conv:<id>` wire form — a human reading the body sees which
 *                 channel it points at. The percent-escaping of names with CJK,
 *                 spaces or the URI's structural characters is the shared codec's
 *                 job: we build a `Locator` from the two canonical name
 *                 constructors and hand it to {@link formatLocatorToken}; the
 *                 renderer NEVER reimplements the escape set. `formatLocator` is
 *                 total over the type, so the emitted string always round-trips
 *                 through `parseLocator`.
 *
 * FALLS BACK to `#conv:<id>` whenever the channel's OWN workspace name is absent.
 * This is a LIVE path, not just a totality guard: a candidate from an Agent Space
 * — whose name the locator grammar cannot spell — carries a null `workspaceName`
 * even though its `#` picker is live, so it lands as the permanent-id form. It is
 * also null for a workspace-less/unresolved conversation. `#conv:` parsing is
 * unchanged and still carries every existing body and permanent-id deep link.
 *
 * The workspace name is READ OFF THE ITEM (stamped at candidate build time from
 * the channel's own `workspace_id`), never the ambient pane workspace: the viewer
 * arm's list spans workspaces, so an ambient name would spell every cross-workspace
 * locator with one workspace's coordinate.
 *
 * The user can still type `#general` or a locator by hand; the picker just emits
 * the readable, reliable form.
 */
export function formatPickInsertion(item: PickerItem): string {
  if (item.kind === "agent") return `@${item.agent.name}`;
  if (item.kind === "human") return `@${item.human.name}`;
  if (item.workspaceName === null) return `#conv:${item.channel.id}`;
  const locator: Locator = {
    kind: "channel",
    workspace: canonicalizeStoredWorkspaceName(item.workspaceName),
    channel: canonicalizeStoredConversationTitle(item.channel.title),
    threadRootId: null,
  };
  return formatLocatorToken(locator);
}
