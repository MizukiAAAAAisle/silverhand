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

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('info', {}, 'chat-bridge: connected to MCP transport');
}
