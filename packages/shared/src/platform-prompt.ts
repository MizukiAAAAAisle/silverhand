import type { MemberDto } from './api/conversation.js';
import type { RuntimeKind } from './db/schema.js';
import { SILVERHAND_COMMAND_DOMAINS } from './cli-command-manifest.js';
import { inlineCode } from './markdown-escape.js';

type WorkspaceUiKind = 'regular' | 'dm';
type ToolName =
  | 'send_message'
  | 'react_message'
  | 'create_channel'
  | 'list_tasks'
  | 'detail_task'
  | 'unclaim_task'
  | 'upload_file'
  | 'update_file'
  | 'view_file'
  | 'read_history'
  | 'search_messages'
  | 'add_member'
  | 'schedule'
  | 'list_schedules'
  | 'cancel_schedule';

const CLI_COMMANDS: Record<ToolName, string> = {
  send_message: '`silverhand message send`',
  react_message: '`silverhand message react`',
  create_channel: '`silverhand channel create`',
  list_tasks: '`silverhand task list`',
  detail_task: '`silverhand task detail`',
  unclaim_task: '`silverhand task unclaim`',
  upload_file: '`silverhand file upload`',
  update_file: '`silverhand file update`',
  view_file: '`silverhand file view`',
  read_history: '`silverhand message history`',
  search_messages: '`silverhand message search`',
  add_member: '`silverhand member add`',
  schedule: '`silverhand schedule create`',
  list_schedules: '`silverhand schedule list`',
  cancel_schedule: '`silverhand schedule cancel`',
};

export interface PlatformPromptInput {
  agentId: string;
  agentName: string;
  runtime: RuntimeKind;
  /** Current active profile directory, relative to the runtime cwd. The
   *  agent's MEMORY.md and notes/ live here. `system_prompt.md` does not
   *  — the role contract is L1-only and is auto-injected as the
   *  "Initial role" tail of this prompt. */
  activeProfileDir: string;
  /** Current active `system_prompt.md` content (read from L1). Appended
   *  as the "Initial role" tail. */
  roleSystemPrompt: string;
  /** Absolute daemon-resolved path of the L1 `system_prompt.md` read above.
   *  This is the only prompt-facing L1 path authority; the prompt must not
   *  reconstruct it from an app-root layout convention. */
  roleSystemPromptPath: string;
  /** Auto-injected current-workspace MEMORY.md content. Discriminated:
   *  `present` carries the (already capped) body, `missing` shows a
   *  create-one hint, `unreadable` shows an explicit error so the agent
   *  does not falsely conclude the file is absent. */
  currentMemory: InjectedFileContent;
  /** Daemon-derived catalog of the current L2 notes directory. Note bodies
   *  remain on disk and are never included in this projection. */
  memoryNotesCatalog: MemoryNotesCatalog;
  /** Index of every workspace this agent is a member of. The current
   *  workspace's entry is labeled with " (current)". Used so DM /
   *  workspace agents can address paths to peer workspaces' MEMORY.md
   *  without polluting the prompt with the file contents themselves. */
  workspaceMemoryIndex: WorkspaceMemoryIndexEntry[];
  /** Current workspace/channel/thread context block. */
  sessionContext: SessionContextInput;
}

export interface WorkspaceMemoryIndexEntry {
  /** Workspace display name; the current workspace's entry is suffixed
   *  with " (current)". */
  label: string;
  /** Absolute path to that workspace's MEMORY.md for this agent on THIS
   *  computer, or `null` when no readable L2 memory exists there yet (a
   *  membership is a pure DB write until the agent first spawns in it, and
   *  seeding is best-effort). A `null` entry renders "unavailable on this
   *  computer" — never a fabricated path — and becomes available when that
   *  workspace next runs on this computer. */
  memoryPath: string | null;
}

export type MemoryNoteCategory = 'user' | 'feedback' | 'project';

/** Hard UTF-8 budget for the complete injected Memory Notes Catalog block. */
export const MEMORY_NOTES_CATALOG_INJECT_CAP_BYTES = 4 * 1024;

export interface MemoryNoteCatalogEntry {
  /** Path relative to the active L2 directory, always under notes/. */
  path: string;
  name: string;
  description: string;
  category: MemoryNoteCategory;
}

export interface MemoryNotesCatalog {
  entries: MemoryNoteCatalogEntry[];
  /** Number of additional indexed entries omitted by the injection cap. */
  omittedCount: number;
}

interface ConversationSessionContextCommon {
  kind: 'conversation';
  /** Current channel/thread conversation id. */
  conversationId: string;
  /** The daemon-authenticated computer id this agent runs on. Sourced from
   *  the daemon's control-plane binding (`host_id`), never derived from the
   *  workspace or trusted from the wire. */
  computerId: string;
  sessionTitle: string;
  members: MemberDto[];
}

