import { describe, expect, it } from 'vitest';
import { BASELINE_MIGRATION_STEP } from '../src/db/baseline-schema.js';
import { CURRENT_MIGRATION_STEP, migrations } from '../src/db/migrations.js';
import {
  CURRENT_SCHEMA_EPOCH,
  MIN_SUPPORTED_MIGRATION_STEP,
  MIN_SUPPORTED_SCHEMA_EPOCH,
  ONE_TO_ONE_EPOCH_CEILING_STEP,
  SCHEMA_EPOCH_MANIFEST,
  assertSchemaEpochManifest,
  assertSupportPolicyFloors,
  classifyMigrationLedger,
  epochForMigrationStep,
  firstStepOfEpoch,
  reportedEpochForAppliedStep,
} from '../src/db/schema-epochs.js';

/**
 * The static half of #task:2103. Everything here is pure — the manifest is the
 * only thing that has to be true before a single migration runs, so it is fenced
 * without a database.
 */
describe('schema epoch manifest', () => {
  it('covers exactly the steps this build ships', () => {
    // The one rule that makes "one release, one epoch bump" checked instead of
    // remembered: adding a migration step without extending (or opening) an
    // epoch trips this, and so does declaring an epoch nobody implements.
    expect(() => assertSchemaEpochManifest()).not.toThrow();
    const last = SCHEMA_EPOCH_MANIFEST[SCHEMA_EPOCH_MANIFEST.length - 1]!;
    expect(last.lastStep).toBe(CURRENT_MIGRATION_STEP);
    expect(last.epoch).toBe(CURRENT_SCHEMA_EPOCH);
  });

  it('starts where the 1:1 history ends and leaves no step unclaimed', () => {
    expect(SCHEMA_EPOCH_MANIFEST[0]!.firstStep).toBe(ONE_TO_ONE_EPOCH_CEILING_STEP + 1);
    for (const step of migrations.map((m) => m.version)) {
      expect(epochForMigrationStep(step)).not.toBeNull();
    }
    // The baseline is inside the 1:1 region, where epoch IS step.
    expect(epochForMigrationStep(MIN_SUPPORTED_MIGRATION_STEP)).toBe(MIN_SUPPORTED_MIGRATION_STEP);
    expect(epochForMigrationStep(0)).toBeNull();
    expect(epochForMigrationStep(CURRENT_MIGRATION_STEP + 1)).toBeNull();
  });

  it('rejects a plan whose last step no epoch claims', () => {
    expect(() =>
      assertSchemaEpochManifest({
        plan: [...migrations, { version: CURRENT_MIGRATION_STEP + 1 }],
      }),
    ).toThrow(/migration step\(s\) \d+ belong to no epoch/);
  });

  it('rejects a manifest range that claims a step this build never defines', () => {
    // The reverse direction of coverage. "Every migration is inside some range"
    // passes happily while a range claims a step no ledger can ever contain, and
    // then `epochForMigrationStep` answers for a phantom.
    const holed = migrations
      .filter((m) => m.version !== CURRENT_MIGRATION_STEP - 1)
      .map((m) => ({ version: m.version }));
    expect(() => assertSchemaEpochManifest({ plan: holed })).toThrow(
      /claim step\(s\) \d+ that this build does not define/,
    );
  });

  it('keeps released epochs a prefix of the manifest', () => {
    let sawUnreleased = false;
    for (const entry of SCHEMA_EPOCH_MANIFEST) {
      if (!entry.released) sawUnreleased = true;
      else expect(sawUnreleased).toBe(false);
    }
    const open = SCHEMA_EPOCH_MANIFEST.at(-1)!;
    expect(() =>
      assertSchemaEpochManifest({
        manifest: [
          ...SCHEMA_EPOCH_MANIFEST.slice(0, -1),
          { ...open, released: false },
          {
            epoch: open.epoch + 1,
            firstStep: open.lastStep + 1,
            lastStep: open.lastStep + 1,
            released: true,
            releasedIn: 'synthetic',
          },
        ],
        plan: [...migrations, { version: open.lastStep + 1 }],
      }),
    ).toThrow(/released epochs are a prefix/);
  });

  it('rejects a second unreleased epoch', () => {
    // Two open epochs would let ONE unshipped build bump the outward number
    // twice, which is the whole thing this ticket exists to prevent. New steps
    // must extend the open epoch instead of opening another.
    const open = SCHEMA_EPOCH_MANIFEST.at(-1)!;
    expect(() =>
      assertSchemaEpochManifest({
        manifest: [
          ...SCHEMA_EPOCH_MANIFEST.slice(0, -1),
          { ...open, released: false },
          {
            epoch: open.epoch + 1,
            firstStep: open.lastStep + 1,
            lastStep: open.lastStep + 1,
            released: false,
          },
        ],
        plan: [...migrations, { version: open.lastStep + 1 }],
      }),
    ).toThrow(/is a second unreleased epoch/);
  });

  it('states released-ness with auditable evidence, not a bare boolean', () => {
    // `released: true` requires `releasedIn` at the type level, so an entry cannot
    // claim it shipped without naming the published build that makes that true.
    // What the fence cannot prove — that a released epoch was never extended —
    // is stated in `SchemaEpochEntry.released` instead of implied.
    for (const entry of SCHEMA_EPOCH_MANIFEST) {
      if (entry.released) expect(entry.releasedIn.length).toBeGreaterThan(0);
    }
  });
});

