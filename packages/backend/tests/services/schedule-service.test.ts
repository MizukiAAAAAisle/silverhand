import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SCHEDULE_MAX_ACTIVE_PER_AGENT,
  SCHEDULE_MIN_DELAY_SECONDS,
  type ScheduleCreateInput,
  type ScheduleDto,
  readScheduleFireMetadata,
} from '@silverhand/shared';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { ScheduleRepo } from '../../src/repos/schedule-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import {
  ScheduleError,
  ScheduleService,
  type ScheduleServiceOptions,
} from '../../src/services/schedule-service.js';
import type { BackendLogger } from '../../src/context.js';
import type { AgentRuntimeHost } from '../../src/runtime/agent-runtime-host.js';
import { ScopeEventBus } from '../../src/ws/scope-event-bus.js';
import { makeTempSilverhandDir, openTestDb } from '../utils/db.js';
import { ConversationReadRepo } from '../../src/repos/conversation-read-repo.js';

class FakeConversationManager {
  starts: Array<{ conversationId: string; agentId: string }> = [];
  delivered: Array<{
    conversationId: string;
    agentId: string;
    messageId: string;
  }> = [];
  deliverError: Error | null = null;

  async start(conversationId: string, agentId: string): Promise<void> {
    this.starts.push({ conversationId, agentId });
  }

  async deliverMessage(
    conversationId: string,
    agentId: string,
    messageId: string,
  ): Promise<void> {
    if (this.deliverError) throw this.deliverError;
    this.delivered.push({ conversationId, agentId, messageId });
  }
}

interface Fixture {
  service: ScheduleService;
  schedules: ScheduleRepo;
  agents: AgentRepo;
  workspaces: WorkspaceRepo;
  messages: MessageRepo;
  conversations: ConversationRepo;
  db: ReturnType<typeof openTestDb>['db'];
  events: ScopeEventBus;
  fake: FakeConversationManager;
  ownerAgentId: string;
  otherAgentId: string;
  homeDmId: string;
  localHostId: string;
  setNow: (ts: number) => void;
  cleanup: () => void;
}

let currentNow = 0;

function bootstrap(
  capChecker: (
    agentId: string,
    workspaceId: string,
    capability: string,
  ) => boolean = () => true,
): Fixture {
  const { db, localHostId } = openTestDb();
  const tmp = makeTempSilverhandDir();
  const hosts = new HostRepo(db);
  hosts.ensureLocal();
  const agents = new AgentRepo(db);
  const workspaces = new WorkspaceRepo(db);
  const conversations = new ConversationRepo(db);
  const messages = new MessageRepo(db);
  const schedules = new ScheduleRepo(db);
  const events = new ScopeEventBus('test-epoch');
  const fake = new FakeConversationManager();
  const logger: BackendLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  // Owner + a second agent for permission-boundary tests.
  const owner = agents.create(
    { name: 'alice', runtime: 'claude' },
    localHostId,
    'local',
  );
  const other = agents.create(
    { name: 'bob', runtime: 'claude' },
    localHostId,
    'local',
  );

  // Provision agent_home + dm_channel for the owner. Tests need this so
  // the wake delivery has a real target.
  const home = workspaces.insertAgentHome({
    agent: owner,
  });
  const dm = conversations.insertDmChannel({
    workspaceId: home.id,
    title: `dm-${owner.name}`,
  });
  conversations.addAgent(dm.id, owner.id);

  // bob has no agent_home so we can test the agent_home_not_found path.

  currentNow = 1_700_000_000_000;
  const setNow = (ts: number) => {
    currentNow = ts;
  };

  const service = new ScheduleService({
    schedules,
    workspaces,
    conversations,
    conversationReads: new ConversationReadRepo(db),
    messages,
    agents,
    runtimeHost: fake as unknown as AgentRuntimeHost,
    events,
    logger,
    now: () => currentNow,
    canUseCapability: capChecker as unknown as ScheduleServiceOptions['canUseCapability'],
    disableAutoTick: true,
  });

  return {
    service,
    schedules,
    agents,
    workspaces,
    messages,
    conversations,
    db,
    events,
    fake,
    ownerAgentId: owner.id,
    otherAgentId: other.id,
    homeDmId: dm.id,
    localHostId,
    setNow,
    cleanup: tmp.cleanup,
  };
}

let fixturesToCleanup: Fixture[] = [];
function setup(): Fixture {
  const f = bootstrap();
  fixturesToCleanup.push(f);
  return f;
}

function setupWithCap(
  capChecker: (agentId: string, workspaceId: string, capability: string) => boolean,
): Fixture {
  const f = bootstrap(capChecker);
  fixturesToCleanup.push(f);
  return f;
}

afterEach(() => {
  for (const f of fixturesToCleanup) f.cleanup();
  fixturesToCleanup = [];
});

