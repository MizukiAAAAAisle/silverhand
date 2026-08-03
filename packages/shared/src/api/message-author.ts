// Bounded-context-neutral author value object (#task:1791). Extracted from
// message.ts so BOTH the message context and the thread-discovery context
// (thread-summary.ts) can share ONE author contract + resolver without an
// import cycle (message.ts <-> thread-summary.ts). Re-exported via
// api/index.ts -> @silverhand/shared.
import { z } from 'zod';
import { FromKindSchema, RuntimeKindSchema, type RuntimeKind } from '../db/schema.js';

/** Server-resolved presentation of a message/thread author (#task:1791).
 *
 *  WHY THIS EXISTS: `messages.from_agent_id` / `from_user_id` are
 *  `ON DELETE SET NULL`, so once an actor is hard-deleted the renderer's
 *  live roster join can no longer name the historical author and every such
 *  message degrades to a generic "@agent". This DTO makes authorship a
 *  server-authoritative fact so the renderer consumes ONE source instead of
 *  re-joining the directory by id (and guessing "deleted" from a directory
 *  miss). The author is `null` for `from_kind='system'` — system is not an
 *  actor and has no identity DTO (do NOT synthesize a system tombstone).
 *
 *  A discriminated union on `status` locks the valid field combinations at the
 *  schema layer (not via comments):
 *   - `active`     — the actor row still exists (its FK is intact); `name` /
 *                    `display_name` / `avatar_url` are the actor's CURRENT
 *                    values (a rename/avatar change propagates live), NOT the
 *                    send-time snapshot. The active arm is split by `kind` so an
 *                    illegal combination is UNCONSTRUCTABLE, not merely
 *                    test-forbidden: an `agent` author carries a non-null
 *                    `runtime` (the current runtime kind, driving the byline's
 *                    runtime glyph when the agent has no custom avatar), and a
 *                    `user` author carries `runtime: null` (users have no
 *                    runtime). `runtime` is CURRENT (rides the same
 *                    `agent_changed` invalidation as name/avatar), never
 *                    snapshotted — so it exists ONLY on the active-agent arm.
 *   - `deleted`    — the actor was hard-deleted; the FK is null but a complete
 *                    send-time snapshot (`author_id` + `author_name`) names it.
 *                    `avatar_url` is always null (no avatar bytes are
 *                    snapshotted → a deleted author renders a neutral avatar).
 *                    No `runtime`: it is not snapshotted, so a deleted author
 *                    can NEVER leak a stale/current runtime.
 *   - `unresolved` — the FK is null AND no snapshot survives (a row that
 *                    predates the snapshot columns whose actor was already
 *                    deleted). Everything is null; we can prove the identity is
 *                    unrecoverable, NOT that it was deleted, and we never guess
 *                    `deleted` from an FK null. `id=null` is DELIBERATELY
 *                    non-aggregating: two `unresolved` authors are NEVER the
 *                    same author (synthesizing distinct lost actors into one
 *                    "unknown" byline is a false fact). `kind` survives via the
 *                    NOT-NULL `from_kind` so the renderer can still say
 *                    "Unknown agent" vs "Unknown user".
 *
 *  Only `active`/`deleted` carry a stable `id` and aggregate by it (consecutive
 *  message grouping, distinct repliers). `avatar_url` is the SAME relative,
 *  cache-busted API URL as `AgentDto.avatar_url` / `UserDto.avatar_url` — never
 *  a storage key. */
const MessageAuthorIdentitySchema = z.object({
  kind: z.enum(['agent', 'user']),
  id: z.string(),
  name: z.string(),
  display_name: z.string(),
});
/** Shared fields of an `active` author (both kinds), minus `kind`/`runtime`
 *  which the per-kind arms pin so illegal combinations can't be constructed. */
const ActiveAuthorBaseSchema = z.object({
  status: z.literal('active'),
  id: z.string(),
  name: z.string(),
  display_name: z.string(),
  /** Actor's CURRENT avatar URL, or null when they have no avatar. */
  avatar_url: z.string().nullable(),
});
export const MessageAuthorDtoSchema = z.union([
  // active + agent: a non-null current runtime is guaranteed at the type layer.
  ActiveAuthorBaseSchema.extend({
    kind: z.literal('agent'),
    runtime: RuntimeKindSchema,
  }),
  // active + user: users have no runtime — pinned null, never absent-but-typed.
  ActiveAuthorBaseSchema.extend({
    kind: z.literal('user'),
    runtime: z.null(),
  }),
  MessageAuthorIdentitySchema.extend({
    status: z.literal('deleted'),
    /** Always null: no avatar bytes are snapshotted. */
    avatar_url: z.null(),
  }),
  z.object({
    kind: z.enum(['agent', 'user']),
    status: z.literal('unresolved'),
    id: z.null(),
    name: z.null(),
    display_name: z.null(),
    avatar_url: z.null(),
  }),
]);
export type MessageAuthorDto = z.infer<typeof MessageAuthorDtoSchema>;

