/**
 * Channel-domain application ports — the driver-free contract between channel
 * orchestration (create / archive / rename / visibility) and persistence.
 * Same discipline as `services/task/ports.ts`: no driver types, no SQL, and the
 * whole relative import closure of this module stays driver-free (gated by the
 * db-boundary port-contract suite).
 *
 * Capability separation (#task:1981 design contract v3.1, widened by #task:1987):
 *  - `ChannelReadPort` / `ChannelDirectWritePort` are the OUTSIDE-transaction
 *    faces; the direct-write face is limited to writes that are atomic on their
 *    own (one UPDATE), so they need no UnitOfWork;
 *  - every multi-row create/rename write exists ONLY on a transaction scope, and
 *    the two scopes are split BY CAPABILITY: member placement and channel
 *    creation live on the workspace-keyed scope, the title write on the
 *    conversation-keyed one;
 *  - the unread/badge publish is an effect port, deliberately unreachable from
 *    either scope, so a transaction callback cannot publish.
 */
import type {
  AgentDto,
  CanonicalConversationTitle,
  ChannelConversationDto,
  ConversationAgentDto,
  ConversationDto,
  ConversationUserMemberDto,
  ConversationVisibility,
  FixedRosterConversationDto,
  MessageDto,
  Workspace,
  WorkspaceRoleDto,
} from '@silverhand/shared';

/** Conversation reads the service performs OUTSIDE any transaction. */
export interface ChannelReadPort {
  get(conversationId: string): ConversationDto | null;
  /** Read a top-level conversation with its placement and roster axes; null
   *  only when the row is missing. */
  getChannelLike(
    conversationId: string,
  ): ChannelConversationDto | FixedRosterConversationDto | null;
  /** Agent membership of the actor's SOURCE conversation (agent-actor gate). */
  getAgent(conversationId: string, agentId: string): ConversationAgentDto | null;
  listAgents(conversationId: string): ConversationAgentDto[];
}

/** Single-statement channel writes. Each is one UPDATE gated on the relevant
 *  placement, roster, and lifecycle predicates, so it is atomic by itself and
 *  returns `null` when nothing matched — the service turns that into a
 *  `ChannelError`. Putting these on the UnitOfWork would be transaction theatre
 *  (R3). */
export interface ChannelDirectWritePort {
  setArchived(
    conversationId: string,
    archived: boolean,
  ): ChannelConversationDto | FixedRosterConversationDto | null;
  setVisibility(
    conversationId: string,
    visibility: ConversationVisibility,
  ): ChannelConversationDto | null;
}

export interface ChannelWorkspaceReadPort {
  get(workspaceId: string): Workspace | null;
  isMember(workspaceId: string, agentId: string): boolean;
  isUserMember(workspaceId: string, userId: string): boolean;
}

export interface ChannelAgentReadPort {
  get(agentId: string): AgentDto | null;
}

/** Channel writes + the reads their decisions depend on, available inside the
 *  CONVERSATION-keyed transaction. Every face here addresses THE KEYED
 *  conversation and takes no id at all: the key is an argument of the entry
 *  point (`atomicallyForChannel`), so "lock channel A, write channel B" is
 *  unexpressible rather than merely refused. Creating a channel and placing
 *  members in it are NOT here — they belong to the workspace-keyed axis below. */
