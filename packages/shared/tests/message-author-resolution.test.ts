import { describe, expect, it } from 'vitest';
import {
  MessageAuthorDtoSchema,
  resolveMessageAuthor,
  type MessageAuthorLiveActor,
  type MessageAuthorRow,
} from '../src/index.js';

// #task:1791 — the pure, server-authoritative author resolver. It is the ONE
// place that decides active vs deleted vs unresolved from (a) the live-FK
// provenance (nulled by ON DELETE SET NULL) and (b) the send-time snapshot
// columns (which survive the delete). These are the falsification cells the
// feature is specified against; the backend integration test drives the same
// cells through real inserts/deletes/renames.

const agentRow = (over: Partial<MessageAuthorRow> = {}): MessageAuthorRow => ({
  from_kind: 'agent',
  from_agent_id: 'ag-1',
  from_user_id: null,
  author_id: 'ag-1',
  author_name: 'agent-handle',
  author_display_name: 'Agent Label',
  ...over,
});
const userRow = (over: Partial<MessageAuthorRow> = {}): MessageAuthorRow => ({
  from_kind: 'user',
  from_agent_id: null,
  from_user_id: 'us-1',
  author_id: 'us-1',
  author_name: 'user-handle',
  author_display_name: 'User Label',
  ...over,
});
const live = (over: Partial<MessageAuthorLiveActor> = {}): MessageAuthorLiveActor => ({
  name: 'live-handle',
  display_name: 'Live Label',
  avatar_url: '/api/agents/ag-1/avatar?v=7',
  runtime: 'claude',
  ...over,
});

