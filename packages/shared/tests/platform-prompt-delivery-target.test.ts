/**
 * #task:2021 P4-3 — the prompt teaches exactly the address the codec renders.
 *
 * This is a DRIFT GATE, and the drift it guards is the expensive kind. The
 * daemon composes the platform prompt from its own bundled `@silverhand/shared`
 * while the backend renders the header, so "what an agent is taught" and "what
 * an agent receives" are two artifacts that can disagree without either side
 * erroring — the reply just lands in whichever conversation the agent assumed
 * (see the v17 ledger entry in `host/src/protocol.ts`). A prose-only assertion
 * (`toContain('#conv:')`) would not catch that: it passes while the taught
 * grammar is subtly unparseable. So the taught token is INSTANTIATED with real
 * ids and fed back through the one codec.
 */
import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_ADDRESS_PREFIX,
  THREAD_ADDRESS_SEPARATOR,
  formatDeliveryTarget,
  parseDeliveryTarget,
  requireAddressableId,
} from '../src/delivery-target.js';
import {
  buildPlatformPrompt,
  type PlatformPromptInput,
  type SessionContextInput,
} from '../src/platform-prompt.js';

const CONV = 'Q1VI9x6vUK1a9oN9';
const ROOT = 'NbBXIEpDUnSWW48x';

/** The grammar the Operating Contract spells out, derived from the codec's own
 *  prefixes rather than re-typed — change either prefix and this fails here
 *  instead of in a live delivery. */
const TAUGHT_GRAMMAR =
  `target=${CONVERSATION_ADDRESS_PREFIX}<conversation_id>`
  + `[${THREAD_ADDRESS_SEPARATOR}<root_message_id>]`;

function promptFor(sessionContext: SessionContextInput): string {
  const input: PlatformPromptInput = {
    agentId: 'a1',
    agentName: 'Alice',
    runtime: 'claude',
    activeProfileDir: '.',
    roleSystemPrompt: 'role',
    roleSystemPromptPath: '/tmp/system_prompt.md',
    currentMemory: { kind: 'missing' },
    memoryNotesCatalog: { entries: [], omittedCount: 0 },
    workspaceMemoryIndex: [],
    sessionContext,
  };
  return buildPlatformPrompt(input);
}

const SCOPES: Array<{ name: string; sessionContext: SessionContextInput }> = [
  {
    name: 'ConversationSlot',
    sessionContext: {
      kind: 'conversation',
      conversationId: CONV,
      computerId: 'host-1',
      sessionTitle: 'a channel',
      members: [],
      workspaceName: 'ws',
      workspacePath: '/tmp/ws',
      channelKind: 'regular',
    },
  },
  {
    name: 'AgentSlot',
    sessionContext: { kind: 'agent', computerId: 'host-1' },
  },
];

describe('platform prompt teaches the absolute delivery target', () => {
  for (const scope of SCOPES) {
    it(`${scope.name}: spells the grammar the codec builds`, () => {
      expect(promptFor(scope.sessionContext)).toContain(TAUGHT_GRAMMAR);
    });

    it(`${scope.name}: has retired the relative \`channel\` token`, () => {
      expect(promptFor(scope.sessionContext)).not.toContain('target=channel');
    });
  }

  it('the taught grammar parses back, main line and reply cluster alike', () => {
    // Instantiate the placeholders the way an agent reads them, then hand the
    // result to the codec. Both arms must survive the round trip, because the
    // bracketed suffix is exactly the part a hand-written grammar gets wrong.
    const taught = TAUGHT_GRAMMAR.slice('target='.length);
    const mainLine = taught
      .replace('<conversation_id>', CONV)
      .replace(`[${THREAD_ADDRESS_SEPARATOR}<root_message_id>]`, '');
    const inThread = taught
      .replace('<conversation_id>', CONV)
      .replace('[', '')
      .replace(']', '')
      .replace('<root_message_id>', ROOT);

    expect(parseDeliveryTarget(mainLine)).toEqual({
      conversationId: CONV,
      threadRootId: null,
    });
    expect(parseDeliveryTarget(inThread)).toEqual({
      conversationId: CONV,
      threadRootId: ROOT,
    });
    // …and the codec renders precisely those two tokens, so the teaching is not
    // merely parseable but identical to what a delivery emits.
    expect(
      formatDeliveryTarget({
        conversationId: requireAddressableId(CONV, 'test'),
        threadRootId: null,
      }),
    ).toBe(mainLine);
    expect(
      formatDeliveryTarget({
        conversationId: requireAddressableId(CONV, 'test'),
        threadRootId: requireAddressableId(ROOT, 'test'),
      }),
    ).toBe(inThread);
  });

  it('AgentSlot targeting tells the agent where the route id comes from', () => {
    // AgentSlot has no ambient conversation, so `--route-conversation-id` is the
    // only thing standing between a correct reply and a misrouted one. The rule
    // has to name the header token it extracts from, or the agent is left to
    // guess which of the two ids in a delivery is the conversation.
    const prompt = promptFor(SCOPES[1]!.sessionContext);
    expect(prompt).toContain('--route-conversation-id <id>');
    expect(prompt).toContain(`target=${CONVERSATION_ADDRESS_PREFIX}<id>`);
  });
});
