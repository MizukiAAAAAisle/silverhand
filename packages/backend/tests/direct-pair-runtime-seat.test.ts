/**
 * #task:2020 (P3) — @Cindy B3, round 2: an endpoint's RUNTIME SEAT in a
 * DirectPair, on the unified P2+P3 model.
 *
 * §4.2 gives a DirectPair NO roster: its two participants are the endpoint
 * columns, forever. A session is not participation, though — an agent running
 * "in" a DM has a process, a status, a resumable CLI session and a custody
 * generation, and every CONTROL PLANE is keyed on that: runtime switch must
 * clear it, bulk stop must stop it, teardown must capture it, session management
 * must be able to forget it. Before v75 those two facts could not both hold:
 * `agent_runtime_slots` had a composite FK to `conversation_agents` and its only
 * creation path was a roster INSERT, so a ConversationSlot on a rosterless
 * placement was neither representable nor creatable — and the only way to
 * fabricate one in a test was to insert the very roster row §4.2 forbids (the
 * contradiction that failed round 1).
 *
 * So this suite asserts the model as ONE thing, from the outside:
 *
 *   1. ZERO ROSTER, ALWAYS — at creation, while running, and through teardown.
 *      Every seat below is produced by the placement's own participation edge
 *      (the pair's INSERT), never by a membership write. `listAgents(pair)` is
 *      re-asserted at each stage rather than once, because "the fixture never
 *      wrote a roster row" is the property under test, not a setup detail.
 *   2. THE SEAT FACE IS THE SLOT TABLE, unjoined and coordinate-free, carrying
 *      generation + custody. A consumer cannot filter by a placement it cannot
 *      see, which is what makes the old INNER-JOIN drop unreachable by any
 *      future edit.
 *   3. AN AGENTSLOT IS ONE SEAT, NOT N. An agent-scoped agent participates in
 *      its inbox, its home DM and the pair, and still holds exactly one slot
 *      with no conversation. The DISPLAY face fans that one slot out over those
 *      participations on purpose; the control plane never does.
 *   4. THE CONTROL PLANES REACH THE DM SEAT THROUGH THEIR OWN ENTRY POINTS —
 *      the HTTP switch, the HTTP bulk stop, the teardown ports, the slot
 *      management face. The regression was one shared query, so four assertions
 *      on that query would have moved together and proved nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRepo } from '../src/repos/agent-repo.js';
import { ConversationRepo } from '../src/repos/conversation-repo.js';
import { RuntimeSlotRepo } from '../src/repos/runtime-slot-repo.js';
import { createSqliteAgentTeardownPersistence } from '../src/repos/agent-teardown-persistence.js';
import { buildTestApp, http, type TestApp } from './utils/app.js';

const NOW = 1_700_000_000_000;

interface Paired {
  readonly agentId: string;
  /** The agent-home DM created with the agent: a WORKSPACE placement, so it is
   *  the control group for every "the coordinate is null" assertion below.
   *  NULL for an agent-scoped agent, which builds no `agent_home` at all
   *  (§9.2) — so that arm's placement coverage is inbox + pair. */
  readonly homeDmId: string | null;
  /** The agent's inbox: the third placement arm, rosterless like the pair. */
  readonly inboxId: string;
  readonly pairId: string;
  readonly conversations: ConversationRepo;
  readonly runtimeSlots: RuntimeSlotRepo;
  readonly agents: AgentRepo;
}

/**
 * An agent in a DirectPair with the viewer, with NOTHING inserted into
 * `conversation_agents` for that pair.
 *
 * The seat exists because the pair's own INSERT created it (v75's
 * `conversations_create_direct_pair_runtime_slots`), which is the whole point:
 * the fixture cannot express a DM session as a membership write, so a future
 * regression that reties seats to the roster makes these seats disappear instead
 * of quietly passing.
 *
 * `scope` selects the agent the pair is opened with; the pair itself does not
 * branch on it (§4.1) and neither does this helper.
 */