/** The CURRENT presentation of a still-existing actor, as the resolver needs
 *  it to build an `active` author. The backend builds this from the live
 *  `agents`/`users` row (its `avatar_url` uses the SAME relative, cache-busted
 *  API URL as AgentDto/UserDto — never a storage key). */
export interface MessageAuthorLiveActor {
  name: string;
  display_name: string;
  avatar_url: string | null;
  /** The actor's CURRENT runtime kind, or null when the actor is a user (users
   *  have no runtime). Non-null iff the actor is an agent — the carrier reads it
   *  from `agents.runtime` (NOT NULL) and passes null for a user row. Feeds the
   *  active-agent arm's non-null `runtime`. */
  runtime: RuntimeKind | null;
}

/** The raw author evidence carried by a message row (or any author-bearing
 *  projection row): the live provenance FKs (nulled by ON DELETE SET NULL) plus
 *  the send-time snapshot columns (which survive the delete). */
export interface MessageAuthorRow {
  from_kind: z.infer<typeof FromKindSchema>;
  from_agent_id: string | null;
  from_user_id: string | null;
  author_id: string | null;
  author_name: string | null;
  author_display_name: string | null;
}

/** Server-authoritative author resolution (#task:1791). Pure: the caller
 *  supplies `liveActor` (the CURRENT actor row) when the provenance FK still
 *  resolves, and null otherwise. The FK being non-null is itself the proof the
 *  actor still exists (ON DELETE SET NULL nulls it exactly on delete), so it —
 *  not a separate existence probe — discriminates `active` from `deleted`.
 *  Never guesses `deleted` from an FK null without a surviving snapshot, and
 *  never guesses `deleted` from an FK that is still intact. */
export function resolveMessageAuthor(
  row: MessageAuthorRow,
  liveActor: MessageAuthorLiveActor | null,
): MessageAuthorDto | null {
  if (row.from_kind === 'system') return null;
  const kind = row.from_kind; // 'agent' | 'user'
  const fkId = kind === 'agent' ? row.from_agent_id : row.from_user_id;
  if (fkId !== null) {
    // FK intact ⇒ the actor row MUST still exist (ON DELETE SET NULL nulls the
    // FK exactly on delete; referential integrity forbids a dangling FK). So the
    // snapshot is NOT consulted here: `deleted`'s only valid evidence is an FK
    // that has been nulled. A missing `liveActor` while the FK is intact is a
    // loader/consistency fault, NOT a deletion — fail closed to `unresolved`
    // (never fabricate `deleted`, never crash the read path) rather than dress a
    // still-living actor as gone.
    if (liveActor === null) return unresolvedAuthor(kind);
    if (kind === 'agent') {
      // agents.runtime is NOT NULL, so a live agent always carries one. A null
      // here is the same class of loader/consistency fault as a missing
      // liveActor → fail closed to `unresolved` rather than fabricate a runtime.
      if (liveActor.runtime === null) return unresolvedAuthor('agent');
      return {
        kind: 'agent',
        status: 'active',
        id: fkId,
        name: liveActor.name,
        display_name: liveActor.display_name,
        avatar_url: liveActor.avatar_url,
        runtime: liveActor.runtime, // CURRENT (rename/avatar/runtime propagate).
      };
    }
    // active user: no runtime (users have none).
    return {
      kind: 'user',
      status: 'active',
      id: fkId,
      name: liveActor.name,
      display_name: liveActor.display_name,
      avatar_url: liveActor.avatar_url,
      runtime: null,
    };
  }
  if (row.author_id !== null && row.author_name !== null) {
    // FK nulled (actor hard-deleted) but a complete send-time snapshot names it.
    return {
      kind,
      status: 'deleted',
      id: row.author_id,
      name: row.author_name,
      // display_name is NOT NULL at the source; `?? name` is only a defensive
      // floor so the resolved arm's `display_name: string` never breaks.
      display_name: row.author_display_name ?? row.author_name,
      avatar_url: null,
    };
  }
  // FK nulled and no snapshot: identity is unrecoverable (never fabricated as
  // deleted). id=null makes this deliberately non-aggregating.
  return unresolvedAuthor(kind);
}

/** The single terminal `unresolved` value — an identity we cannot ASSERT, from
 *  either a legacy row with no snapshot or an FK-intact/live-missing fault. Both
 *  causes must produce the same non-aggregating, everything-null author. */
function unresolvedAuthor(kind: 'agent' | 'user'): MessageAuthorDto {
  return {
    kind,
    status: 'unresolved',
    id: null,
    name: null,
    display_name: null,
    avatar_url: null,
  };
}
