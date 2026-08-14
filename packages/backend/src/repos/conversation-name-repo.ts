import type { Database as Db } from 'better-sqlite3';
import { ConversationNameSchema } from '@silverhand/shared';
import { NAME_TARGET_JOIN } from './conversation-name-sql.js';

/**
 * The workspace NAME NAMESPACE (#task:2016) — the only module that writes
 * `conversation_names`.
 *
 * A conversation's name is not a property of the conversation row; it is an
 * ALLOCATION in its workspace's namespace, and this repo is that namespace's
 * aggregate boundary. Three rules the schema enforces and this surface therefore
 * never re-implements:
 *
 *  - a name that has ever been allocated is never allocated again — the
 *    namespace holds current AND retired rows under one `PRIMARY KEY
 *    (workspace_id, name)`, so there is no "release" operation to expose;
 *  - a conversation has AT MOST one current name (partial UNIQUE), which is why
 *    {@link ConversationNameRepo.allocate} does not need to check for one and why
 *    re-addressing is retire-then-allocate rather than an UPDATE;
 *  - an allocation row is immutable apart from retirement, and undeletable while
 *    its workspace exists (three triggers).
 *
 * What is NOT a DB fact: TOTALITY — that every live workspace conversation has
 * exactly one current name. `conversations` and its name are mutually
 * prerequisite and SQLite has no deferred constraints, so totality is a property
 * of the units of work that create, backfill and re-address channels. That is
 * the whole reason every write here is reachable ONLY from inside a transaction
 * scope (see `services/channel/ports.ts`): a caller that could allocate outside
 * one could leave a channel without an address, and no constraint would notice.
 */
export class ConversationNameRepo {
  constructor(private readonly db: Db) {}

  /**
   * Allocate `name` to `conversationId` in `workspaceId`.
   *
   * Deliberately NOT idempotent and deliberately not an upsert: a conflicting
   * name is a REFUSAL the caller must turn into an error for the requester, and
   * `INSERT OR IGNORE` would turn "someone else owns this address" into "your
   * channel silently has no address". The caller checks {@link isAllocated}
   * first — authoritative because every write path holds the write lock — and
   * this INSERT's key is the structural backstop that aborts the transaction if
   * the check was ever wrong.
   *
   * `assignedAt` is the addressed thing's birth instant (the conversation's
   * `created_at` at creation, the clock at re-address), matching the v72
   * backfill so an upgraded allocation and a fresh one are indistinguishable.
   *
   * FORMAT is asserted here, at the terminal write of the namespace (@Cindy,
   * #task:2016 review) — same shape and same reason as `UserRepo.create`
   * re-asserting `ParticipantNameSchema`. A name is an ADDRESS: the grammar is
   * what makes it spellable by the tokenizer at all, so a value outside the
   * grammar is a permanent, un-referenceable occupation of a namespace slot that
   * can never be released. Every route already validates its input, which is
   * exactly why this is not redundant: the assertion's job is to be the last
   * gate, so a future non-HTTP caller (a backfill, a seeder, an import) cannot
   * introduce one. The `CHECK` in the v72 DDL states the same domain to the
   * database; this throws a legible error instead of a bare
   * `SQLITE_CONSTRAINT_CHECK`, and keeps the closure true for a caller that
   * reaches an older connection.
   */
  allocate(params: {
    workspaceId: string;
    name: string;
    conversationId: string;
    assignedAt: number;
  }): void {
    if (!ConversationNameSchema.safeParse(params.name).success) {
      throw new Error(
        `ConversationNameRepo.allocate: name must satisfy ConversationNameSchema (got ${JSON.stringify(params.name)})`,
      );
    }
    this.db
      .prepare(
        `INSERT INTO conversation_names
           (workspace_id, name, conversation_id, assigned_at, retired_at)
         VALUES (?, ?, ?, ?, NULL)`,
      )
      .run(
        params.workspaceId,
        params.name,
        params.conversationId,
        params.assignedAt,
      );
  }

  /**
   * Retire this conversation's current allocation, returning the name that was
   * retired — or `null` when it held none (an inbox, or a half-state a fault
   * left behind).
   *
   * The retired row STAYS in the namespace forever: it keeps the address
   * un-takeable and keeps pointing at the conversation, which is what lets a
   * reference to a dead address say who succeeded it instead of just failing.
   * There is no `unretire`, by construction — the immutability trigger refuses
   * `retired_at` back to NULL.
   */
  retireCurrent(conversationId: string, retiredAt: number): string | null {
    const current = this.currentNameOf(conversationId);
    if (current === null) return null;
    this.db
      .prepare(
        `UPDATE conversation_names
            SET retired_at = ?
          WHERE conversation_id = ? AND retired_at IS NULL`,
      )
      .run(retiredAt, conversationId);
    return current;
  }