async function paired(
  t: TestApp,
  name: string,
  scope: 'conversation' | 'agent' = 'conversation',
): Promise<Paired> {
  const created = (await (
    await http(t).post('/api/agents', {
      name,
      runtime: 'claude',
      session_scope: scope,
    })
  ).json()) as { agent: { id: string }; dm_channel_id: string | null };
  const agentId = created.agent.id;
  // Which placement arms this agent even HAS, stated up front: the inbox is
  // universal, the home DM exists only for a conversation-scoped agent (§9.2).
  // Asserted rather than assumed, because "two participations, one seat" and
  // "three participations, three seats" are different claims and the reader
  // must be able to tell which one each test is making.
  expect(created.dm_channel_id === null).toBe(scope === 'agent');
  const conversations = new ConversationRepo(t.ctx.db);
  const inbox = conversations.getAgentInbox(agentId);
  expect(inbox).not.toBeNull();
  const { conversation: pair, created: opened } =
    conversations.getOrCreateDirectPair(
      { kind: 'agent', id: agentId },
      { kind: 'human', id: t.viewerUserId },
      NOW,
    );
  expect(opened).toBe(true);
  // Stage 1 of the zero-roster claim: the pair was BORN without a roster row,
  // and the seat (if any) is already there.
  expect(conversations.listAgents(pair.id)).toEqual([]);
  t.fake.stops = [];
  t.fake.starts.length = 0;
  return {
    agentId,
    homeDmId: created.dm_channel_id,
    inboxId: inbox!.id,
    pairId: pair.id,
    conversations,
    runtimeSlots: new RuntimeSlotRepo(t.ctx.db),
    agents: new AgentRepo(t.ctx.db),
  };
}

/**
 * The home DM of a conversation-scoped agent as a non-null coordinate. Reading
 * it through an assertion keeps "this arm exists on this scope" a checked claim
 * at every use rather than a `!` that would quietly compare against `null`.
 */
function homeDmOf(f: Paired): string {
  expect(f.homeDmId).not.toBeNull();
  return f.homeDmId!;
}

/**
 * Make the pair's seat LIVE through the slot authority — the same face the
 * daemon's projection writes. No membership write is involved, so "running in a
 * DM" is expressible without contradicting §4.2.
 */
function runInPair(f: Paired, cliSessionId: string): void {
  const updated = f.runtimeSlots.updateCurrentProjection(
    { kind: 'conversation', conversationId: f.pairId, agentId: f.agentId },
    { status: 'active', pid: 4242, cliSessionId },
  );
  expect(updated).not.toBeNull();
  // Stage 2: still zero roster while the session is live.
  expect(f.conversations.listAgents(f.pairId)).toEqual([]);
}

