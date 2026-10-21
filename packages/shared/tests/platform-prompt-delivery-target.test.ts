/**
 * #task:2021 P4-3/P4-4 — the prompt teaches exactly the addresses the codec
 * renders, all of them.
 *
 * This is a DRIFT GATE, and the drift it guards is the expensive kind. The
 * daemon composes the platform prompt from its own bundled `@silverhand/shared`
 * while the backend renders the header, so "what an agent is taught" and "what
 * an agent receives" are two artifacts that can disagree without either side
 * erroring — the reply just lands in whichever conversation the agent assumed
 * (see the protocol handshake note in `host/src/protocol.ts`). A prose-only assertion
 * (`toContain('#conv:')`) would not catch that: it passes while the taught
 * grammar is subtly unparseable. So every taught token is INSTANTIATED with real
 * values and fed back through the one codec.
 *
 * P4-4 widened what a header can say: `formatStreamAddressToken` picks between a
 * named stream, the per-viewer DM shorthand, and the id form, and the prompt
 * previously taught only the third. So the gate is now driven from the emitter's
 * OWN union — one case per `StreamNaming` kind, exhaustive by type — which is
 * what makes "teaches every form" a fact rather than three hand-listed strings
 * that a fourth arm would silently escape.
 */
import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_ADDRESS_PREFIX,
  NAMED_STREAM_ADDRESS_PREFIX,
  DIRECT_PAIR_SHORTHAND_PREFIX,
  THREAD_ADDRESS_SEPARATOR,
  type StreamNaming,
  formatStreamAddressToken,
  parseDeliveryTargetInput,
  requireAddressableId,
} from '../src/delivery-target.js';
import { fixedConversationTitle } from '../src/conversation-title.js';
import { fixedWorkspaceName } from '../src/workspace-name.js';
import {
  buildPlatformPrompt,
  type PlatformPromptInput,
  type SessionContextInput,
} from '../src/platform-prompt.js';

const CONV = 'Q1VI9x6vUK1a9oN9';
const ROOT = 'NbBXIEpDUnSWW48x';

const stream = (threadRootId: string | null = null) => ({
  conversationId: requireAddressableId(CONV, 'test'),
  threadRootId: threadRootId === null ? null : requireAddressableId(threadRootId, 'test'),
});

/**
 * One case per naming kind: the emitter input, and the PLACEHOLDER form the
 * prompt is required to spell for it.
 *
 * `taught` is built from the codec's own prefixes rather than re-typed, so
 * changing a prefix fails here instead of in a live delivery, and `instantiate`
 * turns the placeholder back into a real token — the two directions together are
 * what "the prompt teaches a parseable form of what you will receive" means.
 *
 * `unnameable` and `id_only` share the id form deliberately: an agent cannot act
 * on the difference (both are "no readable name here"), and the reason is an
 * operator fact counted elsewhere.
 */
const FORMS: ReadonlyArray<{
  label: string;
  naming: StreamNaming;
  taught: string;
  instantiate(taughtForm: string): string;
}> = [
  {
    label: 'named',
    naming: {
      kind: 'named',
      workspace: fixedWorkspaceName('silverhand'),
      title: fixedConversationTitle('general'),
    },
    taught: `${NAMED_STREAM_ADDRESS_PREFIX}<workspace>/<title>`,
    instantiate: (form) => form.replace('<workspace>', 'silverhand').replace('<title>', 'general'),
  },
  {
    label: 'direct_pair',
    naming: { kind: 'direct_pair', otherHandle: 'shiki' },
    taught: `${DIRECT_PAIR_SHORTHAND_PREFIX}<handle>`,
    instantiate: (form) => form.replace('<handle>', 'shiki'),
  },
  {
    label: 'id_only',
    naming: { kind: 'id_only' },
    taught: `${CONVERSATION_ADDRESS_PREFIX}<id>`,
    instantiate: (form) => form.replace('<id>', CONV),
  },
  {
    label: 'unnameable',
    naming: { kind: 'unnameable', reason: 'agent_home' },
    taught: `${CONVERSATION_ADDRESS_PREFIX}<id>`,
    instantiate: (form) => form.replace('<id>', CONV),
  },
];

const TAUGHT_SUFFIX = `${THREAD_ADDRESS_SEPARATOR}<root_message_id>`;

/**
 * The reply cluster a taught token parses to, read EXHAUSTIVELY over the parser's
 * union rather than by shape: the id arm nests its stream (`stream.threadRootId`)
 * while the two readable arms carry the root directly, so a `toMatchObject`
 * against one of those shapes silently passes on the other by matching nothing.
 */
function parsedThreadRootId(raw: string): string | null | undefined {
  const parsed = parseDeliveryTargetInput(raw);
  if (parsed === null) return undefined;
  switch (parsed.kind) {
    case 'stream':
      return parsed.stream.threadRootId;
    case 'named_stream':
    case 'direct_pair_shorthand':
      return parsed.threadRootId;
  }
}

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
      workspacePath: '/workspaces/ws',
      workspaceId: 'ws-1',
    },
  },
  {
    name: 'AgentSlot',
    sessionContext: {
      kind: 'agent',
      computerId: 'host-1',
      memoryRootPath: '/agents/a1',
    },
  },
];

describe('platform prompt teaches the absolute delivery target', () => {
  for (const scope of SCOPES) {
    for (const form of FORMS) {
      it(`${scope.name}: spells the ${form.label} form the emitter can send`, () => {
        // The token an agent in this scope may actually receive…
        const emitted = formatStreamAddressToken(stream(), form.naming);
        expect(emitted.token).toBe(form.instantiate(form.taught));
        // …and the placeholder form the prompt teaches for it.
        expect(promptFor(scope.sessionContext)).toContain(form.taught);
      });
    }

    it(`${scope.name}: teaches the reply-cluster suffix once, for any head`, () => {
      expect(promptFor(scope.sessionContext)).toContain(TAUGHT_SUFFIX);
    });

    it(`${scope.name}: has retired the relative \`channel\` token`, () => {
      expect(promptFor(scope.sessionContext)).not.toContain('target=channel');
    });
  }

  it('every taught form parses back, main line and reply cluster alike', () => {
    // Instantiate the placeholders the way an agent reads them, then hand the
    // result to the codec — including with the suffix appended, which is exactly
    // the part a hand-written grammar gets wrong. The head is asserted to be the
    // codec's rendering of the same stream above, so this pins parseability of
    // the whole token an agent would paste.
    for (const form of FORMS) {
      const head = form.instantiate(form.taught);
      expect(parseDeliveryTargetInput(head), head).not.toBeNull();

      const inThread = `${head}${TAUGHT_SUFFIX.replace('<root_message_id>', ROOT)}`;
      expect(parsedThreadRootId(inThread), inThread).toBe(ROOT);
      // And it is the same token the emitter produces for the threaded stream —
      // teaching that parses but differs from what arrives is still drift.
      expect(formatStreamAddressToken(stream(ROOT), form.naming).token).toBe(inThread);
    }
  });

  it('does not teach internal runtime scope or directory coordinates', () => {
    const prompt = promptFor(SCOPES[1]!.sessionContext);
    expect(prompt).not.toContain('runtime_scope');
    expect(prompt).not.toContain('workdir');
    expect(prompt).not.toContain('cwd');
  });
});