describe('ScheduleService.create', () => {
  it('canonicalizes once delay_seconds → fire_at and sets next_fire_at', () => {
    const f = setup();
    const created = f.service.create(
      {
        title: 'Build check',
        message: 'check the build',
        spec: { kind: 'once', delay_seconds: 60 },
      },
      f.ownerAgentId,
      f.homeDmId,
    );
    expect(created.spec.kind).toBe('once');
    if (created.spec.kind === 'once') {
      expect(created.spec.fire_at).toBe(currentNow + 60_000);
    }
    expect(created.next_fire_at).toBe(currentNow + 60_000);
    expect(created.status).toBe('pending');
    expect(created.fired_count).toBe(0);
    expect(created.title).toBe('Build check');
  });

  it('rejects once when both fire_at and delay_seconds are missing', () => {
    const f = setup();
    expect(() =>
      f.service.create(
        { title: 'Test schedule', message: 'm', spec: { kind: 'once' } as ScheduleCreateInput['spec'] },
        f.ownerAgentId,
        f.homeDmId,
      ),
    ).toThrow(ScheduleError);
  });

  it('rejects once that fires sooner than the min delay', () => {
    const f = setup();
    let err: ScheduleError | undefined;
    try {
      f.service.create(
        {
          title: 'Test schedule',
          message: 'm',
          spec: { kind: 'once', delay_seconds: SCHEDULE_MIN_DELAY_SECONDS - 1 },
        },
        f.ownerAgentId,
        f.homeDmId,
      );
    } catch (e) {
      err = e as ScheduleError;
    }
    expect(err?.code).toBe('fire_at_too_soon');
  });

  it('rejects once that fires further than the max delay', () => {
    const f = setup();
    let err: ScheduleError | undefined;
    try {
      f.service.create(
        {
          title: 'Test schedule',
          message: 'm',
          spec: {
            kind: 'once',
            fire_at: currentNow + 91 * 24 * 60 * 60 * 1000,
          },
        },
        f.ownerAgentId,
        f.homeDmId,
      );
    } catch (e) {
      err = e as ScheduleError;
    }
    expect(err?.code).toBe('fire_at_too_far');
  });

  it('rejects unbounded interval without explicit allow_unbounded', () => {
    const f = setup();
    let err: ScheduleError | undefined;
    try {
      f.service.create(
        {
          title: 'Test schedule',
          message: 'm',
          spec: { kind: 'interval', every_seconds: 60 },
        },
        f.ownerAgentId,
        f.homeDmId,
      );
    } catch (e) {
      err = e as ScheduleError;
    }
    expect(err?.code).toBe('unbounded_repeat_requires_explicit_limit');
  });

  it('accepts interval with allow_unbounded=true', () => {
    const f = setup();
    const created = f.service.create(
      {
        title: 'Test schedule',
        message: 'poll every minute',
        spec: { kind: 'interval', every_seconds: 60 },
        allow_unbounded: true,
      },
      f.ownerAgentId,
      f.homeDmId,
    );
    expect(created.spec.kind).toBe('interval');
    expect(created.next_fire_at).toBe(currentNow + 60_000);
  });

  it('accepts interval bounded by max_occurrences', () => {
    const f = setup();
    const created = f.service.create(
      {
        title: 'Test schedule',
        message: 'three checks',
        spec: { kind: 'interval', every_seconds: 60 },
        max_occurrences: 3,
      },
      f.ownerAgentId,
      f.homeDmId,
    );
    expect(created.max_occurrences).toBe(3);
  });

  it('rejects invalid cron expression', () => {
    const f = setup();
    let err: ScheduleError | undefined;
    try {
      f.service.create(
        {
          title: 'Test schedule',
          message: 'm',
          spec: {
            kind: 'cron',
            expression: 'definitely not cron',
            timezone: 'UTC',
          },
          max_occurrences: 5,
        },
        f.ownerAgentId,
        f.homeDmId,
      );
    } catch (e) {
      err = e as ScheduleError;
    }
    expect(err?.code).toBe('invalid_cron_expression');
  });

  it('rejects invalid IANA timezone', () => {
    const f = setup();
    let err: ScheduleError | undefined;
    try {
      f.service.create(
        {
          title: 'Test schedule',
          message: 'm',
          spec: {
            kind: 'cron',
            expression: '0 9 * * *',
            timezone: 'Mars/Olympus_Mons',
          },
          max_occurrences: 5,
        },
        f.ownerAgentId,
        f.homeDmId,
      );
    } catch (e) {
      err = e as ScheduleError;
    }
    expect(err?.code).toBe('invalid_timezone');
  });

  it('computes next_fire_at for cron in the given timezone', () => {
    const f = setup();
    // Fix "now" to 2024-03-09 12:00:00 UTC; with NYC (UTC-5 standard
    // time, before DST starts on 03-10 at 02:00 local), 09:00 NYC =
    // 14:00 UTC. So the next "9am NYC" occurrence after 12:00 UTC is
    // the same calendar day at 14:00 UTC.
    const fixedNow = Date.UTC(2024, 2, 9, 12, 0, 0); // 2024-03-09T12:00:00Z
    f.setNow(fixedNow);
    const created = f.service.create(
      {
        title: 'Test schedule',
        message: 'daily 9am NYC',
        spec: {
          kind: 'cron',
          expression: '0 9 * * *',
          timezone: 'America/New_York',
        },
        allow_unbounded: true,
      },
      f.ownerAgentId,
      f.homeDmId,
    );
    expect(created.next_fire_at).toBe(Date.UTC(2024, 2, 9, 14, 0, 0));
  });

  it('rejects when owner agent does not exist', () => {
    const f = setup();
    let err: ScheduleError | undefined;
    try {
      f.service.create(
        { title: 'Test schedule', message: 'm', spec: { kind: 'once', delay_seconds: 60 } },
        'nonexistent',
        f.homeDmId,
      );
    } catch (e) {
      err = e as ScheduleError;
    }
    expect(err?.code).toBe('agent_not_found');
  });

  it('rejects when owner has no agent_home dm_channel', () => {
    const f = setup();
    let err: ScheduleError | undefined;
    try {
      f.service.create(
        { title: 'Test schedule', message: 'm', spec: { kind: 'once', delay_seconds: 60 } },
        f.otherAgentId,
        f.homeDmId,
      );
    } catch (e) {
      err = e as ScheduleError;
    }
    expect(err?.code).toBe('agent_home_not_found');
  });

  // ── target_conversation_id (#task:478) ────────────────────────────
  // The schedule's "target" is the conversation whose
  // (conversation, owner_agent) runtime wakes up on each fire — that
  // runtime owns the full lifecycle: receive wake → produce work →
  // post result, all in its own context. Splitting the fire-target
  // from the execution-target would re-introduce the original bug
  // (target-Alice has no memory of authoring the report posted under
  // her name); therefore there is intentionally no `report_target_id`
  // and no fan-out from one session to another.

  it('defaults target_conversation_id to the calling conversation', () => {
    const f = setup();
    const created = f.service.create(
      { title: 'Test schedule', message: 'm', spec: { kind: 'once', delay_seconds: 60 } },
      f.ownerAgentId,
      f.homeDmId,
    );
    // Default = the calling conversation (here: agent_home DM, mirroring
    // the legacy hardcoded fire target so existing tests don't change
    // semantics). When the agent calls from a channel, this would be
    // the channel id.
    expect(created.target_conversation_id).toBe(f.homeDmId);
  });

  it('accepts an explicit target_conversation_id when the owner is a member', () => {
    const f = setup();
    // Provision a regular workspace + channel that the owner joins.
    const ws = f.workspaces.insert({
      name: 'team',
      description: null,
    });
    const channel = f.conversations.insertChannel({
      workspaceId: ws.id,
      title: 'general',
    });
    f.conversations.addAgent(channel.id, f.ownerAgentId);

    const created = f.service.create(
      {
        title: 'Channel cron',
        message: 'fire in the channel',
        target_conversation_id: channel.id,
        spec: { kind: 'once', delay_seconds: 60 },
      },
      f.ownerAgentId,
      f.homeDmId,
    );
    expect(created.target_conversation_id).toBe(channel.id);
  });

  it('projects target_label as `#title` for a regular channel', () => {
    // PR-2 of #task:479: target_label is server-side derived from the
    // joined conversation row so the agent panel (and any other
    // schedule consumer) can show "→ #release" without a per-row
    // /conversations/:id/ref fan-out, AND so the ACL stays single-
    // boundary (the schedule list authorizes; label is part of the
    // schedule's own semantics, not a leaked target metadata
    // projection). Format spec: '#<title>'.
    const f = setup();
    const ws = f.workspaces.insert({
      name: 'team',
      description: null,
    });
    const channel = f.conversations.insertChannel({
      workspaceId: ws.id,
      title: 'release',
    });
    f.conversations.addAgent(channel.id, f.ownerAgentId);

    const created = f.service.create(
      {
        title: 'Channel cron',
        message: 'fire',
        target_conversation_id: channel.id,
        spec: { kind: 'once', delay_seconds: 60 },
      },
      f.ownerAgentId,
      f.homeDmId,
    );
    expect(created.target_label).toBe('#release');
  });

  it('projects target_label as `@title` for a DM channel target', () => {
    // DM channels are addressed with `@` to mirror the inline `@<handle>`
    // mention sigil and distinguish them from `#` channels at a glance.
    const f = setup();
    // The setup helper provisions homeDmId — an agent_home DM — so we
    // reuse it as the target rather than creating another DM workspace.
    const created = f.service.create(
      {
        title: 'DM cron',
        message: 'fire here',
        target_conversation_id: f.homeDmId,
        spec: { kind: 'once', delay_seconds: 60 },
      },
      f.ownerAgentId,
      f.homeDmId,
    );
    // The agent_home DM's title was set at provisioning; we don't
    // assert the exact suffix because that's seeding territory, only
    // that the prefix marks it as a DM.
    expect(created.target_label.startsWith('@')).toBe(true);
  });

  it('rejects when target_conversation_id does not exist', () => {
    const f = setup();
    let err: ScheduleError | undefined;
    try {
      f.service.create(
        {
          title: 'Test schedule',
          message: 'm',
          target_conversation_id: 'no-such-conv',
          spec: { kind: 'once', delay_seconds: 60 },
        },
        f.ownerAgentId,
        f.homeDmId,
      );
    } catch (e) {
      err = e as ScheduleError;
    }
    expect(err?.code).toBe('target_conversation_not_found');
  });

  it('rejects when target conversation is closed', () => {
    const f = setup();
    const ws = f.workspaces.insert({
      name: 'team',
      description: null,
    });
    const channel = f.conversations.insertChannel({
      workspaceId: ws.id,
      title: 'closed-room',
    });
    f.conversations.addAgent(channel.id, f.ownerAgentId);
    // Mark the channel closed via the conversation lifecycle setter.
    f.conversations.close(channel.id, 'closed for test');

    let err: ScheduleError | undefined;
    try {
      f.service.create(
        {
          title: 'Test schedule',
          message: 'm',
          target_conversation_id: channel.id,
          spec: { kind: 'once', delay_seconds: 60 },
        },
        f.ownerAgentId,
        f.homeDmId,
      );
    } catch (e) {
      err = e as ScheduleError;
    }
    expect(err?.code).toBe('target_conversation_closed');
  });

  it('rejects when owner is not a member of target conversation', () => {
    const f = setup();
    const ws = f.workspaces.insert({
      name: 'team',
      description: null,
    });
    const channel = f.conversations.insertChannel({
      workspaceId: ws.id,
      title: 'no-entry',
    });
    // Note: ownerAgentId NOT added as a member.

    let err: ScheduleError | undefined;
    try {
      f.service.create(
        {
          title: 'Test schedule',
          message: 'm',
          target_conversation_id: channel.id,
          spec: { kind: 'once', delay_seconds: 60 },
        },
        f.ownerAgentId,
        f.homeDmId,
      );
    } catch (e) {
      err = e as ScheduleError;
    }
    expect(err?.code).toBe('agent_not_in_target_conversation');
  });

  it('enforces per-agent active quota', () => {
    const f = setup();
    for (let i = 0; i < SCHEDULE_MAX_ACTIVE_PER_AGENT; i++) {
      f.service.create(
        {
          title: 'Test schedule',
          message: `m${i}`,
          spec: { kind: 'once', delay_seconds: 60 + i },
        },
        f.ownerAgentId,
        f.homeDmId,
      );
    }
    let err: ScheduleError | undefined;
    try {
      f.service.create(
        { title: 'Test schedule', message: 'overflow', spec: { kind: 'once', delay_seconds: 9999 } },
        f.ownerAgentId,
        f.homeDmId,
      );
    } catch (e) {
      err = e as ScheduleError;
    }
    expect(err?.code).toBe('too_many_active_schedules');
  });

  it('rejects until_at that precedes the first fire', () => {
    const f = setup();
    let err: ScheduleError | undefined;
    try {
      f.service.create(
        {
          title: 'Test schedule',
          message: 'm',
          spec: { kind: 'interval', every_seconds: 600 },
          until_at: currentNow + 60_000, // before first fire (currentNow + 600_000)
        },
        f.ownerAgentId,
        f.homeDmId,
      );
    } catch (e) {
      err = e as ScheduleError;
    }
    expect(err?.code).toBe('invalid_input');
  });

  // Once-spec strict-reject for repeat-only knobs. Silent-ignoring would
  // surface a non-canonical DTO (e.g. `max_occurrences=3` on a row that
  // can only ever fire once); reject at the input-schema layer so the
  // contract stays "those fields exist on repeat specs only".
  it.each(['max_occurrences', 'until_at', 'allow_unbounded'] as const)(
    'rejects once spec carrying repeat-only field %s',
    field => {
      const f = setup();
      const input: ScheduleCreateInput = {
        title: 'Test schedule',
        message: 'm',
        spec: { kind: 'once', delay_seconds: 600 },
      };
      if (field === 'max_occurrences') {
        (input as { max_occurrences?: number }).max_occurrences = 3;
      } else if (field === 'until_at') {
        (input as { until_at?: number }).until_at = currentNow + 24 * 60 * 60 * 1000;
      } else {
        (input as { allow_unbounded?: boolean }).allow_unbounded = true;
      }
      let err: ScheduleError | undefined;
      try {
        f.service.create(input, f.ownerAgentId, f.homeDmId);
      } catch (e) {
        err = e as ScheduleError;
      }
      expect(err?.code).toBe('invalid_input');
    },
  );
});

