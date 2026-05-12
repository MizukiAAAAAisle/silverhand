import { describe, expect, it } from 'vitest';
import { COMMAND_GROUPS } from '@silverhand/cli';
import { buildPlatformPrompt } from '../../src/drivers/platform-prompt.js';

function prompt(): string {
  return buildPlatformPrompt({
    agentId: 'agent-1',
    agentName: 'Cindy',
    runtime: 'claude',
    activeProfileDir: './.silverhand/agents/agent-1',
    roleSystemPrompt: '_role_',
    sessionContext: {
      conversationId: 'conv-channel-1',
      channelName: 'silverhand',
      channelKind: 'regular',
      sessionTitle: 'member activity',
      otherMembers: [],
      isChildSession: false,
    },
  });
}

describe('buildPlatformPrompt', () => {
  it('requires visible replies through the silverhand CLI', () => {
    const text = prompt();
    expect(text).toContain('Never');
    expect(text).toContain('put chat replies in your normal output');
    expect(text).toContain('When you receive a message, reply via');
    expect(text).toContain('silverhand message send');
  });

  it('keeps system announcements informational unless explicitly requested', () => {
    const text = prompt();
    expect(text).toContain('from_kind=system');
    expect(text).toContain("Don't reply unless the message explicitly");
  });

  it('renders conversation ids in the context block', () => {
    const regular = prompt();
    expect(regular).toContain('Conversation id: `conv-channel-1`');
    expect(regular).not.toContain('Parent channel conversation id');

    const thread = buildPlatformPrompt({
      agentId: 'agent-1',
      agentName: 'Cindy',
      runtime: 'claude',
      activeProfileDir: './.silverhand/agents/agent-1',
      roleSystemPrompt: '_role_',
      sessionContext: {
        conversationId: 'thread-1',
        channelName: 'silverhand',
        channelKind: 'regular',
        sessionTitle: 'Thread: topic',
        otherMembers: [],
        isChildSession: true,
        parentSessionTitle: 'member activity',
        parentChannelConversationId: 'channel-1',
        isAgentSpawnedChild: false,
      },
    });

    expect(thread).toContain('Conversation id: `thread-1`');
    expect(thread).toContain('Parent channel conversation id: `channel-1`');
  });

  it('avoids generic platform wording in the rendered agent manual', () => {
    const text = prompt();
    expect(text).toContain('via Silverhand');
    expect(text).toContain('Silverhand system messages');
    expect(text).not.toContain('via the Silverhand chat platform');
    expect(text).not.toContain('platform announcements');
    expect(text).not.toContain('The platform shows what you did');
  });

  it('hardens multi-agent etiquette against ping loops', () => {
    const text = prompt();
    expect(text).toContain('## Conversation etiquette');
    expect(text).toContain('Never reply to your own agent message');
    expect(text).toContain(
      "Do not acknowledge, summarize, echo or restate another agent's work",
    );
    expect(text).toContain('Only send messages when you have actionable content');
    expect(text).not.toContain('unique value to add');
  });

  it('keeps MEMORY.md as a compact index and sends detailed history to notes', () => {
    const text = prompt();
    expect(text).toContain('canonical role contract');
    expect(text).toContain('Do not copy the role contract into MEMORY.md');
    expect(text).toContain('It may include a short');
    expect(text).toContain('Role source: system_prompt.md');
    expect(text).toContain('target under 10KB');
    expect(text).toContain('It is an index, not the detailed work log');
    expect(text).toContain('run a memory checkpoint');
    expect(text).toContain('update the relevant notes file');
    expect(text).toContain('Otherwise leave MEMORY.md unchanged');
    expect(text).toContain('./.silverhand/agents/agent-1/notes/work-log.md');
    expect(text).toContain('Do not append long per-task bullets to MEMORY.md');
    expect(text).not.toContain(
      "Keep MEMORY.md complete enough that compression preserves",
    );
    expect(text).not.toContain('After completing significant work, update notes');
  });

  it('renders the active profile path instead of hard-coding L2 paths', () => {
    const regular = prompt();
    expect(regular).toContain(
      'Your active profile in this context: `./.silverhand/agents/agent-1`',
    );
    expect(regular).toContain('These file paths are internal working context');
    expect(regular).toContain('Read `./.silverhand/agents/agent-1/MEMORY.md` first');

    const dm = buildPlatformPrompt({
      agentId: 'agent-1',
      agentName: 'Cindy',
      runtime: 'claude',
      activeProfileDir: '.',
      roleSystemPrompt: '_role_',
      sessionContext: {
        conversationId: 'dm-conv-1',
        channelName: 'Onboarding',
        channelKind: 'dm',
        sessionTitle: 'Onboarding',
        otherMembers: [],
        isChildSession: false,
      },
    });

    expect(dm).toContain('Your active profile in this context: `.`');
    expect(dm).toContain('Read `./MEMORY.md` first');
    expect(dm).toContain('`./system_prompt.md`');
    expect(dm).not.toContain('./.silverhand/agents/agent-1/MEMORY.md');

    const messy = buildPlatformPrompt({
      agentId: 'agent-1',
      agentName: 'Cindy',
      runtime: 'claude',
      activeProfileDir: './.silverhand//agents///agent-1/',
      roleSystemPrompt: '_role_',
      sessionContext: {
        conversationId: 'conv-channel-1',
        channelName: 'silverhand',
        channelKind: 'regular',
        sessionTitle: 'member activity',
        otherMembers: [],
        isChildSession: false,
      },
    });

    expect(messy).toContain(
      'Read `./.silverhand/agents/agent-1/MEMORY.md` first',
    );
  });

  it('requires task state updates before reporting completion', () => {
    const text = prompt();
    expect(text).toContain('claim the task first');
    expect(text).toContain('silverhand task claim --message-id <message_id>');
    expect(text).toContain('claim it before doing that work');
    expect(text).toContain('Close the loop on tasks you own');
    expect(text).toContain('call `silverhand task status` first');
    expect(text).toContain('leaving the task state unchanged');
  });

  it('includes schedule tool usage guidance and wake handling', () => {
    const text = prompt();
    expect(text).toContain('## Schedules');
    expect(text).toContain('`silverhand schedule create`');
    expect(text).toContain('`silverhand schedule list`');
    expect(text).toContain('`silverhand schedule cancel`');
    expect(text).toContain('future time');
    expect(text).toContain('strict 5-field UNIX syntax');
    expect(text).toContain("metadata.subtype = 'schedule_fire'");
    expect(text).toMatch(/report via\s+`silverhand message send`/);
  });

  it('renders the silverhand CLI command manual', () => {
    const text = buildPlatformPrompt({
      agentId: 'agent-1',
      agentName: 'Cindy',
      runtime: 'codex',
      activeProfileDir: './.silverhand/agents/agent-1',
      roleSystemPrompt: '_role_',
      sessionContext: {
        conversationId: 'conv-channel-1',
        channelName: 'silverhand',
        channelKind: 'regular',
        sessionTitle: 'member activity',
        otherMembers: [],
        isChildSession: false,
      },
    });

    expect(text).toContain('## Communication by silverhand CLI');
    expect(text).toContain(
      'You should use the silverhand CLI for all chat / task / workspace',
    );
    expect(text).toMatch(/Subcommands default\s+to `--json`/);
    expect(text).toContain('stderr is the primary failure context for you');
    expect(text).toContain('with a non-zero code');
    expect(text).toContain('stable `code` and `retriable` flag');
    expect(text).toContain('exit code 1 as a user/input');
    expect(text).toContain('2 as a temporary error');
    expect(text).toContain('3 as a failure');
    expect(text).toContain('silverhand <noun> <verb> --help');
    expect(text).toContain('**`silverhand message send`**: Send a message');
    expect(text).toContain(
      '**`silverhand task list`**: View the workspace task board',
    );
    expect(text).toContain(
      '**`silverhand schedule create`**: Schedule a self-wake',
    );
    expect(text).toContain('**`silverhand file upload`**: Upload a local file');
    expect(text).toContain('via `silverhand message send` before');
    expect(text).toContain('call `silverhand task status` first');
    expect(text).not.toContain('mcp_chat_send_message');
    expect(text).not.toContain('mcp__chat__');
    expect(text).not.toContain('All cross-agent interaction is through MCP tools');
    // Check the four real env-var names by name. A bare `SILVERHAND_`
    // prefix would falsely flag the recommended heredoc delimiter
    // `SILVERHAND_EOF` in the message-send section.
    expect(text).not.toMatch(
      /SILVERHAND_(?:AUTH_TOKEN|CONVERSATION_ID|AGENT_ID|SERVER_URL)\b/,
    );
    expect(text).not.toContain('auth failure');
  });

  it('uses Thread/channel terminology and gates agent-created top-level channels', () => {
    const text = prompt();
    expect(text).toContain('Threads (when to open one)');
    expect(text).toContain('`silverhand thread create`');
    expect(text).toContain('`silverhand channel create`');
    expect(text).toContain('**Only** call `silverhand channel create`');
    expect(text).toContain('explicitly');
    expect(text).toContain('current workspace');
    expect(text).not.toContain('`mcp__chat__spawn_child_session`');
    expect(text).not.toContain('`mcp__chat__create_session`');
  });

  it('teaches the #~<id> sigil for inline conversation references', () => {
    const text = prompt();
    // Section anchor + syntax statement.
    expect(text).toContain('## Referencing conversations in chat');
    expect(text).toContain('`#~<conversation_id>`');
    expect(text).toMatch(/#~qdQwBXDqcq_GE63-/);
    // Behavioral promise: side pane, not main-view replacement.
    expect(text).toMatch(/side pane/);
    expect(text).toContain('without losing their current view');
    // Channel-create handoff explicitly uses the sigil.
    expect(text).toContain('announcing the new channel as');
    expect(text).toContain('`#~<channel_id>`');
    // History/search wrap-up also nudges sigil use.
    expect(text).toContain(
      'When you cite a search hit or history pointer back in chat',
    );
    // Pre-PR-4 wording — must be gone so we don't tell agents to paste raw ids.
    expect(text).not.toContain('announcing the new channel title\nand ID');
  });

  it('requires visible in-thread summary before closing user-opened threads', () => {
    const text = buildPlatformPrompt({
      agentId: 'agent-1',
      agentName: 'Cindy',
      runtime: 'claude',
      activeProfileDir: './.silverhand/agents/agent-1',
      roleSystemPrompt: '_role_',
      sessionContext: {
        conversationId: 'thread-1',
        channelName: 'silverhand',
        channelKind: 'regular',
        sessionTitle: 'Thread: topic',
        otherMembers: [],
        isChildSession: true,
        parentSessionTitle: 'member activity',
        parentChannelConversationId: 'channel-1',
        isAgentSpawnedChild: false,
      },
    });

    expect(text).toContain('user-opened Thread');
    expect(text).toContain('visible summary');
    expect(text).toContain('ask the user whether to close');
    expect(text).toContain('Only call');
    expect(text).not.toContain('do not close this thread unless');
    expect(text).not.toContain('User-opened Threads should remain open');
    expect(text).not.toContain('then call `close_session`');
    expect(text).toContain('silverhand thread close');
    expect(text).toContain('pass `--posted-to-parent`');
    expect(text).not.toContain('target=parent');
    expect(text).not.toContain('posted_to_parent: true');
  });

  it('keeps close_thread guidance for agent-spawned Threads', () => {
    const text = buildPlatformPrompt({
      agentId: 'agent-1',
      agentName: 'Cindy',
      runtime: 'claude',
      activeProfileDir: './.silverhand/agents/agent-1',
      roleSystemPrompt: '_role_',
      sessionContext: {
        conversationId: 'thread-1',
        channelName: 'silverhand',
        channelKind: 'regular',
        sessionTitle: 'debug branch',
        otherMembers: [],
        isChildSession: true,
        parentSessionTitle: 'member activity',
        parentChannelConversationId: 'channel-1',
        isAgentSpawnedChild: true,
      },
    });

    expect(text).toContain('report the final result via `silverhand thread close`');
  });

  // ── Drift guard ───────────────────────────────────────────────────────
  //
  // The platform prompt teaches agents to invoke the `silverhand` CLI by
  // exact flag name. If a flag in the prompt does not exist in any real
  // CLI command's `--help`, agents will hit a validation_error or
  // mis-route on first call. Rather than enumerate flags by hand, derive
  // the truth from `packages/cli`'s `COMMAND_GROUPS` and assert prompt
  // flags ⊆ CLI flags.
  //
  // Non-flag mentions (decision rules, anti-patterns, semantic guidance)
  // are still verified by the per-section `it()` blocks above. The
  // guard here only blocks pure flag-name drift, which is the failure
  // mode that surfaced in the May 2026 review.

  /** Extract every `--xxx` token from a string. Word-bounded so we
   *  don't pick up `--<placeholder>` markdown nor stray double dashes. */
  function extractFlags(s: string): Set<string> {
    const out = new Set<string>();
    const re = /--[a-z][a-z0-9-]+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) out.add(m[0]);
    return out;
  }

  /** Build the union of every flag mentioned in any CLI command's
   *  `help` text. The CLI source is the single source of truth.
   *  Adds the global flags handled by the dispatcher (not per-command). */
  function cliFlagUniverse(): Set<string> {
    const out = new Set<string>([
      // Global flags — handled in cli.ts before dispatch, so they don't
      // appear in any per-command `help` block.
      '--help',
      '--json',
    ]);
    for (const group of COMMAND_GROUPS) {
      for (const command of group.commands) {
        for (const flag of extractFlags(command.help)) {
          out.add(flag);
        }
      }
    }
    return out;
  }

  it('only references CLI flags that exist in some command help', () => {
    const text = prompt();
    const promptFlags = extractFlags(text);
    const cliFlags = cliFlagUniverse();
    const missing = [...promptFlags].filter(f => !cliFlags.has(f)).sort();
    expect(missing, `prompt mentions flags not in any CLI help: ${missing.join(', ')}`)
      .toEqual([]);
  });

  it('does not reuse JSON-body parameter names where a CLI flag exists', () => {
    // Pre-CLI-migration the prompt referred to backend JSON shapes
    // (`task_numbers`, `attachment_ids`, `before_seq`, …). Agents will
    // copy whatever the prompt says and pass it as a CLI flag, hitting
    // validation_error. These names have CLI flag equivalents now and
    // must never reappear in the prompt.
    const text = prompt();
    const forbidden = [
      'task_numbers',
      'message_ids',
      'attachment_ids',
      'before_seq',
      'after_seq',
      'around_message_id',
      'include_content',
      'include_system',
      'every_seconds',
      'fire_at',
      'delay_seconds',
      'start_at',
      'max_occurrences',
      'until_at',
      'allow_unbounded',
      'context_summary',
      'initial_prompt',
      'posted_to_parent',
      'schedule_id',
    ];
    for (const name of forbidden) {
      expect(text, `prompt should reference CLI flag, not JSON field "${name}"`)
        .not.toContain(name);
    }
  });
});