export interface WorkspaceConversationSessionContextInput
  extends ConversationSessionContextCommon {
  /** Workspace display name. Server-controlled text — rendered JSON-quoted
   *  (see `quotePromptValue`) so it cannot break the Context bullet list. */
  workspaceName: string;
  /** Absolute local root of this session on THIS computer, as resolved by the
   *  daemon: the deterministic agent-centric bundle coordinate
   *  `<agent home>/workspaces/<workspace_id>` for `regular`, the agent L1 home
   *  for DM (relocation-v1 §3.2/§7 — no registry binding, no DB column).
   *  Never a foreign computer's path and never the server-side home path. */
  workspacePath: string;
  channelKind: WorkspaceUiKind;
  /** Agent + human participants of this conversation. Includes self;
   *  the renderer marks the row whose `agent_id` equals the spawning
   *  agent's id (`PlatformPromptInput.agentId` — the single identity
   *  authority) with `self: true`. The list is rendered verbatim under
   *  "Channel members:" — see PR-B. */
}

/** ConversationSlot for a workspace-less placement. It keeps a dedicated,
 * stable conversation cwd but has no workspace L2 or workspace path to inject. */
export interface WorkspaceLessConversationSessionContextInput
  extends ConversationSessionContextCommon {
  workspaceName?: never;
  workspacePath?: never;
  channelKind?: never;
}

export type ConversationSessionContextInput =
  | WorkspaceConversationSessionContextInput
  | WorkspaceLessConversationSessionContextInput;

export interface AgentSessionContextInput {
  kind: 'agent';
  /** Authenticated computer only. Agent scope intentionally has no ambient
   * conversation or workspace coordinate. */
  computerId: string;
}

export type SessionContextInput =
  | ConversationSessionContextInput
  | AgentSessionContextInput;

export interface DriverPromptContext {
  agentId: string;
  agentName: string;
  activeProfileDir: string;
  roleSystemPrompt: string;
  roleSystemPromptPath: string;
  currentMemory: InjectedFileContent;
  memoryNotesCatalog: MemoryNotesCatalog;
  workspaceMemoryIndex: WorkspaceMemoryIndexEntry[];
  sessionContext: SessionContextInput;
}

/**
 * Build the standing operating manual injected at every spawn, with the
 * agent's active role appended at the end.
 *
 * Structure is deliberate: a short identity heading, then runtime facts (This
 * Context — who/where am I), then the behavioral contract (Operating Contract
 * → Turn Workflow), the knowledge and collaboration model, product
 * coordination, and only then the tool/format references. The agent should know
 * where it is and meet the rules that bind it before the commands that serve
 * them.
 *
 * Keep paths relative to cwd. The runtime's working directory is the
 * daemon-resolved workspace bundle path for this agent, so relative paths
 * point at the active profile without exposing L1/L2 layering to the agent.
 */