describe('ScheduleService.list', () => {
  it('filters by status with active alias expanding to pending|firing', async () => {
    const f = setup();
    const due = f.service.create(
      { title: 'Test schedule', message: 'soon', spec: { kind: 'once', delay_seconds: 60 } },
      f.ownerAgentId,
      f.homeDmId,
    );
    const later = f.service.create(
      { title: 'Test schedule', message: 'later', spec: { kind: 'once', delay_seconds: 600 } },
      f.ownerAgentId,
      f.homeDmId,
    );
    // Cancel one to verify it's filtered out by status='active'.
    f.service.cancel(later.id, f.ownerAgentId);

    const active = f.service.list(f.ownerAgentId, 'active', undefined);
    expect(active.map(s => s.id)).toEqual([due.id]);

    const all = f.service.list(f.ownerAgentId, 'all', undefined);
    expect(all.length).toBe(2);
  });

  it('returns schedules owned by the agent only', () => {
    const f = setup();
    const mine = f.service.create(
      { title: 'Test schedule', message: 'mine', spec: { kind: 'once', delay_seconds: 60 } },
      f.ownerAgentId,
      f.homeDmId,
    );
    // bob has no agent_home so we can't service.create for him; insert
    // directly via repo to fake a stray row that our list must ignore.
    // Pass an arbitrary target_conversation_id — list filters by owner,
    // not by target, so the value doesn't matter for this test.
    f.schedules.insert({
      ownerAgentId: f.otherAgentId,
      targetConversationId: 'unused-target',
      title: 'Test schedule',
      message: 'theirs',
      spec: { kind: 'once', fire_at: currentNow + 60_000 },
      nextFireAt: currentNow + 60_000,
    });
    const list = f.service.list(f.ownerAgentId, undefined, undefined);
    expect(list.map(s => s.id)).toEqual([mine.id]);
  });
});

describe('ScheduleService.cancel', () => {
  it('cancels a pending schedule when called by owner', () => {
    const f = setup();
    const s = f.service.create(
      { title: 'Test schedule', message: 'm', spec: { kind: 'once', delay_seconds: 60 } },
      f.ownerAgentId,
      f.homeDmId,
    );
    const after = f.service.cancel(s.id, f.ownerAgentId);
    expect(after.status).toBe('cancelled');
    expect(after.cancelled_at).not.toBeNull();
  });

  it('rejects cancel from a non-owner agent', () => {
    const f = setup();
    const s = f.service.create(
      { title: 'Test schedule', message: 'm', spec: { kind: 'once', delay_seconds: 60 } },
      f.ownerAgentId,
      f.homeDmId,
    );
    let err: ScheduleError | undefined;
    try {
      f.service.cancel(s.id, f.otherAgentId);
    } catch (e) {
      err = e as ScheduleError;
    }
    expect(err?.code).toBe('not_owner');
    expect(f.schedules.get(s.id)?.status).toBe('pending');
  });

  it('rejects cancel when schedule already done', async () => {
    const f = setup();
    const s = f.service.create(
      { title: 'Test schedule', message: 'm', spec: { kind: 'once', delay_seconds: 60 } },
      f.ownerAgentId,
      f.homeDmId,
    );
    f.setNow(currentNow + 70_000);
    await f.service.tick();
    expect(f.schedules.get(s.id)?.status).toBe('done');
    let err: ScheduleError | undefined;
    try {
      f.service.cancel(s.id, f.ownerAgentId);
    } catch (e) {
      err = e as ScheduleError;
    }
    expect(err?.code).toBe('not_cancellable');
  });
});

describe('ScheduleService — manage_schedules capability gate (graded-permissions cut 2)', () => {
  it('create denied → typed capability_denied/manage_schedules', () => {
    const f = setupWithCap(() => false);
    let err: ScheduleError | undefined;
    try {
      f.service.create(
        { title: 'wake', message: 'm', spec: { kind: 'once', delay_seconds: 60 } },
        f.ownerAgentId,
        f.homeDmId,
      );
    } catch (e) {
      err = e as ScheduleError;
    }
    expect(err?.code).toBe('capability_denied');
    expect(err?.capability).toBe('manage_schedules');
  });

  it('cancel denied → typed capability_denied/manage_schedules', () => {
    // Live closure: allow create, then deny manage_schedules before cancel.
    let deny = false;
    const f = setupWithCap(() => !deny);
    const s = f.service.create(
      { title: 'wake', message: 'm', spec: { kind: 'once', delay_seconds: 60 } },
      f.ownerAgentId,
      f.homeDmId,
    );
    deny = true;
    let err: ScheduleError | undefined;
    try {
      f.service.cancel(s.id, f.ownerAgentId);
    } catch (e) {
      err = e as ScheduleError;
    }
    expect(err?.code).toBe('capability_denied');
    expect(err?.capability).toBe('manage_schedules');
    // Not cancelled — the gate fired before the state change.
    expect(f.schedules.get(s.id)?.status).toBe('pending');
  });
});

