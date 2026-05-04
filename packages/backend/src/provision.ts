import { join, resolve, isAbsolute, sep } from 'node:path';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import {
  initWorkspaceDir,
  seedAgentL2,
  ensureAgentL1Dir,
  ChannelRepo,
} from './repos/channel-repo.js';
import { MembershipRepo } from './repos/membership-repo.js';
import { SessionRepo } from './repos/session-repo.js';
import { MessageRepo } from './repos/message-repo.js';
import { AgentRepo } from './repos/agent-repo.js';
import type { SessionManager } from './session-manager.js';
import type { BackendLogger } from './context.js';
import type {
  AgentDto,
  ChannelDto,
  ChannelMemberDto,
  CreateChannelInput,
} from '@silverhand/shared';

export interface ProvisionOpts {
  silverhandDir: string;
  workspacesRoot: string;
  localHostId: string;
  channels: ChannelRepo;
  members: MembershipRepo;
  sessions: SessionRepo;
  messages: MessageRepo;
  agents: AgentRepo;
  sessionManager: SessionManager;
  logger: BackendLogger;
}

export interface DeleteChannelOptions {
  /**
   * Defaults to true for direct callers. HTTP routes pass false so the
   * user-visible request returns after the durable DB delete while process
   * shutdown and filesystem cleanup continue in the background.
   */
  awaitCleanup?: boolean;
}

/**
 * Block dangerous workspace_path values before any filesystem write or
 * delete touches them. Callers should validate at channel-creation time
 * (returns a friendly error) AND at delete-time as defense-in-depth
 * (a corrupted/legacy DB row must never let `fs.rm` walk into the
 * user's home, the silverhand state dir, or the filesystem root).
 *
 * Why `workspacesRoot` is a parameter: the default auto-generated
 * workspace path is `<silverhandDir>/workspaces/<name>`, which IS
 * inside `silverhandDir`. Naively rejecting all silverhandDir-children
 * would break channel creation. So we carve out `workspacesRoot/*` as
 * the legitimate exception, while still refusing silverhandDir itself,
 * `<silverhandDir>/agents/*` (the L1 store), `<silverhandDir>/logs`,
 * etc.
 *
 * Returns the normalized absolute path on success, or a reason string.
 */
export function validateWorkspacePath(
  workspacePath: string,
  silverhandDir: string,
  workspacesRoot: string,
): { ok: true; resolved: string } | { ok: false; reason: string } {
  if (typeof workspacePath !== 'string' || workspacePath.trim() === '') {
    return { ok: false, reason: 'workspace_path is empty' };
  }
  if (!isAbsolute(workspacePath)) {
    return { ok: false, reason: 'workspace_path must be absolute' };
  }
  const resolved = resolve(workspacePath);
  if (resolved === '/' || resolved === sep) {
    return { ok: false, reason: 'workspace_path cannot be the filesystem root' };
  }
  if (resolved === resolve(homedir())) {
    return { ok: false, reason: 'workspace_path cannot be the home directory' };
  }
  const sh = resolve(silverhandDir);
  const wr = resolve(workspacesRoot);
  // Inside silverhandDir? Only allow if it's strictly under workspacesRoot
  // (the carve-out for auto-generated channel workspaces). Equality with
  // workspacesRoot itself is also rejected — that's the parent dir, not
  // a single channel's workspace.
  const insideSh = resolved === sh || resolved.startsWith(sh + sep);
  if (insideSh) {
    const insideWr = resolved.startsWith(wr + sep);
    if (!insideWr) {
      return {
        ok: false,
        reason: 'workspace_path cannot live inside the silverhand state dir (except under workspaces/)',
      };
    }
  }
  return { ok: true, resolved };
}

/**
 * Per-workspace serialization for delete cleanup. Two concurrent
 * `deleteChannel` calls for channels sharing the same workspace would
 * otherwise race the "is anyone else using this workspace?" survivor
 * query against each other's `channels.delete()` — leading to a wipe
 * that the other call's snapshot still considered safe. Routes are
 * async (Hono awaits between DB write and fs cleanup), so the
 * serialization needs to be explicit.
 */