export interface ChannelTxChannelsPort {
  /**
   * Rewrite the keyed conversation's title — which MOVES ITS ADDRESS
   * (#task:2016), because they are the same string.
   *
   * Takes the canonical pair, so this port cannot be handed a title without the
   * key the unique index compares, or a key belonging to a different title. The
   * old address is released by the same statement and NOTHING REMEMBERS IT: there
   * is no retirement, no successor pointer, and a subsequent rename may take it
   * back.
   *
   * It therefore RETURNS the released key next to the new row — the writer is the
   * only place both addresses exist at once, and the observation face that stands
   * in for the deleted retirement history has no other source for it. The value
   * is the one that was stored, so a drifted key is reported as it was rather
   * than as it should have been.
   */
  updateTitle(
    title: CanonicalConversationTitle,
  ): {
    channel: ChannelConversationDto | FixedRosterConversationDto;
    releasedKey: string | null;
  } | null;
  /**
   * Read the authoritative current row of THE KEYED channel-like conversation
   * FOR A SUBSEQUENT WRITE in the same transaction (rename's from-title audit).
   *
   * Isolation obligation, not a hint: the value read here must not change
   * before this transaction commits. The adapter owes a mechanism that makes
   * that TRUE — the SQLite composition takes the write lock at BEGIN
   * (`BEGIN IMMEDIATE`) so no other connection can write the row while the
   * callback runs; a pooled/PG adapter MUST implement this as
   * `SELECT … FOR UPDATE` on the key. "Usually only one writer" is not a
   * mechanism. Otherwise two concurrent renames both read the same old title and
   * one writes a from-title that never existed. The method name carries the
   * obligation — plain `get` is NOT a substitute.
   *
   * The row it returns carries the OLD ADDRESS, because the address is `title`:
   * the rename audit names the title it replaced, read under the same obligation.
   */
  getChannelLikeForUpdate(): ChannelConversationDto | FixedRosterConversationDto | null;
  /**
   * Is `key` held by ANOTHER conversation in the keyed conversation's workspace
   * (#task:2016)?
   *
   * Takes no workspace: the adapter derives it from the key, so a rename cannot
   * be checked against the wrong workspace. EXCLUDES the keyed conversation
   * itself — re-titling `general` to `General` keeps the same address and must
   * succeed, which is the difference from the retired-slug design, where
   * re-taking your own address was a refusal.
   *
   * Authoritative only under the transaction's write lock — same obligation as
   * {@link getChannelLikeForUpdate}. Outside it this is a stale hint, which is
   * why no read port exposes it. The partial UNIQUE index remains the backstop
   * for a caller that skips this.
   */
  isTitleTakenByAnother(key: string): boolean;
}

/**
 * The WORKSPACE-keyed capability set (#task:1987): creating a channel in a
 * workspace and placing its founding members.
 *
 * Why a second axis instead of one wider port. Channel creation is a
 * multi-subject write — the channel row plus one `conversation_agents` /
 * `conversation_users` row per founding member, plus (seeded) two messages —
 * and every one of those rows belongs to ONE workspace. The coordination axis is
 * therefore the workspace, and it is expressed as an ARGUMENT of the entry point
 * (`atomicallyInWorkspace`), so a caller cannot hold a member-write face without
 * having named the workspace it may write in.
 *
 * Rename keeps the conversation-keyed entry point because its coordination
 * subject is the one channel row it rewrites. Splitting BY CAPABILITY rather
 * than forcing one signature is the whole point — the rename scope's key set
 * structurally cannot place a member, and the creation scope's faces
 * structurally cannot be pointed at another workspace.
 *
 * `insertChannel` / `insertDmChannel` take NO `workspaceId`: it comes from the
 * key the adapter closed over, so "lock workspace A, create a channel in B" is
 * unexpressible rather than merely wrong. Every face that takes a
 * `conversationId` is bound to the coordinated workspace by the adapter, which
 * throws — aborting the whole transaction — on a pointer into another one.
 */
export interface WorkspaceChannelTxChannelsPort {
  /**
   * Create a channel in the coordinated workspace. Its TITLE IS its address
   * (#task:2016), so there is no second argument and no unnamed form: the
   * canonical pair is the title, and a row cannot exist at no address.
   *
   * The caller refuses a conflict via {@link isTitleTaken} first so the user gets
   * a typed `title_taken`; the workspace-unique index is the backstop.
   */
  insertChannel(args: {
    title: CanonicalConversationTitle;
    spawnedByAgentId?: string | null;
    visibility?: ConversationVisibility;
  }): ChannelConversationDto;
  /** The DM twin of {@link insertChannel}, addressed by the same rules — a DM
   *  channel is a workspace placement today, so its title is an address too. */
  insertDmChannel(args: {
    title: CanonicalConversationTitle;
    agentId?: string | null;
  }): FixedRosterConversationDto;
  /** Is `key` already held by a conversation of the COORDINATED workspace? Takes
   *  no workspace for the same reason the insert faces do not: it comes from the
   *  key. No self-exclusion arm here — nothing exists yet to exclude.
   *  Authoritative under this transaction's write lock; a pre-lock probe would be
   *  a stale hint. */
  isTitleTaken(key: string): boolean;
  addAgent(conversationId: string, agentId: string): ConversationAgentDto;
  addUser(conversationId: string, userId: string): ConversationUserMemberDto;
  /** Source-conversation snapshot for the seed system message. */
  get(conversationId: string): ConversationDto | null;
  /** Agent membership of the actor's SOURCE conversation, re-derived inside the
   *  lock (see {@link WorkspaceChannelTxWorkspacePort}). */
  getAgent(conversationId: string, agentId: string): ConversationAgentDto | null;
  /** Human members of the SOURCE conversation, inherited narrowly by an
   *  agent-created channel. */
  listUsers(conversationId: string): ConversationUserMemberDto[];
}