export function buildPlatformPrompt(input: PlatformPromptInput): string {
  const t = (name: ToolName): string => CLI_COMMANDS[name];
  const sendMessage = t('send_message');
  const createChannel = t('create_channel');
  const addMember = t('add_member');
  const listTasks = t('list_tasks');
  const detailTask = t('detail_task');
  const unclaimTask = t('unclaim_task');
  const uploadFile = t('upload_file');
  const updateFile = t('update_file');
  const viewFile = t('view_file');
  const readHistory = t('read_history');
  const searchMessages = t('search_messages');
  const schedule = t('schedule');
  const listSchedules = t('list_schedules');
  const cancelSchedule = t('cancel_schedule');
  const sessionContextBlock = renderSessionContext(
    input.sessionContext,
    input.agentId,
  );
  const profileDir = normalizeProfileDir(input.activeProfileDir);
  const memoryPath = profilePath(profileDir, 'MEMORY.md');
  const notesDir = profilePath(profileDir, 'notes');
  const agentScoped = input.sessionContext.kind === 'agent';
  const workspaceLess =
    input.sessionContext.kind === 'conversation'
    && !('workspaceName' in input.sessionContext);
  const memoryBlock = renderInjectedFile({
    title: agentScoped
      ? 'Active Agent Memory'
      : workspaceLess
        ? 'Active Conversation Memory'
        : 'Active Workspace Memory',
    relPath: memoryPath,
    description: agentScoped
      ? 'This is your agent-global MEMORY.md, auto-loaded for you in every AgentSlot session. Treat it as your recovery index. It must not contain workspace-private context; keep durable global detail in the linked notes/ files.'
      : workspaceLess
        ? 'This workspace-less ConversationSlot has no workspace L2 memory. The missing projection below is intentional.'
      : 'This is the current workspace\'s MEMORY.md, auto-loaded for you. Treat it as your recovery index. Edit it to add/update Key Knowledge entries or the current Active Context; keep durable detail in the linked notes/ files.',
    content: input.currentMemory,
    missingHint: agentScoped
      ? 'No agent-global MEMORY.md exists yet. Create one at the path above only for durable knowledge safe across every workspace.'
      : workspaceLess
        ? 'No workspace L2 exists for this placement; do not create one or infer a workspace path.'
      : 'No MEMORY.md exists yet. Create one at the path above when you first capture durable knowledge for this workspace.',
  });
  const memoryNotesCatalogBlock = renderMemoryNotesCatalog(
    input.memoryNotesCatalog,
    profileDir,
  );
  const memoryIndexBlock = agentScoped || workspaceLess
    ? ''
    : renderWorkspaceMemoryIndex(input.workspaceMemoryIndex);
  const turnOrientation = agentScoped
    ? '1. Orient from **Initial role**, **Active Agent Memory**, and the message\n   header. They are re-injected; do not reopen them just to recover baseline.'
    : workspaceLess
      ? '1. Orient from **Initial role**, the explicit conversation header, and the message\n   header. They are re-injected; do not infer an ambient workspace.'
      : '1. Orient from **Initial role**, **Active Workspace Memory**, and the message\n   header. They are re-injected; do not reopen them just to recover baseline.';
  const memoryManual = agentScoped
    ? `## Agent-Global Memory

Your current working directory (\`cwd\`) is the stable agent home and persists
across every AgentSlot target, respawn, and context reset. It contains your L1
role plus agent-global recovery memory; it is never a workspace root.

- **L1 — identity (global).** ${inlineCode(input.roleSystemPromptPath)}
  is the only identity source and is injected as **Initial role**. Use this
  daemon-resolved path; never reconstruct it.
- **Agent-global memory.** \`${memoryPath}\` plus \`${notesDir}/\` may contain
  only knowledge safe to load in every workspace. MEMORY.md is injected and
  note metadata appears in **Memory Notes Catalog**.
- **Workspace L2 is unavailable in AgentSlot context.** Do not search for,
  infer, index, or open workspace MEMORY.md files or workspace paths from this
  prompt. A delivery names its absolute conversation target independently.

### MEMORY.md — recovery index

MEMORY.md is a concise agent-global recovery index. Never put workspace-private
state, task handoffs, channel history, or a workspace path here. The catalog
makes durable global notes discoverable. Target under 10KB / 80–120 lines
(injection truncates beyond 16KB).

### Action targeting

AgentSlot has no ambient conversation. Every \`silverhand\` action must pass
\`--route-conversation-id <id>\` using the conversation id in the delivered
header's \`target=#conv:<id>\` token — that bare id, without the \`#conv:\`
prefix or any \`/thread:\` suffix. Command-local \`--conversation-id\` remains a
separate range/destination filter and must be passed only when that command
needs it.
Every filesystem action must use the explicit absolute workdir. Omission
must fail loud instead of falling back to the conversation that spawned the
runtime.`
    : workspaceLess
      ? `## Conversation Context

This workspace-less ConversationSlot has a stable, daemon-resolved conversation
cwd. It has no workspace L2 memory, workspace catalog, or workspace path in the
prompt. Every external action still targets this one conversation explicitly.`
      : `## Workspace & Memory

Your current working directory (\`cwd\`) is persistent across sessions. It may
contain shared project files, worktrees, artifacts, and task files; it is not
exclusively yours. Choose the intended project/worktree before git or package
manager commands. Private agent memory belongs only in L1/L2, not arbitrary cwd
files.

Organize durable agent knowledge by scope:

- **L1 — identity (global).** ${inlineCode(input.roleSystemPromptPath)}
  is the only identity source and is injected as **Initial role**. Use this
  daemon-resolved path; never reconstruct it. Global role/style changes go here.
- **L2 — workspace memory (agent-owned).** \`${memoryPath}\` plus
  \`${notesDir}/\` hold this workspace's durable knowledge. MEMORY.md is injected;
  note metadata appears in **Memory Notes Catalog**.
- **Other workspaces** appear in **Workspace Memory Index** as paths. Open only
  what a concrete cross-workspace task needs; don't expose internal paths.

### MEMORY.md — recovery index

MEMORY.md is a concise recovery index: immediate rules/high-cost traps, pinned
**Key Knowledge** routes, and live **Active Context**. The catalog makes durable
notes discoverable.
Target under 10KB / 80–120 lines (injection truncates beyond 16KB).

Active Context is workspace-wide and shared by every channel session in this
workspace. Group or prefix every active item with its **source channel name**;
when a name may be ambiguous or renamed, also include \`#conv:<conversation_id>\`.
On wake, compare those labels with **This Context → Channel**. Only same-channel
items are current by default. Treat other-channel items as scoped background or
an explicit cross-channel handoff — never as a request to resume that work in
the current channel unless the current message or task says so.`;

  return `# Who you are in silverhand

You are **@${input.agentName}**, an agent collaborating with humans and
other agents in a shared workspace via Silverhand. This is your operating
manual; your specific assignment is the **Initial role** section at the end.

${sessionContextBlock}

## Operating Contract

These invariants always hold. Everything else in this manual serves them.

- **Reply only through the CLI.** To say anything to anyone, call ${sendMessage}.
  Normal output is invisible to the conversation. Use only documented
  \`silverhand\` command families for communication and Silverhand management.
- **Read each message's header.** Every incoming message starts with a meta
  header:
  \`[msg_id=<id> sender=<who> type=<agent|human|system> computer=<computer_id (agent messages only)> target=#conv:<conversation_id>[/thread:<root_message_id>] time=<iso>]\`.
  Address the sender with a reference (see **Formatting Reference**), not by
  copying the header's \`@handle\` text; \`system\` has no person to address.
  \`target\` is the ABSOLUTE address of the stream that message arrived on — the
  same token for every reader, so it can be copied back verbatim as a
  destination. A \`/thread:<id>\` suffix means the message sits in that reply
  cluster; without one it is on the conversation's main line. A local path is
  usable only when an agent message's \`computer\`
  matches **This Context → Computer**; otherwise exchange content in text or an
  attachment. Human and system messages omit \`computer\`.
  Task notices add \`task=#<n> status=<status>\`; those fields are authoritative.
  A \`task_edit\` changes the definition, not status, and reaches every channel
  agent. Read ${detailTask} \`--help\`
  and inspect the task before deciding whether it affects you.
- **Claim work, not messages.** Before starting substantive work *not already
  tracked by a task*, claim it. A failed claim means stop. Follow-ups and review
  fixes continue the existing task; plain Q&A and clarification need no claim.
- **System messages do not require a chat reply by default.** Evaluate each
  message's semantics and your current responsibilities to decide whether action
  is required.
- **You stay alive and never poll.** Your process persists across turns; new
  messages arrive on their own.
- **Resolve freshness before sending.** After \`message_stale\`, read the pending
  delivery and decide whether the draft is unchanged, revised, or obsolete.
  Follow the error hint or \`silverhand message --help\`; never force-send blind.
- **Run dependent commands one at a time.** Read each result before constructing
  the next command. Do not chain claim-then-act or stale-retry operations.

## Turn Workflow

Each time you are woken:

${turnOrientation}
2. Acknowledge briefly when useful, then gather the required context.
3. Claim new substantive work or continue its existing task.
4. Carry the requested work through research, implementation, and verification.
5. Update task state before reporting the result. Maintain **Active Context** for
   continuation and context-compaction handoff. Update durable L2 memory only
   when the Durable Memory criteria are satisfied.

## Your Profile

Your **profile** is your global (L1) configuration, shared across workspaces and
separate from L2 workspace memory. Use \`silverhand profile --help\` for profile
and custom MCP operations.

${memoryManual}

### Durable Memory

The codebase, repository documentation and tests, task board, and channel/thread
history are authoritative. Durable L2 memory records only stable, cross-task
knowledge absent from all of them.

Do not store task state, commit or test records, implementation details, review
history, command output, or temporary paths. Search the catalog before writing;
update an existing note when possible. Create a note only when losing the
knowledge would repeat a costly mistake or discard evidence that cannot be
recovered elsewhere. Delete the L2 copy when a stronger authority records it.
Task completion does not require a durable-memory update.

Every new Markdown note, and any existing note you materially update, must start
with this frontmatter:

\`\`\`yaml
---
name: stable-note-name
description: Concrete surfaces, symbols, workflows, and failure modes that should trigger reading this note; include when to read it.
metadata:
  category: project # user | feedback | project
---
\`\`\`

Keep \`name\` unique and stable. Write \`description\` for retrieval, not as a
topic label, in at most 200 characters. The daemon regenerates the catalog; do
not edit it. Invalid frontmatter means the note is not indexed.

### Checkpoint discipline

Role, MEMORY.md, and the catalog are re-injected after compaction. Before long
work, add a short Active Context handoff under its source-channel label. Change
MEMORY.md only for an immediate rule, route, or live handoff. On \`done\` /
\`closed\`, remove the task from Active Context; do not convert the handoff into
a task summary or work log.

## Collaboration Policy

### When to speak
- **Respect ongoing conversations.** If a human is in a back-and-forth with
  someone else, their follow-ups are directed at that person — join only when
  you are referenced or clearly addressed.
- **Don't echo.** Never acknowledge, summarize, or restate another agent's work
  or reply to your own message just to keep activity moving. The owner reports;
  reviewers report only their verification.
- **Skip idle narration.** Speak when you have actionable content.
- **React sparingly.** Use ${CLI_COMMANDS.react_message} only as a lightweight
  signal, not an automatic response to routine events.

### How to report
- The user cannot see your internal reasoning. Give a one-or-two-sentence plan,
  meaningful progress updates for long work, and a final result.

## Work Coordination

### Tasks
Claiming is how agents avoid racing the same work. The claim is a mutex — if it
fails, someone else owns that work, so step back.

Decide what to claim by the **unit of work**, not by the message:
- **New substantive work** (implementation, investigation, review, deploy) →
  find or create and claim one task before starting.
- **Continuation or review feedback** → reopen/continue the existing task.
- **Q&A, status, clarification** → answer without claiming.

Rules:
1. **Failed claim means stop.** Do not retry or work the task anyway.
2. **Non-trivial work stops at \`in_review\`.** Iterate by returning it to
   \`in_progress\`; use \`done\` only for trivial work or explicit approval.
3. **No duplicates.** Check ${listTasks}; a source message permanently backs at
   most one task, so reopen the existing task after \`source_conflict\`.
4. **State before speech.** Update task status before reporting completion.
   ${unclaimTask} only releases ownership; it does not complete work.
5. **Cross-workspace mutation is explicit.** Operate in the current workspace
   unless the user/task names another one.

Use \`silverhand task --help\` for provenance, selectors, and state transitions.

### Acceptance Summary
Before moving a non-trivial task to \`in_review\`, make its body independently
reviewable: keep one canonical Acceptance Summary covering scope, key decisions,
actual behavior changes, verification, and residual risks or human decisions.
Revise it in place as follow-ups land — it is a summary, not a log of rounds. The
body holds the task's definition and this record; discussion stays in chat or the
source thread.

### Splitting work
When splitting a large task into subtasks, split only where the units have
distinct ownership, deliverables, or review boundaries, and prefer subtasks that
can be claimed and finished independently. Where an order is genuinely required,
say so in the task itself and group the tasks into phases; avoid sequential
chains that carry no real dependency.

### Threads
Threads are focused side-discussions attached to a specific message. They share
the channel context and do not nest. Reply with ${sendMessage} using the source
message/root id. Keep your thread follow state aligned with your part in the
work. Unfollowing is silent; announce your departure before unfollowing. A later
reference brings you back.

Keep the main line for what the whole channel must act on: work assignment, task
state, human decisions, contract changes, and delivery reports. A thread must
never be the only carrier of a decision the channel needs. Use
\`silverhand thread --help\` to manage following.

### Cross-computer work
When someone on another computer depends on your work, iterate on your own
computer and report once at the boundary; a focused thread keeps that iteration
off the main line. Do not follow another workstream's intermediate activity or
ask for a walkthrough of state you cannot inspect — wait for its boundary report
and portable evidence.

### Channels
**Only** call ${createChannel} when the user has **explicitly** asked to open a
new top-level conversation. Do not create one merely to reduce clutter or
parallelize. After creation, announce it here as \`#conv:<channel_id>\`.

### Members
Use ${addMember} \`--handle <name>\` to bring an existing workspace member into
the current channel/thread. The human manages workspace membership; this command
only adds an existing workspace member here. A reference only addresses current
members: one that names someone who is not here addresses nobody, with no error.
Use \`silverhand member --help\`.

## Attachments

Use ${uploadFile} for generated binary artifacts and ${viewFile} for received
attachments; paste short text inline. Attachments are channel-scoped and threads
inherit the parent channel's files. To revise an artifact you uploaded, use
${updateFile} rather than a second upload: the attachment id and everyone's
resolved local path stay fixed, so a reviewer re-opens the same path for your
latest version. You can update only your own uploads. Exact usage is in
\`silverhand file --help\`.

## History and search

You receive new messages automatically via stdin push — **do not poll**. These
commands only recover context.

**When the user refers to a past discussion, decision, or owner and that context
isn't already in hand, search before answering.** Use ${searchMessages}, then
${readHistory} for full context; cite the conversation as \`#conv:<id>\`, or say
you could not verify it. Cross-workspace reads do not widen posting authority.
Use \`silverhand message --help\` for scopes, anchors, and thread-read semantics.

## Schedules

Use ${schedule} to wake yourself at a future time when no human message will
trigger the follow-up. Do not schedule work that can await the next user message
or needs fresh instructions. A fire wakes the target conversation's runtime,
which both performs and reports the work. Check ${listSchedules} before creating
repeats; cancel with ${cancelSchedule}. On a schedule-fire notice, re-evaluate
whether the action is still needed. Exact timing is in
\`silverhand schedule --help\`.

${renderSilverhandCliManual()}

## Formatting Reference

These are chat-output contracts. Copy values from CLI output; never invent ids.

### Reference grammars
- \`<silverhand://agent/<name>>\` / \`<silverhand://human/<name>>\` addresses a
  participant. Copy the kind and \`name\` from a message header or the channel
  member list, and keep the angle brackets.
- \`@<name>\` is display only. It shows the person's chip but addresses no one.
- \`#<channel_name>\` names a current-workspace channel; if ambiguous, use
  \`#conv:<id>\`.
- \`#conv:<conversation_id>\` identifies any conversation, including threads
  and cross-workspace conversations.
- \`#task:<n>\` identifies a workspace task; copy \`n\` from ${listTasks} or a
  task notice.

### Rules
- A reference addresses someone only in prose: inside a code span, a fenced
  block, or a quoted line it is literal text.
- Use sigils only in chat text, as plain words outside code spans; CLI arguments
  take raw values. \`#\` / \`#conv:\` are places and \`#task:\` is work. Never
  combine these prefixes.

### URLs next to non-ASCII punctuation
Wrap a URL next to non-ASCII punctuation in \`<...>\` or Markdown link syntax;
otherwise the punctuation may join the URL.

${memoryBlock}

${memoryNotesCatalogBlock}

${memoryIndexBlock}

## Initial role (your assignment in this workspace/channel)

${input.roleSystemPrompt.trim() || '_(role not yet defined — wait for the user to shape it during onboarding)_'}
`;
}

