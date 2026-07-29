import { useMemo, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import dayjs from 'dayjs';
import { Loader2, X } from 'lucide-react';
import type { TaskDetailDto, TaskStatus } from '@silverhand/shared';
import { ChannelIcon } from '@/components/ChannelIcon';
import { MiniIconButton } from '@/components/tasks/MiniIconButton';
import {
  PersonAvatar,
  usePersonDirectory,
  type PersonDirectory,
} from '@/components/tasks/PersonAvatar';
import { TaskStatusBadge } from '@/components/tasks/TaskStatusBadge';
import { useConversationMembers } from '@/features/conversations/useConversationMembers';
import { cn } from '@/lib/cn';

/** Statuses whose ASSIGNMENT is frozen. `/claim` refuses both server-side, so
 *  offering the control here would promise a click the server won't honour; the
 *  row stays a plain read-only value with no explanatory copy. (The 409 remains
 *  the authority — a task that turns terminal remotely while the modal is open
 *  fails the write, it doesn't slip through.) */
const ASSIGNMENT_FROZEN: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'done',
  'closed',
]);

const TIMESTAMP_FORMAT = 'YYYY-MM-DD HH:mm';

export interface TaskDetailMetaPanelProps {
  /** The AUTHORITATIVE detail read. Never a board summary merged in per field: a
   *  nullable field (assignee, closed_at) merged field-by-field lets a stale
   *  summary value win over a freshly cleared one, and the terminal-status gate
   *  below must not be judged from a possibly-stale status either. The dialog
   *  only mounts this column once the read resolves, so there is no such window
   *  (#task:1715). */
  view: TaskDetailDto;
  /** A dialog-local write occupies the single write slot — the title/content
   *  inline editor being OPEN counts, not just an in-flight request. Blocks
   *  every trigger here so one interaction can't start a second write whose
   *  response would land on top of the first (shiki 2026-07-29: "ui 上可以加状态
   *  来阻塞用户"). Not a concurrency protocol: remote writes stay
   *  last-write-wins, converging over `task_changed`. */
  busy: boolean;
  statusPending: boolean;
  statusFailed: boolean;
  onStatusChange: (status: TaskStatus) => void;
  assignPending: boolean;
  assignFailed: boolean;
  /** `null` clears the assignee. */
  onAssign: (agentId: string | null) => void;
}

/**
 * The task detail modal's metadata column — the sidebar half of the two-column
 * body (#task:1711, spec from #task:1710).
 *
 * It exists because the 800px modal (#task:1675) left a short task reading as a
 * horizontal bar, AND because assignee / creator / channel / created / closed
 * were not shown in the modal at all. So the column fills real gaps rather than
 * padding the layout: every row is a task fact the header couldn't carry.
 *
 * Two rows are also WRITE surfaces (Status, Assignee). Assignee and Status are
 * two INDEPENDENT fields here (shiki 2026-07-29): editing one never implies a
 * change to the other, and the panel only ever displays what the server settled
 * on. The workflow coupling ("claim = take the job") stays on the agent's own CLI
 * verbs, not in this management surface.
 *
 * Both stay text, not bordered controls — a framed input in a 68px/1fr meta row
 * would add a second layer of chrome competing with the 16px identity squares.
 * Resting is the plain value; hover only fades it (`hover:opacity-80`, the same
 * affordance the status chip uses — shiki 2026-07-29), never a ground.
 *
 * The mutations deliberately live in the DIALOG, not here: title/content, status
 * and assignee share ONE local write slot, and a single owner is the only place
 * that can hold it.
 */