const workspaceLocks = new Map<string, Promise<void>>();
async function withWorkspaceLock<T>(
  workspaceKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = workspaceLocks.get(workspaceKey) ?? Promise.resolve();
  let release!: () => void;
  const next = prev.then(() => new Promise<void>(r => {
    release = r;
  }));
  workspaceLocks.set(workspaceKey, next);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (workspaceLocks.get(workspaceKey) === next) {
      workspaceLocks.delete(workspaceKey);
    }
  }
}

/**
 * Recursively remove `target`, but refuse to follow symlinks at the
 * top level. The caller has already proven `target` is inside the
 * silverhand-owned `.silverhand/` skeleton (via `validateWorkspacePath`
 * + path-prefix check), so a symlink AT this point can only be hostile
 * or a misconfiguration — wiping its target would leak destruction
 * outside the skeleton. Skip + warn instead.
 *
 * Note: `fs.rm({ recursive: true })` in modern Node does NOT follow
 * a top-level symlink (it `unlink`s it), but symlinks-to-dirs nested
 * inside the tree may have their contents recursed into. Since the
 * skeleton is small and well-known (`agents/<id>/{system_prompt.md,
 * MEMORY.md,notes/}` + `CONSENSUS.md`), nested symlinks shouldn't
 * exist; if one does, we'd rather leak the empty dirs than risk
 * descending into something the user owns elsewhere.
 */
async function safeRemoveSilverhandPath(
  target: string,
  logger: BackendLogger,
  context: Record<string, unknown>,
): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    logger.warn({ ...context, target, err }, 'safeRemove: lstat failed');
    return;
  }
  if (stat.isSymbolicLink()) {
    logger.warn(
      { ...context, target },
      'safeRemove: refusing to remove symlink inside .silverhand skeleton',
    );
    return;
  }
  await fs.rm(target, { recursive: true, force: true }).catch(err =>
    logger.warn({ ...context, target, err }, 'safeRemove: rm failed'),
  );
}

/**
 * Per-agent onboarding for a regular channel. Phrased as a direct task
 * to the recipient agent so it actually responds — the platform prompt
 * tells agents to ignore informational `system` messages unless they
 * explicitly ask for action, so the wording matters.
 *
 * Tone modeled on `@slock-ai/daemon`'s onboarding: imperative, scoped,
 * one actionable next step. Mechanics like "use mcp__chat__send_message"
 * and the platform-message disclaimer are NOT repeated here — the
 * platform prompt already covers tool usage and `from_kind=system`
 * semantics; surfacing them again leaks impl into the chat UI.
 */
const ONBOARDING_BODY = (
  channelName: string,
  recipient: AgentDto,
  others: AgentDto[],
): string =>
  [
    `You (@${recipient.name}) just joined #${channelName}.`,
    others.length === 0
      ? `You're the only agent here right now.`
      : `Other agents in this channel:\n${others.map(m => `- @${m.name} (${m.runtime})`).join('\n')}`,
    ``,
    `Send one short greeting — name yourself and, in one sentence, say what your current role looks like (or note that it's not yet defined). Then wait for the user.`,
  ].join('\n');

