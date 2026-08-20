// WHICH CONTAINER EACH CREATE FACE ACCEPTS — the two hard rejects
// `ChannelService` owns (#task:2082).
//
// Both gates used to compare a stored word (`workspace_kind === 'agent_home'`)
// and now ask the ownership relation through one named predicate. Two schema
// CHECKs make that swap behavior-free ON PAPER; nothing pinned it in a test. The
// only prior coverage was `tests/routes/responses.test.ts`, which maps an
// already-constructed `WorkspaceUnsuitableError` to its HTTP body — it never asks
// which container produces which verdict, so an inverted or defaulted predicate
// would have kept it green while opening `POST /workspaces/:id/channels` on an
// agent's private home.
//
// DIFFERENTIAL, in both directions. A refusal cell alone cannot tell "refuses the
// wrong container" from "refuses everything", so each face is also driven with the
// container it MUST accept, and the witness that the gate passed is the NEXT
// guard's distinct error. That keeps the cell about suitability instead of dragging
// a whole successful create (and its transaction, event bus and runtime host) in.
//
// Ports are stubbed down to the two faces these paths reach before their next
// refusal (`workspaces.get`, `agents.get`). Everything else is deliberately absent:
// if a future edit moves either gate later, this file fails loudly rather than
// silently testing a different question.
import { describe, expect, it } from 'vitest';
import { fixedConversationTitle, type Workspace } from '@silverhand/shared';
import {
  ChannelService,
  MemberError,
  WorkspaceUnsuitableError,
  type ChannelServiceOptions,
} from '../../../src/services/channel-service.js';

const REGULAR_ID = 'wsRegular0000001';
const HOME_ID = 'wsHome000000000A';
const OWNER = 'agentOwner00000A';
const USER = 'user000000000001';

/** A container row, differing in the ONE field the gates read: `owner_agent_id`. */
function workspace(over: Partial<Workspace>): Workspace {
  return {
    id: REGULAR_ID,
    name: 'silverhand',
    description: null,
    owner_agent_id: null,
    owner_user_id: USER,
    dm_channel_id: null,
    dm_channel_ids: [],
    archived_at: null,
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

const regular = workspace({});
/** An agent home — a non-null `owner_agent_id`, the sole relation the gates read
 *  now that #task:2080 dropped the redundant stored container word. */
const home = workspace({
  id: HOME_ID,
  owner_agent_id: OWNER,
  owner_user_id: null,
});

/**
 * A service whose only live ports are the two reads these paths perform before
 * their next refusal. `agents.get` always answers `null`, which is what turns the
 * next guard into the "the suitability gate passed" witness.
 */
function serviceOver(containers: Workspace[]): ChannelService {
  const byId = new Map(containers.map(w => [w.id, w]));
  const options = {
    workspaces: {
      get: (id: string) => byId.get(id) ?? null,
      isMember: () => false,
      isUserMember: () => false,
    },
    agents: { get: () => null },
  } as unknown as ChannelServiceOptions;
  return new ChannelService(options);
}

const title = fixedConversationTitle('design');
const actor = { kind: 'user', userId: USER } as never;

describe('createChannel targets a regular container', () => {
  it('refuses an agent home — a private home is not a place to mint a channel', async () => {
    await expect(
      serviceOver([home]).createChannel({
        workspaceId: HOME_ID,
        title,
        memberAgentIds: [],
        actor,
      }),
    ).rejects.toMatchObject({
      name: 'WorkspaceUnsuitableError',
      code: 'workspace_not_regular',
    });
  });

  it('passes a regular container through the gate', async () => {
    // The witness: the very next guard (member existence) is what refuses, so the
    // suitability gate is proven NOT to have fired. A cell that only asserted the
    // refusal above would pass just as well with a predicate that refuses both.
    await expect(
      serviceOver([regular]).createChannel({
        workspaceId: REGULAR_ID,
        title,
        memberAgentIds: ['ghostAgent00000A'],
        actor,
      }),
    ).rejects.toBeInstanceOf(MemberError);
  });
});

describe('createAgentHomeDmChannel targets an agent home', () => {
  it('refuses a regular container', async () => {
    await expect(
      serviceOver([regular]).createAgentHomeDmChannel({
        workspaceId: REGULAR_ID,
        title,
        actor,
      }),
    ).rejects.toMatchObject({
      name: 'WorkspaceUnsuitableError',
      code: 'workspace_not_agent_home',
    });
  });

  it('passes an agent home through the gate', async () => {
    // Same witness shape, one guard further in: reaching `agent_home_owner_not_found`
    // means the gate admitted this container AND read its owner column.
    await expect(
      serviceOver([home]).createAgentHomeDmChannel({
        workspaceId: HOME_ID,
        title,
        actor,
      }),
    ).rejects.toMatchObject({
      name: 'AgentHomeChannelError',
      code: 'agent_home_owner_not_found',
    });
  });

  it('refuses a missing container before it asks anything about its kind', async () => {
    await expect(
      serviceOver([]).createAgentHomeDmChannel({
        workspaceId: HOME_ID,
        title,
        actor,
      }),
    ).rejects.toBeInstanceOf(WorkspaceUnsuitableError);
  });
});