  /** This conversation's current name, or `null` when it has none. */
  currentNameOf(conversationId: string): string | null {
    const row = this.db
      .prepare<[string], { name: string }>(
        `SELECT name FROM conversation_names
          WHERE conversation_id = ? AND retired_at IS NULL`,
      )
      .get(conversationId);
    return row?.name ?? null;
  }

  /**
   * Has `name` EVER been allocated in this workspace — current or retired?
   *
   * The question a create/re-address request must ask, and the reason it is not
   * "is it currently taken": a retired name is permanently unavailable, so a
   * check that ignored `retired_at` would report a free address and then abort on
   * the primary key. One question, one answer, matching the key exactly.
   */
  isAllocated(workspaceId: string, name: string): boolean {
    const row = this.db
      .prepare<[string, string], { one: number }>(
        `SELECT 1 AS one FROM conversation_names
          WHERE workspace_id = ? AND name = ?`,
      )
      .get(workspaceId, name);
    return row !== undefined;
  }

  /**
   * Resolve an address: `workspaceId` + `name` → what it points at now.
   *
   * The four arms are the four genuinely different answers, and a caller that
   * collapsed any two of them would mislead its user:
   *
   *  - `ok` — the allocation is current and its conversation is there.
   *  - `retired` — the conversation is there but has been re-addressed. The
   *    retired row still names it, so the answer carries the SUCCESSOR address
   *    (null only in a half-state: retired with nothing allocated after it).
   *  - `conversation_gone` — the allocation exists, its conversation does not
   *    (per {@link NAME_TARGET_JOIN}: absent, not workspace-placed, or in another
   *    workspace). This arm is LOAD-BEARING: `conversation_id` carries no foreign
   *    key, so a delete path that forgot to retire the name leaves a row pointing
   *    at nothing — and the answer is still "gone", never a resolution onto a
   *    dangling id, and never onto some later conversation, since the name can
   *    never be re-allocated.
   *  - `unknown` — nothing was ever allocated under this name here.
   *
   * `conversation_gone` outranks `retired` on purpose: "it moved, here is where"
   * is only true while the thing still exists.
   */
  resolve(workspaceId: string, name: string): ConversationNameResolution {
    const row = this.db
      .prepare<[string, string], {
        retired_at: number | null;
        conversation_id: string | null;
        successor_name: string | null;
      }>(
        `SELECT n.retired_at                                   AS retired_at,
                c.id                                           AS conversation_id,
                (SELECT cur.name FROM conversation_names cur
                  WHERE cur.conversation_id = n.conversation_id
                    AND cur.retired_at IS NULL)                AS successor_name
           FROM conversation_names n
           LEFT JOIN conversations c
             ON ${NAME_TARGET_JOIN}
          WHERE n.workspace_id = ? AND n.name = ?`,
      )
      .get(workspaceId, name);
    if (row === undefined) return { kind: 'unknown' };
    // A LEFT JOIN carrying the same conjunction an INNER JOIN would: the miss is
    // what distinguishes `conversation_gone` from the two live arms, so the
    // predicate must not degrade to `c.id = n.conversation_id` here either.
    if (row.conversation_id === null) return { kind: 'conversation_gone' };
    if (row.retired_at === null) {
      return { kind: 'ok', conversationId: row.conversation_id };
    }
    return {
      kind: 'retired',
      conversationId: row.conversation_id,
      retiredAt: row.retired_at,
      successorName: row.successor_name,
    };
  }

  /**
   * Every workspace-placed conversation that has NO current name — the
   * consistency query for the totality the DB cannot state (see the class
   * docstring).
   *
   * Exposed as a repo face rather than left to a test's own SQL because it is the
   * shape a future health check or a post-migration assertion wants, and because
   * the definition of the violation should not be re-derived per caller. The
   * expected answer is the empty array; a non-empty one names channels whose
   * address a fault dropped.
   */
  listWorkspacePlacementsWithoutCurrentName(): string[] {
    return this.db
      .prepare<[], { id: string }>(
        `SELECT c.id AS id
           FROM conversations c
          WHERE c.placement_kind = 'workspace'
            AND NOT EXISTS (
              SELECT 1 FROM conversation_names n
               WHERE n.conversation_id = c.id AND n.retired_at IS NULL
            )
          ORDER BY c.created_at, c.id`,
      )
      .all()
      .map(row => row.id);
  }
}

/** What an address resolves to — see {@link ConversationNameRepo.resolve} for
 *  why each arm exists and why `conversation_gone` outranks `retired`. */
export type ConversationNameResolution =
  | { kind: 'ok'; conversationId: string }
  | {
      kind: 'retired';
      conversationId: string;
      retiredAt: number;
      /** The conversation's current address, or `null` in a half-state. */
      successorName: string | null;
    }
  | { kind: 'conversation_gone' }
  | { kind: 'unknown' };
