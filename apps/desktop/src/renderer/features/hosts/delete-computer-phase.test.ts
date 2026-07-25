import { describe, expect, it } from 'vitest';
import { ComputerHasPendingAgentsError } from './hooks';
import {
  resolveDeleteComputerPhase,
  resolveDeleteFailure,
} from './delete-computer-phase';
import type {
  HostResourcesResponse,
  HostWorkspaceResource,
} from '@silverhand/shared';

/**
 * #task:1618 — the delete-computer dialog's structural branch.
 *
 * These pin *behavior*, not painting: "arm an irreversible confirm", "refuse and
 * name the blocker", "wait for the read" and "refuse because the read failed" are
 * decisions a later refactor must not quietly merge. In particular the
 * unknown-vs-empty distinction has no visual tell — both would render a confirm
 * with no impact blocks — so only a test keeps a future simplification from
 * folding a failed read into "nothing on it".
 */
describe('resolveDeleteComputerPhase', () => {
  const agent = {
    id: 'a1',
    name: 'norman',
    display_name: 'Norman',
    runtime: 'claude' as const,
  };
  const ws = (
    over: Partial<HostWorkspaceResource> = {},
  ): HostWorkspaceResource => ({
    id: 'w1',
    name: 'silverhand',
    workspace_path: '/Users/shiki/workspace/silverhand',
    viewer_role: 'owner',
    ...over,
  });
  const ready = (data: HostResourcesResponse) => ({
    isPending: false,
    isFetching: false,
    isError: false,
    data,
  });

  it('arms the confirm and carries both lists once the read lands', () => {
    const phase = resolveDeleteComputerPhase(
      ready({ agents: [agent], workspaces: [ws()] }),
    );
    expect(phase.kind).toBe('confirm');
    if (phase.kind !== 'confirm') return;
    expect(phase.agents).toHaveLength(1);
    expect(phase.workspaces).toHaveLength(1);
  });

  it('treats an empty computer as a legitimate read, not a missing one', () => {
    // A dedicated read-only query answering "nothing" is a fact. The dialog shows
    // the plain confirm — this is exactly the case an earlier revision wrongly
    // blocked (it inherited a guard written for an EMPTY 409 PAYLOAD, where
    // "named nothing" really did mean "cannot be shown").
    const phase = resolveDeleteComputerPhase(
      ready({ agents: [], workspaces: [] }),
    );
    expect(phase.kind).toBe('confirm');
  });

  it('waits instead of arming the confirm while the first read is in flight', () => {
    expect(
      resolveDeleteComputerPhase({
        isPending: true,
        isFetching: true,
        isError: false,
        data: undefined,
      }).kind,
    ).toBe('loading');
  });

  it('waits on a REOPEN refetch even though last open left rows in cache', () => {
    // Cindy #task:1618 BLOCKER. `staleTime: 0` refetches on reopen but does not
    // drop the cached list, so this exact state — settled data, not pending,
    // still fetching — is the ordinary second-open path. Arming Delete here would
    // confirm against the PREVIOUS visit's impact: a computer that was empty then
    // and holds a workspace now would be destroyed from a screen showing nothing.
    expect(
      resolveDeleteComputerPhase({
        isPending: false,
        isFetching: true,
        isError: false,
        data: { agents: [], workspaces: [] },
      }).kind,
    ).toBe('loading');
  });

  it('fails closed when the read fails — never falls back to "assume empty"', () => {
    // The whole fail-closed seam. `unavailable` renders no Delete at all; a
    // regression to `confirm` here would delete a full computer on a read the
    // dialog knows it did not get.
    expect(
      resolveDeleteComputerPhase({
        isPending: false,
        isFetching: false,
        isError: true,
        data: undefined,
      }).kind,
    ).toBe('unavailable');
  });

  it('prefers the failure over data cached from an earlier open', () => {
    // Stale rows are not a substitute for a read we know failed: for an
    // irreversible action, "couldn't check" must show as "couldn't check".
    expect(
      resolveDeleteComputerPhase({
        isPending: false,
        isFetching: false,
        isError: true,
        data: { agents: [], workspaces: [] },
      }).kind,
    ).toBe('unavailable');
  });

  it('keeps Delete unavailable while retrying from a failed read', () => {
    // Retry leaves the error set until the refetch settles; `isError` is checked
    // first so the screen cannot flip to a confirmable phase mid-retry.
    expect(
      resolveDeleteComputerPhase({
        isPending: false,
        isFetching: true,
        isError: true,
        data: undefined,
      }).kind,
    ).toBe('unavailable');
  });

  it('blocks and names the workspaces this viewer does not own', () => {
    const phase = resolveDeleteComputerPhase(
      ready({
        agents: [],
        workspaces: [ws(), ws({ id: 'w2', name: 'theirs', viewer_role: 'admin' })],
      }),
    );
    expect(phase.kind).toBe('blocked');
    if (phase.kind !== 'blocked') return;
    expect(phase.unauthorized.map(w => w.name)).toEqual(['theirs']);
  });

  it('treats no membership at all as unowned', () => {
    const phase = resolveDeleteComputerPhase(
      ready({ agents: [], workspaces: [ws({ viewer_role: null })] }),
    );
    expect(phase.kind).toBe('blocked');
  });

  it('reads only `owner` as cascade-able — member is not enough', () => {
    // `viewer_role` is a resource fact; the "can this be cascaded" reading is
    // this consumer's, and only the owner gate the DELETE re-checks will pass.
    const phase = resolveDeleteComputerPhase(
      ready({ agents: [], workspaces: [ws({ viewer_role: 'member' })] }),
    );
    expect(phase.kind).toBe('blocked');
  });
});

describe('resolveDeleteFailure', () => {
  it('keeps a materializing agent on its own transient axis', () => {
    // Its own screen because the preview does NOT predict this state, so a
    // failed DELETE is the only place the user can learn it.
    expect(resolveDeleteFailure(new ComputerHasPendingAgentsError(1))).toBe(
      'pending',
    );
  });

  it('folds every other failure into the generic line', () => {
    // `has_dependents` / `workspace_forbidden` describe facts the preview already
    // showed. Reaching them means drift or a caller that skipped the preview —
    // naming them again would rebuild discovery-through-error.
    expect(resolveDeleteFailure(new Error('offline'))).toBe('generic');
  });
});