describe('ScheduleService.tick — fire & advance', () => {
  it('one-shot fires once then transitions to done', async () => {
    const f = setup();
    const s = f.service.create(
      { title: 'Test schedule', message: 'follow up', spec: { kind: 'once', delay_seconds: 60 } },
      f.ownerAgentId,
      f.homeDmId,
    );
    f.setNow(currentNow + 60_000);
    await f.service.tick();
    const after = f.schedules.get(s.id);
    expect(after?.status).toBe('done');
    expect(after?.fired_count).toBe(1);
    expect(f.fake.delivered.length).toBe(1);
    expect(f.fake.delivered[0]?.conversationId).toBe(f.homeDmId);
    expect(f.fake.delivered[0]?.agentId).toBe(f.ownerAgentId);
  });

  it('wake message lands in agent_home dm_channel with imperative body', async () => {
    const f = setup();
    f.service.create(
      {
        title: 'Deploy review',
        message: 'review the deploy',
        spec: { kind: 'once', delay_seconds: 60 },
      },
      f.ownerAgentId,
      f.homeDmId,
    );
    f.setNow(currentNow + 60_000);
    await f.service.tick();
    const messageId = f.fake.delivered[0]?.messageId;
    expect(messageId).toBeDefined();
    const msg = f.messages.getById(messageId!);
    expect(msg?.from_kind).toBe('system');
    expect(msg?.content).toContain('Schedule fired');
    expect(msg?.content).toContain('review the deploy');
    expect(msg?.content).toContain('"noted, no action"');
    // Renderer/reviewer can identify reminder messages by metadata
    // subtype — keep this stable so future filtering works.
    const meta = msg?.metadata as Record<string, unknown> | null;
    expect(meta?.subtype).toBe('schedule_fire');

    // Producer-side schema round-trip — every wake's metadata must
    // satisfy `ScheduleFireMetadataSchema` so renderers can rely on
    // the structured fields without re-parsing message.content.
    const parsed = readScheduleFireMetadata(meta);
    expect(parsed).not.toBeNull();
    expect(parsed!.spec_kind).toBe('once');
    expect(parsed!.spec_summary).toBe('once');
    expect(parsed!.title).toBe('Deploy review');
    expect(parsed!.body).toBe('review the deploy');
    expect(parsed!.missed_count).toBe(0);
    expect(typeof parsed!.actual_fire_at).toBe('number');
  });

  it('cron wake metadata embeds the timezone in spec_summary', async () => {
    // Cron expressions resolve to different wall-clock times across
    // zones, so the renderer banner needs the timezone next to the
    // expression. Pin the producer here so it never silently drops.
    const f = setup();
    const fixedNow = Date.UTC(2024, 2, 9, 12, 0, 0);
    f.setNow(fixedNow);
    f.service.create(
      {
        title: 'Test schedule',
        message: 'daily 9am NYC reminder',
        spec: {
          kind: 'cron',
          expression: '0 9 * * *',
          timezone: 'America/New_York',
        },
        allow_unbounded: true,
      },
      f.ownerAgentId,
      f.homeDmId,
    );
    f.setNow(Date.UTC(2024, 2, 9, 14, 0, 0));
    await f.service.tick();
    const messageId = f.fake.delivered[0]?.messageId;
    expect(messageId).toBeDefined();
    const msg = f.messages.getById(messageId!);
    const meta = msg?.metadata as Record<string, unknown> | null;
    const parsed = readScheduleFireMetadata(meta);
    expect(parsed).not.toBeNull();
    expect(parsed!.spec_kind).toBe('cron');
    expect(parsed!.spec_summary).toBe('cron 0 9 * * * (America/New_York)');
  });

  it('does not deliver before next_fire_at', async () => {
    const f = setup();
    f.service.create(
      { title: 'Test schedule', message: 'm', spec: { kind: 'once', delay_seconds: 600 } },
      f.ownerAgentId,
      f.homeDmId,
    );
    f.setNow(currentNow + 60_000); // not yet due
    await f.service.tick();
    expect(f.fake.delivered.length).toBe(0);
  });

  it('interval fires repeatedly, advances next_fire_at from actual_fire_at', async () => {
    const f = setup();
    const s = f.service.create(
      {
        title: 'Test schedule',
        message: 'tick',
        spec: { kind: 'interval', every_seconds: 60 },
        max_occurrences: 3,
      },
      f.ownerAgentId,
      f.homeDmId,
    );

    // First fire at exactly the planned time — next should be t+60s.
    const planned1 = s.next_fire_at;
    f.setNow(planned1);
    await f.service.tick();
    let row = f.schedules.get(s.id)!;
    expect(row.fired_count).toBe(1);
    expect(row.status).toBe('pending');
    expect(row.next_fire_at).toBe(planned1 + 60_000);

    // Simulate "scheduler woke up late" — actual fire 90s past the
    // planned time. Next fire must advance from actual, not planned.
    const planned2 = row.next_fire_at;
    const actual2 = planned2 + 90_000;
    f.setNow(actual2);
    await f.service.tick();
    row = f.schedules.get(s.id)!;
    expect(row.fired_count).toBe(2);
    expect(row.next_fire_at).toBe(actual2 + 60_000);

    // Third fire hits max_occurrences → terminal done.
    f.setNow(row.next_fire_at);
    await f.service.tick();
    row = f.schedules.get(s.id)!;
    expect(row.fired_count).toBe(3);
    expect(row.status).toBe('done');
  });

  it('interval terminates when next fire would exceed until_at', async () => {
    const f = setup();
    const s = f.service.create(
      {
        title: 'Test schedule',
        message: 'tick until',
        spec: { kind: 'interval', every_seconds: 60 },
        until_at: currentNow + 65_000, // covers the first fire only
      },
      f.ownerAgentId,
      f.homeDmId,
    );
    f.setNow(s.next_fire_at);
    await f.service.tick();
    const after = f.schedules.get(s.id)!;
    expect(after.fired_count).toBe(1);
    expect(after.status).toBe('done');
  });

  it('marks schedule failed when wake delivery throws', async () => {
    const f = setup();
    f.fake.deliverError = new Error('mcp dead');
    const s = f.service.create(
      { title: 'Test schedule', message: 'm', spec: { kind: 'once', delay_seconds: 60 } },
      f.ownerAgentId,
      f.homeDmId,
    );
    f.setNow(currentNow + 60_000);
    await f.service.tick();
    const after = f.schedules.get(s.id)!;
    expect(after.status).toBe('failed');
    expect(after.failure_reason).toBe('mcp dead');
  });
});

