import { describe, expect, it } from 'vitest';
import contract from '../src/backend-migration-plan.json' with { type: 'json' };
import { BASELINE_MIGRATION_STEP } from '../src/db/baseline-schema.js';
import { CURRENT_MIGRATION_STEP, migrations } from '../src/db/migrations.js';

describe('backend migration-plan admission authority', () => {
  it('is signed by the real TypeScript migration plan', () => {
    const actual = migrations.map((migration) => migration.version);
    expect(contract.activeSteps).toEqual(actual);
    expect(contract.baselineStep).toBe(BASELINE_MIGRATION_STEP);
    expect(contract.currentStep).toBe(CURRENT_MIGRATION_STEP);
    expect(contract.activeSteps.at(0)).toBe(contract.baselineStep);
    expect(contract.activeSteps.at(-1)).toBe(contract.currentStep);
  });
});