describe('the two floors', () => {
  it('derives the runner step floor from the support-policy epoch', () => {
    expect(() => assertSupportPolicyFloors()).not.toThrow();
    expect(firstStepOfEpoch(MIN_SUPPORTED_SCHEMA_EPOCH)).toBe(MIN_SUPPORTED_MIGRATION_STEP);
    expect(MIN_SUPPORTED_SCHEMA_EPOCH).toBeLessThanOrEqual(CURRENT_SCHEMA_EPOCH);
  });

  it('never lets support policy promise a step below the baseline CREATE', () => {
    expect(MIN_SUPPORTED_MIGRATION_STEP).toBeGreaterThanOrEqual(BASELINE_MIGRATION_STEP);
  });

  it('resolves epoch boundaries in both regions', () => {
    expect(firstStepOfEpoch(ONE_TO_ONE_EPOCH_CEILING_STEP)).toBe(ONE_TO_ONE_EPOCH_CEILING_STEP);
    expect(firstStepOfEpoch(CURRENT_SCHEMA_EPOCH)).toBe(SCHEMA_EPOCH_MANIFEST.at(-1)!.firstStep);
    expect(firstStepOfEpoch(0)).toBeNull();
    expect(firstStepOfEpoch(CURRENT_SCHEMA_EPOCH + 1)).toBeNull();
  });

  it('places a mid-epoch step below its own epoch floor, so no third refusal is possible', () => {
    // Why the guard needs only two too-old texts: a DB inside a supported epoch
    // but below that epoch's first step cannot exist — it would report the
    // previous epoch, which is what the policy comparison already covers.
    const entry = SCHEMA_EPOCH_MANIFEST.at(-1)!;
    if (entry.lastStep > entry.firstStep) {
      expect(reportedEpochForAppliedStep(entry.firstStep)).toBeLessThan(entry.epoch);
    }
  });
});

describe('reportedEpochForAppliedStep', () => {
  it('is the identity in the 1:1 region', () => {
    expect(reportedEpochForAppliedStep(0)).toBe(0);
    expect(reportedEpochForAppliedStep(44)).toBe(44);
    expect(reportedEpochForAppliedStep(ONE_TO_ONE_EPOCH_CEILING_STEP)).toBe(
      ONE_TO_ONE_EPOCH_CEILING_STEP,
    );
  });

  it('reports the PREVIOUS epoch until the epoch is complete', () => {
    const entry = SCHEMA_EPOCH_MANIFEST[0]!;
    expect(reportedEpochForAppliedStep(entry.firstStep)).toBe(ONE_TO_ONE_EPOCH_CEILING_STEP);
    expect(reportedEpochForAppliedStep(entry.lastStep - 1)).toBe(ONE_TO_ONE_EPOCH_CEILING_STEP);
    expect(reportedEpochForAppliedStep(entry.lastStep)).toBe(entry.epoch);
  });
});