describe('resolveMessageAuthor (#task:1791)', () => {
  it('system rows have no author (never a synthetic system tombstone)', () => {
    expect(
      resolveMessageAuthor(
        { from_kind: 'system', from_agent_id: null, from_user_id: null, author_id: null, author_name: null, author_display_name: null },
        null,
      ),
    ).toBeNull();
  });

  it('active: FK intact + live actor → CURRENT identity for both kinds', () => {
    expect(resolveMessageAuthor(agentRow(), live())).toEqual({
      kind: 'agent',
      status: 'active',
      id: 'ag-1',
      name: 'live-handle',
      display_name: 'Live Label',
      avatar_url: '/api/agents/ag-1/avatar?v=7',
      runtime: 'claude',
    });
    // active-user: no runtime, even if the live actor object carried a stray one
    // — the resolver forces `runtime: null` on the user arm.
    expect(
      resolveMessageAuthor(userRow(), live({ avatar_url: null })),
    ).toEqual({
      kind: 'user',
      status: 'active',
      id: 'us-1',
      name: 'live-handle',
      display_name: 'Live Label',
      avatar_url: null,
      runtime: null,
    });
  });

  it('active-agent carries the CURRENT runtime (drives the byline runtime glyph); a rename/runtime-switch propagates live', () => {
    // runtime is the live actor's CURRENT value, not a send-time snapshot — the
    // active-agent arm is the ONLY place runtime appears, and it is non-null by
    // construction so the renderer never handles an impossible null on the agent
    // branch.
    const dto = resolveMessageAuthor(agentRow(), live({ runtime: 'codex' }));
    expect(dto).toMatchObject({ kind: 'agent', status: 'active', runtime: 'codex' });
  });

  it('active-agent with a null live runtime fails closed to unresolved (agents.runtime is NOT NULL; a null is a loader fault, never a fabricated runtime)', () => {
    const dto = resolveMessageAuthor(agentRow(), live({ runtime: null }));
    expect(dto).toEqual({
      kind: 'agent',
      status: 'unresolved',
      id: null,
      name: null,
      display_name: null,
      avatar_url: null,
    });
  });

  it('renamed: the live actor overrides a STALE snapshot (snapshot is a delete-only fallback, never shadows a live rename)', () => {
    // The snapshot still holds the OLD handle/label; the FK is intact, so the
    // resolver must return the live actor's CURRENT values — proving the
    // snapshot never leaks into an active author.
    const row = agentRow({ author_name: 'old-handle', author_display_name: 'Old Label' });
    const dto = resolveMessageAuthor(row, live({ name: 'new-handle', display_name: 'New Label' }));
    expect(dto).toMatchObject({ status: 'active', name: 'new-handle', display_name: 'New Label' });
    // The stale snapshot values must NOT appear anywhere in the active DTO.
    expect(dto).not.toMatchObject({ name: 'old-handle' });
    expect(dto).not.toMatchObject({ display_name: 'Old Label' });
  });

  it('failed-delete: an FK that is still intact stays active even when a snapshot exists (never prematurely deleted)', () => {
    // A refused/rolled-back delete leaves from_*_id populated — the resolver must
    // read that as "actor still exists" and return active, never guessing deleted
    // just because a snapshot is present.
    const dto = resolveMessageAuthor(agentRow(), live());
    expect(dto).toMatchObject({ status: 'active', id: 'ag-1' });
  });

  it('fail-closed: FK intact + a complete snapshot but NO live actor is unresolved, NEVER deleted', () => {
    // FK intact ⇒ referential integrity says the actor still exists, so a missing
    // liveActor is a loader/consistency fault, not a deletion. The resolver must
    // NOT consult the snapshot and dress a still-living actor as `deleted`
    // (a directory miss must never be laundered into a deletion). It fails closed
    // to `unresolved` instead — and specifically does not surface the snapshot id.
    const dto = resolveMessageAuthor(agentRow(), null);
    expect(dto).toEqual({
      kind: 'agent',
      status: 'unresolved',
      id: null,
      name: null,
      display_name: null,
      avatar_url: null,
    });
    // The snapshot id must NOT leak — else two such faults would aggregate and a
    // living actor would be grouped under a "deleted"-looking byline.
    expect(dto).not.toMatchObject({ status: 'deleted' });
    expect(dto).not.toMatchObject({ id: 'ag-1' });
  });

  it('deleted: FK nulled but a complete snapshot names the gone actor (avatar always null)', () => {
    const dto = resolveMessageAuthor(
      agentRow({ from_agent_id: null }),
      null,
    );
    expect(dto).toEqual({
      kind: 'agent',
      status: 'deleted',
      id: 'ag-1',
      name: 'agent-handle',
      display_name: 'Agent Label',
      avatar_url: null,
    });
    // A deleted agent must NOT leak any runtime — it is not snapshotted, and the
    // deleted arm structurally has no runtime field.
    expect(dto).not.toHaveProperty('runtime');
  });

  it('deleted: display_name falls back to the snapshot name when the snapshot label is null', () => {
    const dto = resolveMessageAuthor(
      userRow({ from_user_id: null, author_display_name: null }),
      null,
    );
    expect(dto).toEqual({
      kind: 'user',
      status: 'deleted',
      id: 'us-1',
      name: 'user-handle',
      display_name: 'user-handle',
      avatar_url: null,
    });
  });

  it('unresolved / legacy-unknown: FK nulled AND no snapshot → id=null, non-aggregating, kind preserved', () => {
    // A pre-snapshot-column row whose actor was already deleted: we can prove the
    // identity is unrecoverable, NOT that it was deleted, and id=null means two
    // such authors never collapse into one byline.
    const agent = resolveMessageAuthor(
      agentRow({ from_agent_id: null, author_id: null, author_name: null, author_display_name: null }),
      null,
    );
    expect(agent).toEqual({
      kind: 'agent',
      status: 'unresolved',
      id: null,
      name: null,
      display_name: null,
      avatar_url: null,
    });
    // kind still discriminates "Unknown agent" vs "Unknown user".
    const user = resolveMessageAuthor(
      userRow({ from_user_id: null, author_id: null, author_name: null, author_display_name: null }),
      null,
    );
    expect(user).toMatchObject({ kind: 'user', status: 'unresolved', id: null });
  });

  it('a partial snapshot (id without name) cannot masquerade as deleted → unresolved', () => {
    // The deleted arm requires BOTH author_id and author_name; a torn snapshot
    // must not synthesize a half-named "deleted" author.
    const dto = resolveMessageAuthor(
      agentRow({ from_agent_id: null, author_name: null, author_display_name: null }),
      null,
    );
    expect(dto).toMatchObject({ status: 'unresolved', id: null });
  });

  it('every non-null result satisfies the discriminated-union schema', () => {
    const cases: Array<[MessageAuthorRow, MessageAuthorLiveActor | null]> = [
      [agentRow(), live()],
      [agentRow({ from_agent_id: null }), null],
      [agentRow({ from_agent_id: null, author_id: null, author_name: null, author_display_name: null }), null],
      [userRow(), live({ avatar_url: null })],
      [userRow({ from_user_id: null }), null],
    ];
    for (const [row, actor] of cases) {
      const dto = resolveMessageAuthor(row, actor);
      expect(() => MessageAuthorDtoSchema.parse(dto)).not.toThrow();
    }
  });
});
