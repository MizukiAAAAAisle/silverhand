import { describe, expect, it } from 'vitest';
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
  expectedReach: 'conversation' | 'agent';
  sessionContext: SessionContextInput;
}> = [
  {
    label: 'ConversationSlot (workspace channel)',
    expectedReach: 'conversation',
    sessionContext: {
      kind: 'conversation',
      conversationId: CONV,
      computerId: 'host-1',
      sessionTitle: 'a channel',
      members: [],
      workspaceName: 'ws',
      workspacePath: '/workspaces/ws',
      workspaceId: 'ws-1',
    },
  },
  {
    label: 'ConversationSlot (workspace-less)',
    expectedReach: 'conversation',
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
    expectedReach: 'agent',
    sessionContext: {
      kind: 'agent',
      computerId: 'host-1',
      memoryRootPath: '/agents/a1',
    },
  },
];

const EXPECTED_REACH = {
  conversation: [
    '`silverhand message send`, `silverhand channel create`, `silverhand file upload`, `silverhand member add`',
    'are limited to this conversation (`slot_out_of_scope` elsewhere).',
    '`silverhand message history`, `silverhand task create`, `silverhand schedule create`',
    'may target any conversation you participate in.',
  ].join(' '),
  agent: [
    '`silverhand message send`, `silverhand message history`, `silverhand task create`,',
    '`silverhand schedule create`, `silverhand channel create`, `silverhand file upload`, `silverhand member add`',
    'may target any conversation you participate in.',
  ].join(' '),
} as const;

describe('platform prompt teaches reach, per credential', () => {
  for (const scope of SCOPES) {
    it(`${scope.label}: names each command in the correct reach paragraph`, () => {
      const prompt = promptFor(scope.sessionContext);
      // Do not accept the same command mentioned in the general CLI index.
      const paragraph = prompt.match(/^- \*\*Command reach\.\*\* ([\s\S]*?)(?=\n- |\n\n)/m);
      expect(paragraph).not.toBeNull();
      expect(paragraph![1]!.replace(/\s+/g, ' ').trim()).toBe(EXPECTED_REACH[scope.expectedReach]);
    });
  }
});
