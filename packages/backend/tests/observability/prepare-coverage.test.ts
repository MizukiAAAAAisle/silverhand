import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guard for the prepareObserved migration (#task:1590): every query in these
 * owner files must go through `prepareObserved` so it stays inside the db
 * slow-statement / metrics observation. A bare `.prepare(...)` call here would
 * silently escape observation, so new queries in these files must use the
 * wrapper. Migration/DDL belongs in db.ts, which is deliberately exempt.
 *
 * This file is the SINGLE implementation of the rule (it absorbed the
 * original HostRepo-only `observed-query-coverage.test.ts`). The regex is
 * whitespace-tolerant on purpose: `.prepare (` and `.prepare <T>(...)` are
 * legal TypeScript and must also stay red here.
 */
const BARE_PREPARE = /\.prepare\s*(?:<|\()/;

const MIGRATED_OWNER_FILES = [
  '../../src/repos/host-repo.ts',
  '../../src/repos/message-repo.ts',
  '../../src/repos/conversation-read-repo.ts',
  '../../src/repos/task-repo.ts',
  '../../src/repos/task-board-read-model.ts',
  '../../src/repos/task-persistence.ts',
  '../../src/repos/notification-repo.ts',
  '../../src/read-model/activity.ts',
] as const;

function sourceOf(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    'utf8',
  );
}

describe('prepareObserved coverage', () => {
  for (const relativePath of MIGRATED_OWNER_FILES) {
    it(`keeps ${relativePath.replace('../../', '')} free of bare prepare calls`, () => {
      expect(sourceOf(relativePath)).not.toMatch(BARE_PREPARE);
    });
  }

  it('spot-pins stable query names per migrated owner', () => {
    // One representative name per owner: a rename shows up here as a
    // deliberate diff instead of silently rotating the metric series.
    expect(sourceOf('../../src/repos/host-repo.ts')).toContain(
      "'hosts.list_for_user'",
    );
    expect(sourceOf('../../src/repos/message-repo.ts')).toContain(
      "'messages.list_channel_threads'",
    );
    expect(sourceOf('../../src/repos/conversation-read-repo.ts')).toContain(
      "'reads.unread_counts_by_workspace'",
    );
    expect(sourceOf('../../src/repos/task-repo.ts')).toContain(
      "'tasks.list_filtered'",
    );
    expect(sourceOf('../../src/repos/notification-repo.ts')).toContain(
      "'notifications.unread_counts_by_workspace'",
    );
    expect(sourceOf('../../src/read-model/activity.ts')).toContain(
      "'activity.directed_notifications'",
    );
  });
});