describe('DirectPair runtime seat: the seat face', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('is born with the pair, with no roster row and no workspace coordinate', async () => {
    t = buildTestApp();
    const f = await paired(t, 'seat-face');
    runInPair(f, 'claude-session-in-a-dm');
    const homeDmId = homeDmOf(f);

    // ONE seat per participation, all three placement arms: the home DM
    // (workspace, via its roster edge), the inbox and the pair (rosterless, via
    // their own edges). The pair's seat is the one that was IMPOSSIBLE before.
    const seats = f.runtimeSlots.listSeats(f.agentId);
    expect(
      seats
        .map(seat =>
          seat.scope.kind === 'conversation' ? seat.scope.conversationId : null,
        )
        .sort(),
    ).toEqual([homeDmId, f.inboxId, f.pairId].sort());

    // The control DTO: identity IS the scope, and custody travels with it. A
    // seat that dropped `generation` would force every stop/clear to re-read the
    // slot and race its own decision.
    const pairSeat = seats.find(
      seat =>
        seat.scope.kind === 'conversation'
        && seat.scope.conversationId === f.pairId,
    );
    expect(pairSeat).toEqual({
      scope: {
        kind: 'conversation',
        conversationId: f.pairId,
        agentId: f.agentId,
      },
      status: 'active',
      pid: 4242,
      generation: 0,
      claimedByDaemonInstanceId: null,
      cliSessionId: 'claude-session-in-a-dm',
    });
    // …and there is no workspace field to be null: coordinate-free by
    // construction, so no consumer can filter this seat out of a control plane.
    expect(Object.keys(pairSeat!).sort()).toEqual([
      'claimedByDaemonInstanceId',
      'cliSessionId',
      'generation',
      'pid',
      'scope',
      'status',
    ]);

    // The DISPLAY face keeps the same unit and attaches coordinates. The DM row
    // is PRESENT with nulls rather than absent: an INNER JOIN here deleted the
    // row, and the renderer only reads `workspace_kind === 'agent_home'`, so a
    // null coordinate is a rendering question while a missing row is a lost
    // control.
    const shown = f.agents.listRuntimeConversations(f.agentId);
    expect(shown.find(row => row.conversation_id === f.pairId)).toMatchObject({
      conversation_id: f.pairId,
      channel_id: f.pairId,
      workspace_id: null,
      workspace_name: null,
      workspace_kind: null,
      status: 'active',
      pid: 4242,
    });
    // …and the workspace arm is unchanged, so the nullability is a property of
    // the placement rather than of the join having been loosened everywhere.
    expect(shown.find(row => row.conversation_id === homeDmId)).toMatchObject({
      workspace_kind: 'agent_home',
      status: 'idle',
    });
  });

  it('does not derive participation, and is not derived from membership writes', async () => {
    t = buildTestApp();
    const f = await paired(t, 'seat-not-participation');
    runInPair(f, 'claude-session-in-a-dm');

    // The endpoints are participants with no roster row anywhere.
    expect(f.conversations.isAgentParticipant(f.pairId, f.agentId)).toBe(true);
    expect(f.conversations.isAgentParticipant(f.inboxId, f.agentId)).toBe(true);

    // Membership writes are INERT on this placement, in both directions: the
    // pair's seat is owned by the endpoint edge, so a stray roster row cannot
    // mint a second seat (the unique index would not even allow it) and
    // removing one cannot take the real seat away. If the release trigger were
    // not placement-gated, this `removeAgent` would silently kill a live DM
    // session's seat and with it every control over that process.
    f.conversations.addAgent(f.pairId, f.agentId);
    f.conversations.removeAgent(f.pairId, f.agentId);
    expect(f.conversations.listAgents(f.pairId)).toEqual([]);
    expect(f.conversations.isAgentParticipant(f.pairId, f.agentId)).toBe(true);
    expect(
      f.runtimeSlots.get({
        kind: 'conversation',
        conversationId: f.pairId,
        agentId: f.agentId,
      }),
    ).toMatchObject({ observed_status: 'active', observed_pid: 4242 });

    // The workspace arm is the one where the roster IS the participation edge,
    // so there both go together — which is why the two triggers must agree on
    // whose seat the roster owns.
    const homeDmId = homeDmOf(f);
    f.conversations.removeAgent(homeDmId, f.agentId);
    expect(f.conversations.isAgentParticipant(homeDmId, f.agentId)).toBe(false);
    expect(
      f.runtimeSlots.get({
        kind: 'conversation',
        conversationId: homeDmId,
        agentId: f.agentId,
      }),
    ).toBeNull();
  });

  it('gives an agent-scoped agent ONE seat, not one per participation', async () => {
    t = buildTestApp();
    const f = await paired(t, 'seat-aggregate', 'agent');

    // Every placement arm this agent has — its inbox and the pair, both
    // rosterless; it builds no `agent_home` (§9.2), which is exactly why the
    // seat face must not be derived from the workspace arm's roster. Asserted so
    // the next line is a statement about seats and not about an agent that
    // happens to participate nowhere.
    for (const conversationId of [f.inboxId, f.pairId]) {
      expect(f.conversations.isAgentParticipant(conversationId, f.agentId))
        .toBe(true);
    }
    // ONE seat, no conversation. A participation-driven seat face would report
    // two here, and bulk stop would then stop the SAME process twice.
    expect(f.runtimeSlots.listSeats(f.agentId)).toEqual([
      {
        scope: { kind: 'agent', agentId: f.agentId },
        status: 'idle',
        pid: null,
        generation: 0,
        claimedByDaemonInstanceId: null,
        cliSessionId: null,
      },
    ]);

    // The DISPLAY face is deliberately the opposite shape: one row per
    // conversation the agent participates in, every row reporting that ONE
    // slot's status — which is true, because there is one process.
    f.runtimeSlots.updateCurrentProjection(
      { kind: 'agent', agentId: f.agentId },
      { status: 'active', pid: 777 },
    );
    const shown = f.agents.listRuntimeConversations(f.agentId);
    expect(shown.map(row => row.conversation_id).sort())
      .toEqual([f.inboxId, f.pairId].sort());
    expect(shown.every(row => row.status === 'active' && row.pid === 777))
      .toBe(true);
  });

  /**
   * @Cindy B12, round 3. `agent_runtime_events` is the history of RUNTIME
   * GENERATIONS, not of slot rows: every kind it records (`generation_claimed`,
   * `projection_updated`, `generation_finalized`) is something a claimed
   * generation did, and `slot_migrated` is v70's provenance for projection state
   * that arrived without a claim. A seat born by a placement trigger at
   * generation 0 has nothing of either sort to report, so the log starts at the
   * FIRST CLAIM — asserted here over all four birth paths at once, because the
   * alternative reading ("every slot has a birth event") would have been a
   * contract only the migration's own upgrade instant could satisfy.
   */
  it('starts its history at the first claim, not at birth — all four births', async () => {
    t = buildTestApp();
    const conv = await paired(t, 'seat-history');
    const agg = await paired(t, 'seat-history-aggregate', 'agent');

    // One entry per creation trigger: the workspace arm's roster edge, the
    // inbox, the pair, and the agent-scoped slot that belongs to no
    // conversation. Named rather than looped so a failure says WHICH birth
    // invented a history.
    const births = {
      workspace: conv.runtimeSlots.get({
        kind: 'conversation',
        conversationId: homeDmOf(conv),
        agentId: conv.agentId,
      }),
      inbox: conv.runtimeSlots.get({
        kind: 'conversation',
        conversationId: conv.inboxId,
        agentId: conv.agentId,
      }),
      pair: conv.runtimeSlots.get({
        kind: 'conversation',
        conversationId: conv.pairId,
        agentId: conv.agentId,
      }),
      agent: agg.runtimeSlots.get({ kind: 'agent', agentId: agg.agentId }),
    };
    for (const [arm, slot] of Object.entries(births)) {
      // The seat exists — otherwise "no events" would be vacuously true of a
      // slot that was never created.
      expect(slot, arm).toMatchObject({ generation: 0, observed_status: 'idle' });
      expect(conv.runtimeSlots.listEvents(slot!.id), arm).toEqual([]);
    }

    // The first claim is where the account begins, and it writes exactly one
    // row: a birth event would have made this two, and a reader of the log could
    // no longer tell "this seat has never run" from "this seat ran once".
    const claimed = conv.runtimeSlots.claimGeneration({
      scope: {
        kind: 'conversation',
        conversationId: conv.pairId,
        agentId: conv.agentId,
      },
      daemonInstanceId: 'daemon-dm',
      pid: 4242,
    });
    expect(claimed).toMatchObject({ id: births.pair!.id, generation: 1 });
    expect(
      conv.runtimeSlots
        .listEvents(births.pair!.id)
        .map(event => ({ kind: event.event_kind, generation: event.generation })),
    ).toEqual([{ kind: 'generation_claimed', generation: 1 }]);
    // …and the claim is local to the seat it named: the other three births are
    // still silent, so the log is keyed on the slot and not on the agent.
    for (const arm of ['workspace', 'inbox', 'agent'] as const) {
      expect(conv.runtimeSlots.listEvents(births[arm]!.id), arm).toEqual([]);
    }
  });
});