export async function provisionChannel(
  input: CreateChannelInput,
  opts: ProvisionOpts,
): Promise<{ channel: ChannelDto; onboardingSessionId: string }> {
  const workspacePath =
    input.workspace_path?.trim() || opts.channels.workspacePathFor(input.name);

  // Reject paths that would let the eventual delete-cleanup walk into
  // the user's home, the silverhand state dir, or the FS root. Run
  // before any mkdir so an invalid path never even materializes.
  const validation = validateWorkspacePath(
    workspacePath,
    opts.silverhandDir,
    opts.workspacesRoot,
  );
  if (!validation.ok) {
    throw new Error(`invalid workspace_path: ${validation.reason}`);
  }
  const safeWorkspacePath = validation.resolved;

  // 1. Mkdir + .silverhand init
  await initWorkspaceDir(safeWorkspacePath);

  // 2. DB insert (channel row)
  const channel = opts.channels.insert({
    name: input.name,
    description: input.description ?? null,
    kind: 'regular',
    workspace_path: safeWorkspacePath,
    workspace_host_id: input.workspace_host_id ?? opts.localHostId,
    dm_agent_id: null,
  });

  // 3. Members + L1↔L2 seeding.
  //
  // DB writes (members.add) are synchronous and must stay sequential so
  // better-sqlite3's single-connection writes are never interleaved.
  // Filesystem work (ensureAgentL1Dir + seedAgentL2) is async I/O with
  // no cross-agent dependencies, so we fan it out with Promise.allSettled —
  // this cuts wall time from N×T to T when N agents are joining and each
  // fs round-trip is slow (e.g. iCloud Drive, Spotlight indexing under
  // load from concurrent agent MEMORY.md writes). We use allSettled (not
  // Promise.all) so all seed writes finish before the error is surfaced —
  // avoiding background fs writes racing with a caller retry after 500.
  const memberAgents: AgentDto[] = [];
  const seedTasks: Array<{ agent: AgentDto; agentL1Dir: string }> = [];
  for (const agentId of input.member_agent_ids) {
    const agent = opts.agents.get(agentId);
    if (!agent) continue; // silently skip unknown agents (defense)
    opts.members.add(channel.id, agent.id);
    const agentL1Dir = join(opts.silverhandDir, 'agents', agent.id);
    memberAgents.push(agent);
    seedTasks.push({ agent, agentL1Dir });
  }
  // Parallel fs seeding — allSettled so every agent's writes finish before
  // we inspect results. Promise.all would leave background writes racing if
  // one task rejects early; allSettled waits for all then re-throws the
  // first error, keeping the failure path clean.
  const seedResults = await Promise.allSettled(
    seedTasks.map(({ agent, agentL1Dir }) =>
      ensureAgentL1Dir(agentL1Dir).then(() =>
        seedAgentL2({ workspacePath: safeWorkspacePath, agentId: agent.id, agentL1Dir }),
      ),
    ),
  );
  const firstFailure = seedResults.find(
    (r): r is PromiseRejectedResult => r.status === 'rejected',
  );
  if (firstFailure) throw firstFailure.reason as Error;

  // 4. Auto-create Onboarding session.
  const onboarding = opts.sessions.insert({
    channelId: channel.id,
    title: 'Onboarding',
  });
  for (const agent of memberAgents) {
    opts.sessions.addAgent(onboarding.id, agent.id);
  }

  // 5. Per-member onboarding: each agent gets its own system message
  //    addressed to them by name (the platform prompt instructs agents
  //    to ignore informational system messages, so the imperative
  //    framing matters). Each is delivered + spawned independently —
  //    on session_init the inbox drain feeds it as first user turn.
  for (const agent of memberAgents) {
    const others = memberAgents.filter(m => m.id !== agent.id);
    const onboardingMsg = opts.messages.insert({
      sessionId: onboarding.id,
      fromKind: 'system',
      content: ONBOARDING_BODY(channel.name, agent, others),
      metadata: { subtype: 'onboarding' },
    });
    await opts.sessionManager.deliverMessage(onboarding.id, agent.id, onboardingMsg.id);
    opts.sessionManager
      .start(onboarding.id, agent.id)
      .catch(err =>
        opts.logger.error(
          { sessionId: onboarding.id, agentId: agent.id, err },
          'onboarding spawn failed',
        ),
      );
  }

  return { channel, onboardingSessionId: onboarding.id };
}

/**
 * For DM channels: workspace_path = the agent's L1 dir directly.
 * Used by `/api/agents` POST when an agent is created (auto-DM).
 */
export async function provisionDmChannel(
  agent: AgentDto,
  opts: ProvisionOpts,
): Promise<ChannelDto> {
  const agentL1Dir = join(opts.silverhandDir, 'agents', agent.id);
  await ensureAgentL1Dir(agentL1Dir);

  const dmName = `dm-${agent.name}`;
  const existing = opts.channels.getByName(dmName);
  if (existing) return existing;

  const channel = opts.channels.insert({
    name: dmName,
    description: `DM with @${agent.name}`,
    kind: 'dm',
    workspace_path: agentL1Dir,
    workspace_host_id: opts.localHostId,
    dm_agent_id: agent.id,
  });
  opts.members.add(channel.id, agent.id);

  // Onboarding session for the DM as well — used to shape global
  // identity. Imperative tone so the agent actually replies (the
  // platform prompt suppresses replies to informational system
  // messages).
  const onboarding = opts.sessions.insert({
    channelId: channel.id,
    title: 'Onboarding',
  });
  opts.sessions.addAgent(onboarding.id, agent.id);
  const onboardingMsg = opts.messages.insert({
    sessionId: onboarding.id,
    fromKind: 'system',
    content: [
      `You (@${agent.name}) are now in your personal DM with the user.`,
      `Send one short greeting — say hi by name and ask what role the user would like you to play. Then wait for their reply.`,
    ].join('\n'),
    metadata: { subtype: 'onboarding' },
  });

  await opts.sessionManager.deliverMessage(onboarding.id, agent.id, onboardingMsg.id);
  opts.sessionManager
    .start(onboarding.id, agent.id)
    .catch(err =>
      opts.logger.error(
        { sessionId: onboarding.id, agentId: agent.id, err },
        'dm onboarding spawn failed',
      ),
    );

  return channel;
}