describe('ScheduleService.tick — target_conversation_id (#task:478)', () => {
  // Provision a regular workspace + channel where the owner is a member.
  // Returns the channel id; the caller drives the rest.
  function provisionChannel(f: ReturnType<typeof setup>, name: string): string {
    const ws = f.workspaces.insert({
      name,
      description: null,
    });
    const channel = f.conversations.insertChannel({
      workspaceId: ws.id,
      title: 'fire-here',
    });
    f.conversations.addAgent(channel.id, f.ownerAgentId);
    return channel.id;
  }

  it('wake fires in the explicit target conversation, not agent_home', async () => {
    const f = setup();
    const channelId = provisionChannel(f, 'tick-target');
    const s = f.service.create(
      {
        title: 'channel cron',
        message: 'go',
        target_conversation_id: channelId,
        spec: { kind: 'once', delay_seconds: 60 },
      },
      f.ownerAgentId,
      f.homeDmId,
    );
    f.setNow(currentNow + 60_000);
    await f.service.tick();
    expect(f.schedules.get(s.id)?.status).toBe('done');
    expect(f.fake.delivered.length).toBe(1);
    // Both the system message AND the runtime start hit the target,
    // not the home DM. This is the subject-continuity invariant —
    // the (target, owner) session is the one that wakes, produces,
    // and posts.
    expect(f.fake.delivered[0]?.conversationId).toBe(channelId);
    expect(f.fake.starts[0]?.conversationId).toBe(channelId);
  });

  it('marks failed and posts owner notice when target was deleted between create and fire', async () => {
    const f = setup();
    const channelId = provisionChannel(f, 'tick-deleted');
    const s = f.service.create(
      {
        title: 'doomed',
        message: 'go',
        target_conversation_id: channelId,
        spec: { kind: 'once', delay_seconds: 60 },
      },
      f.ownerAgentId,
      f.homeDmId,
    );
    // Delete the channel between create and fire.
    f.conversations.delete(channelId);
    f.setNow(currentNow + 60_000);
    await f.service.tick();

    const after = f.schedules.get(s.id);
    expect(after?.status).toBe('failed');
    expect(after?.failure_reason).toContain('target_conversation_unavailable');
    // No deliver/start to the missing target; the ONLY delivery is the
    // owner-DM notice row (universe alignment §5.2 — the notice bumps the
    // DM head, so the owner needs a normal delivery to advance past it).
    expect(f.fake.delivered.map(d => d.conversationId)).toEqual([f.homeDmId]);
    expect(f.fake.delivered[0]!.agentId).toBe(f.ownerAgentId);
    expect(f.fake.starts.length).toBe(0);
    // Owner gets a heads-up in their agent_home DM so they don't keep
    // waiting on a wake that will never land. This is a lifecycle
    // notice — distinct from the wake itself, because the wake
    // belongs to the (target, agent) session and that session can no
    // longer be reached.
    const notices = f.messages.listForConversation(f.homeDmId, 50);
    expect(notices.length).toBeGreaterThan(0);
    expect(notices.some(m => m.content.includes('could not fire'))).toBe(true);
  });

  it('marks failed and posts owner notice when target was closed between create and fire', async () => {
    const f = setup();
    const channelId = provisionChannel(f, 'tick-closed');
    const s = f.service.create(
      {
        title: 'closing time',
        message: 'go',
        target_conversation_id: channelId,
        spec: { kind: 'once', delay_seconds: 60 },
      },
      f.ownerAgentId,
      f.homeDmId,
    );
    f.conversations.close(channelId, 'archived for test');
    f.setNow(currentNow + 60_000);
    await f.service.tick();

    expect(f.schedules.get(s.id)?.status).toBe('failed');
    const notices = f.messages.listForConversation(f.homeDmId, 50);
    expect(notices.some(m => m.content.includes('has been closed'))).toBe(true);
  });
});

describe('ScheduleService.tick — concurrency and recovery', () => {
  it('CAS prevents two parallel ticks from firing the same row twice', async () => {
    const f = setup();
    const s = f.service.create(
      { title: 'Test schedule', message: 'racy', spec: { kind: 'once', delay_seconds: 60 } },
      f.ownerAgentId,
      f.homeDmId,
    );
    f.setNow(currentNow + 60_000);
    // Fire both ticks "simultaneously" — Promise.all → JS event loop
    // interleaves them, but the CAS is single-threaded SQLite so only
    // one can claim.
    await Promise.all([f.service.tick(), f.service.tick()]);
    expect(f.fake.delivered.length).toBe(1);
    expect(f.schedules.get(s.id)?.fired_count).toBe(1);
  });

  it('start() resets stale firing rows from a prior process', () => {
    const f = setup();
    const s = f.service.create(
      { title: 'Test schedule', message: 'crashed mid-fire', spec: { kind: 'once', delay_seconds: 60 } },
      f.ownerAgentId,
      f.homeDmId,
    );
    // Simulate crash: the prior process left this row in 'firing'.
    f.schedules.tryClaim(s.id);
    expect(f.schedules.get(s.id)?.status).toBe('firing');
    // disableAutoTick is true so start() does nothing except recovery.
    f.service.start();
    expect(f.schedules.get(s.id)?.status).toBe('pending');
  });

  it('repeat schedule missed multiple intervals only fires once and advances', async () => {
    const f = setup();
    const s = f.service.create(
      {
        title: 'Test schedule',
        message: 'every minute',
        spec: { kind: 'interval', every_seconds: 60 },
        allow_unbounded: true,
      },
      f.ownerAgentId,
      f.homeDmId,
    );
    // Jump forward 10 minutes — by old "catch-up" logic, this would
    // fire 10 times. Locked design says: fire once, advance from
    // actual_fire_at (now), so next is now+60s.
    const farFuture = currentNow + 10 * 60_000;
    f.setNow(farFuture);
    await f.service.tick();
    expect(f.fake.delivered.length).toBe(1);
    const row = f.schedules.get(s.id)!;
    expect(row.fired_count).toBe(1);
    expect(row.next_fire_at).toBe(farFuture + 60_000);
    expect(row.status).toBe('pending');
  });
});

describe('ScheduleService.tick — cron + DST', () => {
  // For DST tests we lean on cron-parser's Luxon-backed timezone math
  // and assert the higher-level invariant: next_fire_at must always be
  // strictly greater than actual_fire_at, no matter how the wall-clock
  // jumps. We don't hardcode wall-clock times because the underlying
  // library decides how to handle skipped/repeated hours.

  it('spring-forward: schedule firing across the missing 02:00-03:00 hour advances strictly forward', async () => {
    const f = setup();
    // 2024-03-10 02:00 → 03:00 jump in America/New_York.
    // Start "now" at 2024-03-09 23:00 UTC = 18:00 EST so we have a
    // few daily fires before, during, and after the transition.
    f.setNow(Date.UTC(2024, 2, 9, 23, 0, 0));
    const s = f.service.create(
      {
        title: 'Test schedule',
        message: 'daily 8am NYC',
        spec: {
          kind: 'cron',
          expression: '0 8 * * *',
          timezone: 'America/New_York',
        },
        max_occurrences: 5,
      },
      f.ownerAgentId,
      f.homeDmId,
    );
    let prev = s.next_fire_at;
    for (let i = 0; i < 5; i++) {
      const row = f.schedules.get(s.id)!;
      const planned = row.next_fire_at;
      // Fire at the planned time exactly.
      f.setNow(planned);
      await f.service.tick();
      const after = f.schedules.get(s.id)!;
      if (i < 4) {
        expect(after.status).toBe('pending');
        expect(after.next_fire_at).toBeGreaterThan(planned);
        expect(after.next_fire_at).toBeGreaterThan(prev);
      } else {
        expect(after.status).toBe('done');
      }
      prev = planned;
    }
    // Sanity: no failures.
    expect(f.schedules.get(s.id)?.failure_reason).toBeNull();
  });

  it('fall-back: schedule firing across the repeated 01:00-02:00 hour advances strictly forward', async () => {
    const f = setup();
    // 2024-11-03 02:00 → 01:00 jump in America/New_York.
    f.setNow(Date.UTC(2024, 10, 2, 23, 0, 0));
    const s = f.service.create(
      {
        title: 'Test schedule',
        message: 'every hour at :30',
        spec: {
          kind: 'cron',
          expression: '30 * * * *',
          timezone: 'America/New_York',
        },
        max_occurrences: 8,
      },
      f.ownerAgentId,
      f.homeDmId,
    );
    let prev = s.next_fire_at;
    for (let i = 0; i < 8; i++) {
      const row = f.schedules.get(s.id)!;
      const planned = row.next_fire_at;
      f.setNow(planned);
      await f.service.tick();
      const after = f.schedules.get(s.id)!;
      if (i < 7) {
        expect(after.status).toBe('pending');
        // Strict forward progress is the only invariant the library
        // is required to uphold across DST repetition.
        expect(after.next_fire_at).toBeGreaterThan(planned);
        expect(after.next_fire_at).toBeGreaterThan(prev);
      } else {
        expect(after.status).toBe('done');
      }
      prev = planned;
    }
    expect(f.schedules.get(s.id)?.failure_reason).toBeNull();
  });
});