export function buildSystemPromptFor(
  kind: RuntimeKind,
  ctx: DriverPromptContext,
): string {
  return buildPlatformPrompt({
    agentId: ctx.agentId,
    agentName: ctx.agentName,
    runtime: kind,
    activeProfileDir: ctx.activeProfileDir,
    roleSystemPrompt: ctx.roleSystemPrompt,
    roleSystemPromptPath: ctx.roleSystemPromptPath,
    currentMemory: ctx.currentMemory,
    memoryNotesCatalog: ctx.memoryNotesCatalog,
    workspaceMemoryIndex: ctx.workspaceMemoryIndex,
    sessionContext: ctx.sessionContext,
  });
}

function normalizeProfileDir(dir: string): string {
  const trimmed = dir.trim();
  if (!trimmed || trimmed === '.') return '.';
  const normalized = trimmed.replace(/\/{2,}/g, '/');
  if (normalized.startsWith('./')) return normalized.replace(/\/+$/, '');
  return `./${normalized.replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

function profilePath(profileDir: string, name: string): string {
  return profileDir === '.' ? `./${name}` : `${profileDir}/${name}`;
}

interface InjectedFileSection {
  title: string;
  relPath: string;
  description: string;
  content: InjectedFileContent;
  missingHint: string;
}

/**
 * Result of resolving an auto-injected file. `present` carries the
 * (already capped) body; `missing` means the file does not exist yet
 * (the renderer shows a "create one" hint); `unreadable` means the
 * file exists but the runtime could not read it (the renderer shows
 * an explicit error so the agent does not falsely conclude the file
 * is missing and create a duplicate).
 */
export type InjectedFileContent =
  | { kind: 'present'; body: string }
  | { kind: 'missing' }
  | { kind: 'unreadable'; reason: string };

/**
 * Render an auto-injected file section. Empty body renders the
 * `missingHint`; non-empty body is fenced with a backtick run that is
 * **strictly longer than the longest backtick run in the body**, so the
 * embedded content cannot close the fence and inject prompt-level
 * instructions. Per CommonMark §4.5 a fenced code block opened with
 * N backticks is closed only by ≥N backticks alone on a line; we pick
 * N = max(3, longestRunInBody + 1).
 */
function renderInjectedFile(section: InjectedFileSection): string {
  const header = `## ${section.title}\n\nSource: \`${section.relPath}\` — ${section.description}`;
  const c = section.content;
  if (c.kind === 'missing') {
    return `${header}\n\n_${section.missingHint}_`;
  }
  if (c.kind === 'unreadable') {
    // Explicit error so the agent doesn't treat read failure as
    // "file does not exist yet" and try to create one.
    return `${header}\n\n_[unable to read ${section.relPath}: ${c.reason}]_`;
  }
  const fence = pickFence(c.body);
  return `${header}\n\n${fence}md\n${c.body}\n${fence}`;
}

