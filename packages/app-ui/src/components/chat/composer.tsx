import { InlineLoading } from "@/components/layout/inline-loading";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";
import { getCurrentUserId } from "@/features/session/current-user";
import { createLogicalSend, type LogicalSend } from "@/features/channels/logical-send";
import {
  Fragment,
  forwardRef,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { AtSign, Hash, Paperclip, X } from "lucide-react";
import type { AgentDto, ChannelConversationDto, Locator, ReferenceKind } from "@silverhand/shared";
import {
  canonicalizeStoredConversationTitle,
  canonicalizeStoredWorkspaceName,
  formatLocatorToken,
  isGenericMimeHint,
  mimeFromFilename,
} from "@silverhand/shared";
import {
  findShorthandCandidates,
  rewriteShorthandReferences,
  type ShorthandResolver,
} from "@silverhand/shared/reference-markdown";
import { MAX_ATTACHMENTS, shouldInterceptOversizedPaste } from "./oversize-paste";
import { Button } from "@/components/ui/button";
import { AgentAvatar } from "@/components/agent-avatar";
import { UserAvatar } from "@/components/user-avatar";
import { AVATAR_PX } from "@/components/avatar-scale";
import { useAgentAvatarObjectUrls } from "@/features/agent-shell/hooks/avatar-hooks";
import { useUserAvatarObjectUrls } from "@/features/users/avatar-hooks";
import {
  useChannelsAcrossWorkspaces,
  useChannelsForWorkspace,
  useWorkspaceMemberLists,
  useWorkspaces,
  type ChannelListItem,
  type WorkspaceHumanMember,
  type WorkspaceMemberLists,
} from "@/features/workspaces/hooks";
import { useAgents } from "@/features/agent-shell/hooks/hooks";
import type { ComposerDirectory, MentionAgent } from "@/features/conversations/pane-mode";

import { useConversationMembers } from "@/features/conversations/use-conversation-members";
import { useSendMessage } from "@/features/channels/hooks";
import {
  isBackendUnreachable,
  isRegistrationRequired,
  isUpdateRequired,
  useViewerUser,
} from "@/features/session/hooks";
import {
  assignAttachmentLabel,
  clearComposerDraft,
  clearComposerSendAttempt,
  dropSentAttachmentsFromDraft,
  hasComposerDraftInFlightUpload,
  patchComposerDraftText,
  pendingAttachmentsBlockSend,
  readComposerDraft,
  removeComposerDraftAttachment,
  startComposerDraftAttachmentUpload,
  subscribeComposerDraft,
  upsertComposerDraftAttachment,
  writeComposerDraft,
  type CachedPendingAttachment,
  type ComposerDraftSnapshot,
} from "@/features/messages/composer-draft-cache";
import { onQuoteToComposer, spliceQuoteIntoDraft } from "@/features/messages/quote-to-composer";
import { Lightbox } from "./lightbox";
import { ComposerActivityHeader } from "./composer-activity-header";

interface ComposerProps {
  conversationId: string;
  /** Which directory the `@` mention picker, the `#` channel picker, and the
   *  send-time shorthand resolver draw candidates from — projected ONCE by the
   *  pane owner from the typed placement (never re-derived here from
   *  `workspaceId === null`, the route, or a lone `hasRoster` boolean). Three
   *  arms, exhaustive over the placement (see {@link ComposerDirectory}):
   *   - `workspace` — a roster-bearing container: `@` = that workspace's
   *     members, `#` = that workspace's channels, scoped to the coordinate the
   *     arm carries.
   *   - `viewer` — a `direct_pair`: `@` = the viewer's own canonical-owned
   *     agents (agents-only, no humans), `#` = every channel the viewer still
   *     participates in, across all their workspaces.
   *   - `withheld` — placement unresolved/unsupported: no query starts, both
   *     pickers offer nothing, and a hand-typed `@handle` stays PENDING (the
   *     authority is undetermined, not "answered empty"). */
  directory: ComposerDirectory;
  /** When set, this composer posts replies into the given root's reply
   *  cluster (sends `reply_to_message_id`) and keeps its own draft,
   *  isolated from the channel's main composer. The channel id in
   *  `conversationId` is still used for the send target, member/mention
   *  resolution, and attachment uploads. */
  threadRootId?: string;
  disabled: boolean;
  /** When true, composer is disabled with an "archived" placeholder.
   *  Independent of `disabled` (closed) so we can distinguish the reason
   *  in the placeholder copy without losing other disabled paths. */
  archived?: boolean;
  /** When true, the conversation can never accept another message — today only a
   *  `direct_pair` whose counterpart principal is gone (#task:2035). A third
   *  reason alongside `disabled` (closed) and `archived`, because both of those
   *  describe reversible operator state and their copy would be a lie here. */
  readOnly?: boolean;
  /** Restrict the run-state activity bubble to these agent ids. The
   *  ThreadPanel passes the thread's follower agent ids so the bubble
   *  only reflects agents participating in this reply cluster, not the
   *  whole (channel-scoped) run-state stream (item 4). `null`/`undefined`
   *  = show all. */
  activityAgentIds?: readonly string[] | null;
}

const MAX_TEXTAREA_HEIGHT = 192; // Mirrors Tailwind max-h-48.
type PendingAttachment = CachedPendingAttachment;

/** The toolbar's icon buttons (attach / `@` / `#`) — one recipe so the row reads
 *  as one group of peers: quiet by default, ground only on hover, no resting
 *  frame or fill (the composer shell is the frame here, and three framed chips
 *  inside it would be a lift on top of a lift). */
const COMPOSER_TOOL_CLASS =
  "inline-flex size-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-elevated hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50";

// Stable empty defaults for the workspace-scoped mention sources. While
// `useWorkspaceMemberLists` has no data (workspaceId null or query loading)
// the `@` picker fails closed to these — reusing one frozen array per kind
// keeps the candidate memo's deps referentially stable across those frames
// instead of re-firing on a fresh `[]` each render.
const EMPTY_AGENTS: AgentDto[] = [];
const EMPTY_HUMANS: WorkspaceHumanMember[] = [];
// One frozen empty result, so an arm that offers nothing and a trigger with no
// query return the same reference — no candidate memo re-fire on a fresh `[]`.
const EMPTY_PICKER: PickerResult = { items: [], hiddenCount: 0 };

/**
 * Best-effort mirror of the backend's `detectContentType` hint→suffix path
 * (#task:1324), so the label's Image/File kind matches the content_type the
 * backend will finally store. If the browser gave a usable hint we trust it;
 * otherwise (empty / octet-stream / malformed) we recover from the filename
 * suffix, exactly like the backend does. Magic-byte sniffing — the backend's
 * one stronger signal — needs the file bytes and would make label assignment
 * async; we keep it synchronous so the chip is correct at paste time. A file
 * whose extension lies about its content is still caught by the backend's
 * kind check at send time (a clear reject, never a silent misbinding).
 */
function effectiveContentType(file: File): string {
  const hint = file.type;
  if (!isGenericMimeHint(hint)) return hint;
  return mimeFromFilename(file.name) ?? "application/octet-stream";
}

type SubmittingSnapshot = {
  snapshot: ComposerDraftSnapshot;
  editGeneration: number;
  sentAttachmentIds: string[];
};

/**
 * Message composer with @-mention / #-channel autocomplete.
 *
 * Behaviour:
 *  - Plain textarea — IME-safe Enter submission preserved from the
 *    previous inline implementation (composition events + the
 *    isComposing fallback).
 *  - Typing `@` or `#` opens a floating menu of matches, unless the
 *    char before it is the tail of another token (ASCII word char or
 *    `/`) — so emails and paths stay quiet while CJK prose needs no
 *    separating space. The menu stays anchored above the textarea
 *    (popup-relative-to-row, not caret-x; caret-x positioning needs a
 *    mirror div and isn't worth the complexity for this usage).
 *  - While the menu is open: ↑/↓ navigate, Enter or Tab pick, Esc
 *    dismisses. Enter does NOT submit while the menu is open with
 *    matches — that would be the worst possible foot-gun.
 *  - Inserting a pick replaces the trigger + query span with
 *    `@handle ` (or `#name `) — plain text, so the on-disk message
 *    body matches what the existing `<Markdown>` mention pipeline
 *    already parses on the render side.
 */
export function Composer({
  conversationId,
  directory,
  threadRootId,
  disabled: disabledProp,
  archived = false,
  readOnly = false,
  activityAgentIds,
}: ComposerProps): JSX.Element {
  // Treat archived and read-only as further flavors of disabled so every
  // send/attach path is gated identically. Placeholder below distinguishes the
  // copy — that is the only thing the three reasons differ in.
  const disabled = disabledProp || archived || readOnly;
  // Draft identity: a reply-cluster composer keeps its own draft so it
  // never clobbers the channel's main draft. Network ops (send target,
  // members, attachment upload path) still use the real `conversationId`.
  const draftKey = threadRootId ? `${conversationId}#cluster#${threadRootId}` : conversationId;
  const [initialDraft] = useState(() => readComposerDraft(draftKey));
  const [draft, setDraftState] = useState(initialDraft?.text ?? "");
  const [caret, setCaretState] = useState(initialDraft?.caret ?? 0);
  const [pending, setPendingState] = useState<PendingAttachment[]>(
    () => initialDraft?.pending ?? [],
  );
  const draftRef = useRef(draft);
  const caretRef = useRef(caret);
  const pendingRef = useRef<PendingAttachment[]>(pending);
  const retrySendRef = useRef<LogicalSend | undefined>(initialDraft?.sendAttempt);
  const editGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  const submittingSnapshotRef = useRef<SubmittingSnapshot | null>(null);
  // Track IME composition explicitly. `e.nativeEvent.isComposing` is
  // unreliable on some Chinese/Japanese IMEs (the final Enter that
  // confirms a candidate fires with isComposing=false on the same
  // event that *was* the composition end). Tracking via composition
  // events + a one-tick guard avoids accidentally sending the partial
  // text on candidate selection.
  const [composing, setComposing] = useState(false);
  const send = useSendMessage(conversationId, threadRootId);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    resizeTextarea(ref.current);
  }, [draft]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  function setPendingValue(
    next: PendingAttachment[] | ((current: PendingAttachment[]) => PendingAttachment[]),
  ): void {
    const value = typeof next === "function" ? next(pendingRef.current) : next;
    pendingRef.current = value;
    setPendingState(value);
  }

  function updateDraft(nextDraft: string, nextCaret: number): void {
    detachSubmittingDraftForEdit();
    editGenerationRef.current += 1;
    draftRef.current = nextDraft;
    caretRef.current = nextCaret;
    setDraftState(nextDraft);
    setCaretState(nextCaret);
    patchComposerDraftText(draftKey, nextDraft, nextCaret);
  }

  function updateCaret(nextCaret: number): void {
    caretRef.current = nextCaret;
    setCaretState(nextCaret);
    patchComposerDraftText(draftKey, draftRef.current, nextCaret);
  }

  function detachSubmittingDraftForEdit(): void {
    retrySendRef.current = undefined;
    clearComposerSendAttempt(draftKey);
    const submitting = submittingSnapshotRef.current;
    if (!submitting) return;
    dropSentAttachmentsFromDraft(
      draftKey,
      submitting.snapshot.pending.map((item) => item.key),
    );
    submittingSnapshotRef.current = null;
    patchComposerDraftText(draftKey, draftRef.current, caretRef.current);
  }

  useEffect(() => {
    for (const item of pendingRef.current) {
      if (
        item.state === "uploading" &&
        item.file &&
        !hasComposerDraftInFlightUpload(draftKey, item.key)
      ) {
        void startComposerDraftAttachmentUpload({
          conversationId: draftKey,
          uploadChannelId: conversationId,
          attachmentKey: item.key,
          file: item.file,
          previewUrl: item.previewUrl,
        });
      }
    }
  }, [draftKey, conversationId]);

  useEffect(() => {
    return subscribeComposerDraft(draftKey, (event) => {
      if (event.type === "clear") {
        retrySendRef.current = undefined;
        draftRef.current = "";
        caretRef.current = 0;
        pendingRef.current = [];
        setDraftState("");
        setCaretState(0);
        setPendingState([]);
        return;
      }
      if (event.type === "attachment-remove") {
        setPendingValue((curr) => curr.filter((item) => item.key !== event.attachmentKey));
        return;
      }
      setPendingValue((curr) =>
        curr.map((item) => (item.key === event.attachmentKey ? { ...item, ...event.patch } : item)),
      );
    });
  }, [draftKey]);

  useEffect(() => {
    return () => {
      const submitting = submittingSnapshotRef.current;
      const snapshot =
        submitting && editGenerationRef.current === submitting.editGeneration
          ? submitting.snapshot
          : {
              conversationId: draftKey,
              sendAttempt: retrySendRef.current,
              text: draftRef.current,
              caret: caretRef.current,
              pending: pendingRef.current,
              updatedAt: Date.now(),
            };
      writeComposerDraft({
        ...snapshot,
        updatedAt: Date.now(),
      });
    };
  }, [draftKey]);

  // The directory arm is projected ONCE by the pane owner (which cannot render
  // without a descriptor) and handed down whole — this component never re-derives
  // it from `workspaceId === null`, the route, or a lone `hasRoster` boolean. Each
  // arm-specific query below is `enabled`-gated on the arm, so the two arms it
  // does not belong to start NO query and leak no candidates (the withheld arm
  // starts none at all). The workspace coordinate the workspace arm needs travels
  // inside the arm, so there is no window in which it is merely UNRESOLVED — the
  // member-list QUERY still has its own loading window, over which everything
  // downstream fails CLOSED to empty rather than to a global directory.
  const isWorkspaceArm = directory.kind === "workspace";
  const isViewerArm = directory.kind === "viewer";
  // The DM counterpart agent (viewer arm only) — a conversation fact, even when the
  // viewer does not own it. null in every other arm and for a human / deleted /
  // unresolved counterpart.
  const counterpartAgent = directory.kind === "viewer" ? directory.counterpartAgent : null;
  const armWorkspaceId = directory.kind === "workspace" ? directory.workspaceId : null;
  const armWorkspaceName = directory.kind === "workspace" ? directory.workspaceName : null;
  const armHasChannelNamespace =
    directory.kind === "workspace" ? directory.hasChannelNamespace : false;
  // Workspace arm `@` source: ONLY this workspace's members. Null id (any other
  // arm, or an unresolved workspace) disables the query, so the arrays stay empty
  // (fail closed, no global fallback); stable empty-array constants keep the memo
  // deps below referentially stable during the loading window.
  const memberLists = useWorkspaceMemberLists(armWorkspaceId);
  const agents = memberLists.data?.agents ?? EMPTY_AGENTS;
  const workspaceHumans = memberLists.data?.humans ?? EMPTY_HUMANS;
  // Viewer arm `@` source: the viewer's canonical-owned agents (agents-only, no
  // humans — a `direct_pair` has no workspace roster). `enabled` off in every
  // other arm. The backend narrows `created_by_user_id == viewer` (#task:1256);
  // the renderer never re-filters ownership client-side.
  const ownedAgentsQuery = useAgents({ scope: "owned", enabled: isViewerArm });
  const ownedAgents = ownedAgentsQuery.data ?? EMPTY_AGENTS;
  // The viewer arm's `@` candidate set: the counterpart agent (offered even when
  // the viewer does not own it) merged with the owned agents by id. Shared by the
  // picker, avatar prefetch, and send-time resolver so a non-owned counterpart the
  // picker offers still resolves on send (#task:2147).
  const viewerMentionAgents = useMemo<MentionAgent[]>(
    () => (isViewerArm ? mergeViewerMentionAgents(counterpartAgent, ownedAgents) : EMPTY_AGENTS),
    [isViewerArm, counterpartAgent, ownedAgents],
  );
  // Viewer arm `#` source: every channel the viewer still participates in, across
  // ALL their workspaces (#task:2148). The workspace list gives both the fan-out's
  // id set and the id→name map each cross-workspace candidate stamps onto its own
  // locator (never the ambient name). `enabled` off in every other arm so the
  // fan-out — and the workspace list it depends on — starts no query there.
  const workspacesQuery = useWorkspaces({ enabled: isViewerArm });
  const viewerWorkspaceIds = useMemo(
    () => (isViewerArm ? (workspacesQuery.data ?? []).map((w) => w.id) : []),
    [isViewerArm, workspacesQuery.data],
  );
  const viewerChannelSlices = useChannelsAcrossWorkspaces(viewerWorkspaceIds);
  const workspaceNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of workspacesQuery.data ?? []) m.set(w.id, w.name);
    return m;
  }, [workspacesQuery.data]);

  const conversationMembers = useConversationMembers(isWorkspaceArm ? conversationId : null);

  const viewerQuery = useViewerUser();
  const viewerId =
    viewerQuery.data &&
    !isRegistrationRequired(viewerQuery.data) &&
    !isBackendUnreachable(viewerQuery.data) &&
    !isUpdateRequired(viewerQuery.data)
      ? viewerQuery.data.id
      : null;

  const rosterResolved = conversationMembers.status === "resolved";
  const { agentMemberIds, humanMemberIds } = useMemo(() => {
    const a = new Set<string>();
    const h = new Set<string>();
    if (conversationMembers.status === "resolved") {
      for (const member of conversationMembers.members) {
        if (member.kind === "agent") a.add(member.agent_id);
        else if (member.kind === "human") h.add(member.user_id);
      }
    }
    return { agentMemberIds: a, humanMemberIds: h };
  }, [conversationMembers.status, conversationMembers.members]);
  // Human candidates for avatar PREFETCH: this workspace's human members
  // minus the viewer. This mirrors the picker's own candidate transform
  // (`buildMentionHumans`) so the avatars are warm before a row renders;
  // avatar prefetch is not gated on roster resolution — only the visible
  // candidate list is (see `selectMentionCandidates`).
  const mentionHumans = useMemo<HumanMentionCandidate[]>(
    () => buildMentionHumans(workspaceHumans, viewerId),
    [workspaceHumans, viewerId],
  );
  const agentAvatarUrls = useAgentAvatarObjectUrls(isViewerArm ? viewerMentionAgents : agents);
  const humanAvatarUrls = useUserAvatarObjectUrls(mentionHumans);
  const { data: workspaceChannels = [], status: workspaceChannelsStatus } = useChannelsForWorkspace(
    armWorkspaceId,
    // Sound as the hook's `workspaceResolved` argument: a namespace only exists
    // for a RESOLVED workspace placement, so the bit implies the row resolved
    // (the converse does not hold — hence two names, #task:2078).
    armHasChannelNamespace,
  );

  // The `@` mention source, assembled ONCE per arm and read by all THREE consumers
  // — the picker below, the send-time rewrite in `submit`, and its settle gate —
  // so a candidate the picker offers is exactly one the send path can resolve, and
  // they can never drift (#task:2147). `sourceKnown` is the three-value authority
  // fact collapsed to a bool only here: `withheld` → false (undetermined, so a
  // hand-typed `@handle` stays PENDING, never "answered empty"); `workspace` → the
  // member roster has answered (one successful fetch; a stale-but-real roster is
  // authoritative across background refetches); `viewer` → the owned-agents query
  // settled, and a settled-EMPTY result is still KNOWN (resolves to no match, not
  // pending).
  const mentionSource = useMemo<ComposerMentionSource>(() => {
    switch (directory.kind) {
      case "workspace":
        return {
          sourceKnown: memberLists.data !== undefined,
          select: (query) =>
            selectMentionCandidates(
              memberLists.data,
              rosterResolved,
              agentMemberIds,
              humanMemberIds,
              viewerId,
              query,
            ),
          resolveShorthand: buildShorthandResolver(agents, workspaceHumans),
        };
      case "viewer":
        return {
          // Only the owned-agents query is async; the counterpart is a synchronous
          // descriptor fact already folded into `viewerMentionAgents`, so it adds no
          // pending-ness — the settle gate is exactly the owned query's success.
          sourceKnown: ownedAgentsQuery.isSuccess,
          select: (query) =>
            selectViewerMentionCandidates(viewerMentionAgents, counterpartAgent?.id ?? null, query),
          resolveShorthand: buildViewerShorthandResolver(viewerMentionAgents),
        };
      case "withheld":
        return {
          sourceKnown: false,
          select: () => EMPTY_PICKER,
          resolveShorthand: () => null,
        };
    }
  }, [
    directory.kind,
    memberLists.data,
    rosterResolved,
    agentMemberIds,
    humanMemberIds,
    viewerId,
    agents,
    workspaceHumans,
    viewerMentionAgents,
    counterpartAgent,
    ownedAgentsQuery.isSuccess,
  ]);

  // The `#` channel source, same one-source discipline. `offersChannels` gates the
  // toolbar `#` button and the placeholder hint; a control that opens on nothing is
  // worse than no control.
  const channelSource = useMemo<ComposerChannelSource>(() => {
    switch (directory.kind) {
      case "workspace":
        return {
          offersChannels: armHasChannelNamespace,
          select: (query) => ({
            ...filterChannels(workspaceChannels, armWorkspaceName, query),
            status: channelSourceStatusOf(workspaceChannelsStatus),
          }),
        };
      case "viewer":
        return {
          offersChannels: true,
          select: (query) =>
            viewerChannelPickerResult(
              viewerChannelSlices,
              workspacesQuery.status,
              workspaceNameById,
              query,
            ),
        };
      case "withheld":
        return { offersChannels: false, select: () => ({ ...EMPTY_PICKER, status: "complete" }) };
    }
  }, [
    directory.kind,
    armHasChannelNamespace,
    armWorkspaceName,
    workspaceChannels,
    workspaceChannelsStatus,
    viewerChannelSlices,
    workspacesQuery.status,
    workspaceNameById,
  ]);

  const offersMentions = directory.kind !== "withheld";
  const offersChannels = channelSource.offersChannels;

  const trigger = useMemo(
    () => (composing ? null : detectTrigger(draft, caret)),
    [draft, caret, composing],
  );

  // `channelStatus` is a `#`-only presentation fact: whether the channel source's
  // page is the whole set or a progressive slice (loading / partial_error). The `@`
  // picker has no such notion — its completeness drives the SEND gate
  // (`sourceKnown`), not the render — so it always reports `complete`. Extracted to
  // {@link selectPickerView} so the seam that carries the status into the render is
  // fenced, not just computed.
  const { items, hiddenCount, channelStatus } = useMemo(
    () => selectPickerView(trigger, mentionSource, channelSource),
    [trigger, mentionSource, channelSource],
  );

  // People-section headers ("In this channel" / "Other channels") on the `@`
  // picker. The workspace arm splits its roster; the viewer arm (a DM) files the
  // counterpart agent under "In this channel" and the viewer's other owned agents
  // under "Other channels". Both are `@`-only — the `#` channel lists are flat.
  // `PickerMenu` still renders headers only when there IS an in-channel row, so a
  // DM with no resolved agent counterpart shows one flat, header-less list.
  const peopleSections = (isWorkspaceArm || isViewerArm) && trigger?.kind === "@";
  // Viewer-arm `#` candidates span workspaces, so the row names each channel's
  // workspace to keep same-named channels distinguishable (#task:2148).
  const showChannelWorkspace = isViewerArm && trigger?.kind === "#";

  const [active, setActive] = useState(0);
  // Keep the highlight in range as the candidate list shrinks/grows.
  useEffect(() => {
    if (active >= items.length) setActive(0);
  }, [items.length, active]);
  // Reset highlight whenever the trigger reopens at a different spot.
  useEffect(() => {
    setActive(0);
  }, [trigger?.pos, trigger?.kind]);

  // The `#` picker opens even with zero rows while its source is not yet complete,
  // so the loading / partial-error marker shows instead of silently nothing (which
  // would read as "no channels"). The `@` picker only opens on real rows.
  const menuOpen = !!trigger && (items.length > 0 || channelStatus !== "complete");

  const insertPick = (item: PickerItem): void => {
    if (!trigger) return;
    const before = draft.slice(0, trigger.pos);
    const after = draft.slice(trigger.pos + 1 + trigger.query.length);
    // Trailing space so the next keystroke isn't immediately treated
    // as continuation of the handle (and so the caret lands at a
    // typing-friendly spot).
    const insertion = `${formatPickInsertion(item)} `;
    const nextDraft = before + insertion + after;
    const nextCaret = (before + insertion).length;
    updateDraft(nextDraft, nextCaret);
    // Defer caret update until React applies the value — selection
    // setters before that get blown away by the controlled re-render.
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextCaret, nextCaret);
      updateCaret(nextCaret);
    });
  };

  const sendDisabled =
    disabled ||
    send.isPending ||
    pendingAttachmentsBlockSend(pending) ||
    (!draft.trim() && pending.filter((p) => p.state === "done").length === 0);

  /** Insert a passage quoted from a message as a Markdown blockquote at
   *  the caret (#task:1544), routed here by the SelectionQuoteToolbar via
   *  the `draftKey`-keyed window-event bus. Mirrors the mention/label
   *  insert idiom: splice → updateDraft → defer focus + caret past the
   *  controlled re-render. Disabled/archived composers ignore quotes. */
  useEffect(() => {
    if (disabled) return;
    return onQuoteToComposer(draftKey, (text) => {
      const el = ref.current;
      const pos = el?.selectionStart ?? caretRef.current;
      const { text: nextDraft, caret: nextCaret } = spliceQuoteIntoDraft(
        draftRef.current,
        pos,
        text,
      );
      updateDraft(nextDraft, nextCaret);
      requestAnimationFrame(() => {
        const node = ref.current;
        if (!node) return;
        node.focus();
        node.setSelectionRange(nextCaret, nextCaret);
        updateCaret(nextCaret);
      });
    });
  }, [draftKey, disabled]);

  /** Insert an attachment's label (e.g. `Image #1`) as plain text at the
   *  caret so the user can describe it inline (#task:1324). The body reference
   *  is verbatim the label the agent receives, so the two match; it stays plain
   *  text (deleting it doesn't remove the attachment — that's the chip's job). */
  const insertLabelAtCaret = (label: string): void => {
    const el = ref.current;
    const pos = el?.selectionStart ?? caretRef.current;
    const text = draftRef.current;
    const before = text.slice(0, pos);
    const after = text.slice(pos);
    // Pad with a leading space only when the preceding char isn't already
    // whitespace, and a trailing space so typing continues cleanly.
    const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
    const insertion = `${lead}${label} `;
    const nextDraft = before + insertion + after;
    const nextCaret = (before + insertion).length;
    updateDraft(nextDraft, nextCaret);
    requestAnimationFrame(() => {
      const node = ref.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(nextCaret, nextCaret);
      updateCaret(nextCaret);
    });
  };

  function submit(): void {
    const content = draft.trim();
    const ready = pending
      .filter((p) => p.state === "done" && p.attachment)
      // Carry the compose-time label alongside the uploaded dto so the send
      // payload (and the optimistic snapshot) reference the same stable
      // identity the chip showed (#task:1324).
      .map((p) => ({ ...p.attachment!, label: p.label }));
    if ((!content && ready.length === 0) || disabled) return;
    if (pendingAttachmentsBlockSend(pending)) return;
    const submittedPending = pending.filter((p) => p.state === "done" && p.attachment);
    const sentAttachmentIds = ready.map((item) => item.id);
    const logicalSend =
      retrySendRef.current ?? createLogicalSend(conversationId, threadRootId ?? null);
    retrySendRef.current = undefined;
    const submittedSnapshot: ComposerDraftSnapshot = {
      sendAttempt: logicalSend,
      conversationId: draftKey,
      // The SHORTHAND, not the rewritten body: a failed send restores the draft,
      // and the author must get back the bytes they typed. Restoring the
      // canonical form would silently rewrite their draft on the first network
      // hiccup, and re-sending it is a no-op (already canonical) anyway.
      text: content,
      caret: content.length,
      pending: submittedPending,
      updatedAt: Date.now(),
    };
    const editGeneration = editGenerationRef.current;
    submittingSnapshotRef.current = {
      snapshot: submittedSnapshot,
      editGeneration,
      sentAttachmentIds,
    };
    draftRef.current = "";
    caretRef.current = 0;
    pendingRef.current = [];
    setDraftState("");
    setCaretState(0);
    setPendingState([]);
    /** Put the author's own bytes back in the composer. Generation-guarded, so
     *  it is a no-op once the user has started the next message — and idempotent,
     *  because it clears the ref it tests. */
    const restoreDraft = (): void => {
      if (logicalSend.userId !== getCurrentUserId()) return;
      const submitting = submittingSnapshotRef.current;
      if (submitting?.editGeneration !== editGeneration) return;
      submittingSnapshotRef.current = null;
      retrySendRef.current = logicalSend;
      if (mountedRef.current) {
        draftRef.current = submittedSnapshot.text;
        caretRef.current = submittedSnapshot.caret;
        pendingRef.current = submittedSnapshot.pending;
        setDraftState(submittedSnapshot.text);
        setCaretState(submittedSnapshot.caret);
        setPendingState(submittedSnapshot.pending);
      }
      patchComposerDraftText(draftKey, submittedSnapshot.text, submittedSnapshot.caret);
      for (const item of submittedSnapshot.pending) {
        upsertComposerDraftAttachment(draftKey, item);
      }
      writeComposerDraft(submittedSnapshot);
    };
    const dispatch = (storedContent: string): void => {
      logicalSend.canonicalContent ??= storedContent;
      void send
        .mutateAsync({ content: logicalSend.canonicalContent, attachments: ready, logicalSend })
        .then(() => {
          if (logicalSend.userId !== getCurrentUserId()) return;
          const submitting = submittingSnapshotRef.current;
          if (submitting?.editGeneration !== editGeneration) return;
          clearComposerDraft(draftKey, { sentAttachmentIds });
          submittingSnapshotRef.current = null;
        })
        .catch(restoreDraft);
    };
    if (logicalSend.canonicalContent !== undefined) {
      dispatch(logicalSend.canonicalContent);
      return;
    }
    // Authoring bytes and stored bytes differ here, on purpose:
    // the textarea keeps showing `@Alice` because that is what
    // the author typed, while the body that ships spells every resolvable
    // shorthand as `<silverhand://agent/Alice>` — the only form that addresses
    // anyone. The rewrite is prose-position-aware, so a handle inside a code span,
    // a quote, or a link label is stored exactly as written.
    //
    // The resolver and its settle gate both come from `mentionSource` — the SAME
    // arm source the picker read — so a body resolves exactly when the arm's
    // authority is known: a workspace roster that has answered, or the viewer's
    // owned agents (which, settled-empty, resolve every handle to no match and
    // ship the body as authored — a `direct_pair` delivers to its endpoint
    // regardless).
    if (canResolveShorthandNow(content, mentionSource.sourceKnown)) {
      dispatch(rewriteShorthandReferences(content, mentionSource.resolveShorthand));
      return;
    }
    // The arm's authority is not yet known and this body names someone, so
    // spelling it canonically is part of sending it. Sending now would ship a body
    // that addresses nobody with no signal anywhere, so settle the arm's source
    // first — and if it cannot be had, hand the draft back exactly as a failed
    // send does rather than store a half-truth. The `withheld` arm has no source to
    // settle, so its refetch yields null and the draft is restored: a hand-typed
    // handle correctly stays pending until the placement resolves.
    void refetchMentionResolver()
      .then((resolver) => {
        if (!resolver) {
          restoreDraft();
          return;
        }
        dispatch(rewriteShorthandReferences(content, resolver));
      })
      // Only reachable if the query layer itself rejects; without it the draft
      // the user typed would be gone for good.
      .catch(restoreDraft);
  }

  /** Settle the current arm's `@` authority and return a resolver, or `null` when
   *  it cannot be settled (a failed refetch, or the withheld arm which has no
   *  source at all). Arm-aware so the wait targets the same authority the picker
   *  and the resolver read — never a workspace roster in a DM or vice versa. */
  async function refetchMentionResolver(): Promise<ShorthandResolver | null> {
    if (directory.kind === "workspace") {
      const roster = (await memberLists.refetch()).data;
      return roster ? buildShorthandResolver(roster.agents, roster.humans) : null;
    }
    if (directory.kind === "viewer") {
      const owned = (await ownedAgentsQuery.refetch()).data;
      if (!owned) return null;
      // Same merge the picker read, so a picked (or hand-typed) non-owned
      // counterpart resolves on send instead of dropping to an unaddressed chip.
      return buildViewerShorthandResolver(
        mergeViewerMentionAgents(directory.counterpartAgent, owned),
      );
    }
    return null;
  }

  function addFiles(files: FileList | File[]): void {
    const list = Array.from(files);
    if (list.length === 0) return;
    const slotsLeft = MAX_ATTACHMENTS - pendingRef.current.length;
    if (slotsLeft <= 0) return;
    // Adding an attachment is the start of editing the next message. Detach the
    // just-submitted snapshot FIRST — once, before any label assignment — so the
    // draft's label counter is reset and the new files number from #1 instead of
    // continuing the sent message's sequence (#task:1324). Doing this per-file
    // AFTER assign (as before) let the first new file inherit the sent counter.
    detachSubmittingDraftForEdit();
    editGenerationRef.current += 1;
    for (const file of list.slice(0, slotsLeft)) {
      const key = `att-${crypto.randomUUID()}`;
      // Derive the label's kind from the content_type the backend will finally
      // store, NOT the raw browser File.type (#task:1324). A dropped `.png`
      // often arrives with an empty File.type; the backend recovers image/png
      // from the suffix, so trusting the raw hint would label it `File #N`
      // while the stored row is an image → a send-time
      // `attachment_label_kind_mismatch` 400. We reuse the same shared helpers
      // the backend's detectContentType uses for its hint→suffix path.
      const contentType = effectiveContentType(file);
      const isImage = contentType.startsWith("image/");
      const previewUrl = isImage ? URL.createObjectURL(file) : undefined;
      // Assign the stable `Image #N` / `File #N` label the instant the file
      // enters the draft, so the chip the user sees IS the reference the agent
      // will get (#task:1324). Bound to this instance for the draft's life.
      const label = assignAttachmentLabel(draftKey, contentType);
      const item: PendingAttachment = {
        key,
        filename: file.name,
        size: file.size,
        contentType,
        state: "uploading",
        file,
        previewUrl,
        label,
      };
      setPendingValue((curr) => [...curr, item]);
      void startComposerDraftAttachmentUpload({
        conversationId: draftKey,
        uploadChannelId: conversationId,
        attachmentKey: key,
        file,
        previewUrl,
        label,
      });
    }
  }

  function removePending(key: string): void {
    detachSubmittingDraftForEdit();
    editGenerationRef.current += 1;
    setPendingValue((curr) => curr.filter((p) => p.key !== key));
    removeComposerDraftAttachment(draftKey, key);
  }

  // Composer-level lightbox: shown when the user clicks an image chip.
  // Non-image chips still use the file download path (handled inside
  // AttachmentChip via a no-op onPreview).
  const [previewing, setPreviewing] = useState<{
    url: string;
    alt: string;
  } | null>(null);

  function onDrop(e: DragEvent<HTMLFormElement>): void {
    e.preventDefault();
    setDragOver(false);
    if (disabled) return;
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  }

  function onDragOver(e: DragEvent<HTMLFormElement>): void {
    if (disabled) return;
    if (Array.from(e.dataTransfer.types).includes("Files")) {
      e.preventDefault();
      setDragOver(true);
    }
  }

  function onDragLeave(e: DragEvent<HTMLFormElement>): void {
    // dragleave fires for child traversal; only flip false when leaving
    // the form root.
    if (e.currentTarget === e.target) setDragOver(false);
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>): void {
    if (disabled) return;
    // `clipboardData.files` covers both pasted images (e.g. screenshots
    // — surfaced as a single image/png blob) and Finder file copies.
    // We only intercept when actual files are present so plain text
    // paste keeps its native behaviour and IME composition isn't
    // disrupted.
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      addFiles(files);
      return;
    }
    // Oversized text paste: never let a multi-MB string enter the
    // textarea or the message pipeline (the backend rejects it and
    // rendering it pins the renderer). Convert it to a text attachment
    // through the normal pending-upload flow. See
    // `shouldInterceptOversizedPaste` for the capacity guard: at
    // capacity the text falls through to the native paste (draft keeps
    // it) and the submit-time conversion in `useSendMessage` remains
    // the authority.
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (shouldInterceptOversizedPaste(text, pendingRef.current.length)) {
      e.preventDefault();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const file = new File([text], `pasted-text-${stamp}.txt`, {
        type: "text/plain",
      });
      addFiles([file]);
    }
  }

  // Escape suppresses the menu for the current trigger token. Tracked
  // by the trigger's position; clears as soon as the trigger goes
  // away (caret moved off the token, or the token was deleted).
  const [dismissedPos, setDismissedPos] = useState<number | null>(null);
  const dismissed = trigger != null && dismissedPos === trigger.pos;
  useEffect(() => {
    if (!trigger) {
      if (dismissedPos !== null) setDismissedPos(null);
      return;
    }
    if (dismissedPos !== null && dismissedPos !== trigger.pos) {
      setDismissedPos(null);
    }
  }, [trigger, dismissedPos]);

  const insertTriggerAtCaret = (kind: "@" | "#"): void => {
    const el = ref.current;
    const pos = el?.selectionStart ?? caretRef.current;
    const text = draftRef.current;
    const before = text.slice(0, pos);
    const lead = /[\w/]$/.test(before) ? " " : "";
    const nextDraft = before + lead + kind + text.slice(pos);
    const nextCaret = before.length + lead.length + 1;
    setDismissedPos(null);
    updateDraft(nextDraft, nextCaret);
    requestAnimationFrame(() => {
      const node = ref.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(nextCaret, nextCaret);
      updateCaret(nextCaret);
    });
  };

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (menuOpen && !dismissed) {
      if (e.key === "Escape") {
        e.preventDefault();
        if (trigger) setDismissedPos(trigger.pos);
        return;
      }
      if (items.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setActive((i) => (i + 1) % items.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setActive((i) => (i - 1 + items.length) % items.length);
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          if (composing || e.nativeEvent.isComposing) return; // IME candidate
          e.preventDefault();
          const pick = items[active];
          if (pick) insertPick(pick);
          return;
        }
      }
    }

    if (e.key !== "Enter") return;
    if (e.shiftKey) return; // newline
    if (composing || e.nativeEvent.isComposing) return; // IME candidate
    e.preventDefault();
    submit();
  }

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    submit();
  }

  return (
    <form
      data-composer
      onSubmit={onSubmit}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      className={
        "shrink-0 border-t border-border-subtle bg-bg-base px-3 py-3 " +
        (dragOver ? "[outline:2px_solid_var(--border-focus)] -outline-offset-2" : "")
      }
    >
      <AnimatePresence initial={false} key={draftKey}>
        {pending.length > 0 ? (
          <PendingAttachmentTray key="attachments">
            <AnimatePresence initial={false} mode="popLayout" propagate>
              {pending.map((p) => (
                <PendingAttachmentMotion key={p.key}>
                  <AttachmentChip
                    item={p}
                    onRemove={() => removePending(p.key)}
                    onInsertLabel={
                      p.label && p.state !== "error"
                        ? () => insertLabelAtCaret(p.label!)
                        : undefined
                    }
                    onPreview={
                      p.previewUrl
                        ? () => setPreviewing({ url: p.previewUrl!, alt: p.filename })
                        : undefined
                    }
                  />
                </PendingAttachmentMotion>
              ))}
            </AnimatePresence>
          </PendingAttachmentTray>
        ) : null}
      </AnimatePresence>
      <div className="relative">
        {menuOpen && !dismissed ? (
          <PickerMenu
            items={items}
            hiddenCount={hiddenCount}
            channelStatus={channelStatus}
            active={active}
            onPick={insertPick}
            onHover={setActive}
            peopleSections={peopleSections}
            showChannelWorkspace={showChannelWorkspace}
            agentAvatarUrls={agentAvatarUrls}
            humanAvatarUrls={humanAvatarUrls}
          />
        ) : null}
        <div
          data-composer-shell
          className="flex flex-col overflow-hidden rounded-(--control-radius) border border-border-subtle bg-bg-floating focus-within:border-border-focus"
        >
          <div data-composer-editor>
            <ComposerActivityHeader
              conversationId={conversationId}
              restrictToAgentIds={activityAgentIds}
            />
            <textarea
              ref={ref}
              value={draft}
              data-composer-input
              onChange={(e) => {
                updateDraft(e.target.value, e.target.selectionStart ?? e.target.value.length);
              }}
              onKeyUp={(e) => updateCaret(e.currentTarget.selectionStart ?? 0)}
              onClick={(e) => updateCaret(e.currentTarget.selectionStart ?? 0)}
              onSelect={(e) => updateCaret(e.currentTarget.selectionStart ?? 0)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={() => setComposing(false)}
              disabled={disabled}
              placeholder={
                archived
                  ? "This conversation is archived"
                  : readOnly
                    ? "This conversation is read-only"
                    : disabled
                      ? "This conversation is closed"
                      : "Message…"
              }
              // No bottom/right padding to dodge buttons anymore — they
              // live in the toolbar below. `min-h-[60px]` keeps the
              // textarea at 3 rows; the toolbar adds its own ~32px
              // below, so total composer height ≈ 92px (up from 76px)
              className="block max-h-48 min-h-15 w-full resize-none bg-transparent px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            />
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              // Reset so re-selecting the same file fires onChange.
              e.target.value = "";
            }}
          />
          {/* Desktop frames the whole composer; compact layout frames only
           *  the editor above this shared toolbar. */}
          <div data-composer-toolbar className="flex items-center justify-between px-2 py-1.5">
            {/* One flat group, no dividers: peers that all put something into the
                message. The `@` and `#` buttons are absent — not disabled — in an
                arm that offers no such candidates: the withheld arm offers neither,
                and a picker that opens on nothing is worse than no control (same
                reason the placeholder drops the hint there). The viewer arm offers
                BOTH — a DM mentions the viewer's own agents and references any
                channel the viewer is in (#task:2148). */}
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled || pending.length >= MAX_ATTACHMENTS}
                title="Attach a file"
                className={COMPOSER_TOOL_CLASS}
              >
                <Paperclip className="size-4" />
              </button>
              {offersMentions ? (
                <button
                  type="button"
                  onClick={() => insertTriggerAtCaret("@")}
                  disabled={disabled}
                  title="Mention a member"
                  aria-label="Mention a member"
                  data-composer-tool="mention"
                  className={COMPOSER_TOOL_CLASS}
                >
                  <AtSign className="size-4" />
                </button>
              ) : null}
              {offersChannels ? (
                <button
                  type="button"
                  onClick={() => insertTriggerAtCaret("#")}
                  disabled={disabled}
                  title="Reference a channel"
                  aria-label="Reference a channel"
                  data-composer-tool="channel"
                  className={COMPOSER_TOOL_CLASS}
                >
                  <Hash className="size-4" />
                </button>
              ) : null}
            </div>
            <Button
              type="submit"
              variant="default"
              size="sm"
              disabled={sendDisabled}
              title="Send (Enter)"
              data-composer-action="send"
              data-sticker
              data-sticker-size="md"
              className="h-7"
            >
              Send
            </Button>
          </div>
        </div>
      </div>
      <Lightbox
        open={previewing !== null}
        onOpenChange={(open) => {
          if (!open) setPreviewing(null);
        }}
        src={previewing?.url ?? ""}
        alt={previewing?.alt ?? ""}
      />
    </form>
  );
}

