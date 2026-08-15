import { describe, expect, it, vi } from 'vitest';
import { fixedWorkspaceName, formatWorkspaceAddressSegment } from '@silverhand/shared';
import { resolveRegularWorkspaceAddress } from '../src/application/workspace-address-resolution.js';
import {
  WorkspaceAddressFallbackWindow,
  hashWorkspaceAddressKey,
  logWorkspaceAddressAssignment,
  logWorkspaceAddressConflict,
  logWorkspaceAddressResolution,
  summarizeWorkspaceAddressDogfood,
  type WorkspaceAddressDogfoodEvent,
} from '../src/observability/workspace-address-log.js';
import { WorkspaceRepo } from '../src/repos/workspace-repo.js';
import type { BackendLogger } from '../src/context.js';
import { openTestDb } from './utils/db.js';

const logger = (): BackendLogger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe('workspace semantic address resolution', () => {
  it('round-trips the strict segment into the current regular workspace only', () => {
    const { db } = openTestDb();
    const workspaces = new WorkspaceRepo(db);
    const regularName = fixedWorkspaceName('设计/General');
    const regular = workspaces.insert({ name: regularName, description: null });
    const log = logger();
    expect(resolveRegularWorkspaceAddress(
      { workspaces, logger: log },
      formatWorkspaceAddressSegment(regularName),
    )).toEqual({ kind: 'found', workspace: regular });
    expect(resolveRegularWorkspaceAddress(
      { workspaces, logger: log },
      '设计%2fgeneral',
    )).toEqual({ kind: 'unresolved' });
    db.close();
  });

  it('deliberately rebinds an old token after rename releases its current key', () => {
    const { db } = openTestDb();
    const workspaces = new WorkspaceRepo(db);
    const oldName = fixedWorkspaceName('Roadmap');
    const oldToken = formatWorkspaceAddressSegment(oldName);
    const first = workspaces.insert({ name: oldName, description: null });
    workspaces.updateMutableMetadata(first.id, { name: fixedWorkspaceName('Planning') });
    const second = workspaces.insert({ name: fixedWorkspaceName('roadmap'), description: null });

    expect(resolveRegularWorkspaceAddress(
      { workspaces, logger: logger() },
      oldToken,
    )).toEqual({ kind: 'found', workspace: second });
    db.close();
  });

  it('reports unresolved/ambiguous without logging raw names', () => {
    const log = logger();
    const missingRepo = {
      listRegularByNameKey: () => [],
    } as unknown as WorkspaceRepo;
    expect(resolveRegularWorkspaceAddress(
      { workspaces: missingRepo, logger: log },
      'Secret%20Workspace',
    )).toEqual({ kind: 'unresolved' });
    const ambiguousRepo = {
      listRegularByNameKey: () => [{ id: 'a' }, { id: 'b' }],
    } as unknown as WorkspaceRepo;
    expect(resolveRegularWorkspaceAddress(
      { workspaces: ambiguousRepo, logger: log },
      'Secret%20Workspace',
    )).toEqual({ kind: 'ambiguous' });
    const serialized = JSON.stringify((log.warn as ReturnType<typeof vi.fn>).mock.calls);
    expect(serialized).not.toContain('Secret');
    expect(serialized).toContain(hashWorkspaceAddressKey('secret workspace'));
  });
});

describe('workspace address dogfood observation', () => {
  it('feeds the exact structured logger wire into the offline aggregator', () => {
    const log = logger();
    const oldHash = hashWorkspaceAddressKey('old');
    logWorkspaceAddressAssignment(log, {
      workspaceId: 'a',
      action: 'rename',
      oldKey: 'old',
      newKey: 'new',
    });
    logWorkspaceAddressAssignment(log, {
      workspaceId: 'b',
      action: 'create',
      oldKey: null,
      newKey: 'old',
    });
    logWorkspaceAddressConflict(log, { workspaceId: null, key: 'taken' });
    logWorkspaceAddressResolution(log, { outcome: 'unresolved', key: null, matches: 0 });
    logWorkspaceAddressResolution(log, { outcome: 'ambiguous', key: 'dupe', matches: 2 });
    const window = new WorkspaceAddressFallbackWindow();
    window.record('agent_home');
    window.record('agent_home');
    window.record('token_budget');
    window.flush(log);

    const emitted = (log.warn as ReturnType<typeof vi.fn>).mock.calls
      .map(call => call[0] as WorkspaceAddressDogfoodEvent);
    expect(emitted[0]).toMatchObject({
      workspace_address_event: 'assignment',
      workspace_id: 'a',
      old_key_hash: oldHash,
    });
    expect(summarizeWorkspaceAddressDogfood(emitted)).toEqual({
      assignments: 2,
      renames: 1,
      reuses: 1,
      conflicts: 1,
      unresolved: 1,
      ambiguous: 1,
      fallbacks: 3,
    });
  });

  it('aggregates high-frequency fallback and emits only on flush', () => {
    const log = logger();
    const window = new WorkspaceAddressFallbackWindow();
    window.record('agent_home');
    window.record('agent_home');
    window.record('token_budget');
    expect(log.warn).not.toHaveBeenCalled();
    expect(window.flush(log)).toBe(true);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(window.snapshot()).toEqual({ token_budget: 0, agent_home: 0, unrenderable: 0 });
    // A flush with nothing to say reports that it stayed silent, which is what an
    // interval-gated caller arms its clock on (#task:2021 P4-4): consuming the
    // window on an empty pass would delay the first REAL fallback by a whole
    // interval.
    expect(window.flush(log)).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
