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
  firstStepOfEpoch,
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
    // then the build would publish an epoch containing a phantom step.
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
});
