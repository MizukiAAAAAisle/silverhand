import { describe, expect, it } from 'vitest';
import {
  RUNTIME_CATALOG,
  RuntimeKindSchema,
  runtimeCatalogEntry,
} from '../src/index.js';
import fixture from './fixtures/offered-runtimes.json' with { type: 'json' };

/**
 * TypeScript half of the cross-language gate on which runtimes the product offers.
 * This side is the oracle: the values are derived from the real catalogue
 * (`RUNTIME_CATALOG` / `RuntimeKindSchema`), never restated, so signing the artifact
 * and checking it are the same act. The Rust half
 * (`rust/crates/backend-core/tests/runtime_catalog_parity.rs`) reads the same file and
 * holds `SELECTABLE_RUNTIMES` to it.
 */
describe('offered runtimes cross-language authority', () => {
  it('signs the picker list in the picker order', () => {
    const offered = RUNTIME_CATALOG.filter(entry => entry.selectable).map(
      entry => entry.kind,
    );
    expect(offered).toEqual(fixture.offered);
  });

  it('signs the kinds a row may hold that no picker offers', () => {
    const vocabularyOnly = RuntimeKindSchema.options
      .filter(kind => !runtimeCatalogEntry(kind).selectable)
      .sort();
    expect(vocabularyOnly).toEqual([...fixture.vocabularyOnly].sort());
  });

  it('covers every runtime kind exactly once across the two halves', () => {
    const signed = [...fixture.offered, ...fixture.vocabularyOnly].sort();
    expect(signed).toEqual([...RuntimeKindSchema.options].sort());
  });
});