/** Ensure `<silverhandDir>/workspaces/` exists. */
export async function ensureWorkspacesRoot(workspacesRoot: string): Promise<void> {
  await fs.mkdir(workspacesRoot, { recursive: true });
}

/**
 * Add an agent to an existing channel. Mirrors the per-member work
 * `provisionChannel` does at create time so add-after-the-fact is fully
 * symmetric — without this, a mid-channel join would skip L2 seeding
 * (no MEMORY.md / system_prompt.md in the channel workspace) and never
 * appear in the channel's open root sessions.
 *
 * What this does:
 *  1. Insert (idempotent) into `channel_members`.
 *  2. Ensure the agent's L1 dir + seed L2 from L1 (so MEMORY.md
 *     inherits whatever the user shaped in DM).
 *  3. Add to every root, open session in the channel — child sessions
 *     keep snapshot semantics on purpose (they're explicit subsets).
 *  4. Post a `system` "@xxx joined" message to each of those sessions
 *     and deliver to every existing + new member's inbox so live agents
 *     notice and the new agent boots into a self-explanatory state.
 *  5. Spawn the new agent in each affected session, mirroring
 *     `provisionChannel` step 5.
 *
 * Idempotent: re-running with an already-joined agent is a no-op for
 * channel_members but will still ensure L2 / re-broadcast is suppressed
 * by the `INSERT OR IGNORE` semantics on session_agents.
 */
export async function joinChannel(
  channelId: string,
  agent: AgentDto,
  opts: ProvisionOpts,
): Promise<{ member: ChannelMemberDto; sessionsUpdated: string[] }> {
  const channel = opts.channels.get(channelId);
  if (!channel) throw new Error('channel not found');

  const member = opts.members.add(channelId, agent.id);

  const agentL1Dir = join(opts.silverhandDir, 'agents', agent.id);
  await ensureAgentL1Dir(agentL1Dir);
  await seedAgentL2({
    workspacePath: channel.workspace_path,
    agentId: agent.id,
    agentL1Dir,
  });

  const rootOpenSessions = opts.sessions
    .listForChannel(channelId)
    .filter(s => s.parent_session_id === null && s.closed_at === null);

  const sessionsUpdated: string[] = [];
  for (const session of rootOpenSessions) {
    const before = opts.sessions.listAgents(session.id);
    const alreadyIn = before.some(sa => sa.agent_id === agent.id);
    if (alreadyIn) continue; // recovery / re-add — skip the announce

    opts.sessions.addAgent(session.id, agent.id);
    sessionsUpdated.push(session.id);

    const announce = opts.messages.insert({
      sessionId: session.id,
      fromKind: 'system',
      content: `@${agent.name} joined this channel.`,
      metadata: { subtype: 'join' },
    });

    // Deliver to everyone in the session — including the joiner. The
    // new agent isn't running yet; deliverMessage enqueues to inbox
    // and the spawn below drains it on session_init.
    const after = opts.sessions.listAgents(session.id);
    for (const sa of after) {
      await opts.sessionManager.deliverMessage(session.id, sa.agent_id, announce.id);
    }

    // Spawn only the new agent. Existing members are already running
    // (or intentionally idle) — don't disturb them.
    opts.sessionManager
      .start(session.id, agent.id)
      .catch(err =>
        opts.logger.error(
          { sessionId: session.id, agentId: agent.id, err },
          'join: spawn failed',
        ),
      );
  }

  return { member, sessionsUpdated };
}