/**
 * The MINIMAL FACT PROJECTION of the coordinated workspace, readable inside the
 * lock. Every face is keyed — no `workspaceId` argument — so it can only answer
 * about the workspace this transaction actually coordinates.
 *
 * Why it exists (#task:1987, Cindy `WzFlaHtF_3-4Jdvx`). Binding the write TARGET
 * to the key is only half the mechanism; the other half is that the transaction
 * must re-derive its ELIGIBILITY TO WRITE. A pre-lock gate is an early refusal
 * only: between it and BEGIN a roster change can commit, and the interleaving
 * then produces a `conversation_agents` / `conversation_users` row for a
 * principal with no workspace membership — a state NO serial order can reach
 * (create-then-remove cascades the edge away; remove-then-create refuses). So
 * membership is recomputed here, in the lock, before any row is inserted.
 *
 * The human face is the ROLE, not a boolean (Cindy `m6nN9WG8jvusBJA2`). A role
 * row IS workspace membership, so one projection answers both questions this
 * axis asks — "may this actor create here" (rank) and "is this person a member"
 * (presence) — and they cannot drift apart the way two faces over the same row
 * could. It is also why the actor's `admin` authority is re-derived HERE rather
 * than left to the route: the same slice's `addWorkspaceHumanMember` already
 * treats an `admin` demotion committing in the seam as a rollback, and two
 * writers of workspace-governed rows must not disagree about when authority is
 * sampled. `owner`/`admin` vs `member` is the pure rule in
 * `auth/workspace-role.ts` — the callback consults it, never a rank of its own.
 */
export interface WorkspaceChannelTxWorkspacePort {
  /** The coordinated workspace's DECIDING facts, re-read in the lock: nothing but
   *  the home owner, which is all either creation callback consults — both "is
   *  this an agent home" and "whose" are that one relation.
   *  Deliberately NOT `Workspace` — a full row would hand the callback name /
   *  description / pin state and invite a decision on a fact this port never
   *  promised to have read under the lock. */
  get(): CoordinatedWorkspaceFacts | null;
  hasAgentMember(agentId: string): boolean;
  /** The human's authoritative `workspace_users` role, or `null` when they hold
   *  no row — which IS "not a member of this workspace". */
  humanRole(userId: string): WorkspaceRoleDto | null;
}

/** The workspace facts a creation transaction is allowed to decide on. Named and
 *  exact, with TWO machines behind that claim, because a type-level narrowing is
 *  not a boundary — structural typing lets a projection spread the row and still
 *  satisfy this interface:
 *   - `tests/repos/conversation-persistence.test.ts` pins the adapter's snapshot
 *     next to the axis's face list (the keyed-projection cell), and
 *   - `tests/services/channel/coordinated-workspace-facts.test.ts` pins the
 *     runtime KEY SET plus the absence of each surplus physical column, on both a
 *     regular container and an agent home.
 *  Widening the set breaks both, so it is a contract change rather than an
 *  accident of passing a row through. */
export interface CoordinatedWorkspaceFacts {
  /** The home agent of an agent-home workspace; `null` for a regular one. ONE
   *  field, because "which kind of container is this" and "who owns it" are the
   *  same fact — asked through `isAgentHomeWorkspace`, which narrows this to a
   *  `string` for the agent_home path that needs the id anyway. */
  owner_agent_id: string | null;
}