describe('ScheduleService renders wake body', () => {
  it('publishes the wake message to the agent_home dm_channel for live UI', async () => {
    const f = setup();
    const conversationEvents: Array<{ kind: string; payload: unknown }> = [];
    const viewerEvents: Array<{ kind: string; payload: unknown }> = [];
    const unsubConversation = f.events.subscribe(f.homeDmId, event => {
      conversationEvents.push(event);
    });
    const unsubViewer = f.events.subscribeScope('viewer:local', event => {
      viewerEvents.push({ kind: event.kind, payload: event.payload });
    });
    try {
      const s = f.service.create(
        { title: 'Test schedule', message: 'show in ui', spec: { kind: 'once', delay_seconds: 60 } },
        f.ownerAgentId,
        f.homeDmId,
      );
      f.setNow(s.next_fire_at);
      await f.service.tick();
    } finally {
      unsubConversation();
      unsubViewer();
    }

    const msgId = f.fake.delivered[0]!.messageId;
    expect(conversationEvents).toHaveLength(1);
    expect(conversationEvents[0]!.kind).toBe('message');
    expect((conversationEvents[0]!.payload as any).message.id).toBe(msgId);
    expect((conversationEvents[0]!.payload as any).message.metadata.subtype).toBe(
      'schedule_fire',
    );
    expect(viewerEvents).toContainEqual(
      expect.objectContaining({
        kind: 'unread_updated',
        payload: expect.objectContaining({ conversation_id: f.homeDmId }),
      }),
    );
  });

  it('includes repeat metadata when fired_count is non-terminal', async () => {
    const f = setup();
    const s = f.service.create(
      {
        title: 'Test schedule',
        message: 'metric check',
        spec: { kind: 'interval', every_seconds: 60 },
        max_occurrences: 3,
      },
      f.ownerAgentId,
      f.homeDmId,
    );
    f.setNow(s.next_fire_at);
    await f.service.tick();
    const msgId = f.fake.delivered[0]!.messageId;
    const msg = f.messages.getById(msgId)!;
    expect(msg.content).toContain('Next fire at');
    expect(msg.content).toContain('1/3');
  });

  it('reports late delivery in human-readable form', async () => {
    const f = setup();
    const s = f.service.create(
      { title: 'Test schedule', message: 'morning', spec: { kind: 'once', delay_seconds: 60 } },
      f.ownerAgentId,
      f.homeDmId,
    );
    // Fire 10 minutes after the planned time.
    f.setNow(s.next_fire_at + 10 * 60_000);
    await f.service.tick();
    const msgId = f.fake.delivered[0]!.messageId;
    const msg = f.messages.getById(msgId)!;
    expect(msg.content).toMatch(/fired \d+m late/);
  });
});

describe('ScheduleService dispose', () => {
  it('start + stop are idempotent and do not leak timers', () => {
    const f = setup();
    f.service.start();
    f.service.stop();
    f.service.stop();
    f.service.start();
    f.service.stop();
    // No assertion beyond "no throw"; vitest catches lingering timers
    // via process exit hooks if any timer was missed.
    expect(true).toBe(true);
  });
});

// ── Review fixes (Cindy r1) ───────────────────────────────────────

describe('ScheduleService — cron 5-field strictness', () => {
  it('rejects 6-field (seconds) cron expressions at create time', () => {
    const f = setup();
    let err: ScheduleError | undefined;
    try {
      f.service.create(
        {
          title: 'Test schedule',
          message: 'sub-minute is not allowed',
          // cron-parser would happily accept this 6-field form,
          // but our v1 contract is 5-field UNIX cron.
          spec: { kind: 'cron', expression: '0 0 9 * * *', timezone: 'UTC' },
          max_occurrences: 5,
        },
        f.ownerAgentId,
        f.homeDmId,
      );
    } catch (e) {
      err = e as ScheduleError;
    }
    expect(err?.code).toBe('invalid_cron_expression');
    expect(err?.message).toContain('5 fields');
  });

  it('rejects @daily / @hourly / @reboot aliases', () => {
    const f = setup();
    for (const alias of ['@daily', '@hourly', '@reboot', '@yearly']) {
      let err: ScheduleError | undefined;
      try {
        f.service.create(
          {
            title: 'Test schedule',
            message: 'aliases blocked',
            spec: { kind: 'cron', expression: alias, timezone: 'UTC' },
            max_occurrences: 5,
          },
          f.ownerAgentId,
          f.homeDmId,
        );
      } catch (e) {
        err = e as ScheduleError;
      }
      expect(err?.code, `alias ${alias} should be rejected`).toBe(
        'invalid_cron_expression',
      );
      expect(err?.message).toContain('alias');
    }
  });

  it('accepts the canonical 5-field form', () => {
    const f = setup();
    expect(() =>
      f.service.create(
        {
          title: 'Test schedule',
          message: 'fine',
          spec: { kind: 'cron', expression: '0 9 * * *', timezone: 'UTC' },
          max_occurrences: 5,
        },
        f.ownerAgentId,
        f.homeDmId,
      ),
    ).not.toThrow();
  });
});

describe('ScheduleService — cancel-during-firing race', () => {
  it('cancel that wins between CAS and completion is preserved', async () => {
    const f = setup();
    const s = f.service.create(
      { title: 'Test schedule', message: 'racy', spec: { kind: 'once', delay_seconds: 60 } },
      f.ownerAgentId,
      f.homeDmId,
    );

    // Simulate the race: tick() begins, CAS-claims into 'firing',
    // then a cancel arrives (here we just call schedules.cancel
    // directly — that's what the future MCP route would do via
    // service.cancel) BEFORE the wake completes. We model "wake
    // completes after cancel" by hooking into the fake CM.
    let cancelDuringDeliver = false;
    f.fake.deliverMessage = async (cid, aid, mid) => {
      f.fake.delivered.push({ conversationId: cid, agentId: aid, messageId: mid });
      // Inject the race: cancel races in here.
      if (!cancelDuringDeliver) {
        cancelDuringDeliver = true;
        // service.cancel rejects pending|firing only; here it's firing.
        f.service.cancel(s.id, f.ownerAgentId);
      }
    };

    f.setNow(currentNow + 60_000);
    await f.service.tick();

    // Wake was delivered (CAS won, message was inserted) — that's OK,
    // cancel only promises "no future fires", it doesn't undeliver.
    expect(f.fake.delivered.length).toBe(1);
    // Cancel must remain the terminal state — completion path must NOT
    // overwrite cancelled with done/pending.
    const after = f.schedules.get(s.id)!;
    expect(after.status).toBe('cancelled');
    expect(after.cancelled_at).not.toBeNull();
  });

  it('cancel race on a repeat schedule blocks the rearm', async () => {
    const f = setup();
    const s = f.service.create(
      {
        title: 'Test schedule',
        message: 'repeating racy',
        spec: { kind: 'interval', every_seconds: 60 },
        max_occurrences: 5,
      },
      f.ownerAgentId,
      f.homeDmId,
    );
    f.fake.deliverMessage = async (cid, aid, mid) => {
      f.fake.delivered.push({ conversationId: cid, agentId: aid, messageId: mid });
      f.service.cancel(s.id, f.ownerAgentId);
    };
    f.setNow(s.next_fire_at);
    await f.service.tick();
    const after = f.schedules.get(s.id)!;
    expect(after.status).toBe('cancelled');
    // The rearm path tried to bump fired_count + push next_fire_at —
    // it must have been a no-op because of the status='firing' guard.
    expect(after.fired_count).toBe(0);
    expect(after.next_fire_at).toBe(s.next_fire_at);
  });
});

