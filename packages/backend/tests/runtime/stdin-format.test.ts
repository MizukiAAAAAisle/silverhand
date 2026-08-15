import { describe, expect, it } from 'vitest';
import {
  composeRuntimeDeliveryPresentation,
  fixedConversationTitle,
  fixedWorkspaceName,
  parseDeliveryTarget,
  parseDeliveryTargetInput,
  type AddressFallbackReason,
  type StreamNaming,
} from '@silverhand/shared';
import {
  formatInboxBatch,
  formatInboxBatchPresentation,
  formatStdinMessageHeader,
  type DeliveryStreamAddressing,
  type MessageLite,
} from '../../src/runtime/stdin-format.js';
import { createReferenceMemo } from '../../src/runtime/reference-memo.js';

const TOOL = 'silverhand message send';

// Real id shapes (#task:2021 P4-3): the header's `target` is rendered by the
// shared codec, whose domain is exactly `randomBytes(12).toString('base64url')`
// — 16 base64url characters — so a fixture id like `c1` is not a small
// inaccuracy here, it is an unspellable coordinate and fails loud. Two
// conversations on purpose: the target is a fact about the ROW, and that is only
// observable when one batch carries messages from more than one stream.
const CONV = 'Q1VI9x6vUK1a9oN9';
const CONV_OTHER = 'aBcDeFgHiJkLmNoP';
const ROOT = 'NbBXIEpDUnSWW48x';

// #task:2000 — the formatter no longer parses; it asks the phase's one
// derivation for the addressing set. A fresh memo per call keeps these cases
// independent of each other.
const REFERENCES = () => createReferenceMemo().referencesOf;

/**
 * A naming source under the test's control, plus the fallbacks it was told about
 * (#task:2021 P4-4).
 *
 * The default is `id_only`, the arm that renders `#conv:<id>` and counts NOTHING:
 * every case in this file that is about the header's OTHER fields must not have to
 * care how the stream is named, and `id_only` is the one arm whose token is a
 * function of the row alone.
 *
 * `fallbacks` is an array rather than a count because WHICH reason was recorded is
 * the whole point of the record — a renderer that reported every degradation as one
 * reason would make the dogfood question unanswerable.
 */
function addressing(
  naming: StreamNaming = { kind: 'id_only' },
): DeliveryStreamAddressing & { fallbacks: AddressFallbackReason[] } {
  const fallbacks: AddressFallbackReason[] = [];
  return {
    namingOf: () => naming,
    recordFallback: reason => {
      fallbacks.push(reason);
    },
    fallbacks,
  };
}

