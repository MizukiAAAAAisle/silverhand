/**
 * #task:2021 P4-4 — the ONE end-to-end fact the rest of the suite can only
 * approximate: a REAL `silverhand` subprocess, handed the token a REAL delivery
 * header would carry, lands on the stream that header named.
 *
 * Everything else in this repo tests one half. `delivery-target-resolution`
 * proves an address resolves; `stdin-format` proves a header renders;
 * `platform-prompt-delivery-target` proves the prompt teaches a parseable form;
 * the CLI's own subprocess suite proves the flag reaches the wire byte-exact.
 * None of them can fail if the halves DISAGREE — and that is precisely how this
 * feature breaks in production: the emitter spells a stream one way, the
 * resolver reads that spelling as a different stream (or as nothing), and the
 * agent's answer lands somewhere its author never named. No layer errors.
 *
 * So this file crosses every boundary for real, in one direction:
 *
 *     row → streamNamingOf (the production policy over production repos)
 *         → formatStdinMessageHeader (the real emitter)
 *         → the header's `target=` field, cut out as an agent would
 *         → argv of a REAL `tsx src/cli.ts` subprocess
 *         → HTTP to a REAL listening backend (a port, not `app.fetch`)
 *         → resolveDeliveryTarget → the row that was written
 *
 * and asserts the coordinate at the end equals the one at the start.
 *
 * THE MATRIX. Three placement/naming cells — every arm `streamNamingOf` can
 * return that an agent can hold end to end — each in both streams (main line and
 * reply cluster), on both doors an agent answers through (`message send`,
 * `message history`):
 *
 *   named         a workspace channel whose two names round-trip → the readable form
 *   direct_pair   a DM, viewed by one of its endpoints            → `dm:@handle`
 *   unnameable    a channel in an agent_home workspace            → `#conv:<id>`
 *
 * `streamNamingOf`'s fourth arm, `id_only`, is a DM whose peer handle cannot be
 * rendered (a non-endpoint viewer, or an endpoint whose handle is gone). It emits
 * the same FORM as `unnameable` and is exercised as a pure function in
 * `application/stream-naming.test.ts`; it is not seeded here because no
 * subprocess-visible behaviour distinguishes it from the cell above.
 *
 * WHY A REAL PORT AND A REAL PROCESS. `app.fetch` would skip the HTTP client,
 * argv parsing, the flag policy and the exit code — the layers that translate an
 * agent's intent into a request. And a stubbed capture server (what
 * `packages/cli` uses, correctly, to assert bytes) cannot resolve an address at
 * all, so it can only prove the token was forwarded, never that it means the
 * same stream on the other side.
 *
 * WHICH CREDENTIAL. An AGENT-SCOPED session, i.e. a real AgentSlot bearer. Two
 * of the three cells are not the route conversation, and reaching a stream other
 * than its own is exactly what a ConversationSlot may NOT do on the write door
 * (#task:2021 P4-4, ruled 2026-08-15) — so a conversation-scoped credential could
 * not exercise this matrix at all, and pinning the confinement itself is
 * `routes/delivery-reach-slot-scope.test.ts`'s job. What is under test here is that
 * one absolute address means one stream end to end, which is the agent-scoped
 * session's whole premise.
 *
 * COST. ~13 subprocess spawns under `tsx`. That is the price of the only
 * evidence that this seam holds.
 */
import { serve } from '@hono/node-server';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  agentHomeWorkspaceId,
  fixedConversationTitle,
  fixedWorkspaceName,
  parseDeliveryTargetInput,
  type StreamNaming,
} from '@silverhand/shared';
import { streamNamingOf } from '../../src/application/stream-naming.js';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { AgentCapabilityRepo } from '../../src/repos/agent-capability-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { UserRepo } from '../../src/repos/user-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import {
  formatStdinMessageHeader,
  type MessageLite,
} from '../../src/runtime/stdin-format.js';
import {
  buildTestApp,
  type TestApp,
} from '../utils/app.js';
import { agentSlotToken } from '../utils/agent-scope.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PKG = resolve(__dirname, '..', '..', '..', 'cli');
const CLI_SRC = join(CLI_PKG, 'src', 'cli.ts');
const TSX_BIN = join(CLI_PKG, 'node_modules', '.bin', 'tsx');

const NOW = 1_700_000_000_000;

/** Which naming arm a cell exercises, and the two things that differ per cell. */
interface Cell {
  readonly label: StreamNaming['kind'];
  readonly conversationId: string;
  /** The cluster root seeded here, i.e. the `/thread:` half of the matrix. */
  readonly rootId: string;
}

