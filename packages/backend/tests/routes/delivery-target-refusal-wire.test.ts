/**
 * #task:2021 P4-4 — the existence collapse, asserted WHERE THE ACTOR READS IT.
 *
 * `tests/delivery-target-resolution.test.ts` proves the collapse inside the
 * resolver: unknown and unauthorized return one object, and the branch leaves
 * through the operator port. That proof stops at the function boundary. Between it
 * and the agent there are SEVEN doors, each of which serializes the refusal into
 * an HTTP response, and any one of them could re-separate the two cases by status,
 * by message, by an extra field, or by catching the refusal and re-wrapping it in
 * its own vocabulary. A collapse that holds in the application layer and leaks at
 * the door is not a collapse — the door is the only surface an unauthorized prober
 * can actually reach.
 *
 * So this file is a matrix over (door x probe) at the WIRE, and its central claim
 * is a single set: every combination produces byte-identical response bytes.
 * Not "the same code" — the same bytes, status included, because anything that
 * differs is a signal, and a prober does not care which field carried it.
 *
 * The probes are chosen to be indistinguishable ONLY IF the collapse holds. They
 * cover the three ways an address can name nothing the caller may use:
 *   - unknown: a title, a workspace, or an id that names no row;
 *   - unauthorized: a channel that exists, in a workspace the caller is not in,
 *     both by name and by id — plus a PUBLIC channel, which the caller can
 *     legitimately discover elsewhere and still may not address;
 *   - unauthorized ARCHIVED: a channel in a workspace whose lifecycle ended, which
 *     the caller is also not a member of. It is here because archiving does NOT
 *     release a workspace's name key and the root resolver answers with the current
 *     regular identity INCLUDING archived rows, without judging lifecycle or
 *     authorization (@lwf's v78 handoff). Folding it into the same unresolvable
 *     shape is therefore THIS layer's job, and a third answer for it would be a
 *     lifecycle oracle over every archived workspace.
 *
 * WHAT THE ARCHIVED PROBES DO NOT CLAIM (@Cindy B3). Every probe here is refused
 * for LACK OF AUTHORIZATION; the archived pair adds only that archiving does not
 * turn that refusal into a different one. They say nothing about an archived stream
 * the caller IS on — that address still resolves, for a read and for a write alike,
 * which the second test in this file pins as a positive control. Without it the
 * collapse reads as "archived is unreachable", and a real behaviour change would
 * look already-tested.
 *
 * The negative half matters as much: the operator's record must still carry the
 * branch. A "collapse" implemented by throwing the reason away would pass a
 * byte-identity test and cost operators every refusal diagnosis, so this file also
 * asserts that the captured log lines DO distinguish the probes, and that the
 * distinguishing values appear nowhere in any response body.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { internalPaths } from '@silverhand/shared';
import type { BackendLogger } from '../../src/context.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import {
  buildTestApp,
  http,
  issueTestConversationRuntimeToken,
  type TestApp,
} from '../utils/app.js';

/** A well-formed id (16 base64url characters) that names no row. Shaped like a
 *  real id because a malformed one is a grammar refusal and never reaches a
 *  lookup — a different code, and correctly so. */
const MISSING_ID = 'zzzzMISSINGzzz01';

/** The one answer. Written out rather than derived so that changing the route's
 *  message or key order is a deliberate edit to a wire contract three readers
 *  parse, not an incidental diff. */
const THE_ONE_ANSWER =
  '404 {"error":"target names no stream you can use","code":"target_unresolved"}';

interface Recorded {
  readonly fields: Record<string, unknown>;
}

function capturingLogger(sink: Recorded[]): BackendLogger {
  const record = (obj: unknown): void => {
    if (obj && typeof obj === 'object') sink.push({ fields: obj as Record<string, unknown> });
  };
  return { info: record, warn: record, error: record };
}

/** The refusal lines only — the sink also sees whatever else the request logged. */
function refusals(sink: Recorded[]): Array<Record<string, unknown>> {
  return sink
    .map(r => r.fields)
    .filter(f => f['delivery_target_event'] === 'refused');
}

async function makeAgent(t: TestApp, name: string): Promise<string> {
  const created = (await (
    await http(t).post('/api/agents', { name, runtime: 'claude' })
  ).json()) as any;
  return created.agent.id as string;
}

async function makeWorkspace(
  t: TestApp,
  name: string,
  memberAgentIds: string[],
): Promise<{ workspaceId: string; channelId: string }> {
  const created = (await (
    await http(t).post('/api/workspaces', { name, member_agent_ids: memberAgentIds })
  ).json()) as any;
  return {
    workspaceId: created.workspace.id as string,
    channelId: created.onboarding_channel_id as string,
  };
}

