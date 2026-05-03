import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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
 *                   child sessions
 *   - spawn_child_session: open an isolated sub-discussion
 *   - close_session: end the current (sub-)session, optionally posting
 *                    summary back to parent
 *
 * Memory / consensus reads/writes use the agent's own Read/Write tools
 * (cwd is the channel workspace) — no MCP tool wrapper needed.
 */
export async function startBridge(args: BridgeArgs): Promise<void> {
  const client = new BackendClient(args);

  const server = new McpServer(
    { name: 'silverhand-chat-bridge', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );

  server.tool(
    'send_message',
    'Send a chat message in the current session, or to the parent / a specific child session.',
    {
      content: z.string().min(1).describe('Message body.'),
      target: z
        .union([
          z.literal('self').describe('Current session (default).'),
          z.literal('parent').describe('Parent session of the current sub-session.'),
          z
            .object({ child_session_id: z.string().min(1) })
            .describe('A sub-session you spawned off the current session.'),
        ])
        .optional()
        .describe(
          'Where to send. Defaults to "self" (current session). ' +
            'Use "parent" only from a child session. ' +
            'Use {child_session_id} to message a sub-session you spawned.',
        ),
    },
    async ({ content, target }) => {
      log(
        'info',
        { contentBytes: content.length, target: target ?? 'self' },
        'tool: send_message invoked',
      );
      try {
        const r = await client.sendMessage({ content, target });
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
    'spawn_child_session',
    'Open an isolated sub-discussion off the current session. Use when a side-topic ' +
      'would clutter the main thread. Members must already be in the current channel.',
    {
      title: z.string().min(1).describe('Short title for the sub-session.'),
      members: z
        .array(z.string().min(1))
        .min(1)
        .describe('Agent ids to pull in. Must be a subset of current channel members.'),
      context_summary: z
        .string()
        .min(1)
        .describe(
          'Concise summary of what the sub-session needs to know from this session. ' +
            'Be specific and minimal — this is your forcing function for deciding ' +
            'whether the spawn is actually warranted.',
        ),
      initial_prompt: z
        .string()
        .min(1)
        .describe('First message you (the spawning agent) post into the sub-session.'),
    },
    async input => {
      log('info', { title: input.title, memberCount: input.members.length }, 'tool: spawn_child_session invoked');
      try {
        const r = await client.spawnChildSession(input);
        log('info', { childSessionId: r.child_session_id }, 'tool: spawn_child_session ok');
        return { content: [{ type: 'text', text: JSON.stringify(r) }] };
      } catch (err) {
        log('error', { err }, 'tool: spawn_child_session failed');
        throw err;
      }
    },
  );

  server.tool(
    'close_session',
    'Mark the current session as closed and (optionally) post a summary to the parent. ' +
      'Use only on a sub-session you are wrapping up.',
    {
      summary: z
        .string()
        .min(1)
        .describe('Final summary of the sub-session outcome.'),
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
      log('info', { summaryBytes: input.summary.length, postedToParent: !!input.posted_to_parent }, 'tool: close_session invoked');
      try {
        await client.closeSession(input);
        log('info', {}, 'tool: close_session ok');
        return { content: [{ type: 'text', text: 'ok' }] };
      } catch (err) {
        log('error', { err }, 'tool: close_session failed');
        throw err;
      }
    },
  );

  // ── Tasks ────────────────────────────────────────────────────────
  // See docs/tasks-design.md §5. Tasks are message metadata; numbering
  // space is per-channel, operation scope is per-session. These tools
  // aggregate at channel level (you'll see other sessions' tasks in
  // list_tasks output) but only accept mutations on tasks that belong
  // to YOUR session — cross-session claim/unclaim/update fails with
  // `owner_session` in the failure reason.

  server.tool(
    'list_tasks',
    'View the task board for the current channel. Aggregates tasks from EVERY session ' +
      'in this channel — each entry carries a `session` field pointing to the session it ' +
      'belongs to. You can only claim/update tasks in YOUR own session (see reason field ' +
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
    'Create one or more task-messages in the current session. Use for genuinely new work; ' +
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
      'different session, the result entry has success=false with a reason. ALWAYS move ' +
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
          'Message ids to promote-and-claim. Message must be in your session and not be ' +
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('info', {}, 'chat-bridge: connected to MCP transport');
}