interface Fixture {
  readonly t: TestApp;
  readonly agents: AgentRepo;
  readonly users: UserRepo;
  readonly workspaces: WorkspaceRepo;
  readonly conversations: ConversationRepo;
  readonly messages: MessageRepo;
  readonly aliceId: string;
  readonly bobHandle: string;
  readonly token: string;
  readonly cells: readonly Cell[];
}

let fixture: Fixture;
let server: ReturnType<typeof serve>;
let baseUrl: string;

/**
 * The production naming policy over production repo projections — the same three
 * lookups `OutboundEventFanout.streamNaming` wires, so this test cannot pass
 * with a naming rule the runtime does not use.
 */
function namingFor(f: Fixture, conversationId: string): StreamNaming {
  const facts = f.conversations.addressFacts(conversationId);
  if (facts === null) throw new Error(`no address facts for ${conversationId}`);
  return streamNamingOf(
    facts,
    { agentId: f.aliceId },
    {
      rootOf: workspaceId => f.workspaces.addressRoot(workspaceId),
      handleOf: endpoint =>
        endpoint.kind === 'agent'
          ? f.agents.get(endpoint.id)?.name ?? null
          : f.users.get(endpoint.id)?.name ?? null,
    },
  );
}

/**
 * The token an agent reads: rendered by the real emitter into a real header, then
 * cut back out of it by field name.
 *
 * Deliberately NOT `formatStreamAddressToken` called directly — that would test
 * the codec against itself and miss the header's own framing (a stray space, a
 * quoted field, a suffix appended in the wrong place). The extraction is the one
 * an agent performs, so a header that made the token unrecoverable fails here
 * rather than in a live reply.
 */
function headerTargetOf(
  f: Fixture,
  conversationId: string,
  threadRootId: string | null,
): string {
  const message: MessageLite = {
    id: 'HeaderProbe00001',
    conversation_id: conversationId,
    thread_root_id: threadRootId,
    from_kind: 'agent',
    from_agent_id: f.aliceId,
    from_user_id: null,
    content: 'probe',
    created_at: NOW,
  };
  const header = formatStdinMessageHeader(
    message,
    id => f.agents.get(id)?.name,
    () => undefined,
    () => undefined,
    undefined,
    { namingOf: () => namingFor(f, conversationId), recordFallback: () => {} },
  );
  const match = /(?:^|\s)target=(\S+)/.exec(header);
  if (!match) throw new Error(`no target field in header: ${header}`);
  return match[1]!;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * One real AgentSlot CLI invocation. The route is agent-global; `--target`
 * alone decides where this lands, which is the property under test.
 */
function runCli(argv: readonly string[], stdin?: string): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(TSX_BIN, [CLI_SRC, ...argv], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SILVERHAND_SERVER_URL: baseUrl,
        SILVERHAND_AGENT_ID: fixture.aliceId,
        SILVERHAND_AUTH_TOKEN: fixture.token,
        SILVERHAND_CONVERSATION_ID: '',
        // No daemon: a send must not need one, and the read door's
        // `agent_stream_observed` intent is daemon-gated by design.
        SILVERHAND_DAEMON_SOCKET: '',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', chunk => (stdout += chunk.toString('utf8')));
    child.stderr!.on('data', chunk => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', code => resolvePromise({ code, stdout, stderr }));
    child.stdin!.end(stdin === undefined ? undefined : Buffer.from(stdin, 'utf8'));
  });
}

const send = (target: string, body: string): Promise<RunResult> =>
  runCli(['message', 'send', '--target', target], body);

const history = (target: string): Promise<RunResult> =>
  runCli(['message', 'history', '--target', target, '--include-content']);

/** The CLI's one-line JSON error object, as an agent would parse it off stderr. */
function errorOf(stderr: string): {
  code?: string;
  subkind?: string;
  message?: string;
  details?: Record<string, unknown>;
} {
  for (const line of stderr.split(/\r?\n/)) {
    const start = line.indexOf('{');
    if (start < 0) continue;
    try {
      const parsed = JSON.parse(line.slice(start)) as {
        error?: Record<string, unknown>;
      };
      if (parsed.error) return parsed.error as never;
    } catch {
      /* a trace line, not the error line */
    }
  }
  throw new Error(`no JSON error line in stderr:\n${stderr}`);
}

interface HistoryWindow {
  target: { conversation_id: string; thread_root_id: string | null };
  messages: Array<{ message_ref: { id: string } }>;
}