describe('DirectPair runtime seat: the control planes reach it', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('runtime switch clears the DM session and restarts it under the new runtime', async () => {
    t = buildTestApp();
    const f = await paired(t, 'seat-switch');
    runInPair(f, 'claude-session-in-a-dm');

    const res = await http(t).put(`/api/agents/${f.agentId}/runtime`, {
      runtime: 'codex',
      model: 'gpt-5-codex',
      reasoning_effort: 'high',
      fast_mode: true,
    });
    expect(res.status).toBe(200);
    // ONE cleared session and it is the DM's. Under the roster-driven face this
    // response said `cleared_sessions: 0` with a 200: the switch committed while
    // a session of the previous runtime kept running in a conversation nothing
    // could see.
    expect(await res.json()).toMatchObject({
      cleared_sessions: 1,
      restarted_conversations: 1,
      restart_failures: 0,
    });
    expect(t.fake.clearedSessions).toEqual([
      {
        scope: {
          kind: 'conversation',
          conversationId: f.pairId,
          agentId: f.agentId,
        },
        actorUserId: t.viewerUserId,
      },
    ]);
    // Live-before means resume-after: the session comes back in the SAME DM.
    expect(t.fake.starts).toEqual([
      { conversationId: f.pairId, agentId: f.agentId },
    ]);
    expect(f.conversations.listAgents(f.pairId)).toEqual([]);
  });

  it('clears one live AgentSlot and restarts it without inventing per-conversation ownership', async () => {
    t = buildTestApp();
    const f = await paired(t, 'seat-switch-aggregate', 'agent');
    f.runtimeSlots.updateCurrentProjection(
      { kind: 'agent', agentId: f.agentId },
      { status: 'active', pid: 777, cliSessionId: 'claude-aggregate-session' },
    );
    t.fake.clearSessionResult = {
      prevCliSessionId: 'claude-aggregate-session',
      wasRunning: true,
      focusConversationId: f.pairId,
    };

    const res = await http(t).put(`/api/agents/${f.agentId}/runtime`, {
      runtime: 'codex',
      model: 'gpt-5-codex',
      reasoning_effort: 'high',
      fast_mode: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      cleared_sessions: 1,
      restarted_conversations: 1,
      restart_failures: 0,
    });
    expect(t.fake.clearedSessions).toEqual([{
      scope: { kind: 'agent', agentId: f.agentId },
      actorUserId: t.viewerUserId,
    }]);
    expect(t.fake.starts).toEqual([{
      conversationId: f.pairId,
      agentId: f.agentId,
    }]);
    // The runtime changed, while the slot remains one aggregate seat and the
    // DirectPair remains rosterless.
    expect(f.agents.getRow(f.agentId)).toMatchObject({
      runtime: 'codex',
      runtime_transition_target: null,
    });
    expect(f.runtimeSlots.listSeats(f.agentId)).toHaveLength(1);
    expect(f.runtimeSlots.listSeats(f.agentId)[0]?.scope).toEqual({
      kind: 'agent',
      agentId: f.agentId,
    });
    expect(f.conversations.listAgents(f.pairId)).toEqual([]);
  });

  it('bulk stop stops the DM session, once', async () => {
    t = buildTestApp();
    const f = await paired(t, 'seat-stop');
    runInPair(f, 'claude-session-in-a-dm');

    const res = await http(t).post(`/api/agents/${f.agentId}/stop`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopped: 1 });
    // Exactly one stop: the agent participates in three conversations and has
    // one live session. A face that fanned out over participation would stop the
    // same process repeatedly — harmless-looking here, and wrong the moment one
    // session legitimately serves several conversations.
    expect(t.fake.stops).toMatchObject([
      { conversationId: f.pairId, agentId: f.agentId },
    ]);
  });

  it('session management forgets the DM session without touching custody or membership', async () => {
    t = buildTestApp();
    const f = await paired(t, 'seat-management');
    runInPair(f, 'claude-session-in-a-dm');

    const scope = {
      kind: 'conversation' as const,
      conversationId: f.pairId,
      agentId: f.agentId,
    };
    const cleared = f.runtimeSlots.clearCliSession({
      scope,
      expectedGeneration: f.runtimeSlots.get(scope)!.generation,
    });
    // The management face is not a runtime projection: the resumable session is
    // gone, while status / pid / generation / custody are untouched. Before v75
    // there was no row here to clear, so a DM's `--resume` handle was
    // unforgettable.
    expect(cleared).toMatchObject({
      cli_session_id: null,
      observed_status: 'active',
      observed_pid: 4242,
      generation: 0,
    });
    expect(f.conversations.listAgents(f.pairId)).toEqual([]);
  });

  it('teardown captures the DM session through both of its faces', async () => {
    t = buildTestApp();
    const f = await paired(t, 'seat-teardown');
    runInPair(f, 'claude-session-in-a-dm');
    const teardown = createSqliteAgentTeardownPersistence(t.ctx.db);

    const pairSession = {
      runtimeScope: {
        kind: 'conversation',
        conversationId: f.pairId,
        agentId: f.agentId,
      },
      conversationId: f.pairId,
      status: 'active',
      runtimeGeneration: 0,
    };
    // The pre-flight read (eligibility: "is anything still running?") …
    expect(teardown.read.listRuntimeSessions(f.agentId)).toEqual(
      expect.arrayContaining([pairSession]),
    );
    // … and the in-transaction capture, which is the ONLY record that survives
    // the row's deletion: the post-commit catch-up stops what this array named.
    // A DM session missing here is an agent process that outlives its agent with
    // no coordinate left to stop it by.
    const captured = teardown.uow.atomicallyForAgent({ agentId: f.agentId }, tx => {
      const capture = tx.agent.capture();
      tx.agent.deleteAgentRow();
      return capture;
    });
    expect(captured.runtimeSessions).toEqual(
      expect.arrayContaining([pairSession]),
    );
    // Stage 3 of the zero-roster claim, and the cascade: the agent is gone, so
    // its seats are gone, and the pair still never held a roster row.
    expect(f.runtimeSlots.listSeats(f.agentId)).toEqual([]);
    expect(f.conversations.listAgents(f.pairId)).toEqual([]);
  });

  it('the runtime-state read surface shows the DM seat in both scopes', async () => {
    t = buildTestApp();
    const f = await paired(t, 'seat-runtime-state');
    runInPair(f, 'claude-session-in-a-dm');

    const res = await http(t).get(`/api/agents/${f.agentId}/runtime-state`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversation_agents: Array<{ conversation_id: string }>;
      visible_conversation_agents: Array<{ conversation_id: string }>;
    };
    // Both scopes: the complete control view AND the display roster. The Stop
    // button's membership gate reads the first, so a DM seat missing from it
    // makes a running session unstoppable from the UI even after the API can
    // reach it.
    expect(body.conversation_agents.map(r => r.conversation_id)).toContain(f.pairId);
    expect(body.visible_conversation_agents.map(r => r.conversation_id)).toContain(
      f.pairId,
    );
  });
});
