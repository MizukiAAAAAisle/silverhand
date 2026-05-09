import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { z } from 'zod';
import type { BridgeArgs } from './args.js';
import { BackendClient } from './client.js';
import { log } from './logger.js';

/**
 * MCP tools exposed to the agent CLI. Names map to claude prefix
 * `mcp__chat__<tool>` (and equivalent for other runtimes).
 *
 * Tool surface deliberately minimal per core-design §3.6 / §4.6:
 *   - send_message: primary chat tool, with target= to reach parent /
 *                   child Threads
 *   - create_thread: open an isolated sub-discussion (Thread) off the
 *                    current channel
 *   - close_thread: end the current Thread, optionally posting summary
 *                   back to parent
 *   - create_channel: open a new top-level channel in the same workspace;
 *                     use only when the user explicitly requests it
 *
 * Memory / consensus reads/writes use the agent's own Read/Write tools
 * (cwd is the conversation workspace_path snapshot) — no MCP wrapper needed.
 */
export async function startBridge(args: BridgeArgs): Promise<void> {
  const client = new BackendClient(args);

  const server = new McpServer(
    { name: 'silverhand-chat-bridge', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );

  server.tool(
    'send_message',
    'Send a chat message in the current channel/thread, or to the parent / a specific child Thread.',
    {
      content: z.string().min(1).describe('Message body.'),
      target: z
        .union([
          z.literal('self').describe('Current channel/thread (default).'),
          z.literal('parent').describe('Parent channel of the current Thread.'),
          z
            .object({ thread_id: z.string().min(1) })
            .describe('A direct child Thread you opened from the current channel.'),
        ])
        .optional()
        .describe(
          'Where to send. Defaults to "self" (current channel/thread). ' +
            'Use "parent" only from a Thread. ' +
            'Use {thread_id} to message a direct child Thread you opened.',
        ),
      attachment_ids: z
        .array(z.string().min(1))
        .max(20)
        .optional()
        .describe(
          'Attachment ids returned by `upload_file`. Each must belong to the ' +
            'current channel (threads inherit their parent channel). ' +
            'Up to 20 per message; omit when sending a plain text message.',
        ),
    },
    async ({ content, target, attachment_ids }) => {
      log(
        'info',
        {
          contentBytes: content.length,
          target: target ?? 'self',
          attachmentCount: attachment_ids?.length ?? 0,
        },
        'tool: send_message invoked',
      );
      try {
        const r = await client.sendMessage({ content, target, attachment_ids });
        log('info', { messageId: r.message_id }, 'tool: send_message ok');
        return {
          content: [{ type: 'text', text: JSON.stringify(r) }],
        };
      } catch (err) {
        log('error', { err }, 'tool: send_message failed');
        throw err;
      }
    },
  );

  server.tool(
    'create_thread',
    'Open an isolated Thread (sub-discussion) off the current channel. Use when a side-topic ' +
      'is large enough that mixing it with the main channel would obscure the context, or when ' +
      'you want to delegate a sub-task to a subset of members in parallel. ' +
      'When members is omitted, all current channel members are pulled in; the caller is always included. ' +
      'Cannot be used inside a Thread — Threads cannot nest further.',
    {
      title: z.string().min(1).describe('Short title for the Thread.'),
      members: z
        .array(z.string().min(1))
        .optional()
        .describe(
          'Optional agent ids to pull in. Must be a subset of current channel members. ' +
            'Omit to use all current channel members; the caller is always included.',
        ),
      context_summary: z
        .string()
        .min(1)
        .describe(
          'Concise summary of what the Thread needs to know from this channel. ' +
            'Be specific and minimal — this is your forcing function for deciding ' +
            'whether opening a Thread is actually warranted.',
        ),
      initial_prompt: z
        .string()
        .min(1)
        .describe('First message posted into the Thread to kick off the discussion.'),
    },
    async input => {
      log('info', { title: input.title, memberCount: input.members?.length ?? null }, 'tool: create_thread invoked');
      try {
        const r = await client.createThread(input);
        log('info', { threadId: r.thread_id }, 'tool: create_thread ok');
        return { content: [{ type: 'text', text: JSON.stringify(r) }] };
      } catch (err) {
        log('error', { err }, 'tool: create_thread failed');
        throw err;
      }
    },
  );

  server.tool(
    'close_thread',
    'Mark the current Thread as closed and (optionally) post a summary to the parent channel. ' +
      'Use only when you are currently inside a Thread.',
    {
      summary: z
        .string()
        .min(1)
        .describe('Final summary of the Thread outcome.'),
      posted_to_parent: z
        .boolean()
        .optional()
        .describe(
          'Set true if you have already sent the conclusion to the parent via ' +
            'send_message(target="parent"). When false (default), the platform ' +
            'auto-posts the summary so the parent always learns the result.',
        ),
    },
    async input => {
      log('info', { summaryBytes: input.summary.length, postedToParent: !!input.posted_to_parent }, 'tool: close_thread invoked');
      try {
        await client.closeThread(input);
        log('info', {}, 'tool: close_thread ok');
        return { content: [{ type: 'text', text: 'ok' }] };
      } catch (err) {
        log('error', { err }, 'tool: close_thread failed');
        throw err;
      }
    },
  );

  server.tool(
    'read_history',
    'Read anchored chat history from the current channel/thread, parent, a direct child Thread, or any conversation you are a current member of (use {conversation_id} from list_channels to reach a different workspace). ' +
      'Requires exactly one anchor: before_seq, after_seq, or around_message_id. ' +
      'Returns snippets and metadata by default; set include_content=true only when full text is needed.',
    {
      target: z
        .union([
          z.literal('self').describe('Current channel/thread (default).'),
          z.literal('parent').describe('Parent channel of the current Thread.'),
          z
            .object({ thread_id: z.string().min(1) })
            .describe('A direct child Thread of the current channel.'),
          z
            .object({ conversation_id: z.string().min(1) })
            .describe(
              'Any conversation (channel / dm_channel / thread) you are a current member of. ' +
                'Use this with ids from list_channels to read history of channels in another workspace.',
            ),
        ])
        .optional()
        .describe(
          'Where to read. Defaults to "self". Use "parent" only from a Thread, ' +
            '{thread_id} for a direct child Thread you can access, or {conversation_id} ' +
            'for any conversation you are a current member of.',
        ),
      before_seq: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Read messages with seq lower than this value.'),
      after_seq: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Read messages with seq greater than this value.'),
      around_message_id: z
        .string()
        .min(1)
        .optional()
        .describe('Read a window centered on this message id.'),
      include_content: z
        .boolean()
        .optional()
        .describe('When true, include full message content. Default false returns snippets only.'),
      include_system: z
        .boolean()
        .optional()
        .describe('When false, omit system messages. Default true.'),
      limit: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe('Maximum messages to return. Default 50, max 100.'),
    },
    async input => {
      const anchorCount = [
        input.before_seq,
        input.after_seq,
        input.around_message_id,
      ].filter(v => v !== undefined).length;
      if (anchorCount !== 1) {
        throw new Error(
          'read_history: anchor required; pass exactly one of before_seq, after_seq, or around_message_id',
        );
      }
      log(
        'info',
        {
          target: input.target ?? 'self',
          limit: input.limit ?? 50,
          includeContent: !!input.include_content,
        },
        'tool: read_history invoked',
      );
      try {
        const r = await client.readHistory({
          ...input,
          include_content: input.include_content ?? false,
          include_system: input.include_system ?? true,
          limit: input.limit ?? 50,
        });
        log(
          'info',
          {
            messageCount: r.messages.length,
            targetConversationId: r.target.conversation_id,
          },
          'tool: read_history ok',
        );
        return { content: [{ type: 'text', text: JSON.stringify(r) }] };
      } catch (err) {
        log('error', { err }, 'tool: read_history failed');
        throw err;
      }
    },
  );

  server.tool(
    'list_workspaces',
    'List every workspace this agent is currently a member of: regular workspaces it has been added to, plus its own personal home workspace. ' +
      'Each entry includes `agent_dir` — the absolute path to the agent\'s working directory inside that workspace (use it to read your own MEMORY.md / notes / logs there for self-correction). ' +
      'Use this before list_channels({workspace_id}) so workspace_id values come from the tool surface.',
    {},
    async () => {
      log('info', {}, 'tool: list_workspaces invoked');
      try {
        const r = await client.listWorkspaces();
        log(
          'info',
          { workspaceCount: r.workspaces.length },
          'tool: list_workspaces ok',
        );
        return { content: [{ type: 'text', text: JSON.stringify(r) }] };
      } catch (err) {
        log('error', { err }, 'tool: list_workspaces failed');
        throw err;
      }
    },
  );

  server.tool(
    'list_channels',
    'List top-level channels of a workspace where this agent is currently a member. ' +
      'Defaults to the current workspace; pass `workspace_id` (from list_workspaces) to list channels of another workspace you have access to. ' +
      'Use this before search_messages(scope="channel") so channel_id values come from the tool surface.',
    {
      workspace_id: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Optional workspace id from list_workspaces. Defaults to the current workspace when omitted.',
        ),
    },
    async input => {
      log(
        'info',
        { workspaceId: input.workspace_id ?? null },
        'tool: list_channels invoked',
      );
      try {
        const r = await client.listChannels({ workspace_id: input.workspace_id });
        log('info', { channelCount: r.channels.length }, 'tool: list_channels ok');
        return { content: [{ type: 'text', text: JSON.stringify(r) }] };
      } catch (err) {
        log('error', { err }, 'tool: list_channels failed');
        throw err;
      }
    },
  );

  server.tool(
    'search_messages',
    'Search message text visible to this agent. scope defaults to "current" (current channel/thread only). ' +
      'Use scope="workspace" for all conversations in this workspace where the agent is a current member; pass an explicit `workspace_id` (from list_workspaces) to search a different workspace you have access to. ' +
      'Use scope="channel" with a channel_id returned by list_channels (in any workspace you can access) to search that channel and visible child Threads. ' +
      'Returns message_ref + sender + a short excerpt only. To fetch the full body of a hit, call read_history with `target: { conversation_id: hit.message_ref.conversation_id }, around_message_id: hit.message_ref.id` — using the default `self` target will 404 on remote hits.',
    {
      q: z.string().trim().min(1).max(200).describe('Search text. Required.'),
      scope: z
        .enum(['current', 'workspace', 'channel'])
        .optional()
        .describe('Search scope. Default current.'),
      workspace_id: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Optional workspace id from list_workspaces. Only valid when scope is workspace; defaults to the current workspace.',
        ),
      channel_id: z
        .string()
        .min(1)
        .optional()
        .describe('Required only when scope is channel; must come from list_channels.'),
      include_system: z
        .boolean()
        .optional()
        .describe('When false, omit system messages. Default true.'),
      limit: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe('Maximum hits to return. Default 50, max 100.'),
    },
    async input => {
      const scope = input.scope ?? 'current';
      if ((scope === 'channel') !== !!input.channel_id) {
        throw new Error(
          'search_messages: channel_id is required only when scope is channel',
        );
      }
      if (input.workspace_id && scope !== 'workspace') {
        throw new Error(
          'search_messages: workspace_id is only valid with scope=workspace',
        );
      }
      log(
        'info',
        {
          scope,
          workspaceId: input.workspace_id ?? null,
          channelId: input.channel_id ?? null,
          limit: input.limit ?? 50,
        },
        'tool: search_messages invoked',
      );
      try {
        const r = await client.searchMessages({
          ...input,
          scope,
          include_system: input.include_system ?? true,
          limit: input.limit ?? 50,
        });
        log('info', { hitCount: r.hits.length }, 'tool: search_messages ok');
        return { content: [{ type: 'text', text: JSON.stringify(r) }] };
      } catch (err) {
        log('error', { err }, 'tool: search_messages failed');
        throw err;
      }
    },
  );

  server.tool(
    'create_channel',
    'Create a new top-level channel in the same workspace. ' +
      'ONLY use this when the user has explicitly requested opening a separate channel ' +
      '(e.g. "open a new channel", "discuss this separately", "start a new conversation"). ' +
      'Do NOT use it to avoid context clutter or for parallel sub-tasks — use create_thread instead. ' +
      'The new channel is created in the current workspace with the current channel members. ' +
      'After creation, post a visible message in the current channel announcing the new channel ID ' +
      'so the user knows a fork happened.',
    {
      title: z.string().min(1).describe('Short title for the new channel.'),
      context_summary: z
        .string()
        .min(1)
        .describe(
          'Explain why this new channel is being created and what user intent it serves. ' +
            'This is stored for audit and recovery — be explicit that the user requested it.',
        ),
      initial_prompt: z
        .string()
        .min(1)
        .describe(
          'First message posted into the new channel. Should clearly state what this ' +
            'channel is for and what participants should do next.',
        ),
    },
    async input => {
      log('info', { title: input.title }, 'tool: create_channel invoked');
      try {
        const r = await client.createChannel(input);
        log('info', { channelId: r.channel_id }, 'tool: create_channel ok');
        return { content: [{ type: 'text', text: JSON.stringify(r) }] };
      } catch (err) {
        log('error', { err }, 'tool: create_channel failed');
        throw err;
      }
    },
  );

  // ── Tasks ────────────────────────────────────────────────────────
  // See docs/tasks-design.md §5. Tasks are message metadata; numbering
  // space is per-workspace, operation scope is per-channel/thread.
  // These tools aggregate at workspace level (you'll see other
  // channels/threads' tasks in list_tasks output) but only accept
  // mutations on tasks that belong to YOUR current channel/thread.

  server.tool(
    'list_tasks',
    'View the task board for the current workspace. Aggregates tasks from every channel ' +
      'and thread in this workspace — each entry carries a source field pointing to the ' +
      'channel/thread it belongs to. You can only claim/update tasks in YOUR current channel/thread (see reason field ' +
      'on claim failures).',
    {
      status: z
        .enum(['all', 'todo', 'in_progress', 'in_review', 'done'])
        .optional()
        .describe('Filter by status. Default = all.'),
    },
    async ({ status }) => {
      log('info', { status: status ?? 'all' }, 'tool: list_tasks invoked');
      try {
        const r = await client.listTasks({ status });
        return { content: [{ type: 'text', text: JSON.stringify(r) }] };
      } catch (err) {
        log('error', { err }, 'tool: list_tasks failed');
        throw err;
      }
    },
  );

  server.tool(
    'create_tasks',
    'Create one or more task-messages in the current channel/thread. Use for genuinely new work; ' +
      'if the work already exists as a message, use claim_tasks with message_ids instead ' +
      '(promotes the existing message to a task and claims it). Does NOT auto-claim — call ' +
      'claim_tasks afterward if you intend to work on them yourself.',
    {
      tasks: z
        .array(
          z.object({
            title: z.string().min(1).max(200).describe('Short task title.'),
            body: z
              .string()
              .optional()
              .describe('Optional longer body. Defaults to the title when omitted.'),
          }),
        )
        .min(1)
        .describe('Array of tasks to create.'),
    },
    async input => {
      log('info', { count: input.tasks.length }, 'tool: create_tasks invoked');
      try {
        const r = await client.createTasks(input);
        if ('error' in r) {
          log('warn', { error: r.error }, 'tool: create_tasks rejected');
          return { content: [{ type: 'text', text: JSON.stringify(r) }] };
        }
        log('info', { created: r.tasks.length }, 'tool: create_tasks ok');
        return { content: [{ type: 'text', text: JSON.stringify(r) }] };
      } catch (err) {
        log('error', { err }, 'tool: create_tasks failed');
        throw err;
      }
    },
  );

  server.tool(
    'claim_tasks',
    'Claim tasks so you become the assignee. Two modes:\n' +
      '1. task_numbers: claim existing tasks (shown in list_tasks) — e.g. [1,3].\n' +
      '2. message_ids: promote a regular message to a task and claim it (use the message\n' +
      '   id from chat). Thread / system messages cannot become tasks.\n' +
      'Claim is atomic: if another agent already claimed it OR the task belongs to a\n' +
      'different channel/thread, the result entry has success=false with a reason. ALWAYS move ' +
      'on when a claim fails — do not retry, do not work on it anyway. Claiming a `todo` ' +
      'task auto-advances it to `in_progress`.',
    {
      task_numbers: z
        .array(z.number().int().positive())
        .optional()
        .describe('Existing task numbers to claim (from list_tasks output).'),
      message_ids: z
        .array(z.string().min(1))
        .optional()
        .describe(
          'Message ids to promote-and-claim. Message must be in your current channel/thread and not be ' +
            'a system / thread message.',
        ),
    },
    async input => {
      log(
        'info',
        {
          byNumber: input.task_numbers?.length ?? 0,
          byMessage: input.message_ids?.length ?? 0,
        },
        'tool: claim_tasks invoked',
      );
      try {
        const r = await client.claimTasks(input);
        const ok = r.results.filter(x => x.success).length;
        log('info', { ok, total: r.results.length }, 'tool: claim_tasks ok');
        return { content: [{ type: 'text', text: JSON.stringify(r) }] };
      } catch (err) {
        log('error', { err }, 'tool: claim_tasks failed');
        throw err;
      }
    },
  );

  server.tool(
    'unclaim_task',
    'Release your claim on a task so someone else can pick it up. Use only when you can no ' +
      'longer work on it — do NOT use unclaim to signal "done" (use update_task_status with ' +
      'in_review / done instead). Fails if you are not the assignee or the task is already done.',
    {
      task_number: z.number().int().positive().describe('Task number to unclaim.'),
    },
    async ({ task_number }) => {
      log('info', { task_number }, 'tool: unclaim_task invoked');
      try {
        const r = await client.unclaimTask(task_number);
        return { content: [{ type: 'text', text: JSON.stringify(r) }] };
      } catch (err) {
        log('error', { err }, 'tool: unclaim_task failed');
        throw err;
      }
    },
  );

  server.tool(
    'update_task_status',
    'Move a task through its lifecycle. You must be the assignee.\n' +
      '  in_progress → in_review: your work is ready for human validation\n' +
      '  in_progress → done     : ONLY for trivial tasks or after explicit human approval\n' +
      '  in_review   → done     : after human approval (usually the human does this)\n' +
      '  in_review   → in_progress: if you need to go back and iterate\n' +
      'Other transitions are rejected. Stop at `in_review` by default and let the human ' +
      'push it to done.',
    {
      task_number: z.number().int().positive(),
      status: z.enum(['in_progress', 'in_review', 'done']),
    },
    async input => {
      log('info', input, 'tool: update_task_status invoked');
      try {
        const r = await client.updateTaskStatus(input);
        return { content: [{ type: 'text', text: JSON.stringify(r) }] };
      } catch (err) {
        log('error', { err }, 'tool: update_task_status failed');
        throw err;
      }
    },
  );

  // ── Schedules ────────────────────────────────────────────────────
  // Agent-owned cron-like scheduler: the agent picks a time policy,
  // the backend wakes the agent at the next due time by inserting a
  // `from_kind='system'` message into the agent's agent_home primary
  // dm_channel. Schedules are scoped to the calling agent — there is
  // no channel/thread coupling. See `docs/mcp-system.md` §6 for the
  // complete contract; the descriptions below are what the model sees
  // at tool-listing time, so they must be self-sufficient.

  server.tool(
    'schedule',
    'Create a self-wake schedule for this agent. Three spec kinds: ' +
      '`once` (single fire at fire_at OR delay_seconds from now), ' +
      '`interval` (every every_seconds, >=60), or ' +
      '`cron` (5-field UNIX cron in an IANA timezone). ' +
      'When the schedule fires, the platform inserts a system message into your ' +
      'agent_home dm_channel; treat it as your own task to act on. ' +
      'Repeat schedules without max_occurrences/until_at must set allow_unbounded=true. ' +
      'Quotas: ≤50 active per agent; one-shot delay ∈ [30s, 90d]; interval every_seconds ≥ 60.',
    {
      message: z
        .string()
        .min(1)
        .max(500)
        .describe(
          'Free-text payload echoed in the wake message. Write the actual instruction ' +
            'to your future self here (e.g. "check task #42 status and report").',
        ),
      spec: z
        .discriminatedUnion('kind', [
          z
            .object({
              kind: z.literal('once'),
              fire_at: z
                .number()
                .int()
                .positive()
                .optional()
                .describe('Absolute epoch-ms UTC fire time. Mutually exclusive with delay_seconds.'),
              delay_seconds: z
                .number()
                .int()
                .positive()
                .optional()
                .describe('Convenience: fire now + delay_seconds. Mutually exclusive with fire_at.'),
            })
            .describe('One-shot fire. Specify exactly one of fire_at or delay_seconds.'),
          z
            .object({
              kind: z.literal('interval'),
              every_seconds: z
                .number()
                .int()
                .min(60)
                .describe('Fire cadence in seconds. Minimum 60 (aligned to scheduler tick).'),
              start_at: z
                .number()
                .int()
                .positive()
                .optional()
                .describe('Absolute epoch-ms UTC for the first fire. Defaults to now+every_seconds.'),
            })
            .describe('Repeat at a fixed interval.'),
          z
            .object({
              kind: z.literal('cron'),
              expression: z
                .string()
                .min(1)
                .max(200)
                .describe('5-field UNIX cron expression (minute granularity). No seconds, no @aliases.'),
              timezone: z
                .string()
                .min(1)
                .max(64)
                .describe('IANA timezone name, e.g. "Asia/Shanghai" or "America/New_York".'),
            })
            .describe('Repeat on a cron schedule in an explicit timezone (DST-aware).'),
        ])
        .describe('Time policy. Discriminated by `kind`.'),
      until_at: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Optional epoch-ms UTC end time for repeat specs. ' +
            'Rejected on `once` (a one-shot fires exactly once and has no end-time concept).',
        ),
      max_occurrences: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Optional max number of fires for repeat specs. ' +
            'Rejected on `once` (a one-shot always fires exactly once).',
        ),
      allow_unbounded: z
        .boolean()
        .optional()
        .describe(
          'Required `true` when a repeat spec sets neither max_occurrences nor until_at. ' +
            'Rejected on `once`. Forces explicit opt-in to forever-runs.',
        ),
    },
    async input => {
      log(
        'info',
        { kind: input.spec.kind, hasUntil: !!input.until_at, hasMax: !!input.max_occurrences },
        'tool: schedule invoked',
      );
      try {
        const r = await client.createSchedule(input);
        log(
          'info',
          { id: r.schedule.id, nextFireAt: r.schedule.next_fire_at },
          'tool: schedule ok',
        );
        return { content: [{ type: 'text', text: JSON.stringify(r) }] };
      } catch (err) {
        log('error', { err }, 'tool: schedule failed');
        throw err;
      }
    },
  );

  server.tool(
    'list_schedules',
    'List this agent\'s schedules. Default returns all statuses; pass status="active" for ' +
      'pending+firing only (the common case for "what do I still have on the books"). ' +
      'Returns an array of full schedule rows ordered by next_fire_at ASC. ' +
      'No cross-agent visibility — only schedules you own.',
    {
      status: z
        .enum(['pending', 'firing', 'active', 'done', 'cancelled', 'failed', 'all'])
        .optional()
        .describe(
          'Filter by status. "active" = pending+firing (sugar; the DB never persists "active"). ' +
            'Default "all".',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('Max rows to return. Default 100, max 200.'),
    },
    async input => {
      log('info', { status: input.status ?? 'all', limit: input.limit ?? 100 }, 'tool: list_schedules invoked');
      try {
        const r = await client.listSchedules(input);
        log('info', { count: r.schedules.length }, 'tool: list_schedules ok');
        return { content: [{ type: 'text', text: JSON.stringify(r) }] };
      } catch (err) {
        log('error', { err }, 'tool: list_schedules failed');
        throw err;
      }
    },
  );

  server.tool(
    'cancel_schedule',
    'Cancel one of your schedules by id. Only `pending` or `firing` rows are cancellable; ' +
      'terminal states (done, cancelled, failed) return `not_cancellable`. ' +
      'Cancel races with an in-flight fire are accepted: if cancel arrives after CAS-claim ' +
      'the wake may still be delivered, but no further fires will occur.',
    {
      schedule_id: z.string().min(1).describe('id from a prior schedule/list_schedules result.'),
    },
    async ({ schedule_id }) => {
      log('info', { schedule_id }, 'tool: cancel_schedule invoked');
      try {
        const r = await client.cancelSchedule({ schedule_id });
        log('info', { id: r.schedule.id, status: r.schedule.status }, 'tool: cancel_schedule ok');
        return { content: [{ type: 'text', text: JSON.stringify(r) }] };
      } catch (err) {
        log('error', { err }, 'tool: cancel_schedule failed');
        throw err;
      }
    },
  );

  // ── Attachments ──────────────────────────────────────────────────
  // Files are scoped to the calling channel/thread; the backend derives
  // ownership from the current conversation and rejects cross-channel
  // reads. Keep tool descriptions terse: agents need to know when these
  // exist, not how the storage layer works.

  server.tool(
    'upload_file',
    'Upload a local file you have on disk so it can be attached to a `send_message` ' +
      'call. Use when you have generated a binary artifact (image, PDF, archive, etc.) ' +
      'and want chat participants to see it. The returned `id` is single-use input for ' +
      '`send_message.attachment_ids`; the file is bound to the current channel and ' +
      'cannot be referenced from other channels.',
    {
      path: z
        .string()
        .min(1)
        .describe(
          'Absolute path to the file on disk. Relative paths are rejected so the agent ' +
            'is forced to be explicit about which file it is uploading.',
        ),
      filename: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Optional display filename. Defaults to the basename of `path`. The backend ' +
            'sanitizes path separators and control characters.',
        ),
      content_type: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Optional MIME type hint. The backend will sniff magic bytes and fall back to ' +
            'the file extension when omitted.',
        ),
    },
    async ({ path, filename, content_type }) => {
      log('info', { path, hasFilename: !!filename, hasType: !!content_type }, 'tool: upload_file invoked');
      if (!isAbsolute(path)) {
        throw new Error('upload_file: `path` must be absolute');
      }
      let buffer: Buffer;
      try {
        buffer = await readFile(path);
      } catch (err) {
        log('error', { path, err }, 'tool: upload_file read failed');
        throw new Error(
          `upload_file: could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      try {
        const dto = await client.uploadAttachment({
          filename: filename ?? basename(path),
          contentType: content_type ?? null,
          buffer,
        });
        log('info', { id: dto.id, size: dto.size }, 'tool: upload_file ok');
        return { content: [{ type: 'text', text: JSON.stringify(dto) }] };
      } catch (err) {
        log('error', { err }, 'tool: upload_file failed');
        throw err;
      }
    },
  );

  server.tool(
    'view_file',
    'Resolve an attachment id to a local path (or download URL for remote storages) so ' +
      'you can read its contents with your normal file tools. Useful when another ' +
      'participant attached a file via `send_message` and you need to inspect it. ' +
      'Cross-channel ids are rejected.',
    {
      attachment_id: z
        .string()
        .min(1)
        .describe('Attachment id from a message snapshot or `upload_file` result.'),
    },
    async ({ attachment_id }) => {
      log('info', { attachment_id }, 'tool: view_file invoked');
      try {
        const located = await client.locateAttachment(attachment_id);
        log(
          'info',
          { storage: located.storage, filename: located.filename },
          'tool: view_file ok',
        );
        return { content: [{ type: 'text', text: JSON.stringify(located) }] };
      } catch (err) {
        log('error', { err }, 'tool: view_file failed');
        throw err;
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('info', {}, 'chat-bridge: connected to MCP transport');
}
