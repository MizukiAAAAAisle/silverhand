import { describe, expect, it } from 'vitest';
import { buildPlatformPrompt } from '../../src/drivers/platform-prompt.js';

function prompt(): string {
  return buildPlatformPrompt({
    agentId: 'agent-1',
    agentName: 'Cindy',
    runtime: 'claude',
    activeProfileDir: './.silverhand/agents/agent-1',
    roleSystemPrompt: '_role_',
    sessionContext: {
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
      "Do not acknowledge, summarize, or restate another agent's work",
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
    expect(text).toContain('exactly one of `fire_at` or `delay_seconds`');
    expect(text).toContain('strict 5-field UNIX syntax');
    expect(text).toContain('IANA timezone');
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
    expect(text).toContain('3 as an auth failure');
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

  it('requires visible in-thread summary before closing user-opened threads', () => {
    const text = buildPlatformPrompt({
      agentId: 'agent-1',
      agentName: 'Cindy',
      runtime: 'claude',
      activeProfileDir: './.silverhand/agents/agent-1',
      roleSystemPrompt: '_role_',
      sessionContext: {
        channelName: 'silverhand',
        channelKind: 'regular',
        sessionTitle: 'Thread: topic',
        otherMembers: [],
        isChildSession: true,
        parentSessionTitle: 'member activity',
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
        channelName: 'silverhand',
        channelKind: 'regular',
        sessionTitle: 'debug branch',
        otherMembers: [],
        isChildSession: true,
        parentSessionTitle: 'member activity',
        isAgentSpawnedChild: true,
      },
    });

    expect(text).toContain('report the final result via `silverhand thread close`');
  });
});