export function TaskDetailMetaPanel({
  view,
  busy,
  statusPending,
  statusFailed,
  onStatusChange,
  assignPending,
  assignFailed,
  onAssign,
}: TaskDetailMetaPanelProps): JSX.Element {
  const directory = usePersonDirectory();
  const editor = view.last_editor;
  const editedAt = view.last_edited_at;
  const canAssign = !ASSIGNMENT_FROZEN.has(view.status);

  return (
    <aside
      // Theme-neutral hook: names the DOM role only, so a theme can paint the
      // divider its own way (forza6 gets a 2px ink edge — `border-border-subtle`
      // is a hairline there, it does not thicken on its own).
      data-task-meta-panel
      aria-label="Task metadata"
      // 240px is MEASURED, not slack: label 68 + gap 8 + value ~132 + px-4 (32).
      // The value column has to hold `2026-07-28 16:45` in 11px mono and an
      // `@display_name` — don't compress it to add fields.
      //
      // No ground of its own: the column sits on the dialog's own
      // `bg-bg-floating` (shiki 2026-07-29), so the divider is the only
      // separator. A second fill here read as a panel bolted onto the modal.
      className="flex w-[240px] shrink-0 flex-col gap-y-3.5 overflow-y-auto border-l border-border-subtle px-4 py-4"
    >
      <MetaRow label="Task">
        <span className="font-mono text-[11px] text-text-secondary">
          #{view.task_number}
        </span>
      </MetaRow>

      <MetaRow label="Status" error={statusFailed ? 'Couldn’t update status.' : null}>
        <span className="flex items-center gap-1.5">
          <TaskStatusBadge
            status={view.status}
            {...(busy ? {} : { onChange: onStatusChange })}
          />
          {statusPending ? <PendingSpinner /> : null}
        </span>
      </MetaRow>

      <MetaRow
        label="Assignee"
        error={assignFailed ? 'Couldn’t update assignee.' : null}
      >
        {/* Clearing is an inline ✕ on the current value (shiki 2026-07-29), not
            a row inside the picker: the dropdown then holds only candidates —
            one list, one kind of choice — and "remove this owner" reads as an
            action ON the value it sits beside. Revealed on row hover (and on
            its own focus, so it stays keyboard-reachable) rather than parked
            there permanently: a 240px column of always-on ✕ would be chrome. */}
        <span className="group/assignee flex items-center gap-1">
          {canAssign && !busy ? (
            <AssigneePicker
              conversationId={view.channel_id}
              currentAgentId={
                view.assignee?.type === 'agent' ? view.assignee.id : null
              }
              directory={directory}
              onPick={onAssign}
            >
              <AssigneeValue view={view} directory={directory} />
            </AssigneePicker>
          ) : (
            <AssigneeValue view={view} directory={directory} />
          )}
          {canAssign && !busy && view.assignee ? (
            <MiniIconButton
              icon={X}
              label="Clear assignee"
              // `/unclaim` — ownership only. Terminal tasks never reach here
              // (`canAssign`), and the server refuses them anyway (409).
              onClick={() => onAssign(null)}
              // `ml-1` on top of the row's `gap-1`: the ✕ acts ON the value but
              // is not part of it, so it needs a visible seam (shiki
              // 2026-07-29). 4px alone read as touching the name.
              className="ml-1 opacity-0 transition-opacity group-hover/assignee:opacity-100 focus-visible:opacity-100"
            />
          ) : null}
          {assignPending ? <PendingSpinner /> : null}
        </span>
      </MetaRow>

      {/* "From", not "Creator" (shiki 2026-07-29) — the row answers where the
          task came from, and reads as the counterpart of the Assignee row
          above it rather than a second ownership claim. */}
      <MetaRow label="From">
        <span className="flex min-w-0 items-center gap-1.5">
          {/* `system` has no identity object to show — a synthetic creator gets
              its name only, never a person avatar. */}
          {view.creator.type !== 'system' && view.creator.id ? (
            <PersonAvatar
              person={{ type: view.creator.type, id: view.creator.id }}
              name={view.creator.name}
              {...directory}
            />
          ) : null}
          <span className="truncate" title={view.creator.name}>
            {view.creator.type === 'system'
              ? view.creator.name
              : `@${view.creator.name}`}
          </span>
        </span>
      </MetaRow>

      <MetaRow label="Channel">
        <span className="flex min-w-0 items-center gap-1.5">
          <ChannelIcon variant="sticker" density="sm" className="text-text-muted" />
          <span className="truncate" title={view.conversation.title}>
            {view.conversation.title}
          </span>
        </span>
      </MetaRow>

      <MetaRow label="Created">
        <Timestamp at={view.created_at} />
      </MetaRow>

      {/* Last DEFINITION edit (title or content) — the byline the header used to
          carry. It is a product fact, not decoration: the task body is the
          definition-of-record and a `task_edit` notice broadcasts to every agent
          in the channel, so "who last changed it, and when" belongs on the
          record. The avatar stays (shiki 2026-07-29: 头像是重要的身份信息). A row
          is only rendered when the task has actually been edited. */}
      {editor && editedAt !== null ? (
        <MetaRow label="Edited">
          <span className="flex min-w-0 flex-col gap-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <PersonAvatar
                person={{ type: editor.kind, id: editor.id }}
                name={editor.name}
                {...directory}
              />
              <span className="truncate" title={editor.name}>
                @{editor.name}
              </span>
            </span>
            <Timestamp at={editedAt} muted />
          </span>
        </MetaRow>
      ) : null}

      {/* Missing values render NO row — never a `—` placeholder, so the rows
          above never shift when a field appears. */}
      {view.closed_at !== null ? (
        <MetaRow label="Closed">
          <Timestamp at={view.closed_at} />
        </MetaRow>
      ) : null}
    </aside>
  );
}

// ── Row primitives ─────────────────────────────────────────────────

/** One metadata row: label left, value right, both LEFT-aligned — a
 *  right-aligned value column would make the right edge jitter with value
 *  length. Label uses the shared `.chrome-label` utility so forza6 gets its
 *  Rajdhani caps for free. */
function MetaRow({
  label,
  error,
  children,
}: {
  label: string;
  /** Inline write failure for THIS row — an 11px line under the value. No
   *  toast, no dialog: the failure belongs where the write was started. */
  error?: string | null;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="grid grid-cols-[68px_1fr] items-start gap-x-2">
      <span className="chrome-label text-[10px] font-medium leading-4 text-text-muted">
        {label}
      </span>
      <div className="min-w-0 text-xs leading-4 text-text-primary">
        {children}
        {error ? <p className="mt-0.5 text-[11px] text-error">{error}</p> : null}
      </div>
    </div>
  );
}