describe('runtime delivery presentation single authority', () => {
  const cases: Array<{ name: string; messages: MessageLite[] }> = [
    { name: 'system only', messages: [systemMessage()] },
    {
      name: 'undirected user',
      messages: [
        {
          id: 'm-user-all',
          conversation_id: CONV,
          thread_root_id: null,
          from_kind: 'user',
          from_agent_id: null,
          from_user_id: 'u1',
          content: 'hello everyone',
          created_at: 1,
        },
      ],
    },
    {
      name: 'user addressed elsewhere',
      messages: [
        {
          id: 'm-user-other',
          conversation_id: CONV,
          thread_root_id: null,
          from_kind: 'user',
          from_agent_id: null,
          from_user_id: 'u1',
          content: '@Alice please handle',
          created_at: 2,
        },
      ],
    },
    {
      name: 'agent mention',
      messages: [
        {
          id: 'm-agent-mention',
          conversation_id: CONV,
          thread_root_id: null,
          from_kind: 'agent',
          from_agent_id: 'a1',
          from_user_id: null,
          content: '@Cindy review this',
          created_at: 3,
        },
      ],
    },
    {
      name: 'mixed precedence',
      messages: [
        systemMessage({ id: 'm-system-mixed' }),
        {
          id: 'm-user-recipient',
          conversation_id: CONV,
          thread_root_id: null,
          from_kind: 'user',
          from_agent_id: null,
          from_user_id: 'u1',
          content: '@Cindy continue',
          created_at: 4,
        },
      ],
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name}: shared composer is byte-identical to formatInboxBatch`, () => {
      const items = testCase.messages.map(message => ({
        message: { ...message, metadata: message.metadata ?? null },
      }));
      const args = [
        items,
        agentName,
        agentComputer,
        userName,
        undefined,
        'Cindy',
        TOOL,
        REFERENCES(),
        addressing(),
      ] as const;
      const historical = formatInboxBatch(...args);
      const structured = formatInboxBatchPresentation(...args);
      expect(structured.text).toBe(historical);
      expect(
        composeRuntimeDeliveryPresentation(structured.presentations, TOOL),
      ).toBe(historical);
    });
  }
});

describe('formatStdinMessageHeader reply-cluster metadata', () => {
  it('names the main line by the conversation address alone', () => {
    const header = formatStdinMessageHeader(
      {
        id: 'm-main',
        conversation_id: CONV,
        thread_root_id: null,
        from_kind: 'user',
        from_agent_id: null,
        from_user_id: 'u1',
        content: 'main',
        created_at: 0,
      },
      agentName,
      agentComputer,
      userName,
      undefined,
      addressing(),
    );

    expect(header).toMatch(
      new RegExp(
        `^\\[msg_id=m-main sender=@shiki type=human target=#conv:${CONV} time=`,
      ),
    );
    expect(header).not.toContain('thread:');
  });

  it('includes thread root metadata for reply-cluster messages', () => {
    const header = formatStdinMessageHeader(
      {
        id: 'm-reply',
        conversation_id: CONV,
        thread_root_id: ROOT,
        from_kind: 'agent',
        from_agent_id: 'a1',
        from_user_id: null,
        content: 'reply',
        created_at: 0,
      },
      agentName,
      agentComputer,
      userName,
      undefined,
      addressing(),
    );

    expect(header).toMatch(
      new RegExp(
        `^\\[msg_id=m-reply sender=@Alice type=agent computer=host-alice `
        + `target=#conv:${CONV}/thread:${ROOT} time=`,
      ),
    );
  });

  it('appends task=#<n> status=<status> for a task system-event message', () => {
    const header = formatStdinMessageHeader(
      {
        id: 'm-task',
        conversation_id: CONV,
        thread_root_id: null,
        from_kind: 'user',
        from_agent_id: null,
        from_user_id: 'u1',
        content: 'Fix the flaky test',
        created_at: 0,
        // The suffix now derives from the task system-event's own metadata
        // (v60: a task is a first-class aggregate, not a message column).
        metadata: JSON.stringify({
          subtype: 'task_create',
          task_number: 123,
          task_status: 'todo',
        }),
      },
      agentName,
      agentComputer,
      userName,
      undefined,
      addressing(),
    );

    expect(header).toMatch(
      new RegExp(
        `^\\[msg_id=m-task sender=@shiki type=human target=#conv:${CONV} `
        + `time=\\S+ task=#123 status=todo\\]$`,
      ),
    );
  });

  it('omits the task suffix for a non-task message', () => {
    const header = formatStdinMessageHeader(
      {
        id: 'm-plain',
        conversation_id: CONV,
        thread_root_id: null,
        from_kind: 'user',
        from_agent_id: null,
        from_user_id: 'u1',
        content: 'just chatting',
        created_at: 0,
        metadata: null,
      },
      agentName,
      agentComputer,
      userName,
      undefined,
      addressing(),
    );

    expect(header).not.toContain('task=');
    expect(header).not.toContain('status=');
  });

  it('carries the current status for a task status-change event (in_progress)', () => {
    const header = formatStdinMessageHeader(
      {
        id: 'm-claimed',
        conversation_id: CONV,
        thread_root_id: null,
        from_kind: 'agent',
        from_agent_id: 'a1',
        from_user_id: null,
        content: 'work it',
        created_at: 0,
        metadata: JSON.stringify({
          subtype: 'task_status',
          task_number: 7,
          task_status: 'in_progress',
        }),
      },
      agentName,
      agentComputer,
      userName,
      undefined,
      addressing(),
    );

    expect(header).toContain('task=#7 status=in_progress');
  });

  // ── #task:1600 — conditional computer= header ──────────────────────

  it('agent rows carry computer=<current host id>, resolved live at render time', () => {
    const header = formatStdinMessageHeader(
      {
        id: 'm-a',
        conversation_id: CONV,
        thread_root_id: null,
        from_kind: 'agent',
        from_agent_id: 'a1',
        from_user_id: null,
        content: 'hi',
        created_at: 0,
      },
      agentName,
      agentComputer,
      userName,
      undefined,
      addressing(),
    );
    expect(header).toMatch(
      new RegExp(
        `^\\[msg_id=m-a sender=@Alice type=agent computer=host-alice `
        + `target=#conv:${CONV} time=`,
      ),
    );
  });

  it('human and system rows NEVER carry a computer field', () => {
    const human = formatStdinMessageHeader(
      {
        id: 'm-h',
        conversation_id: CONV,
        thread_root_id: null,
        from_kind: 'user',
        from_agent_id: null,
        from_user_id: 'u1',
        content: 'hi',
        created_at: 0,
      },
      agentName,
      agentComputer,
      userName,
      undefined,
      addressing(),
    );
    const system = formatStdinMessageHeader(
      systemMessage({}),
      agentName,
      agentComputer,
      userName,
      undefined,
      addressing(),
    );
    expect(human).not.toContain('computer=');
    expect(system).not.toContain('computer=');
  });

  it('an unresolvable sender agent OMITS the field — no computer=unknown token exists', () => {
    const header = formatStdinMessageHeader(
      {
        id: 'm-gone',
        conversation_id: CONV,
        thread_root_id: null,
        from_kind: 'agent',
        from_agent_id: 'a-deleted',
        from_user_id: null,
        content: 'hi',
        created_at: 0,
      },
      agentName,
      agentComputer,
      userName,
      undefined,
      addressing(),
    );
    expect(header).not.toContain('computer=');
    expect(header).not.toContain('unknown');
  });
});

