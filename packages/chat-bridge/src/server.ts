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