function Timestamp({ at, muted }: { at: number; muted?: boolean }): JSX.Element {
  return (
    <time
      dateTime={new Date(at).toISOString()}
      className={cn('font-mono text-[11px]', muted && 'text-text-muted')}
    >
      {dayjs(at).format(TIMESTAMP_FORMAT)}
    </time>
  );
}

function PendingSpinner(): JSX.Element {
  return (
    <Loader2 className="size-3 shrink-0 animate-spin text-text-muted" aria-hidden />
  );
}

function AssigneeValue({
  view,
  directory,
}: {
  view: TaskDetailDto;
  directory: PersonDirectory;
}): JSX.Element {
  if (!view.assignee) {
    return <span className="italic text-text-muted">Unassigned</span>;
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <PersonAvatar
        person={{ type: view.assignee.type, id: view.assignee.id }}
        name={view.assignee.name}
        {...directory}
      />
      <span className="truncate" title={view.assignee.name}>
        @{view.assignee.name}
      </span>
    </span>
  );
}

// ── Assignee picker ────────────────────────────────────────────────

/**
 * Assign / re-assign to an agent of this task's conversation, or clear the
 * assignee.
 *
 * Candidates are the conversation's AGENT members — the same set `/claim`
 * validates against (`assignee_not_conversation_member`), so no row here is one
 * the server would refuse. Humans can hold an assignee (`type: 'user'` exists on
 * the read model) and are displayed, but the write path only takes `agent_id`,
 * so they are never offered.
 *
 * CLEARING is not a row in here — it is the inline ✕ beside the current value
 * (shiki 2026-07-29), so this list stays one kind of choice: who to assign to.
 */
function AssigneePicker({
  conversationId,
  currentAgentId,
  directory,
  onPick,
  children,
}: {
  conversationId: string;
  currentAgentId: string | null;
  directory: PersonDirectory;
  /** Candidates only — `null` (clearing) is not this component's to express;
   *  it belongs to the inline ✕ above. Narrowed so the dropdown can't grow the
   *  row back by type alone. */
  onPick: (agentId: string) => void;
  children: React.ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Change assignee"
          title="Change assignee"
          // Hover = a slight fade, the SAME affordance the status chip uses
          // (`hover:opacity-80`, shiki 2026-07-29) — no ground, no border. A
          // hover fill here made one meta row look like a framed control while
          // the row above it only dimmed; two editable rows in one column must
          // answer "I'm clickable" the same way.
          //
          // No padding either: with the fill gone it bought nothing, and the
          // negative margins it needed to keep the value aligned with the rows
          // above were also pulling the ✕ back over the name.
          className="flex min-w-0 items-center rounded-[var(--control-radius)] text-left transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
        >
          {children}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          collisionPadding={8}
          data-popover-frame="info"
          // Above the dialog's own layer (`z-50`) — a picker rendered under its
          // host dialog is unclickable.
          className="z-[85] min-w-[180px] max-w-[240px] bg-bg-floating p-1 shadow-popover outline-none"
          onCloseAutoFocus={e => e.preventDefault()}
        >
          <PickerBody
            conversationId={conversationId}
            currentAgentId={currentAgentId}
            directory={directory}
            onPick={agentId => {
              setOpen(false);
              onPick(agentId);
            }}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Split out so the roster query only mounts once Radix opens the popover
 *  (Content isn't rendered while closed) — a closed picker issues no request. */
function PickerBody({
  conversationId,
  currentAgentId,
  directory,
  onPick,
}: {
  conversationId: string;
  currentAgentId: string | null;
  directory: PersonDirectory;
  onPick: (agentId: string) => void;
}): JSX.Element {
  const roster = useConversationMembers(conversationId);
  const candidates = useMemo(() => {
    if (roster.status !== 'resolved') return [];
    return roster.members.flatMap(m =>
      m.kind === 'agent' && m.agent_id !== currentAgentId
        ? [{ id: m.agent_id, name: m.name, displayName: m.display_name || m.name }]
        : [],
    );
  }, [roster, currentAgentId]);

  return (
    <div className="flex flex-col gap-1">
      <p className="chrome-label px-2 pt-1 text-[10px] font-medium text-text-muted">
        Assign to
      </p>
      {candidates.length === 0 ? (
        <p className="px-2 py-1.5 text-[11px] italic text-text-muted">
          {roster.status === 'loading' ? 'Loading…' : 'No other agents here.'}
        </p>
      ) : (
        candidates.map(c => (
          <button
            key={c.id}
            type="button"
            onClick={() => onPick(c.id)}
            className="flex w-full min-w-0 items-center gap-2 rounded-[var(--select-item-radius)] px-2 py-1 text-left text-xs transition-colors hover:bg-bg-hover"
          >
            <PersonAvatar
              person={{ type: 'agent', id: c.id }}
              name={c.displayName}
              {...directory}
            />
            <span className="truncate" title={c.displayName}>
              @{c.name}
            </span>
          </button>
        ))
      )}
    </div>
  );
}