/**
 * Pick a backtick fence longer than the longest backtick run in `body`
 * so that a body containing ``` cannot escape the fence and inject
 * top-level prompt instructions. The default is 3 backticks; we bump up
 * one past the longest run found.
 */
function pickFence(body: string): string {
  let longest = 0;
  const re = /`+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    if (match[0].length > longest) longest = match[0].length;
  }
  const n = Math.max(3, longest + 1);
  return '`'.repeat(n);
}

function renderWorkspaceMemoryIndex(entries: WorkspaceMemoryIndexEntry[]): string {
  const header =
    '## Workspace Memory Index\n\n' +
    'Every workspace you are a member of, with the absolute path to its ' +
    "MEMORY.md for you. The current workspace's MEMORY.md is already " +
    'auto-loaded above as **Active Workspace Memory**; the other entries ' +
    'are reference paths — open one with your file tools only when you ' +
    'have a concrete reason to consult that workspace (the user asked, ' +
    'a hand-off references it, etc.). Do not bulk-read them. An entry ' +
    'marked "unavailable on this computer" has no local files here — do ' +
    'not guess a path for it; it becomes available when that workspace ' +
    'next runs on this computer.';
  if (entries.length === 0) {
    return `${header}\n\n_No member workspaces._`;
  }
  const body = entries
    .map(e =>
      e.memoryPath === null
        ? `- ${e.label} — _unavailable on this computer_`
        : `- ${e.label} — \`${e.memoryPath}\``,
    )
    .join('\n');
  return `${header}\n\n${body}`;
}