/**
 * Remove an agent from a channel. Symmetric to `joinChannel` but
 * deliberately keeps the agent's L2 directory on disk **by default** —
 * those files contain MEMORY the agent built up and may be re-needed
 * if they rejoin (rejoin will skip seedAgentL2 since dst already
 * exists). Pass `wipeL2: true` from the agent-delete flow, where there
 * is no rejoin path.
 *
 * Steps:
 *  1. Stop any running session-agent processes for this channel
 *     (hard mode — they're being kicked).
 *  2. Remove session_agents rows from every root session in the
 *     channel (open or closed — historical sessions shouldn't keep
 *     reporting them as members).
 *  3. Remove channel_members.
 *  4. Post `@xxx left` to remaining members of each affected open
 *     root session.
 *  5. (Optional) `rm -rf <workspace>/.silverhand/agents/<id>/`.
 */
export async function leaveChannel(
  channelId: string,
  agent: AgentDto,
  opts: ProvisionOpts,
  leaveOpts: { wipeL2?: boolean } = {},
): Promise<{ sessionsUpdated: string[] }> {
  const channel = opts.channels.get(channelId);
  if (!channel) throw new Error('channel not found');

  const rootSessions = opts.sessions
    .listForChannel(channelId)
    .filter(s => s.parent_session_id === null);

  const sessionsUpdated: string[] = [];
  for (const session of rootSessions) {
    const wasMember = opts.sessions
      .listAgents(session.id)
      .some(sa => sa.agent_id === agent.id);
    if (!wasMember) continue;

    // Stop first; removeAgent drops the row that stop() consults.
    await opts.sessionManager
      .stop(session.id, agent.id, 'hard')
      .catch(err =>
        opts.logger.warn(
          { sessionId: session.id, agentId: agent.id, err },
          'leave: stop failed (continuing with removal)',
        ),
      );
    opts.sessions.removeAgent(session.id, agent.id);
    sessionsUpdated.push(session.id);

    if (session.closed_at !== null) continue; // no announce on closed

    const announce = opts.messages.insert({
      sessionId: session.id,
      fromKind: 'system',
      content: `@${agent.name} left this channel.`,
      metadata: { subtype: 'leave' },
    });
    for (const sa of opts.sessions.listAgents(session.id)) {
      await opts.sessionManager.deliverMessage(session.id, sa.agent_id, announce.id);
    }
  }

  opts.members.remove(channelId, agent.id);

  if (leaveOpts.wipeL2) {
    const l2Dir = join(channel.workspace_path, '.silverhand', 'agents', agent.id);
    await fs.rm(l2Dir, { recursive: true, force: true }).catch(err =>
      opts.logger.warn(
        { channelId, agentId: agent.id, l2Dir, err },
        'leave: wipeL2 failed',
      ),
    );
  }

  return { sessionsUpdated };
}

/**
 * Tear down a channel completely. The DB has CASCADE on
 * `sessions.channel_id`, `channel_members.channel_id`, and on every
 * session-scoped table downstream — so dropping the channel row is
 * enough for data. But the spawned (session, agent) child processes
 * outlive the row unless we explicitly stop them, and the on-disk L2
 * working copies (`<workspace>/.silverhand/agents/<id>/`) and the
 * `.silverhand/` skeleton would otherwise leak.
 *
 * Steps:
 *  1. Snapshot session agents, members, and workspace path before the
 *     DB row disappears.
 *  2. Start hard-stopping every running (session, agent) for sessions
 *     in the channel, but do not require the HTTP caller to wait for
 *     child-process exit.
 *  3. `channels.delete(id)` — DB cascade handles sessions, messages,
 *     inbox, saved, session_agents, channel_members.
 *  4. After all stops finish, perform filesystem cleanup in the
 *     background for route callers (skipped entirely for DM channels).
 *
 * Filesystem-cleanup safety:
 *  - DM channels point `workspace_path` at the agent's L1 dir
 *    (`~/.silverhand/agents/<id>/`). Wiping `.silverhand/` under that
 *    would mean wiping a slice of the global silverhand state dir.
 *    Skip cleanup for DMs entirely.
 *  - `validateWorkspacePath` re-checks the row at delete time as
 *    defense-in-depth: a corrupted/legacy row pointing at `/`, `~`,
 *    or `<silverhandDir>` must never reach `fs.rm`.
 *  - `path.resolve` normalizes survivor-comparison so trailing
 *    slashes / `.`-segments don't make a sibling channel look like
 *    a stranger.
 *  - Per-workspace mutex serializes concurrent deletes against the
 *    "is anyone else using this workspace?" snapshot.
 *  - `safeRemoveSilverhandPath` refuses to follow symlinks.
 */