/** Message inserts the WORKSPACE-keyed axis performs: the seed context message
 *  (`system`) and the seed initial prompt (`agent` — which is why this is not
 *  called `systemEvents`). Takes a `conversationId` because the target channel is
 *  created inside the same transaction; the adapter binds it to the workspace. */
export interface ChannelTxMessagesPort {
  insert(args: {
    conversationId: string;
    fromKind: 'system' | 'agent';
    fromAgentId?: string | null;
    content: string;
    metadata?: Record<string, unknown> | null;
  }): MessageDto;
}

/** The CONVERSATION-keyed axis's message face (the rename announcement): the
 *  target is the key, so there is no `conversationId` to pass or to bind. */
export interface KeyedChannelTxMessagesPort {
  insert(args: {
    fromKind: 'system' | 'agent';
    fromAgentId?: string | null;
    content: string;
    metadata?: Record<string, unknown> | null;
  }): MessageDto;
}

/** The transaction-scoped capability bundle of the CONVERSATION-keyed axis
 *  (rename). ALL persistence inside an `atomicallyForChannel` callback MUST come
 *  from this scope — never a captured factory repo (a future pooled adapter would
 *  read/write on the wrong connection). No effect capability exists here BY
 *  CONSTRUCTION, no member-write face does either, and no face can name a
 *  conversation other than the key. */
export interface ChannelTxScope {
  channels: ChannelTxChannelsPort;
  messages: KeyedChannelTxMessagesPort;
}

/** The WORKSPACE-keyed bundle (channel creation). Same rules; the message face is
 *  bound to the coordinated workspace too, so a seed message cannot be inserted
 *  into a conversation of another one. */
export interface WorkspaceChannelTxScope {
  channels: WorkspaceChannelTxChannelsPort;
  messages: ChannelTxMessagesPort;
  /** Source-agent snapshot for the seed system message, and the in-lock
   *  existence re-check of every principal about to be written. */
  agents: ChannelAgentReadPort;
  /** In-lock eligibility facts — see {@link WorkspaceChannelTxWorkspacePort}. */
  workspace: WorkspaceChannelTxWorkspacePort;
}

/**
 * Atomic write boundaries for the channel domain — two coordination axes, ONE
 * mechanism. BOTH entry points take their key as an argument, so the adapter can
 * bind every face to it and can derive the lock from it.
 *
 * The adapter must implement both on the same connection/lock regime: if a
 * workspace-keyed transaction and a conversation-keyed one could run
 * concurrently, a rename could interleave with the creation whose title it reads.
 * On SQLite that is automatic (the write lock is file-wide). A pooled/PG adapter
 * must take a lock the two axes SHARE, and a `FOR UPDATE` on the CONVERSATION row
 * is not it — that row is not what the workspace axis locks, so both axes would
 * still run at once. The conversation-keyed entry point therefore owes three
 * steps, in this order:
 *
 *  1. resolve the key's workspace — `SELECT workspace_id FROM conversations
 *     WHERE id = $1` — and refuse a missing channel right there (`not_found`);
 *     nothing is locked yet, so this is an early refusal, not a decision;
 *  2. lock THAT workspace, the object the workspace-keyed axis also takes:
 *     `SELECT id FROM workspaces WHERE id = $ws FOR UPDATE` (or
 *     `pg_advisory_xact_lock` on the same workspace id — one mechanism, chosen
 *     once for both entry points, never one axis per mechanism);
 *  3. only then read the channel row `FOR UPDATE`, which is what discharges
 *     `getChannelLikeForUpdate`'s isolation obligation.
 *
 * Step 1 resolves BEFORE the lock, so a conversation moved between workspaces
 * would invalidate it — which is safe here only because `conversations
 * .workspace_id` is immutable. An adapter for a schema where it is not owes a
 * re-read of the workspace id inside the lock and a rollback on disagreement.
 */
export interface ChannelUnitOfWork {
  atomicallyForChannel<T>(channelId: string, fn: (tx: ChannelTxScope) => T): T;
  atomicallyInWorkspace<T>(
    workspaceId: string,
    fn: (tx: WorkspaceChannelTxScope) => T,
  ): T;
}