describe('ScheduleService — start() failure marks the schedule failed', () => {
  it('treats a ConversationManager.start rejection as a wake failure', async () => {
    const f = setup();
    // deliver succeeds so the message is persisted, but start throws
    // — modeling a runtime that fails to spawn (PATH issue, missing
    // binary, init watchdog timeout, etc).
    f.fake.start = async () => {
      throw new Error('runtime spawn failed');
    };
    const s = f.service.create(
      { title: 'Test schedule', message: 'wake me', spec: { kind: 'once', delay_seconds: 60 } },
      f.ownerAgentId,
      f.homeDmId,
    );
    f.setNow(currentNow + 60_000);
    await f.service.tick();
    const after = f.schedules.get(s.id)!;
    expect(after.status).toBe('failed');
    expect(after.failure_reason).toContain('runtime spawn failed');
    // The message DID get inserted — that's an inbox liability we
    // accept (the agent will see it next time it starts via some
    // other path), but the schedule itself is terminal-failed so it
    // won't re-fire.
    expect(f.fake.delivered.length).toBe(1);
  });
});

describe('ScheduleService — cron|interval fire failure does NOT terminate the plan (#task:755-followup)', () => {
  // Pre-v39 every wake failure routed through `markFailed` and pushed
  // the row to terminal `status='failed'`, killing daily/weekly cron
  // schedules on a single bad fire. The new contract: only `kind:'once'`
  // (no future fire) goes terminal — `cron|interval` log fire-level
  // metrics and re-arm to the natural next cadence tick.

  it('cron fire failure: status returns to pending, count++, next_fire_at advances to next cron tick', async () => {
    const f = setup();
    f.fake.start = async () => {
      throw new Error('agent runtime is unavailable: no outbound daemon transport is attached for this host');
    };
    // 06:00 daily Asia/Shanghai — same shape as the real
    // daily-cli-report schedule that died in the field.
    f.setNow(Date.UTC(2026, 5, 1, 0, 0, 0)); // 2026-06-01 00:00 UTC = 08:00 CST
    const s = f.service.create(
      {
        title: 'daily failer',
        message: 'cron failing',
        spec: {
          kind: 'cron',
          expression: '0 6 * * *',
          timezone: 'Asia/Shanghai',
        },
        allow_unbounded: true,
      },
      f.ownerAgentId,
      f.homeDmId,
    );
    const firstPlanned = s.next_fire_at;
    f.setNow(firstPlanned);
    await f.service.tick();
    const after = f.schedules.get(s.id)!;
    expect(after.status).toBe('pending');
    expect(after.fired_count).toBe(0); // failed fire MUST NOT count
    expect(after.last_fired_at).toBeNull();
    expect(after.failure_reason).toBeNull(); // legacy column reserved for kind:once
    expect(after.last_failure_reason).toContain('outbound daemon transport');
    expect(after.last_failure_at).not.toBeNull();
    expect(after.consecutive_failure_count).toBe(1);
    // Natural next cron tick is exactly 24h later.
    expect(after.next_fire_at).toBe(firstPlanned + 24 * 60 * 60 * 1000);
  });

  it('interval fire failure: status returns to pending, count++, next_fire_at advances by every_seconds', async () => {
    const f = setup();
    f.fake.start = async () => {
      throw new Error('transient transport detach');
    };
    const s = f.service.create(
      {
        title: 'every 60s failer',
        message: 'interval failing',
        spec: { kind: 'interval', every_seconds: 60 },
        allow_unbounded: true,
      },
      f.ownerAgentId,
      f.homeDmId,
    );
    f.setNow(s.next_fire_at);
    await f.service.tick();
    const after = f.schedules.get(s.id)!;
    expect(after.status).toBe('pending');
    expect(after.fired_count).toBe(0);
    expect(after.consecutive_failure_count).toBe(1);
    expect(after.last_failure_reason).toBe('transient transport detach');
    expect(after.next_fire_at).toBe(s.next_fire_at + 60_000);
  });

  it('repeated cron fire failures keep status=pending and bump consecutive_failure_count each time', async () => {
    const f = setup();
    f.fake.start = async () => {
      throw new Error('still down');
    };
    f.setNow(Date.UTC(2026, 5, 1, 0, 0, 0));
    const s = f.service.create(
      {
        title: 'persistent failer',
        message: 'three strikes',
        spec: {
          kind: 'cron',
          expression: '0 6 * * *',
          timezone: 'Asia/Shanghai',
        },
        allow_unbounded: true,
      },
      f.ownerAgentId,
      f.homeDmId,
    );
    for (let i = 1; i <= 3; i++) {
      const planned = f.schedules.get(s.id)!.next_fire_at;
      f.setNow(planned);
      await f.service.tick();
      const after = f.schedules.get(s.id)!;
      expect(after.status).toBe('pending');
      expect(after.consecutive_failure_count).toBe(i);
      expect(after.fired_count).toBe(0);
    }
    // Plan is still alive — never enters terminal `failed`.
    expect(f.schedules.get(s.id)!.status).not.toBe('failed');
  });

  it('successful fire after a failure resets consecutive_failure_count to 0', async () => {
    const f = setup();
    let failNext = true;
    f.fake.start = async () => {
      if (failNext) throw new Error('first fire bad');
    };
    f.setNow(Date.UTC(2026, 5, 1, 0, 0, 0));
    const s = f.service.create(
      {
        title: 'recovering',
        message: 'fail then succeed',
        spec: {
          kind: 'cron',
          expression: '0 6 * * *',
          timezone: 'Asia/Shanghai',
        },
        allow_unbounded: true,
      },
      f.ownerAgentId,
      f.homeDmId,
    );
    // Fire 1: fails.
    f.setNow(s.next_fire_at);
    await f.service.tick();
    let row = f.schedules.get(s.id)!;
    expect(row.consecutive_failure_count).toBe(1);
    expect(row.fired_count).toBe(0);
    // Fire 2: succeeds → counter resets, fired_count++.
    failNext = false;
    f.setNow(row.next_fire_at);
    await f.service.tick();
    row = f.schedules.get(s.id)!;
    expect(row.status).toBe('pending');
    expect(row.consecutive_failure_count).toBe(0);
    expect(row.fired_count).toBe(1);
    expect(row.last_fired_at).toBe(s.next_fire_at + 24 * 60 * 60 * 1000);
    // The failure metadata is intentionally NOT cleared — it remains
    // as a post-mortem record of the most recent fire failure. UI can
    // hide it once `consecutive_failure_count === 0`.
    expect(row.last_failure_reason).toBe('first fire bad');
  });

  it('once fire failure still goes terminal `failed` (no future fire to retry)', async () => {
    const f = setup();
    f.fake.start = async () => {
      throw new Error('once boom');
    };
    const s = f.service.create(
      { title: 'one-shot', message: 'go', spec: { kind: 'once', delay_seconds: 60 } },
      f.ownerAgentId,
      f.homeDmId,
    );
    f.setNow(currentNow + 60_000);
    await f.service.tick();
    const after = f.schedules.get(s.id)!;
    expect(after.status).toBe('failed');
    expect(after.failure_reason).toContain('once boom');
    // The new fire-failure metric columns stay at insert-time defaults:
    // they are reserved for `cron|interval` non-terminal failures.
    expect(after.last_failure_reason).toBeNull();
    expect(after.last_failure_at).toBeNull();
    expect(after.consecutive_failure_count).toBe(0);
  });

  it('interval failure whose natural next tick is past until_at terminates as `done`', async () => {
    const f = setup();
    f.fake.start = async () => {
      throw new Error('runtime down');
    };
    // Interval is the cleanest setup for this assertion: every_seconds
    // = 60, first fire at T0+60s, until_at at T0+90s. After the failed
    // fire at T0+60s, planFailureRearm computes next-tick = T0+120s
    // which is strictly past until_at → terminal-as-`done`.
    const T0 = currentNow;
    const s = f.service.create(
      {
        title: 'last gasp',
        message: 'no time left',
        spec: { kind: 'interval', every_seconds: 60 },
        until_at: T0 + 90_000,
      },
      f.ownerAgentId,
      f.homeDmId,
    );
    f.setNow(s.next_fire_at);
    await f.service.tick();
    const after = f.schedules.get(s.id)!;
    // Plan window genuinely closed — no future fire is possible
    // regardless of the failure history. Goes `done`, not `failed`.
    expect(after.status).toBe('done');
    // markDone increments fired_count; we accept that on the failure
    // until_at-exhausted path the row reads as if the last fire
    // succeeded (UI: `last_failure_*` is null because markDone path
    // doesn't update them; the error trace lives only in the logger).
    // If we ever want permanent observability for this branch, add the
    // failure metric writes to markDone's UPDATE.
    expect(after.fired_count).toBe(1);
  });

  it('cancel race during a cron fire failure still wins over markFireFailed', async () => {
    const f = setup();
    const failureMessage = 'transport gone';
    f.setNow(Date.UTC(2026, 5, 1, 0, 0, 0));
    // Forward-declare the schedule id so the start() closure can call
    // cancel() on it before throwing. We must install fake.start AFTER
    // create() so the closure captures the real id.
    let scheduleId = '';
    const s = f.service.create(
      {
        title: 'cancel races fail',
        message: 'go',
        spec: {
          kind: 'cron',
          expression: '0 6 * * *',
          timezone: 'Asia/Shanghai',
        },
        allow_unbounded: true,
      },
      f.ownerAgentId,
      f.homeDmId,
    );
    scheduleId = s.id;
    f.fake.start = async () => {
      // After tryClaim → status='firing'; cancel transitions
      // firing→cancelled.
      f.service.cancel(scheduleId, f.ownerAgentId);
      throw new Error(failureMessage);
    };
    f.setNow(s.next_fire_at);
    await f.service.tick();
    const after = f.schedules.get(s.id)!;
    // Cancel won the race — schedule terminates as cancelled, NOT
    // pending-with-failure. The CAS predicate `status='firing'` on
    // markFireFailed protects this; cancel transitions firing →
    // cancelled, so the subsequent UPDATE sees no firing row and
    // returns false.
    expect(after.status).toBe('cancelled');
    expect(after.consecutive_failure_count).toBe(0);
    expect(after.last_failure_reason).toBeNull();
  });
});