/**
 * #task:2021 — the header's `target` is an ABSOLUTE address, and since P4-4 it is
 * one the reader may paste back.
 *
 * The properties that make it one: it is derived per ROW (the formatter has no
 * authority over a row's coordinate, per-call or ambient), it parses back through
 * the codec to the stream it names (so the emitted token is a coordinate and not
 * just a label), the relative token `channel` is gone everywhere — a header that
 * still emitted it would be naming whichever stream the reader assumed — and every
 * form the renderer can choose is accepted by the SAME grammar the write surfaces
 * take (`parseDeliveryTargetInput`), which is what makes "paste it into `--target`"
 * true rather than aspirational.
 */
describe('the header target is absolute', () => {
  it('addresses each row by its own stream, even in one batch', () => {
    // Row-wise invariant, proved adversarially: production claims per stream
    // today (`claimPending(conversationId, agentId)` filters on
    // `conversation_id`), so a single batch carrying two origins is NOT a
    // currently reachable path — it is the shape that must stay impossible to
    // get wrong. Handing the formatter two origins at once is the only way to
    // show it never reintroduces a per-call or ambient coordinate: a
    // conversation parameter passed once per batch would render both rows with
    // the same address, and the second agent would reply into the first stream.
    // Agent-scoped drain is what makes that reachable, and this test is the
    // fence that will already be standing.
    const { presentations } = formatInboxBatchPresentation(
      [
        {
          message: {
            id: 'm-here',
            conversation_id: CONV,
            thread_root_id: null,
            from_kind: 'user',
            from_agent_id: null,
            from_user_id: 'u1',
            content: 'here',
            created_at: 0,
            metadata: null,
          },
        },
        {
          message: {
            id: 'm-there',
            conversation_id: CONV_OTHER,
            thread_root_id: ROOT,
            from_kind: 'user',
            from_agent_id: null,
            from_user_id: 'u1',
            content: 'there',
            created_at: 1,
            metadata: null,
          },
        },
      ],
      agentName,
      agentComputer,
      userName,
      undefined,
      'Cindy',
      TOOL,
      REFERENCES(),
      addressing(),
    );

    expect(presentations[0]!.body).toContain(`target=#conv:${CONV} `);
    expect(presentations[1]!.body).toContain(
      `target=#conv:${CONV_OTHER}/thread:${ROOT} `,
    );
  });

  it('round-trips through the codec: the emitted token names that stream', () => {
    for (const threadRootId of [null, ROOT]) {
      const header = formatStdinMessageHeader(
        {
          id: 'm-rt',
          conversation_id: CONV,
          thread_root_id: threadRootId,
          from_kind: 'user',
          from_agent_id: null,
          from_user_id: 'u1',
          content: 'x',
          created_at: 0,
        },
        agentName,
        agentComputer,
        userName,
        undefined,
        addressing(),
      );
      const token = /target=(\S+)/.exec(header)![1]!;
      expect(parseDeliveryTarget(token)).toEqual({
        conversationId: CONV,
        threadRootId,
      });
    }
  });

  it('emits one whitespace-free token, so the header stays splittable', () => {
    const header = formatStdinMessageHeader(
      {
        id: 'm-token',
        conversation_id: CONV,
        thread_root_id: ROOT,
        from_kind: 'system',
        from_agent_id: null,
        from_user_id: null,
        content: 'x',
        created_at: 0,
      },
      agentName,
      agentComputer,
      userName,
      undefined,
      addressing(),
    );
    expect(header.split(/\s+/).filter(f => f.startsWith('target='))).toEqual([
      `target=#conv:${CONV}/thread:${ROOT}`,
    ]);
  });

  it('has retired the relative `channel` token', () => {
    const header = formatStdinMessageHeader(
      systemMessage({}),
      agentName,
      agentComputer,
      userName,
      undefined,
      addressing(),
    );
    expect(header).not.toContain('channel');
  });

  it('fails loud for a coordinate no address can carry', () => {
    // Corruption, not input: every `conversations.id` and every `messages.id` is
    // 16 base64url characters, so there is no branch to take here — omitting
    // `target=` would hand the reader back the ambient guess.
    expect(() =>
      formatStdinMessageHeader(
        systemMessage({ conversation_id: 'c1' }),
        agentName,
        agentComputer,
        userName,
        undefined,
        addressing(),
      ),
    ).toThrow(/messages\.conversation_id is not spellable/);
    expect(() =>
      formatStdinMessageHeader(
        systemMessage({ thread_root_id: 'm-root' }),
        agentName,
        agentComputer,
        userName,
        undefined,
        addressing(),
      ),
    ).toThrow(/messages\.thread_root_id is not spellable/);
  });
});

