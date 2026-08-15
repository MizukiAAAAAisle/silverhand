/**
 * #task:2021 P4-4 — the prompt teaches the reach boundary, per scope, from the
 * ruling.
 *
 * The prompt's paragraph is DERIVED from `DELIVERY_REACH`, so this file is not
 * guarding a copy against an original; it guards the three things derivation cannot
 * guarantee on its own:
 *
 *   1. The paragraph is actually IN the prompt, in both scopes. A derived string
 *      that no template interpolates is the same silence as no rule at all.
 *   2. Every addressed door is named. The two lists partition the table, so this is
 *      the assertion that the surface renders BOTH — prose that enumerates the
 *      confined doors and leaves the rest implicit is true only until a door is
 *      added.
 *   3. The two scopes differ, and differ the ruled way: a ConversationSlot is told
 *      about a boundary and the refusal code it will meet; an AgentSlot has no
 *      confined door and must not be taught one, or it would decline work it may do
 *      and no error would ever correct it.
 */
import { describe, expect, it } from 'vitest';
import {
  ADDRESSED_OPERATION_COMMAND,
  ADDRESSED_OPERATIONS,
  reachTaughtCommands,
  type RuntimeSlotKind,
} from '../src/delivery-reach.js';
import { SLOT_REACH_REFUSAL_CODE } from '../src/delivery-target.js';
import {
  buildPlatformPrompt,
  type PlatformPromptInput,
  type SessionContextInput,
} from '../src/platform-prompt.js';

const CONV = 'Q1VI9x6vUK1a9oN9';

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

/**
 * One case per scope: the credential the daemon issues for it, and the prompt an
 * agent in it reads.
 *
 * The workspace-less ConversationSlot is included because its memory manual is a
 * separate branch — a reach rule written into one of the two conversation branches
 * would be invisible to the other, and it is the same credential in both.
 */
const SCOPES: ReadonlyArray<{
  label: string;
  slotKind: RuntimeSlotKind;
  sessionContext: SessionContextInput;
}> = [
  {
    label: 'ConversationSlot (workspace channel)',
    slotKind: 'conversation_slot',
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
    label: 'ConversationSlot (workspace-less)',
    slotKind: 'conversation_slot',
    sessionContext: {
      kind: 'conversation',
      conversationId: CONV,
      computerId: 'host-1',
      sessionTitle: 'a pair',
      members: [],
    },
  },
  {
    label: 'AgentSlot',
    slotKind: 'agent_slot',
    sessionContext: { kind: 'agent', computerId: 'host-1' },
  },
];

const taughtCommand = (command: string): string => `\`silverhand ${command}\``;

describe('platform prompt teaches reach, per credential', () => {
  for (const scope of SCOPES) {
    it(`${scope.label}: names every addressed door`, () => {
      const prompt = promptFor(scope.sessionContext);
      for (const operation of ADDRESSED_OPERATIONS) {
        expect(
          prompt,
          `${scope.label} / ${operation}`,
        ).toContain(taughtCommand(ADDRESSED_OPERATION_COMMAND[operation]));
      }
    });

    it(`${scope.label}: teaches the refusal only where a door is confined`, () => {
      const prompt = promptFor(scope.sessionContext);
      const { confined } = reachTaughtCommands(scope.slotKind);
      expect(prompt.includes(SLOT_REACH_REFUSAL_CODE)).toBe(confined.length > 0);
    });
  }

  it('the two credentials are taught different reach, which is the ruling', () => {
    // If these ever coincided, either the ConversationSlot was granted the four
    // write doors across streams or the AgentSlot lost its only way to act. Both
    // are decisions nobody took, and the prompt is where an agent would learn the
    // wrong one first.
    const conversationSlot = promptFor(SCOPES[0]!.sessionContext);
    const agentSlot = promptFor(SCOPES[2]!.sessionContext);
    const { confined } = reachTaughtCommands('conversation_slot');
    expect(confined.length).toBeGreaterThan(0);
    for (const command of confined) {
      // Same command named in both prompts (assertion above), but only one of them
      // calls it confined.
      expect(conversationSlot).toContain(taughtCommand(command));
    }
    expect(conversationSlot).toContain(SLOT_REACH_REFUSAL_CODE);
    expect(agentSlot).not.toContain(SLOT_REACH_REFUSAL_CODE);
  });
});