beforeAll(async () => {
  // Memberships are not fixture-seeded: participation is what the resolver
  // judges, so a trigger that joins every principal to every conversation would
  // answer before the product does.
  const t = buildTestApp({ seedAllFixtureMemberships: false });
  const db = t.ctx.db;
  const agents = new AgentRepo(db);
  const users = new UserRepo(db);
  const workspaces = new WorkspaceRepo(db);
  const conversations = new ConversationRepo(db);
  const messages = new MessageRepo(db);
  const hostId = new HostRepo(db).ensureLocal().id;
  const alice = agents.create(
    // Agent-scoped: this matrix is three-quarters cross-stream, and only an
    // AgentSlot reaches past its own conversation on a write door.
    { name: 'rt-alice', runtime: 'claude', session_scope: 'agent' },
    hostId,
    t.viewerUserId,
  );
  const bob = agents.create(
    { name: 'rt-bob', runtime: 'claude' },
    hostId,
    t.viewerUserId,
  );

  // `named`: a regular workspace whose name and title both round-trip.
  const ws = workspaces.insert({
    name: fixedWorkspaceName('rt-ws'),
    description: null,
  });
  const named = conversations.insertChannel({
    workspaceId: ws.id,
    title: fixedConversationTitle('general'),
    visibility: 'private',
  }).id;
  conversations.addAgent(named, alice.id);
  // A capability is a grant INSIDE a workspace, held by a MEMBER (the grant table
  // keys on `workspace_members`), and a `regular` workspace with no grant row
  // denies — unlike the `agent_home` arm, where the owner holds implicit
  // authority. The other two cells therefore need neither: the home channel is
  // alice's own surface, and a direct pair carries its participants on the row.
  workspaces.insertMembership(ws.id, alice.id);
  new AgentCapabilityRepo(db).replaceSet(ws.id, alice.id, [
    'send_messages',
    'read_messages',
  ]);

  // `unnameable`: an agent_home root has no name key, so no address root — the
  // arm that must degrade to the id form rather than emit an unusable name.
  const homeId = agentHomeWorkspaceId(alice.id);
  if (!workspaces.get(homeId)) {
    workspaces.insertAgentHome({ agent: { id: alice.id, name: alice.name } });
  }
  const home = conversations.insertChannel({
    workspaceId: homeId,
    title: fixedConversationTitle('scratch'),
    visibility: 'private',
  }).id;
  conversations.addAgent(home, alice.id);

  // `direct_pair`: one row, two first persons; alice reads `dm:@rt-bob`.
  const pair = conversations.getOrCreateDirectPair(
    { kind: 'agent', id: alice.id },
    { kind: 'agent', id: bob.id },
    NOW,
  ).conversation.id;

  const seedRoot = (conversationId: string): string =>
    messages.insertForConversation({
      conversationId,
      fromKind: 'agent',
      fromAgentId: alice.id,
      content: 'cluster root',
    }).id;

  fixture = {
    t,
    agents,
    users,
    workspaces,
    conversations,
    messages,
    aliceId: alice.id,
    bobHandle: bob.name,
    token: agentSlotToken(t, alice.id),
    cells: [
      { label: 'named', conversationId: named, rootId: seedRoot(named) },
      {
        label: 'direct_pair',
        conversationId: pair,
        rootId: seedRoot(pair),
      },
      {
        label: 'unnameable',
        conversationId: home,
        rootId: seedRoot(home),
      },
    ],
  };

  // Awaited, not read back synchronously: `serve` binds on the next tick, so
  // `address()` is still null when it returns.
  await new Promise<void>(listening => {
    server = serve({ fetch: t.app.fetch, hostname: '127.0.0.1', port: 0 }, info => {
      baseUrl = `http://127.0.0.1:${info.port}`;
      listening();
    });
  });
});

afterAll(async () => {
  await new Promise<void>(done => server.close(() => done()));
  fixture.t.cleanup();
});