/**
 * #task:2021 P4-4 — which FORM the target takes, and what a fall back costs.
 *
 * The renderer's four arms live in the codec and the policy that chooses between
 * them lives in `application/stream-naming.ts`; what belongs HERE is the contract
 * between them and the header: whatever the naming says, the emitted token is
 * accepted by the write surfaces' grammar, and every degradation to the id form is
 * reported exactly once so the count is neither silent nor doubled.
 */
describe('the header target renders the naming it is given', () => {
  const WORKSPACE = fixedWorkspaceName('silverhand');
  const TITLE = fixedConversationTitle('UI/UX 优化');

  const forms: Array<{
    name: string;
    naming: StreamNaming;
    token: string;
    fallback: AddressFallbackReason | null;
  }> = [
    {
      name: 'a named workspace stream spells both names, percent-escaped',
      naming: { kind: 'named', workspace: WORKSPACE, title: TITLE },
      // Only what the header's own lexing needs is escaped: `/` becomes `%2F`, so
      // the segment count stays the grammar, and a space becomes `%20`, so the
      // token stays one whitespace-free field. Non-ASCII is left RAW — the token
      // is read by a person as often as by a parser, and `%E4%BC%98%E5%8C%96`
      // would make a Chinese channel name unrecognizable to its own members.
      token: '#silverhand/UI%2FUX%20优化',
      fallback: null,
    },
    {
      name: 'a DirectPair spells the OTHER participant, for this reader only',
      naming: { kind: 'direct_pair', otherHandle: 'shiki' },
      token: 'dm:@shiki',
      fallback: null,
    },
    {
      name: 'an agent inbox spells its id and is NOT counted as a fallback',
      naming: { kind: 'id_only' },
      token: `#conv:${CONV}`,
      fallback: null,
    },
    {
      name: 'an agent-home placement degrades and is counted',
      naming: { kind: 'unnameable', reason: 'agent_home' },
      token: `#conv:${CONV}`,
      fallback: 'agent_home',
    },
    {
      name: 'a name the current domain would refuse degrades and is counted',
      naming: { kind: 'unnameable', reason: 'unrenderable' },
      token: `#conv:${CONV}`,
      fallback: 'unrenderable',
    },
  ];

  for (const form of forms) {
    it(form.name, () => {
      const source = addressing(form.naming);
      const header = formatStdinMessageHeader(
        systemMessage({}),
        agentName,
        agentComputer,
        userName,
        undefined,
        source,
      );
      expect(header).toContain(`target=${form.token} `);
      expect(source.fallbacks).toEqual(
        form.fallback === null ? [] : [form.fallback],
      );
    });

    it(`${form.name} — and the token is accepted by the write grammar`, () => {
      const header = formatStdinMessageHeader(
        systemMessage({ thread_root_id: ROOT }),
        agentName,
        agentComputer,
        userName,
        undefined,
        addressing(form.naming),
      );
      // The whole token, thread suffix included: an agent pastes what it read, so
      // "the head parses" is not the property that matters.
      const token = /target=(\S+)/.exec(header)![1]!;
      expect(parseDeliveryTargetInput(token)).not.toBeNull();
      expect(token.endsWith(`/thread:${ROOT}`)).toBe(true);
    });
  }

  it('counts one fallback per framed ROW, not per batch', () => {
    const source = addressing({ kind: 'unnameable', reason: 'unrenderable' });
    formatInboxBatchPresentation(
      [
        { message: { ...systemMessage({ id: 'm-1' }), metadata: null } },
        { message: { ...systemMessage({ id: 'm-2' }), metadata: null } },
      ],
      agentName,
      agentComputer,
      userName,
      undefined,
      'Cindy',
      TOOL,
      REFERENCES(),
      source,
    );
    // Two headers were emitted with the id form, so the window owes two — the
    // aggregate is the fanout's to hold, and a formatter that deduplicated here
    // would understate exactly the traffic the count exists to size.
    expect(source.fallbacks).toEqual(['unrenderable', 'unrenderable']);
  });
});

function systemMessage(overrides: Partial<MessageLite> = {}): MessageLite {
  return {
    id: 'm-system',
    conversation_id: CONV,
    thread_root_id: null,
    from_kind: 'system',
    from_agent_id: null,
    from_user_id: null,
    content: 'system event',
    created_at: 0,
    ...overrides,
  };
}

function agentName(id: string): string | undefined {
  return id === 'a1' ? 'Alice' : undefined;
}

function agentComputer(id: string): string | undefined {
  return id === 'a1' ? 'host-alice' : undefined;
}

function userName(id: string): string | undefined {
  return id === 'u1' ? 'shiki' : undefined;
}
