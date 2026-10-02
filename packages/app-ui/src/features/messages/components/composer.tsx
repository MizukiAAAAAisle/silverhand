import { AnimatePresence } from "motion/react";
import { getCurrentUserId } from "@/features/session/current-user";
import { createLogicalSend, type LogicalSend } from "@/features/channels/logical-send";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { AtSign, Hash, Paperclip } from "lucide-react";
import type { AgentDto } from "@silverhand/shared";
import { isGenericMimeHint, mimeFromFilename } from "@silverhand/shared";
import {
  rewriteShorthandReferences,
  type ShorthandResolver,
} from "@silverhand/shared/reference-markdown";
import { MAX_ATTACHMENTS, shouldInterceptOversizedPaste } from "../model/oversize-paste";
import { Button } from "@/components/ui/button";
import { useAgentAvatarObjectUrls } from "@/features/agent-shell/hooks/avatar-hooks";
import { useUserAvatarObjectUrls } from "@/features/users/avatar-hooks";
import {
  useChannelsAcrossWorkspaces,
  useChannelsForWorkspace,
  useWorkspaceMemberLists,
  useWorkspaces,
  type WorkspaceHumanMember,
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
import {
  EMPTY_PICKER,
  mergeViewerMentionAgents,
  type HumanMentionCandidate,
  buildMentionHumans,
  type ComposerMentionSource,
  selectMentionCandidates,
  buildShorthandResolver,
  selectViewerMentionCandidates,
  buildViewerShorthandResolver,
  type ComposerChannelSource,
  filterChannels,
  channelSourceStatusOf,
  viewerChannelPickerResult,
  detectTrigger,
  selectPickerView,
  type PickerItem,
  formatPickInsertion,
  canResolveShorthandNow,
} from "../model/composer-picker";
import { PickerMenu } from "./composer-picker-menu";
import {
  PendingAttachmentTray,
  PendingAttachmentMotion,
  AttachmentChip,
} from "./pending-attachment-tray";

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
        "shrink-0 border-t border-border-subtle bg-(--pane-bg,var(--bg-base)) px-3 py-3 " +
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

export function resizeTextarea(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.style.height = "auto";
  const nextHeight = Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT);
  el.style.height = `${nextHeight}px`;
  el.style.overflowY = el.scrollHeight > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
}
