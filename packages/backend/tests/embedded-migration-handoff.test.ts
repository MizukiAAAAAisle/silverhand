import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CURRENT_MIGRATION_STEP } from '@silverhand/shared/db/migrations';
import { migrateAndCloseForEmbeddedHandoff } from '../src/embedded-migration-handoff.js';
import * as database from '../src/db.js';
import * as workspaceAudit from '../src/read-model/workspace-name-audit.js';

afterEach(() => vi.restoreAllMocks());

describe('migrateAndCloseForEmbeddedHandoff', () => {
  for (const auditFails of [false, true]) {
    it(`closes the actual opened handle when audits ${auditFails ? 'throw' : 'pass'}`, () => {
      const dbPath = join(mkdtempSync(join(tmpdir(), 'sh-handoff-')), 'silverhand.db');
      const realOpen = database.openDatabase;
      let opened: ReturnType<typeof realOpen> | undefined;
      vi.spyOn(database, 'openDatabase').mockImplementation((...args) => {
        opened = realOpen(...args);
        return opened;
      });
      if (auditFails) vi.spyOn(workspaceAudit, 'scanWorkspaceNameAddresses').mockImplementation(() => { throw new Error('audit failed'); });
      let step: number | null = null;
      const run = () => migrateAndCloseForEmbeddedHandoff(dbPath, {
        allowSchemaUpgrade: true, onMigrationResult: result => { step = result.afterStep; },
      });
      if (auditFails) expect(run).toThrow('audit failed');
      else expect(run).not.toThrow();
      expect(step).toBe(CURRENT_MIGRATION_STEP);
      expect(opened).toBeDefined();
      expect(opened!.open).toBe(false);
      if (!auditFails) {
        expect(run).not.toThrow();
        expect(opened!.open).toBe(false);
      }
    });
  }
});