function PendingAttachmentTray({ children }: { children: ReactNode }): JSX.Element {
  const reducedMotion = useReducedMotion();
  const present = useIsPresent();
  return (
    <motion.div
      ref={(node) => node?.toggleAttribute("inert", !present)}
      aria-hidden={!present || undefined}
      initial={{ height: 0, opacity: 0, overflow: "hidden" }}
      animate={{ height: "auto", opacity: 1, transitionEnd: { overflow: "visible" } }}
      exit={{ height: 0, opacity: 0, overflow: "hidden" }}
      transition={{ duration: reducedMotion ? 0 : 0.14, ease: "easeOut" }}
    >
      <div className="relative flex flex-wrap gap-1.5 pb-2">{children}</div>
    </motion.div>
  );
}

// Forward the DOM ref so popLayout can remove an exiting chip from flex flow.
const PendingAttachmentMotion = forwardRef<HTMLDivElement, { children: ReactNode }>(
  function PendingAttachmentMotion({ children }, ref): JSX.Element {
    const present = useIsPresent();
    const reducedMotion = useReducedMotion();
    return (
      <motion.div
        ref={(node) => {
          node?.toggleAttribute("inert", !present);
          if (typeof ref === "function") ref(node);
          else if (ref) ref.current = node;
        }}
        aria-hidden={!present || undefined}
        className="min-w-0 max-w-70"
        style={{ pointerEvents: present ? undefined : "none" }}
        layout={reducedMotion ? false : "position"}
        initial={{ opacity: 0, scale: reducedMotion ? 1 : 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: reducedMotion ? 1 : 0.96 }}
        transition={{ duration: reducedMotion ? 0 : 0.14, ease: "easeOut" }}
      >
        {children}
      </motion.div>
    );
  },
);