export async function deleteChannel(
  channelId: string,
  opts: ProvisionOpts,
  deleteOpts: DeleteChannelOptions = {},
): Promise<void> {
  const channel = opts.channels.get(channelId);
  if (!channel) return; // already gone — idempotent

  const allSessions = opts.sessions.listForChannel(channelId);
  const stopTasks: Array<Promise<void>> = [];
  for (const session of allSessions) {
    for (const sa of opts.sessions.listAgents(session.id)) {
      stopTasks.push(
        opts.sessionManager
          .stop(session.id, sa.agent_id, 'hard')
          .catch(err =>
            opts.logger.warn(
              { sessionId: session.id, agentId: sa.agent_id, err },
              'deleteChannel: stop failed (continuing with delete)',
            ),
          ),
      );
    }
  }

  const memberIds = opts.members.listForChannel(channelId).map(a => a.id);
  const rawWorkspacePath = channel.workspace_path;
  const channelKind = channel.kind;
  let workspacePath: string | null = null;

  // DM channels share their `workspace_path` with the agent's L1 dir
  // (see `provisionDmChannel`). Filesystem cleanup would mean writing
  // into the global silverhand state dir — never safe. Just drop the
  // DB row and stop here. The agent itself is responsible for its L1
  // lifecycle (handled by the agent-delete flow).
  if (channelKind !== 'dm') {
    // Defense-in-depth: even though `provisionChannel` validates at
    // create time, a legacy/imported row could have an unsafe path.
    // Refuse cleanup rather than risk wiping outside the workspace.
    const validation = validateWorkspacePath(
      rawWorkspacePath,
      opts.silverhandDir,
      opts.workspacesRoot,
    );
    if (validation.ok) {
      workspacePath = validation.resolved;
    } else {
      opts.logger.error(
        { channelId, workspacePath: rawWorkspacePath, reason: validation.reason },
        'deleteChannel: unsafe workspace_path — dropping DB row, skipping filesystem cleanup',
      );
    }
  }

  opts.channels.delete(channelId);

  const cleanup = async (): Promise<void> => {
    await Promise.all(stopTasks);
    if (workspacePath === null) return;

    // Serialize per resolved workspace so concurrent deletes for two
    // channels sharing a workspace don't race the survivor query.
    await withWorkspaceLock(workspacePath, async () => {
      // Re-snapshot survivors INSIDE the lock — the only way a sibling
      // channel can disappear between here and the wipe is if it also
      // holds this lock, which serializes after us.
      const survivingByWorkspace = opts.channels
        .list()
        .filter(c => resolve(c.workspace_path) === workspacePath);

      const survivingMembers = new Set<string>();
      for (const surv of survivingByWorkspace) {
        for (const a of opts.members.listForChannel(surv.id)) {
          survivingMembers.add(a.id);
        }
      }

      for (const agentId of memberIds) {
        if (survivingMembers.has(agentId)) continue;
        const l2Dir = join(workspacePath, '.silverhand', 'agents', agentId);
        await safeRemoveSilverhandPath(l2Dir, opts.logger, {
          op: 'deleteChannel.l2',
          channelId,
          agentId,
        });
      }

      if (survivingByWorkspace.length === 0) {
        const dotDir = join(workspacePath, '.silverhand');
        await safeRemoveSilverhandPath(dotDir, opts.logger, {
          op: 'deleteChannel.skeleton',
          channelId,
        });
      }
    });
  };

  if (deleteOpts.awaitCleanup === false) {
    void cleanup().catch(err =>
      opts.logger.error({ channelId, err }, 'deleteChannel: background cleanup failed'),
    );
    return;
  }

  await cleanup();
}