describe('ScheduleService — wake body advancement details', () => {
  it('reports missed_count for interval schedules that caught up late', async () => {
    const f = setup();
    const s = f.service.create(
      {
        title: 'Test schedule',
        message: 'every 60s',
        spec: { kind: 'interval', every_seconds: 60 },
        allow_unbounded: true,
      },
      f.ownerAgentId,
      f.homeDmId,
    );
    // Skip 5 minutes — 5 occurrences elapsed since the planned fire
    // time. We catch up with a single fire; missed_count = 5.
    f.setNow(s.next_fire_at + 5 * 60_000);
    await f.service.tick();
    const msgId = f.fake.delivered[0]!.messageId;
    const msg = f.messages.getById(msgId)!;
    expect(msg.content).toContain('Missed 5 prior occurrence');
    const meta = msg.metadata as Record<string, unknown>;
    expect(meta.missed_count).toBe(5);
    // next_fire_at metadata also surfaced for downstream consumers.
    expect(meta.next_fire_at).toBe(s.next_fire_at + 5 * 60_000 + 60_000);
  });

  it('renders next_fire_at ISO timestamp for non-terminal repeat fires', async () => {
    const f = setup();
    const s = f.service.create(
      {
        title: 'Test schedule',
        message: 'tick',
        spec: { kind: 'interval', every_seconds: 60 },
        max_occurrences: 3,
      },
      f.ownerAgentId,
      f.homeDmId,
    );
    f.setNow(s.next_fire_at);
    await f.service.tick();
    const msgId = f.fake.delivered[0]!.messageId;
    const msg = f.messages.getById(msgId)!;
    // Format is `Next fire at <ISO>.`
    expect(msg.content).toMatch(/Next fire at \d{4}-\d{2}-\d{2}T/);
  });

  it('renders "final fire" hint when repeat hits max_occurrences', async () => {
    const f = setup();
    const s = f.service.create(
      {
        title: 'Test schedule',
        message: 'last tick',
        spec: { kind: 'interval', every_seconds: 60 },
        max_occurrences: 1,
      },
      f.ownerAgentId,
      f.homeDmId,
    );
    f.setNow(s.next_fire_at);
    await f.service.tick();
    const msgId = f.fake.delivered[0]!.messageId;
    const msg = f.messages.getById(msgId)!;
    expect(msg.content).toContain('final fire');
    // Schedule must be terminal `done`, not pending.
    expect(f.schedules.get(s.id)?.status).toBe('done');
  });

  it('one-shot wake never includes next_fire_at or missed_count copy', async () => {
    const f = setup();
    const s = f.service.create(
      { title: 'Test schedule', message: 'just once', spec: { kind: 'once', delay_seconds: 60 } },
      f.ownerAgentId,
      f.homeDmId,
    );
    f.setNow(s.next_fire_at);
    await f.service.tick();
    const msgId = f.fake.delivered[0]!.messageId;
    const msg = f.messages.getById(msgId)!;
    expect(msg.content).not.toContain('Next fire at');
    expect(msg.content).not.toContain('Missed');
    expect(msg.content).not.toContain('final fire');
    const meta = msg.metadata as Record<string, unknown>;
    expect(meta.missed_count).toBe(0);
    expect(meta.next_fire_at).toBeNull();
  });
});

describe('ScheduleSchedule isolation', () => {
  it('listForAgent excludes other agents and orders by next_fire_at asc', () => {
    const f = setup();
    const a = f.service.create(
      { title: 'Test schedule', message: 'second', spec: { kind: 'once', delay_seconds: 600 } },
      f.ownerAgentId,
      f.homeDmId,
    );
    const b = f.service.create(
      { title: 'Test schedule', message: 'first', spec: { kind: 'once', delay_seconds: 60 } },
      f.ownerAgentId,
      f.homeDmId,
    );
    const list = f.service.list(f.ownerAgentId, 'pending', undefined);
    expect(list.map(s => s.id)).toEqual([b.id, a.id]);
  });

  it('does not validate workspace path / settings of other agents', () => {
    const f = setup();
    f.service.create(
      { title: 'Test schedule', message: 'mine', spec: { kind: 'once', delay_seconds: 60 } },
      f.ownerAgentId,
      f.homeDmId,
    );
    // Listing under a foreign agent returns nothing — no error.
    const list = f.service.list(f.otherAgentId, 'all', undefined);
    expect(list).toEqual([]);
  });
});

describe('ScheduleDto round-trip', () => {
  it('preserves spec_json across insert + read', () => {
    const f = setup();
    const created = f.service.create(
      {
        title: 'Test schedule',
        message: 'cron readback',
        spec: {
          kind: 'cron',
          expression: '*/15 * * * *',
          timezone: 'UTC',
        },
        allow_unbounded: true,
      },
      f.ownerAgentId,
      f.homeDmId,
    );
    const reread: ScheduleDto = f.schedules.get(created.id)!;
    expect(reread.spec.kind).toBe('cron');
    if (reread.spec.kind === 'cron') {
      expect(reread.spec.expression).toBe('*/15 * * * *');
      expect(reread.spec.timezone).toBe('UTC');
    }
  });
});
