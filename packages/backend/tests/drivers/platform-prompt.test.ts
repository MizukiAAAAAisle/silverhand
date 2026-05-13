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

  it('teaches that Threads are independent agent sessions and own their follow-up work', () => {
    // Two facts the agent must internalize without us teaching them
    // about runtime delivery:
    //   1. A Thread is a *separate* (conversation, agent) process —
    //      not a chat-organization layer. The parent channel's process
    //      does NOT see Thread content. This justifies "if the work
    //      depends on Thread context, do it inside the Thread".
    //   2. Work-log ownership: when follow-up depends on a Thread's
    //      accumulated state, the Thread session creates/claims and
    //      drives the task; parent stays a pointer. Don't @-mention
    //      executors in parent while delegating "to the Thread" —
    //      that splits the log between two sessions.
    //
    // We deliberately do NOT mention auto-wake / `--no-wake` / runtime
    // delivery semantics. That's a backend transport guarantee
    // (cross-target sends wake idle target members); the agent should
    // default-assume "the message reaches the target" and not have to
    // know about it. Per @shiki review of msg `Va7npVrVTFMQpGFQ`.
    const text = prompt();
    expect(text).toContain('separate agent sessions');
    expect(text).toContain('with their own context');
    expect(text).toContain(
      "(conversation, agent) process accumulates the Thread's",
    );
    expect(text).toContain('parent channel');
    expect(text).toContain('does not see any of that');

    // Work-log ownership clauses.
    expect(text).toContain(
      "follow-up work depends on a Thread's accumulated discussion",
    );
    expect(text).toContain('the Thread session should own that work');
    expect(text).toMatch(/create or\s+claim\s+the task in the Thread/);
    expect(text).toMatch(/post progress\s+in the Thread/);
    expect(text).toMatch(
      /let the\s+parent channel carry only a short pointer or final\s+summary/,
    );
    expect(text).toMatch(/Do not\s+@-mention an executor in the parent/);
    expect(text).toMatch(
      /mention or task them inside\s+the Thread instead/,
    );

    // Drift guard: never reintroduce wake/runtime-delivery vocabulary.
    // Agents must not be taught to think about runtime delivery state.
    expect(text).not.toContain('auto-wake');
    expect(text).not.toContain('auto-start');
    expect(text).not.toMatch(/woken automatically/i);
    expect(text).not.toContain('--no-wake');
    expect(text).not.toContain('--wake');
    expect(text).not.toContain('idle members are woken');
    expect(text).not.toContain('idle recipients');
  });

  it('teaches the #conv:<id> sigil for inline conversation references', () => {
    const text = prompt();
    // PR-4 commit 4 unified the sigil docs under a single Formatting
    // heading per @shiki direction (msg `gTMLaOKaVGwhatkj`). Section
    // anchor pins that heading shape so future rewrites can't silently
    // reintroduce a per-sigil heading.
    expect(text).toMatch(/^## Formatting\s*$/m);
    // Each grammar must keep its sub-heading anchor; tests below
    // assert the per-grammar bullets and the closing summary.
    expect(text).toMatch(/^### Reference grammars\s*$/m);
    expect(text).toMatch(/^### Summary — when to use which\s*$/m);
    expect(text).toContain('`#conv:<conversation_id>`');
    expect(text).toMatch(/#conv:qdQwBXDqcq_GE63-/);

    // The prompt is a pure output-format contract, not a UI behavior
    // explanation. Per @shiki + @Cindy reviews on `8f2f046` / `d4fbf1c`,
    // the agent doesn't need to know how the recipient's UI renders
    // the sigil — it only needs to know which token to write where.
    // Forbid every interaction-leaning verb that snuck in earlier
    // drafts. NOTE: use `\s+` not a literal space so line-wrapped
    // matches like "side\npane" still trip the guard.
    expect(text).not.toMatch(/\bside\s+pane\b/i);
    expect(text).not.toMatch(/\bprimary\s+pane\b/i);
    expect(text).not.toContain('clickable pill');
    expect(text).not.toContain('placeholder with a');
    expect(text).not.toContain('Recipients without access');
    expect(text).not.toMatch(/can click it open/);
    expect(text).not.toMatch(/click it to open/);
    expect(text).not.toMatch(/without losing their\s+current view/);
    expect(text).not.toMatch(/without taking them away\s+from their primary pane/);
    // PR-4 commit 1 review (Cindy, msg `bVRspMv1pSWXCFOc`): the WIP
    // heading rewrite snuck in a "Silverhand auto renders these tokens
    // as clickable elements" line. The whole point of the sigil section
    // is a pure chat-output contract — no renderer/click behavior leaks
    // back. Forbid the exact phrasing plus the broader vocabulary so a
    // future rewording can't re-introduce it.
    expect(text).not.toMatch(/auto renders/i);
    expect(text).not.toMatch(/clickable elements/i);
    expect(text).not.toMatch(/\bclickable\b/i);

    // Lists every CLI field that returns a conversation-shaped id, so
    // the agent doesn't have to guess (channel_id was missing in
    // earlier drafts even though `silverhand channel create` returns it).
    expect(text).toContain('`conversation_id`');
    expect(text).toContain('`channel_id`');
    expect(text).toContain('`thread_id`');
    expect(text).toContain('`hit.message_ref.conversation_id`');

    // Hard scope boundary: chat text only. Without this an agent will
    // happily write `--target conversation:#conv:<id>` and 404. The
    // unified Formatting section enforces this for ALL grammars via
    // a "do not wrap any of them in CLI arguments" clause; we still
    // assert that `#conv:` is one of the grammars covered by that
    // boundary so a future rewrite can't silently drop coverage.
    expect(text).toMatch(/Do not.*wrap.*in CLI arguments/i);
    expect(text).toContain('`#conv:<conversation_id>`');
    // And the explicit "what NOT to wrap" list — message ids are the
    // most likely confusion since they appear right next to
    // conversation ids in CLI output. The phrase shows up inside a
    // bold-marked clause (`**Do not**\s+wrap…`) so we tolerate
    // markdown emphasis between the words.
    expect(text).toMatch(/do not\W+wrap message ids/i);

    // Application points across the rest of the prompt.
    expect(text).toContain('announcing the new channel as');
    expect(text).toContain('`#conv:<channel_id>`');
    expect(text).toContain(
      'When you cite a search hit or history pointer back in chat',
    );
    expect(text).toContain('`#conv:<hit.message_ref.conversation_id>`');
    expect(text).toMatch(/Message ids stay raw/);

    // Earlier wordings that must never come back (drift guard).
    expect(text).not.toContain('announcing the new channel title\nand ID');
    // The sigil section earlier listed an exact char count — agents
    // don't generate ids, they copy them; binding length here just
    // adds maintenance.
    expect(text).not.toMatch(/16-character id/);

    // Hard cutover: the legacy `#~<id>` form must not appear anywhere
    // in the rendered prompt. We dropped backward-compat alias support
    // in PR-4 commit 1 per @shiki direction.
    expect(text).not.toContain('#~');
  });

  it('teaches the #task:<n> sigil and groups all grammars under Formatting', () => {
    const text = prompt();
    // Same-section neighbor of `#conv:<id>`. PR-4 commit 4: unified
    // Formatting section enumerates all four reference grammars
    // (`@<handle>`, `#<channel_name>`, `#conv:<id>`, `#task:<n>`)
    // with per-form scenarios and a closing summary.
    expect(text).toMatch(/^## Formatting\s*$/m);
    expect(text).toContain('`#task:<n>`');
    // Concrete example uses a real task number alongside #conv: so
    // both grammars reinforce each other in one mental model.
    expect(text).toMatch(/#task:5/);
    // Each of the four grammars gets its own bullet under Reference
    // grammars; assert they're all present.
    expect(text).toContain('`@<handle>`');
    expect(text).toContain('`#<channel_name>`');
    expect(text).toContain('`#conv:<conversation_id>`');
    expect(text).toContain('`#task:<n>`');
    // Workspace-scoped invariant — prevents agents from assuming task
    // numbers are global like message ids.
    expect(text).toMatch(/workspace-scoped/i);
    // Leading-zero rejection mirrors the tokenizer/URL parser
    // contract; surfacing it here keeps the prompt and the renderer
    // aligned.
    expect(text).toMatch(/leading zero|#task:05 is invalid/i);

    // Pure output-contract drift guards — same vocabulary blocks the
    // sigil section now applies to the whole Formatting section.
    // No UI behavior, no rendered shape, no click affordance.
    expect(text).not.toMatch(/\bclickable\b/i);
    expect(text).not.toMatch(/\bdrawer\b/i);
    expect(text).not.toMatch(/\bpopover\b/i);
    expect(text).not.toMatch(/\bhover\b/i);
    expect(text).not.toMatch(/\bskeleton\b/i);
    expect(text).not.toMatch(/scroll(s|ed)?\s+(into\s+view|to)/i);
    expect(text).not.toMatch(/auto renders/i);
    expect(text).not.toMatch(/clickable elements/i);

    // Boundary clauses: pure-text-only and don't-mix. The summary
    // contrasts the chat sigil against the canonical CLI flag form
    // so the agent doesn't write `--task-number #task:5`. The flag
    // example wraps onto a new line in the rendered prompt
    // (`--task-number\n  5`), so we allow whitespace between flag
    // and value.
    expect(text).toMatch(/Do not.*wrap.*in CLI arguments/i);
    expect(text).toContain('#task:5');
    expect(text).toMatch(/--task-number\s+5\b/);

    // Cross-grammar summary picks the right form for the right job.
    expect(text).toMatch(/Pick the most precise form available/i);

    // Channel-name semantics: scope = current workspace, ambiguous
    // names render inert (frontend keys lookup by channel `title` and
    // surfaces a sentinel for duplicate titles). The prompt should
    // describe the contract without leaning on UI-shape vocabulary;
    // "inert text" is the output contract the renderer enforces.
    expect(text).toMatch(/ambiguous/i);
    expect(text).toMatch(/inert text/i);
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