describe(
  'the delivered header token is the coordinate a real CLI hits',
  { timeout: 120_000 },
  () => {
    it('renders one spelling per naming arm, every one of them parseable', () => {
      const tokens = new Map<string, string>();
      for (const cell of fixture.cells) {
        const token = headerTargetOf(fixture, cell.conversationId, null);
        // Every emitted token is in the grammar the doors accept. If this fails,
        // no amount of correct resolution matters — the agent was handed
        // something it cannot paste.
        expect(
          parseDeliveryTargetInput(token),
          `${cell.label}: ${token}`,
        ).not.toBeNull();
        tokens.set(cell.label, token);
      }
      expect(tokens.get('named')).toBe('#rt-ws/general');
      expect(tokens.get('direct_pair')).toBe(`dm:@${fixture.bobHandle}`);
      // A workspace with no address root degrades to the id form rather than
      // emitting a name nobody can paste back.
      expect(tokens.get('unnameable')).toBe(
        `#conv:${fixture.cells[2]!.conversationId}`,
      );
    });

    for (const index of [0, 1, 2]) {
      for (const stream of ['main', 'thread'] as const) {
        const label = (['named', 'direct_pair', 'unnameable'] as const)[index];
        it(`${label} / ${stream}: a real subprocess reaches exactly the stream the header named`, async () => {
          const cell = fixture.cells[index]!;
          const threadRootId = stream === 'main' ? null : cell.rootId;
          const token = headerTargetOf(fixture, cell.conversationId, threadRootId);

          const body = `round-trip ${cell.label} ${stream}`;
          const sent = await send(token, body);
          expect(sent.code, sent.stderr).toBe(0);
          const ack = JSON.parse(sent.stdout) as {
            message_id: string;
            thread_root_id: string | null;
          };
          // The wire's own answer about WHERE it landed…
          expect(ack.thread_root_id).toBe(threadRootId);
          // …and the row, read from the addressed conversation. Both, because
          // an ack is a claim and the row is the fact.
          const row = fixture.messages.getInConversation(
            cell.conversationId,
            ack.message_id,
          );
          expect(
            row,
            `${cell.label}/${stream}: the row is not in the addressed conversation`,
          ).not.toBeNull();
          expect(row!.content).toBe(body);
          expect(row!.thread_root_id).toBe(threadRootId);
          // STABLE, not merely correct: the header rendered for the message the
          // agent just wrote is the token it was handed. Without this a
          // spelling could resolve correctly and still re-render differently,
          // and the next reply would carry a token nobody round-tripped.
          expect(
            headerTargetOf(fixture, cell.conversationId, row!.thread_root_id),
          ).toBe(token);

          // The read door takes the SAME token — one grammar, both directions.
          const read = await history(token);
          expect(read.code, read.stderr).toBe(0);
          const window = JSON.parse(read.stdout) as HistoryWindow;
          // The server's own statement of which coordinate it read.
          expect(window.target.conversation_id).toBe(cell.conversationId);
          expect(window.target.thread_root_id).toBe(threadRootId);
          // And every row it returned belongs to that STREAM, not merely to that
          // conversation: a read that widened a cluster to its channel would
          // leak the main line into a thread's context.
          expect(window.messages.length).toBeGreaterThan(0);
          for (const message of window.messages) {
            const row = fixture.messages.getInConversation(
              cell.conversationId,
              message.message_ref.id,
            );
            expect(row, `${message.message_ref.id} is not in ${cell.label}`)
              .not.toBeNull();
            if (threadRootId === null) {
              // A main-line window admits no anchored row: a reply leaking into
              // it is exactly the widening this address grammar exists to deny.
              expect(row!.thread_root_id).toBeNull();
            } else {
              // A cluster window holds the root — a main-line row whose id IS
              // the root — plus the rows anchored to it, so membership is
              // `thread_root_id ?? id`.
              expect(row!.thread_root_id ?? row!.id).toBe(threadRootId);
            }
          }
        });
      }
    }

    it('refuses a mid-cluster reply id instead of widening it to the cluster', async () => {
      // The one refusal that keeps a coordinate a coordinate. A reply to a root
      // is itself in that root's cluster, so if a mid-cluster id were normalized
      // two different addresses would name one stream — and an agent quoting the
      // wrong one would still "work", until the day it named a different cluster.
      const cell = fixture.cells[0]!;
      const reply = fixture.messages.insertForConversation({
        conversationId: cell.conversationId,
        fromKind: 'agent',
        fromAgentId: fixture.aliceId,
        content: 'a reply inside the cluster',
        threadRootId: cell.rootId,
      });
      const refused = await send(
        `#conv:${cell.conversationId}/thread:${reply.id}`,
        'should not land',
      );
      expect(refused.code, refused.stdout).toBe(1);
      const error = errorOf(refused.stderr);
      // 404, collapsed with unknown/unauthorized: the refusal is about the
      // coordinate and says nothing about what exists behind it.
      expect(error.code).toBe('not_found');
      expect(JSON.stringify(error.details ?? {})).not.toContain(cell.rootId);
    });
  },
);
