import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { Hash, Paperclip, Send, X } from 'lucide-react';
import type { AgentDto } from '@silverhand/shared';
import { Button } from '@/components/ui/button';
import { AgentAvatar } from '@/components/AgentAvatar';
import { useAgents } from '@/features/agents/hooks';
import { useAgentAvatarObjectUrls } from '@/features/agents/avatar-hooks';
import { useWorkspaces, type WorkspaceListItem } from '@/features/workspaces/hooks';
import { useSendMessage } from '@/features/channels/hooks';
import {
  clearComposerDraft,
  dropSentAttachmentsFromDraft,
  hasComposerDraftInFlightUpload,
  patchComposerDraftText,
  readComposerDraft,
  removeComposerDraftAttachment,
  startComposerDraftAttachmentUpload,
  subscribeComposerDraft,
  upsertComposerDraftAttachment,
  writeComposerDraft,
  type CachedPendingAttachment,
  type ComposerDraftSnapshot,
} from '@/lib/composer-draft-cache';
import { Lightbox } from './Lightbox';

interface ComposerProps {
  conversationId: string;
  routeKind?: 'channel' | 'thread';
  disabled: boolean;
  /** When true, composer is disabled with an "archived" placeholder.
   *  Independent of `disabled` (closed) so we can distinguish the reason
   *  in the placeholder copy without losing other disabled paths. */
  archived?: boolean;
}