async function createChannel(
  t: TestApp,
  workspaceId: string,
  title: string,
  memberAgentIds: string[],
  visibility?: 'public' | 'private',
): Promise<string> {
  const res = await http(t).post(`/api/workspaces/${workspaceId}/channels`, {
    title,
    member_agent_ids: memberAgentIds,
    ...(visibility === undefined ? {} : { visibility }),
  });
  const created = (await res.json()) as any;
  if (!created?.channel?.id) {
    throw new Error(`channel create failed (${res.status}): ${JSON.stringify(created)}`);
  }
  return created.channel.id as string;
}

interface Credential {
  conversationId: string;
  agentId: string;
}

/**
 * Every door that resolves an address, each shaped exactly as its client shapes
 * it, and each given a request that is valid in every respect EXCEPT the address.
 * That is what makes the matrix an argument: the only thing varying across a row
 * is which door serialized the refusal.
 */
const DOORS: ReadonlyArray<{
  label: string;
  call: (t: TestApp, credential: Credential, target: string) => Promise<Response>;
}> = [
  {
    label: 'message send',
    call: (t, cred, target) =>
      http(t).post(
        internalPaths.agentSendConversationMessage(cred.conversationId, cred.agentId),
        { content: 'hello', target },
      ),
  },
  {
    label: 'message history',
    call: (t, cred, target) =>
      http(t).post(internalPaths.agentReadHistory(cred.conversationId, cred.agentId), {
        target,
        limit: 10,
      }),
  },
  {
    label: 'task create',
    call: (t, cred, target) =>
      http(t).post(
        internalPaths.agentCreateConversationTasks(cred.conversationId, cred.agentId),
        { tasks: [{ title: 'a task' }], target },
      ),
  },
  {
    label: 'schedule create',
    call: (t, cred, target) =>
      http(t).post(internalPaths.agentScheduleCreate(cred.conversationId, cred.agentId), {
        title: 'wake',
        message: 'do the thing',
        spec: { kind: 'once', delay_seconds: 60 },
        target_conversation: target,
      }),
  },
  {
    label: 'channel create (fork source)',
    call: (t, cred, target) =>
      http(t).post(internalPaths.agentCreateChannel(cred.conversationId, cred.agentId), {
        title: 'forked',
        context_summary: 'split this out',
        initial_prompt: 'continue here',
        target,
      }),
  },
  {
    label: 'member add',
    call: (t, cred, target) =>
      http(t).post(
        internalPaths.agentAddConversationMember(cred.conversationId, cred.agentId),
        { handle: 'someone', target },
      ),
  },
  {
    label: 'file upload',
    call: async (t, cred, target) => {
      // The one door whose address rides in a multipart form beside the bytes.
      const form = new FormData();
      form.append('target', target);
      form.append('file', new Blob([Buffer.from('png')], { type: 'image/png' }), 'shot.png');
      return await t.app.fetch(
        new Request(
          `http://localhost${internalPaths.agentUploadAttachment(
            cred.conversationId,
            cred.agentId,
          )}`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${issueTestConversationRuntimeToken(
                t,
                cred.conversationId,
                cred.agentId,
              )}`,
            },
            body: form,
          },
        ),
      );
    },
  },
];

describe('a refused address is ONE answer at every door', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('answers unknown, unauthorized and archived with byte-identical bytes', async () => {
    const sink: Recorded[] = [];
    t = buildTestApp({ logger: capturingLogger(sink) });
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');

    // Where alice's credential lives. Three of the probes name streams in this
    // very workspace, so "not for you" cannot be mistaken for "not reachable
    // from here".
    const live = await makeWorkspace(t, 'live', [alice, bob]);
    // Exists, alice is not on its roster.
    const secret = await createChannel(t, live.workspaceId, 'secret', [bob], 'private');
    // Exists AND is discoverable — a public channel alice may legitimately see
    // listed elsewhere. Discovery is not addressability, and this is the probe
    // that would notice if the two were conflated.
    const open = await createChannel(t, live.workspaceId, 'open', [bob], 'public');
    // Archived, and it keeps its name key. Alice is NOT a member of it — every
    // probe in this list is an unauthorized one, which is the whole claim (see the
    // docblock).
    const sealed = await makeWorkspace(t, 'sealed', [bob]);
    const vault = await createChannel(t, sealed.workspaceId, 'vault', [bob]);
    expect(new WorkspaceRepo(t.ctx.db).setArchived(sealed.workspaceId, true)).not.toBeNull();

    const probes: ReadonlyArray<{ label: string; target: string }> = [
      { label: 'unknown title', target: '#live/no-such-room' },
      { label: 'unknown workspace', target: '#no-such-ws/vault' },
      { label: 'unknown id', target: `#conv:${MISSING_ID}` },
      { label: 'unauthorized by name', target: '#live/secret' },
      { label: 'unauthorized by id', target: `#conv:${secret}` },
      { label: 'public but unjoined', target: `#conv:${open}` },
      { label: 'unauthorized archived by name', target: '#sealed/vault' },
      { label: 'unauthorized archived by id', target: `#conv:${vault}` },
    ];

    const credential: Credential = { conversationId: live.channelId, agentId: alice };
    const answers = new Map<string, string>();
    for (const door of DOORS) {
      for (const probe of probes) {
        const res = await door.call(t, credential, probe.target);
        answers.set(`${door.label} / ${probe.label}`, `${res.status} ${await res.text()}`);
      }
    }

    // THE claim. Reported as the offending entries rather than as a set size, so a
    // failure names the door that started answering differently.
    const deviations = [...answers].filter(([, answer]) => answer !== THE_ONE_ANSWER);
    expect(deviations).toEqual([]);
    expect(answers.size).toBe(DOORS.length * probes.length);
  });

  /**
   * The positive control for the archived probes (@Cindy B3).
   *
   * The collapse above is about AUTHORIZATION, and an archived workspace must not
   * quietly turn into a second reason for the same answer. So a participant of a
   * stream in an archived workspace still resolves it — by id and by name, for a
   * read and for a write — and this test is what stops the collapse from being read
   * as "archived is unreachable".
   *
   * Recorded as it IS rather than as a lifecycle contract: nothing in the product
   * freezes writes to a live channel under an archived workspace today (an archived
   * CONVERSATION is frozen — `application/react-message.ts` — a workspace is not).
   * Whether it should be is a product decision nobody has taken, and P4
   * deliberately does not take it by answering `target_unresolved`; lifecycle is
   * not this layer's question (`application/delivery-target-resolution.ts`, rule 1).
   */
  it('keeps an archived workspace’s stream addressable for a participant, both ways', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const sealed = await makeWorkspace(t, 'sealed', [alice]);
    const vault = await createChannel(t, sealed.workspaceId, 'vault', [alice]);
    expect(new WorkspaceRepo(t.ctx.db).setArchived(sealed.workspaceId, true)).not.toBeNull();

    const credential: Credential = { conversationId: vault, agentId: alice };
    for (const target of [`#conv:${vault}`, '#sealed/vault']) {
      const read = await DOORS[1]!.call(t, credential, target);
      expect(`${read.status} ${await read.clone().text()}`, target).not.toBe(THE_ONE_ANSWER);
      expect(read.status, target).toBe(200);
      const write = await DOORS[0]!.call(t, credential, target);
      const body = await write.clone().text();
      expect(`${write.status} ${body}`, target).not.toBe(THE_ONE_ANSWER);
      expect(body, target).not.toContain('target_unresolved');
      expect(write.status, `${target}: ${body}`).toBeLessThan(400);
    }
  });

  it('keeps the branch — in the operator log, and only there', async () => {
    const sink: Recorded[] = [];
    t = buildTestApp({ logger: capturingLogger(sink) });
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const live = await makeWorkspace(t, 'live', [alice, bob]);
    const secret = await createChannel(t, live.workspaceId, 'secret', [bob], 'private');
    const credential: Credential = { conversationId: live.channelId, agentId: alice };

    // One probe per BRANCH this time: the point is that the operator can still
    // tell them apart, so the interesting number is how many distinct reasons the
    // log holds — not how many requests were made.
    const byProbe = new Map<string, string>();
    const bodies: string[] = [];
    for (const [label, target] of [
      ['title', '#live/no-such-room'],
      ['workspace', '#no-such-ws/vault'],
      ['id', `#conv:${MISSING_ID}`],
      ['participation', `#conv:${secret}`],
    ] as const) {
      sink.length = 0;
      const res = await DOORS[0]!.call(t, credential, target);
      bodies.push(await res.text());
      const lines = refusals(sink);
      // Exactly once per refusal: a port called twice would double every
      // operator's count, and one not called at all is the diagnosis-free
      // "collapse" this test exists to reject.
      expect(lines, label).toHaveLength(1);
      const line = lines[0]!;
      expect(line['code'], label).toBe('target_unresolved');
      // The address itself is never in the line — a refused address is routinely a
      // name the caller was not authorized to resolve, so the log carries a hash.
      expect(JSON.stringify(line), label).not.toContain('no-such');
      expect(String(line['address_hash'])).toMatch(/^sha256:[0-9a-f]{24}$/);
      byProbe.set(label, String(line['operator_reason']));
    }

    // The branch survives, and it is a branch: four probes, four reasons.
    expect(new Set(byProbe.values()).size).toBe(4);
    // …and not one of those reasons reached the actor. Asserted against the
    // bodies collected above rather than by re-reading the route, because "the
    // reason is not on the wire" is a property of what was SENT.
    for (const reason of byProbe.values()) {
      for (const body of bodies) expect(body).not.toContain(reason);
    }
    for (const body of bodies) {
      // The actor's object has one field beside the sentence. A widening — a
      // `reason`, a `detail`, an `existing` — is how the oracle comes back, so the
      // key set is asserted, not just the absence of today's field names.
      expect(Object.keys(JSON.parse(body) as object).sort()).toEqual(['code', 'error']);
    }
  });
});
