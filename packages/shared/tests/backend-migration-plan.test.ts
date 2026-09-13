import { describe, expect, it } from 'vitest';
import contract from '../src/backend-migration-plan.json' with { type: 'json' };
import { BASELINE_MIGRATION_STEP } from '../src/db/baseline-schema.js';
import { CURRENT_MIGRATION_STEP, migrations } from '../src/db/migrations.js';
import { classifyMigrationLedger } from '../src/db/schema-epochs.js';

describe('backend migration-plan admission authority', () => {
  it('is signed by the real TypeScript migration plan', () => {
    const actual = migrations.map((migration) => migration.version);
    expect(contract.activeSteps).toEqual(actual);
    expect(contract.baselineStep).toBe(BASELINE_MIGRATION_STEP);
    expect(contract.currentStep).toBe(CURRENT_MIGRATION_STEP);
    expect(contract.activeSteps.at(0)).toBe(contract.baselineStep);
    expect(contract.activeSteps.at(-1)).toBe(contract.currentStep);
  });

  it('keeps historical ledger rows outside the active-plan verdict', () => {
    const plan = contract.activeSteps.map((version) => ({ version }));
    expect(classifyMigrationLedger(contract.activeSteps, plan)).toMatchObject({
      kind: 'ok',
      progress: { kind: 'complete' },
    });
    expect(
      classifyMigrationLedger(
        [...Array.from({ length: 43 }, (_, index) => index + 1), ...contract.activeSteps],
        plan,
      ),
    ).toMatchObject({ kind: 'ok', progress: { kind: 'complete' } });

    const hole = contract.activeSteps.filter((step) => step !== 63);
    expect(classifyMigrationLedger(hole, plan)).toMatchObject({
      kind: 'inconsistent',
      missingSteps: [63],
    });
    expect(classifyMigrationLedger(contract.activeSteps.slice(0, -1), plan)).toMatchObject({
      kind: 'ok',
      progress: { kind: 'not_started' },
    });
  });
});