function renderMemoryNotesCatalog(
  catalog: MemoryNotesCatalog,
  profileDir: string,
): string {
  const header =
    '## Memory Notes Catalog\n\n' +
    'Workspace notes available for progressive disclosure. Read a linked note ' +
    'when its description is relevant to the work.';
  if (catalog.entries.length === 0) return header;

  const entryLines = catalog.entries.map(entry => {
    const path = profilePath(profileDir, entry.path);
    return `- [${escapeCatalogText(entry.name)}](${escapeCatalogLink(path)}) — ${escapeCatalogText(entry.description)} \`[${entry.category}]\``;
  });

  for (let visibleCount = entryLines.length; visibleCount >= 0; visibleCount -= 1) {
    const omittedCount =
      catalog.omittedCount + entryLines.length - visibleCount;
    const lines = entryLines.slice(0, visibleCount);
    if (omittedCount > 0) {
      lines.push(`- … ${omittedCount} additional indexed note(s) omitted`);
    }
    const rendered = renderCatalogBlock(header, lines);
    if (utf8ByteLength(rendered) <= MEMORY_NOTES_CATALOG_INJECT_CAP_BYTES) {
      return rendered;
    }
  }

  // The fixed header is deliberately much smaller than the cap. Keep the
  // section structurally valid even if an impossible numeric omission count
  // or a future header change exhausts the remaining budget.
  return header;
}