const MAX_TEXTAREA_HEIGHT = 192; // Mirrors Tailwind max-h-48.
const MAX_ATTACHMENTS = 20; // Matches backend SendMessageInputSchema cap.
type PendingAttachment = CachedPendingAttachment;
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
 *  - Typing `@` or `#` at a word boundary (start of input, or after
 *    whitespace / `(` / `[`) opens a floating menu of matches. The
 *    menu stays anchored above the textarea (popup-relative-to-row,
 *    not caret-x; caret-x positioning needs a mirror div and isn't
 *    worth the complexity for this usage).
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
  routeKind = 'channel',
  disabled: disabledProp,
  archived = false,
}: ComposerProps): JSX.Element {
  // Treat archived as another flavor of disabled so every send/attach
  // path is gated identically. Placeholder below distinguishes the copy.
  const disabled = disabledProp || archived;
  const [initialDraft] = useState(() => readComposerDraft(conversationId));
  const [draft, setDraftState] = useState(initialDraft?.text ?? '');
  const [caret, setCaretState] = useState(initialDraft?.caret ?? 0);
  const [pending, setPendingState] = useState<PendingAttachment[]>(
    () => initialDraft?.pending ?? [],
  );
  const draftRef = useRef(draft);
  const caretRef = useRef(caret);
  const pendingRef = useRef<PendingAttachment[]>(pending);
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
  const send = useSendMessage(conversationId, routeKind);
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
    next:
      | PendingAttachment[]
      | ((current: PendingAttachment[]) => PendingAttachment[]),
  ): void {
    const value =
      typeof next === 'function' ? next(pendingRef.current) : next;
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
    patchComposerDraftText(conversationId, routeKind, nextDraft, nextCaret);
  }

  function updateCaret(nextCaret: number): void {
    caretRef.current = nextCaret;
    setCaretState(nextCaret);
    patchComposerDraftText(conversationId, routeKind, draftRef.current, nextCaret);
  }

  function detachSubmittingDraftForEdit(): void {
    const submitting = submittingSnapshotRef.current;
    if (!submitting) return;
    dropSentAttachmentsFromDraft(
      conversationId,
      submitting.snapshot.pending.map(item => item.key),
    );
    submittingSnapshotRef.current = null;
    patchComposerDraftText(
      conversationId,
      routeKind,
      draftRef.current,
      caretRef.current,
    );
  }

  useEffect(() => {
    for (const item of pendingRef.current) {
      if (
        item.state === 'uploading'
        && item.file
        && !hasComposerDraftInFlightUpload(conversationId, item.key)
      ) {
        void startComposerDraftAttachmentUpload({
          conversationId,
          routeKind,
          attachmentKey: item.key,
          file: item.file,
          previewUrl: item.previewUrl,
        });
      }
    }
  }, [conversationId, routeKind]);

  useEffect(() => {
    return subscribeComposerDraft(conversationId, event => {
      if (event.type === 'clear') {
        draftRef.current = '';
        caretRef.current = 0;
        pendingRef.current = [];
        setDraftState('');
        setCaretState(0);
        setPendingState([]);
        return;
      }
      if (event.type === 'attachment-remove') {
        setPendingValue(curr =>
          curr.filter(item => item.key !== event.attachmentKey),
        );
        return;
      }
      setPendingValue(curr =>
        curr.map(item =>
          item.key === event.attachmentKey
            ? { ...item, ...event.patch }
            : item,
        ),
      );
    });
  }, [conversationId]);

  useEffect(() => {
    return () => {
      const submitting = submittingSnapshotRef.current;
      const snapshot =
        submitting && editGenerationRef.current === submitting.editGeneration
          ? submitting.snapshot
          : {
              conversationId,
              routeKind,
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
  }, [conversationId, routeKind]);

  const { data: agents = [] } = useAgents();
  const agentAvatarUrls = useAgentAvatarObjectUrls(agents);
  const { data: workspaces = [] } = useWorkspaces();

  const trigger = useMemo(
    () => (composing ? null : detectTrigger(draft, caret)),
    [draft, caret, composing],
  );

  const items = useMemo<PickerItem[]>(() => {
    if (!trigger) return [];
    if (trigger.kind === '@') {
      return filterAgents(agents, trigger.query);
    }
    return filterWorkspaces(workspaces, trigger.query);
  }, [trigger, agents, workspaces]);

  const [active, setActive] = useState(0);
  // Keep the highlight in range as the candidate list shrinks/grows.
  useEffect(() => {
    if (active >= items.length) setActive(0);
  }, [items.length, active]);
  // Reset highlight whenever the trigger reopens at a different spot.
  useEffect(() => {
    setActive(0);
  }, [trigger?.pos, trigger?.kind]);

  const menuOpen = !!trigger && items.length > 0;

  const insertPick = (item: PickerItem): void => {
    if (!trigger) return;
    const handle = item.kind === 'agent' ? item.agent.name : item.workspace.name;
    const before = draft.slice(0, trigger.pos);
    const after = draft.slice(trigger.pos + 1 + trigger.query.length);
    // Trailing space so the next keystroke isn't immediately treated
    // as continuation of the handle (and so the caret lands at a
    // typing-friendly spot).
    const insertion = `${trigger.kind}${handle} `;
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
    disabled
    || send.isPending
    || pending.some(p => p.state === 'uploading')
    || (!draft.trim() && pending.filter(p => p.state === 'done').length === 0);

  function submit(): void {
    const content = draft.trim();
    const ready = pending
      .filter(p => p.state === 'done' && p.attachment)
      .map(p => p.attachment!);
    if ((!content && ready.length === 0) || disabled) return;
    if (pending.some(p => p.state === 'uploading')) return;
    const submittedPending = pending.filter(p => p.state === 'done' && p.attachment);
    const sentAttachmentIds = ready.map(item => item.id);
    const submittedSnapshot: ComposerDraftSnapshot = {
      conversationId,
      routeKind,
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
    draftRef.current = '';
    caretRef.current = 0;
    pendingRef.current = [];
    setDraftState('');
    setCaretState(0);
    setPendingState([]);
    void send
      .mutateAsync({ content, attachments: ready })
      .then(() => {
        const submitting = submittingSnapshotRef.current;
        if (submitting?.editGeneration !== editGeneration) return;
        clearComposerDraft(conversationId, { sentAttachmentIds });
        submittingSnapshotRef.current = null;
      })
      .catch(() => {
        const submitting = submittingSnapshotRef.current;
        if (submitting?.editGeneration !== editGeneration) return;
        submittingSnapshotRef.current = null;
        if (mountedRef.current) {
          draftRef.current = submittedSnapshot.text;
          caretRef.current = submittedSnapshot.caret;
          pendingRef.current = submittedSnapshot.pending;
          setDraftState(submittedSnapshot.text);
          setCaretState(submittedSnapshot.caret);
          setPendingState(submittedSnapshot.pending);
        }
        patchComposerDraftText(
          conversationId,
          routeKind,
          submittedSnapshot.text,
          submittedSnapshot.caret,
        );
        for (const item of submittedSnapshot.pending) {
          upsertComposerDraftAttachment(conversationId, routeKind, item);
        }
      });
  }

  function addFiles(files: FileList | File[]): void {
    const list = Array.from(files);
    if (list.length === 0) return;
    const slotsLeft = MAX_ATTACHMENTS - pendingRef.current.length;
    if (slotsLeft <= 0) return;
    for (const file of list.slice(0, slotsLeft)) {
      const key = `att-${crypto.randomUUID()}`;
      const isImage = file.type.startsWith('image/');
      const previewUrl = isImage ? URL.createObjectURL(file) : undefined;
      const item: PendingAttachment = {
        key,
        filename: file.name,
        size: file.size,
        contentType: file.type || 'application/octet-stream',
        state: 'uploading',
        file,
        previewUrl,
      };
      detachSubmittingDraftForEdit();
      editGenerationRef.current += 1;
      setPendingValue(curr => [
        ...curr,
        item,
      ]);
      void startComposerDraftAttachmentUpload({
        conversationId,
        routeKind,
        attachmentKey: key,
        file,
        previewUrl,
      });
    }
  }

  function removePending(key: string): void {
    detachSubmittingDraftForEdit();
    editGenerationRef.current += 1;
    setPendingValue(curr => curr.filter(p => p.key !== key));
    removeComposerDraftAttachment(conversationId, key);
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
    if (Array.from(e.dataTransfer.types).includes('Files')) {
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
    if (!files || files.length === 0) return;
    e.preventDefault();
    addFiles(files);
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

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    // Picker eats navigation keys whenever it's actually visible
    // (matches available AND not dismissed for the current token).
    if (menuOpen && !dismissed) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive(i => (i + 1) % items.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive(i => (i - 1 + items.length) % items.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (composing || e.nativeEvent.isComposing) return; // IME candidate
        e.preventDefault();
        const pick = items[active];
        if (pick) insertPick(pick);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (trigger) setDismissedPos(trigger.pos);
        return;
      }
    }

    if (e.key !== 'Enter') return;
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
      onSubmit={onSubmit}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      className={
        'shrink-0 border-t border-border-subtle bg-bg-primary px-3 py-3 ' +
        (dragOver ? 'ring-2 ring-border-focus' : '')
      }
    >
      {pending.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {pending.map(p => (
            <AttachmentChip
              key={p.key}
              item={p}
              onRemove={() => removePending(p.key)}
              onPreview={
                p.previewUrl
                  ? () => setPreviewing({ url: p.previewUrl!, alt: p.filename })
                  : undefined
              }
            />
          ))}
        </div>
      ) : null}
      <div className="relative">
        {menuOpen && !dismissed ? (
          <PickerMenu
            items={items}
            active={active}
            onPick={insertPick}
            onHover={setActive}
            agentAvatarUrls={agentAvatarUrls}
          />
        ) : null}
        <textarea
          ref={ref}
          value={draft}
          onChange={e => {
            updateDraft(
              e.target.value,
              e.target.selectionStart ?? e.target.value.length,
            );
          }}
          onKeyUp={e => updateCaret(e.currentTarget.selectionStart ?? 0)}
          onClick={e => updateCaret(e.currentTarget.selectionStart ?? 0)}
          onSelect={e => updateCaret(e.currentTarget.selectionStart ?? 0)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          disabled={disabled}
          placeholder={
            archived
              ? '会话已归档，无法发送'
              : disabled
                ? '会话已关闭，无法发送'
                : 'Enter 发送，Shift + Enter 换行，@agent，#channel'
          }
          className="block max-h-48 min-h-[60px] w-full resize-none rounded-md border border-border-subtle bg-bg-floating px-3 py-2 pb-11 pr-12 text-sm text-text-primary placeholder:text-text-muted focus:border-border-focus focus:outline-none focus:ring-2 focus:ring-border-focus disabled:cursor-not-allowed disabled:opacity-60"
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={e => {
            if (e.target.files) addFiles(e.target.files);
            // Reset so re-selecting the same file fires onChange.
            e.target.value = '';
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || pending.length >= MAX_ATTACHMENTS}
          title="附件"
          className="absolute bottom-2 left-2 inline-flex size-8 items-center justify-center rounded-md text-text-muted transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Paperclip className="size-4" />
        </button>
        <Button
          type="submit"
          variant="default"
          size="icon"
          disabled={sendDisabled}
          title="发送消息"
          className="absolute bottom-2 right-2 size-8"
        >
          <Send className="size-3.5" />
        </Button>
      </div>
      <Lightbox
        open={previewing !== null}
        onOpenChange={open => {
          if (!open) setPreviewing(null);
        }}
        src={previewing?.url ?? ''}
        alt={previewing?.alt ?? ''}
      />
    </form>
  );
}

function AttachmentChip({
  item,
  onRemove,
  onPreview,
}: {
  item: PendingAttachment;
  onRemove: () => void;
  /** Provided only for image attachments with a local previewUrl. */
  onPreview?: () => void;
}): JSX.Element {
  const sizeLabel = formatBytes(item.size);
  const stateClass =
    item.state === 'error'
      ? 'border-status-danger text-status-danger'
      : item.state === 'uploading'
        ? 'border-border-subtle text-text-muted'
        : 'border-border-subtle text-text-secondary';
  const isImage = item.contentType.startsWith('image/');

  // Image chip: small thumbnail + filename + remove. Click thumbnail
  // opens the lightbox. Non-image chip: paperclip icon + filename.
  return (
    <div
      className={`flex max-w-[260px] items-center gap-1.5 rounded-md border bg-bg-floating px-2 py-1 text-xs ${stateClass}`}
      title={item.error ?? `${item.filename} (${sizeLabel})`}
    >
      {isImage && item.previewUrl ? (
        <button
          type="button"
          onClick={onPreview}
          disabled={!onPreview}
          className="block size-8 shrink-0 overflow-hidden rounded-sm border border-border-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
          aria-label="预览图片"
        >
          <img
            src={item.previewUrl}
            alt={item.filename}
            className="block size-full object-cover"
          />
        </button>
      ) : (
        <Paperclip className="size-3 shrink-0" />
      )}
      <span className="truncate">{item.filename}</span>
      <span className="shrink-0 text-[10px] text-text-muted">
        {item.state === 'uploading' ? '上传中…' : sizeLabel}
      </span>
      <button
        type="button"
        onClick={onRemove}
        className="ml-1 inline-flex size-4 items-center justify-center rounded-sm text-text-muted hover:text-text-primary"
        aria-label="移除附件"
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

function resizeTextarea(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.style.height = 'auto';
  const nextHeight = Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT);
  el.style.height = `${nextHeight}px`;
  el.style.overflowY =
    el.scrollHeight > MAX_TEXTAREA_HEIGHT ? 'auto' : 'hidden';
}

// ── trigger detection ─────────────────────────────────────────────

interface ActiveTrigger {
  kind: '@' | '#';
  /** Index in `text` of the trigger character itself. */
  pos: number;
  /** Substring between trigger and caret (the live query). */
  query: string;
}

const HANDLE_CHAR = /[a-zA-Z0-9_-]/;

/**
 * Walks left from the caret looking for the nearest `@` or `#` that
 * could plausibly start an autocomplete token. Bails on whitespace or
 * anything not in the handle character class — so `foo@bar`, `path/@x`,
 * and `2#3` don't open the menu.
 *
 * Boundary check on the trigger char itself: the char before the
 * trigger must not extend the handle (i.e. not a handle char and not
 * `/`, so emails like `me@example.com` and URL-ish `path/@thing`
 * stay quiet). Mirrors the render-side regex in `Markdown.tsx`.
 */
function detectTrigger(text: string, caret: number): ActiveTrigger | null {
  if (caret < 1 || caret > text.length) return null;
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i]!;
    if (ch === '@' || ch === '#') {
      const prev = i === 0 ? '' : text[i - 1]!;
      const boundary = prev === '' || (!HANDLE_CHAR.test(prev) && prev !== '/');
      if (!boundary) return null;
      return {
        kind: ch as '@' | '#',
        pos: i,
        query: text.slice(i + 1, caret),
      };
    }
    if (!HANDLE_CHAR.test(ch)) return null;
  }
  return null;
}

// ── filtering ─────────────────────────────────────────────────────

type PickerItem =
  | { kind: 'agent'; agent: AgentDto }
  | { kind: 'workspace'; workspace: WorkspaceListItem };

function filterAgents(agents: AgentDto[], query: string): PickerItem[] {
  const q = query.toLowerCase();
  // Empty query — show everything (capped) so the menu acts as a
  // browser when the user just types `@` to explore.
  const matched = q
    ? agents.filter(a =>
        a.name.toLowerCase().includes(q) ||
        (a.display_name ?? '').toLowerCase().includes(q),
      )
    : agents;
  return matched.slice(0, 8).map(agent => ({ kind: 'agent', agent }));
}

function filterWorkspaces(
  workspaces: WorkspaceListItem[],
  query: string,
): PickerItem[] {
  const q = query.toLowerCase();
  const matched = q
    ? workspaces.filter(w => w.name.toLowerCase().includes(q))
    : workspaces;
  return matched.slice(0, 8).map(workspace => ({ kind: 'workspace', workspace }));
}

// ── menu ──────────────────────────────────────────────────────────

function PickerMenu({
  items,
  active,
  onPick,
  onHover,
  agentAvatarUrls,
}: {
  items: PickerItem[];
  active: number;
  onPick: (item: PickerItem) => void;
  onHover: (index: number) => void;
  agentAvatarUrls: Map<string, string | null>;
}): JSX.Element {
  return (
    <div
      // Float above the textarea, left-aligned. Width matches the
      // textarea so long display names don't get clipped.
      className="absolute bottom-full left-0 right-0 mb-1.5 max-h-64 overflow-y-auto rounded-md border border-border bg-bg-floating p-1 shadow-lg"
      role="listbox"
      // Don't steal focus from the textarea on click — submit handler
      // still needs the caret position to do the replacement.
      onMouseDown={e => e.preventDefault()}
    >
      {items.map((item, i) => (
        <Row
          key={rowKey(item)}
          item={item}
          active={i === active}
          onPick={() => onPick(item)}
          onHover={() => onHover(i)}
          agentAvatarUrl={
            item.kind === 'agent'
              ? agentAvatarUrls.get(item.agent.id) ?? null
              : null
          }
        />
      ))}
    </div>
  );
}

function Row({
  item,
  active,
  onPick,
  onHover,
  agentAvatarUrl,
}: {
  item: PickerItem;
  active: boolean;
  onPick: () => void;
  onHover: () => void;
  agentAvatarUrl: string | null;
}): JSX.Element {
  const cls =
    'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-left ' +
    (active ? 'bg-bg-hover text-text-primary' : 'text-text-secondary');
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onClick={onPick}
      onMouseMove={onHover}
      className={cls}
    >
      {item.kind === 'agent' ? (
        <>
          <AgentAvatar
            runtime={item.agent.runtime}
            size={20}
            avatarObjectUrl={agentAvatarUrl}
            alt={item.agent.display_name || item.agent.name}
          />
          <span className="truncate font-medium">
            {item.agent.display_name?.trim() || item.agent.name}
          </span>
          <span className="truncate text-xs text-text-muted">
            @{item.agent.name}
          </span>
          <span className="ml-auto shrink-0 text-[10px] text-text-muted">
            {item.agent.runtime}
          </span>
        </>
      ) : (
        <>
          <Hash className="size-4 text-text-muted" />
          <span className="truncate font-medium">#{item.workspace.name}</span>
          <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wider text-text-muted">
            {item.workspace.kind}
          </span>
        </>
      )}
    </button>
  );
}

function rowKey(item: PickerItem): string {
  return item.kind === 'agent'
    ? `a:${item.agent.id}`
    : `w:${item.workspace.id}`;
}