describe('classifyMigrationLedger', () => {
  const plan = [{ version: 44 }, { version: 45 }, { version: 46 }];

  it('reports a fresh DB as not having started the next epoch', () => {
    // In the 1:1 region each step IS an epoch, so the next epoch is the next
    // step's own number.
    expect(classifyMigrationLedger([], plan)).toEqual({
      kind: 'ok',
      progress: { kind: 'not_started', epoch: 44, nextStep: 44 },
    });
    // Between two 1:1 epochs there is no "partial": finishing a step finishes
    // its epoch, so the verdict is `not_started` on the NEXT one.
    expect(classifyMigrationLedger([44, 45], plan)).toEqual({
      kind: 'ok',
      progress: { kind: 'not_started', epoch: 46, nextStep: 46 },
    });
  });

  it('reports a legal prefix INSIDE a multi-step epoch as partial', () => {
    // This is the state a crash mid-upgrade leaves behind, and the only state
    // from which resuming is legal: applied is a prefix, so the runner knows
    // exactly which step comes next.
    const entry = SCHEMA_EPOCH_MANIFEST[0]!;
    const slice = migrations
      .filter((m) => m.version >= entry.lastStep - 1)
      .map((m) => ({ version: m.version }));
    expect(classifyMigrationLedger([entry.lastStep - 1], slice)).toEqual({
      kind: 'ok',
      progress: {
        kind: 'partial',
        epoch: entry.epoch,
        appliedThroughStep: entry.lastStep - 1,
        nextStep: entry.lastStep,
      },
    });
  });

  it('reports a fully applied plan as complete at the epoch it reached', () => {
    expect(classifyMigrationLedger([44, 45, 46], plan)).toEqual({
      kind: 'ok',
      progress: { kind: 'complete', epoch: 46 },
    });
  });

  it('never calls a mid-epoch stop complete', () => {
    // A plan slice that ends inside an unreleased epoch is fully applied AND has
    // not reached that epoch. Saying "complete: 69" here is the one lie that
    // would let a partial database look shipped.
    const entry = SCHEMA_EPOCH_MANIFEST[0]!;
    const slice = migrations
      .filter((m) => m.version <= entry.lastStep - 1)
      .map((m) => ({ version: m.version }));
    const verdict = classifyMigrationLedger(
      slice.map((m) => m.version),
      slice,
    );
    expect(verdict).toEqual({
      kind: 'ok',
      progress: { kind: 'complete', epoch: entry.epoch - 1 },
    });
  });

  it('fails loud on a hole below the highest applied step', () => {
    expect(classifyMigrationLedger([44, 46], plan)).toEqual({
      kind: 'inconsistent',
      appliedThroughStep: 46,
      missingSteps: [45],
      unexpectedSteps: [],
    });
  });

  it('fails loud on an in-range step the plan does not define', () => {
    expect(classifyMigrationLedger([44, 45], [{ version: 44 }, { version: 46 }])).toEqual({
      kind: 'inconsistent',
      appliedThroughStep: 45,
      missingSteps: [],
      unexpectedSteps: [45],
    });
  });

  it('ignores ledger rows below the plan floor', () => {
    // Pre-baseline history (v1..v43) is real in production ledgers and says
    // nothing about this build's plan.
    expect(classifyMigrationLedger([1, 2, 43, 44, 45, 46], plan)).toEqual({
      kind: 'ok',
      progress: { kind: 'complete', epoch: 46 },
    });
  });

  it('leaves rows above the plan to the newer-schema refusal', () => {
    // `runMigrations` owns that decision and evaluates it on max(step); this
    // classifier must not double-judge it as an unknown step.
    expect(classifyMigrationLedger([44, 45, 46, 999], plan)).toEqual({
      kind: 'ok',
      progress: { kind: 'complete', epoch: 46 },
    });
  });

  it('reads the real plan against the real ledger without complaint', () => {
    const steps = migrations.map((m) => m.version);
    expect(classifyMigrationLedger(steps, migrations)).toEqual({
      kind: 'ok',
      progress: { kind: 'complete', epoch: CURRENT_SCHEMA_EPOCH },
    });
  });
});