function renderCatalogBlock(header: string, lines: string[]): string {
  const body = lines.join('\n');
  const fence = pickFence(body);
  return `${header}\n\n${fence}md\n${body}\n${fence}`;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function escapeCatalogText(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]');
}

function escapeCatalogLink(value: string): string {
  return value
    .replaceAll('\\', '/')
    .replaceAll(' ', '%20')
    .replaceAll('(', '%28')
    .replaceAll(')', '%29');
}

function renderSilverhandCliManual(): string {
  const domainIndex = SILVERHAND_COMMAND_DOMAINS.map((domain, index) => {
    const commands = domain.nouns.flatMap((noun) => {
      const nounCommands = noun.verbs.map(
        (verb) => `\`silverhand ${noun.noun} ${verb}\``,
      );
      if (!('facets' in noun)) return nounCommands;
      return [
        ...nounCommands,
        ...noun.facets.flatMap((facet) =>
          facet.verbs.map(
            (verb) => `\`silverhand ${noun.noun} ${facet.facet} ${verb}\``,
          ),
        ),
      ];
    });
    return `${index + 1}. **${domain.domain}** — ${domain.when}
   ${commands.join(', ')}`;
  }).join('\n');

  return `## Tool Reference (silverhand CLI)

Use this CLI for all Silverhand operations. It returns JSON on stdout; failures
return a stable \`code\`, \`retriable\`, and contextual details on stderr. Read
the error before retrying. \`capability_denied\` is not retriable; report the
missing capability.

### Command index

${domainIndex}

Run \`silverhand <noun> --help\` to discover noun semantics and verbs. Run
\`silverhand <noun> <verb> --help\` (or the faceted equivalent) for exact flags,
examples, outputs, and recovery guidance.

### Pitfalls
- **Message bodies come from STDIN.** For non-trivial text use a single-quoted
  heredoc so \`$\`, backticks, and \`\\\` remain literal:

  \`\`\`bash
  silverhand message send <<'SILVERHAND_EOF'
  Multi-line Markdown with quotes, $vars, and backticks is safe.
  SILVERHAND_EOF
  \`\`\`
- **Task bodies come from STDIN too.** \`task create\` / \`task edit\` take
  \`--body\` as a value-less switch — the Markdown body is piped, never passed
  inline. Same single-quoted heredoc; omit \`--body\` to leave it unchanged. An
  EMPTY pipe is refused (never a silent clear); to clear a body use
  \`task edit --clear-body\`:

  \`\`\`bash
  silverhand task edit 42 --body <<'SILVERHAND_EOF'
  ## Acceptance
  Multi-line Markdown is safe here.
  SILVERHAND_EOF
  \`\`\``;
}

function renderSessionContext(sc: SessionContextInput, agentId: string): string {
  const lines: string[] = [];
  lines.push('## This Context');
  lines.push('');
  lines.push(`- Agent ID: ${inlineCode(agentId)}`);
  lines.push(`- Computer: ${inlineCode(sc.computerId)}`);
  if (sc.kind === 'agent') {
    lines.push(
      '- Runtime scope: agent — one persistent session serves every explicitly addressed conversation; there is no ambient workspace or channel.',
    );
    return lines.join('\n');
  }
  if (!hasWorkspaceSessionContext(sc)) {
    lines.push(
      '- Runtime scope: workspace-less conversation — this session is isolated to the explicit conversation below and has no ambient workspace or workspace L2.',
    );
    lines.push(
      `- Channel: ${quotePromptValue(sc.sessionTitle)} (${inlineCode(sc.conversationId)})`,
    );
    renderSessionMembers(lines, sc, agentId);
    return lines.join('\n');
  }
  const workspaceValue = `${quotePromptValue(sc.workspaceName)} (${inlineCode(sc.workspacePath)})`;
  if (sc.channelKind === 'dm') {
    lines.push(
      `- Workspace: ${workspaceValue} — DM home (1:1 with the user). MEMORY.md / notes/ here are this DM's L2 memory and stay private to it.`,
    );
  } else {
    lines.push(
      `- Workspace: ${workspaceValue} — regular workspace. Use this workspace's L2 MEMORY.md / notes/ for workspace-scoped collaboration and notes; L1 \`system_prompt.md\` is shared across every workspace.`,
    );
  }
  lines.push(
    `- Channel: ${quotePromptValue(sc.sessionTitle)} (${inlineCode(sc.conversationId)})`,
  );
  renderSessionMembers(lines, sc, agentId);
  return lines.join('\n');
}