function AttachmentChip({
  item,
  onRemove,
  onInsertLabel,
  onPreview,
}: {
  item: PendingAttachment;
  onRemove: () => void;
  /** Insert this attachment's stable label into the message body. Omitted when
   *  the attachment has no label yet or failed to upload. */
  onInsertLabel?: () => void;
  /** Provided only for image attachments with a local previewUrl. */
  onPreview?: () => void;
}): JSX.Element {
  const sizeLabel = formatBytes(item.size);
  // `error` uses the `--color-error` token at full strength on BOTH frame and
  // ink: there is no `danger` token in any theme (the `status-danger` classes
  // this replaced were never generated, so a failed upload read exactly like a
  // finished one), and a failure the user must notice before sending is where
  // saturation is earned. Full-strength `border-error` on a compact bordered
  // control matches `ConnectionPane`'s failed-endpoint option.
  const stateClass =
    item.state === "error"
      ? "border-error text-error"
      : item.state === "uploading"
        ? "border-border-subtle text-text-muted"
        : "border-border-subtle text-text-secondary";
  const isImage = item.contentType.startsWith("image/");

  // Image chip: small thumbnail + filename + remove. Click thumbnail
  // opens the lightbox. Non-image chip: paperclip icon + filename.
  // Two-line layout (#task:1324): the filename owns the main line and
  // truncates; the `Image #N` label + size sit on a light sub-line so the
  // label never competes with the filename for horizontal width. The label
  // doubles as the "insert reference" button — clicking it drops the label
  // into the message body as plain text — but it's de-emphasized to a subtle
  // text button, not a heavy accent badge.
  return (
    <div
      className={`flex max-w-70 items-center gap-1.5 rounded-md border bg-bg-floating px-2 py-1 text-xs ${stateClass}`}
      title={item.error ?? `${item.filename} (${sizeLabel})`}
    >
      {isImage && item.previewUrl ? (
        <button
          type="button"
          onClick={onPreview}
          disabled={!onPreview}
          className="block size-8 shrink-0 overflow-hidden rounded-sm border border-border-subtle focus-outline"
          aria-label="Preview image"
        >
          <img src={item.previewUrl} alt={item.filename} className="block size-full object-cover" />
        </button>
      ) : (
        <Paperclip className="size-3 shrink-0" />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{item.filename}</span>
        <div className="flex items-center gap-1 text-(length:--text-badge) text-text-muted">
          {item.label ? (
            onInsertLabel ? (
              <button
                type="button"
                onClick={onInsertLabel}
                title="Insert reference into message"
                aria-label={`Insert ${item.label} into message`}
                className="shrink-0 rounded-sm font-mono text-text-muted transition-colors hover:text-text-secondary hover:underline focus-outline"
              >
                {item.label}
              </button>
            ) : (
              <span className="shrink-0 font-mono">{item.label}</span>
            )
          ) : null}
          <span className="shrink-0">{item.state === "uploading" ? "Uploading…" : sizeLabel}</span>
        </div>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="ml-1 inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-text-muted hover:text-text-primary"
        aria-label="Remove attachment"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function resizeTextarea(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.style.height = "auto";
  const nextHeight = Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT);
  el.style.height = `${nextHeight}px`;
  el.style.overflowY = el.scrollHeight > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
}

// ── trigger detection ─────────────────────────────────────────────

interface ActiveTrigger {
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
const HANDLE_CHAR = /[\p{L}\p{N}\p{M}_-]/u;

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
const TOKEN_TAIL_CHAR = /\w/;

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
interface ComposerMentionSource {
  /** Whether this arm's authority has ANSWERED. Feeds
   *  {@link canResolveShorthandNow}: false ⇒ a hand-typed `@handle` stays PENDING
   *  (undetermined, never "answered empty"). */
  sourceKnown: boolean;
  select: (query: string) => PickerResult;
  resolveShorthand: ShorthandResolver;
}

interface ComposerChannelSource {
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
const CHANNEL_PICKER_CAP = 8;

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

// ── menu ──────────────────────────────────────────────────────────

function PickerMenu({
  items,
  hiddenCount,
  channelStatus,
  active,
  onPick,
  onHover,
  peopleSections,
  showChannelWorkspace,
  agentAvatarUrls,
  humanAvatarUrls,
}: {
  items: PickerItem[];
  hiddenCount: number;
  /** `#`-only settledness of the channel source. `loading` (some slice pending)
   *  and `partial_error` (a workspace's channels unavailable) stay DISTINCT so the
   *  marker never reports an errored fan-out as "still loading", and neither folds
   *  a partial page into a complete-looking set (#task:2148). Always `complete`
   *  for `@`, which carries its completeness on the send gate, not the render. */
  channelStatus: ChannelSourceStatus;
  active: number;
  onPick: (item: PickerItem) => void;
  onHover: (index: number) => void;
  /** Whether to split rows into "In this channel" / "Other channels" headers on
   *  the `@` picker — the workspace arm against its roster, the viewer arm (a DM)
   *  filing the counterpart agent under "In this channel". Every `#` channel list
   *  is flat (#task:2147). */
  peopleSections: boolean;
  /** Whether a channel row names its workspace — the viewer arm's `#` list spans
   *  workspaces, so same-named channels must stay distinguishable (#task:2148). */
  showChannelWorkspace: boolean;
  agentAvatarUrls: Map<string, string | null>;
  humanAvatarUrls: Map<string, string | null>;
}): JSX.Element {
  // #task:876 (2026-06-03): split header labels per section. We compute the
  // boundary index here (first item with !inConversation) and let the map render a
  // header chip just before that row. Gated on `peopleSections`: a flat arm (any
  // `#`) reports -1 / false so no header ever renders. Channel rows also carry no
  // membership concept, so they never trigger a header even inside a people-
  // sectioned arm.
  //
  // Both headers require a non-empty in-section: the split only means something when
  // something is in this channel. Without it (a roster the viewer sees no in-channel
  // candidate for, or a DM whose counterpart is a human / not owned), the whole list
  // is "other" and a lone "Other channels" header labels nothing — render it flat
  // instead (#task:2147).
  const hasInSection =
    peopleSections && items.some((item) => item.kind !== "channel" && item.inConversation);
  const headerBoundaryIndex = hasInSection
    ? items.findIndex((item) => item.kind !== "channel" && !item.inConversation)
    : -1;
  return (
    <div
      className="absolute bottom-full left-0 mb-1.5 w-64 overflow-hidden rounded-(--select-content-radius) bg-bg-floating shadow-popover"
      data-composer-picker=""
      data-dropdown-frame
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="scrollbar-hide max-h-64 overflow-y-auto p-1" role="listbox">
        {items.map((item, i) => (
          <Fragment key={rowKey(item)}>
            {/* Section header — render BEFORE the row so the boundary
              aligns with the first "other channels" entry. The "In this
              channel" header only renders when that section is non-empty
              AND we haven't already passed it (i === 0 with at least one
              in-channel row). */}
            {i === 0 && hasInSection ? <SectionHeader label="In this channel" /> : null}
            {i === headerBoundaryIndex ? <SectionHeader label="Other channels" /> : null}
            <Row
              item={item}
              active={i === active}
              onPick={() => onPick(item)}
              onHover={() => onHover(i)}
              showChannelWorkspace={showChannelWorkspace}
              agentAvatarUrl={
                item.kind === "agent" ? (agentAvatarUrls.get(item.agent.id) ?? null) : null
              }
              humanAvatarUrl={
                item.kind === "human" ? (humanAvatarUrls.get(item.human.id) ?? null) : null
              }
            />
          </Fragment>
        ))}
      </div>
      {/* Truncation footer (#task:1206). When the display cap dropped
          matched candidates, name the count so truncation isn't silent.
          It sits OUTSIDE the scroll area (sibling under the listbox), so
          it stays visible at any scroll position — the whole point is the
          user with a short query learns more exist. Purely informational:
          not a `role="option"`, not in the keyboard active-index space, no
          hover/click; `aria-hidden` since it's a visual nudge, not a
          selectable result. Muted ink (utility tone), divider only — no
          fill. */}
      {hiddenCount > 0 ? (
        <div
          aria-hidden
          className="border-t border-border-subtle px-3 py-1.5 text-(length:--text-meta) text-text-muted"
        >
          +{hiddenCount} more
        </div>
      ) : null}
      {channelStatus === "loading" ? (
        <div className="border-t border-border-subtle">
          <InlineLoading label="Loading channels" />
        </div>
      ) : channelStatus === "partial_error" ? (
        <div
          role="status"
          className="border-t border-border-subtle px-3 py-1.5 text-(length:--text-meta) text-text-muted"
        >
          Some channels unavailable
        </div>
      ) : null}
    </div>
  );
}

function SectionHeader({ label }: { label: string }): JSX.Element {
  return (
    <div
      role="presentation"
      className="px-2 pb-1 pt-1.5 text-(length:--text-badge) font-medium uppercase tracking-wider text-text-muted"
    >
      {label}
    </div>
  );
}

function Row({
  item,
  active,
  onPick,
  onHover,
  showChannelWorkspace,
  agentAvatarUrl,
  humanAvatarUrl,
}: {
  item: PickerItem;
  active: boolean;
  onPick: () => void;
  onHover: () => void;
  showChannelWorkspace: boolean;
  agentAvatarUrl: string | null;
  humanAvatarUrl: string | null;
}): JSX.Element {
  const dimmed = (item.kind === "agent" || item.kind === "human") && !item.inConversation;
  const cls =
    "flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left " +
    (active ? "bg-bg-hover text-text-primary" : "text-text-secondary") +
    (dimmed && !active ? " opacity-60" : "");

  const rowRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!active) return;
    rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <button
      ref={rowRef}
      type="button"
      role="option"
      aria-selected={active}
      onClick={onPick}
      onMouseMove={onHover}
      className={cls}
    >
      {item.kind === "agent" ? (
        <>
          <AgentAvatar
            runtime={item.agent.runtime}
            size={AVATAR_PX.md}
            avatarObjectUrl={agentAvatarUrl}
            alt={item.agent.display_name || item.agent.name}
          />
          <div className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-sm font-medium text-text-primary">
              {item.agent.display_name?.trim() || item.agent.name}
            </span>
            <div className="flex items-center gap-1.5 text-(length:--text-meta) text-text-muted">
              <span className="truncate font-mono">@{item.agent.name}</span>
              <span data-agent-runtime className="shrink-0">
                {item.agent.runtime}
              </span>
            </div>
          </div>
        </>
      ) : item.kind === "human" ? (
        <>
          <UserAvatar
            size={AVATAR_PX.md}
            avatarObjectUrl={humanAvatarUrl}
            alt={item.human.display_name || item.human.name}
          />
          <div className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-sm font-medium text-text-primary">
              {item.human.display_name?.trim() || item.human.name}
            </span>
            <div className="flex items-center gap-1.5 text-(length:--text-meta) text-text-muted">
              <span className="truncate font-mono">@{item.human.name}</span>
              <span data-participant-kind className="shrink-0">
                human
              </span>
            </div>
          </div>
        </>
      ) : (
        <>
          <Hash className="size-4 shrink-0 text-text-muted" />
          {showChannelWorkspace && item.workspaceName ? (
            <div className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className="truncate text-sm font-medium text-text-primary">
                {item.channel.title}
              </span>
              <span className="truncate text-(length:--text-meta) text-text-muted">
                {item.workspaceName}
              </span>
            </div>
          ) : (
            <span className="truncate text-sm font-medium text-text-primary">
              {item.channel.title}
            </span>
          )}
        </>
      )}
    </button>
  );
}

function rowKey(item: PickerItem): string {
  if (item.kind === "agent") return `a:${item.agent.id}`;
  if (item.kind === "human") return `h:${item.human.id}`;
  return `c:${item.channel.id}`;
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