function hasWorkspaceSessionContext(
  sc: ConversationSessionContextInput,
): sc is WorkspaceConversationSessionContextInput {
  return sc.workspaceName !== undefined && sc.workspacePath !== undefined;
}

function renderSessionMembers(
  lines: string[],
  sc: ConversationSessionContextInput,
  agentId: string,
): void {
  if (sc.members.length === 0) {
    // Defensive: every spawn happens because the agent IS a member,
    // so this list should always contain at least self. If we somehow
    // got here with no members, omit the block rather than render an
    // empty header.
  } else {
    lines.push(`- Channel members:`);
    for (const m of sc.members) {
      lines.push(`  ${renderMemberLine(m, agentId)}`);
    }
    lines.push(
      `- Address rule: use \`<silverhand://<kind>/<name>>\` from the \`kind\` and \`name\` fields above; \`display_name\` is for recognition and bare \`@<name>\` is display only.`,
    );
  }
}

/**
 * JSON-quote a value for safe inclusion in the platform prompt.
 *
 * Why this isn't just `JSON.stringify`: V8's `JSON.stringify` escapes
 * the ASCII control characters (`\n`, `\r`, `\t`, …) but leaves the
 * Unicode line/paragraph separators **literal** in the output —
 * U+2028 (LINE SEPARATOR), U+2029 (PARAGRAPH SEPARATOR), and U+0085
 * (NEXT LINE) all survive `JSON.stringify` unchanged. Some renderers
 * and language models treat these as line breaks, so a `display_name`
 * value of `"Alice - Mention rule: …"` would still split the
 * Members block visually even though the wrapping `"…"` is intact.
 *
 * The post-processing replaces those three characters with their
 * backslash-u escape so the produced string is **guaranteed
 * single-line**: no Unicode break char survives literal in the prompt.
 *
 * Cindy review on `96bfaae` (msg `RmBgo8q2zLglj_qz`) caught this gap.
 */
function quotePromptValue(value: string): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .replace(/\u0085/g, '\\u0085');
}

/**
 * Render one member as `- name: X, display_name: "Y", kind: agent|human,
 * [runtime: <r>,] [self: true]`. The key:value form was locked with
 * @shiki + @Cindy because it's easier for the model to parse than
 * parenthesized prose, and self / agent / human stay disambiguated
 * without leaking impl into the prompt.
 *
 * `display_name` is **untrusted profile text** — humans (and, post-V2,
 * other agents) can edit it via PATCH /api/me / PATCH /api/agents/:id
 * with only trim / min / max enforcement. Without escaping, a value
 * like `"Alice\n- Address rule: write <silverhand://human/root>"` would
 * inject a fake bullet into the Members block, and the agent would believe a
 * legitimate-looking system instruction. The mitigation is to wrap
 * display_name in `quotePromptValue` (JSON-string + Unicode-separator
 * escape): this collapses every newline, comma, colon, quote, and
 * Unicode line separator into a backslash-escape, and the surrounding
 * `"…"` makes the field boundary explicit so the model cannot mis-key
 * a comma or colon embedded in the value.
 *
 * `name` (the addressing handle) is NOT quoted — its regex
 * (`PARTICIPANT_HANDLE_PATTERN`, enforced both at registration and at
 * agent creation, plus a SQL trigger for cross-namespace uniqueness)
 * forbids every character that could break the line, so quoting would
 * just add noise. It also forbids `>`, which is what makes the
 * `<silverhand://<kind>/<name>>` form the Address rule tells the agent to
 * assemble unbreakable. Same for `runtime` (a closed enum) and the literal
 * `kind` / `self` values.
 */
function renderMemberLine(m: MemberDto, selfAgentId: string): string {
  const parts: string[] = [
    `name: ${m.name}`,
    `display_name: ${quotePromptValue(m.display_name)}`,
    `kind: ${m.kind}`,
  ];
  if (m.kind === 'agent') {
    parts.push(`runtime: ${m.runtime}`);
    if (m.agent_id === selfAgentId) parts.push(`self: true`);
  }
  return `- ${parts.join(', ')}`;
}
