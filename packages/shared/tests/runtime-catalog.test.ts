import { describe, expect, it } from 'vitest';

import {
  RUNTIME_CATALOG,
  RUNTIME_ORDER_LIST,
  RuntimeKindSchema,
  ReasoningEffortSchema,
  reasoningEffortLabel,
  reasoningEffortValidForRuntime,
  runtimeCatalogCoversAllKinds,
  runtimeCatalogEntry,
  runtimeCliLabel,
  runtimeLabel,
  runtimeSupportsReasoningEffort,
} from '../src/index.js';

describe('runtime catalog (shared source of truth)', () => {
  it('covers every RuntimeKind exactly once, in order', () => {
    expect(runtimeCatalogCoversAllKinds()).toBe(true);
    expect([...RUNTIME_ORDER_LIST].sort()).toEqual(
      [...RuntimeKindSchema.options].sort(),
    );
    expect(RUNTIME_CATALOG.map(e => e.kind)).toEqual([...RUNTIME_ORDER_LIST]);
  });

  it('exposes short + CLI labels for every kind', () => {
    for (const kind of RuntimeKindSchema.options) {
      const entry = runtimeCatalogEntry(kind);
      expect(entry.kind).toBe(kind);
      expect(runtimeLabel(kind)).toBe(entry.label);
      expect(runtimeCliLabel(kind)).toBe(entry.cliLabel);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.cliLabel.length).toBeGreaterThan(0);
    }
  });

  it('only offers spawnable runtimes: selectable is a strict subset per product curation', () => {
    // claude/codex/qoder are the offered set today; cursor/gemini are
    // roadmap. The host-side test asserts selectable ⇒ hasDriver.
    const selectable = RUNTIME_CATALOG.filter(e => e.selectable).map(e => e.kind);
    expect(selectable).toEqual(['claude', 'codex', 'qoder']);
  });

  it('keeps every reasoning option inside the shared ReasoningEffort enum', () => {
    for (const entry of RUNTIME_CATALOG) {
      for (const opt of entry.reasoningEffortOptions) {
        expect(ReasoningEffortSchema.safeParse(opt).success).toBe(true);
      }
      // `runtimeSupportsReasoningEffort` mirrors the options list.
      expect(runtimeSupportsReasoningEffort(entry.kind)).toBe(
        entry.reasoningEffortOptions.length > 0,
      );
    }
  });

  it('keeps codex and qoder reasoning sets distinct (no forced abstraction)', () => {
    expect(runtimeCatalogEntry('codex').reasoningEffortOptions).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
    expect(runtimeCatalogEntry('qoder').reasoningEffortOptions).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    // claude has no reasoning control.
    expect(runtimeCatalogEntry('claude').reasoningEffortOptions).toEqual([]);
  });

  it('title-cases reasoning labels for display while values stay lowercase', () => {
    expect(reasoningEffortLabel('xhigh')).toBe('Xhigh');
    expect(reasoningEffortLabel('none')).toBe('None');
    expect(reasoningEffortLabel('max')).toBe('Max');
  });

  it('reasoningEffortValidForRuntime gates values to the runtime (null always ok)', () => {
    // null/undefined (unset) is always valid.
    expect(reasoningEffortValidForRuntime('codex', null)).toBe(true);
    expect(reasoningEffortValidForRuntime('codex', undefined)).toBe(true);
    // codex accepts its four, rejects qoder-only values.
    expect(reasoningEffortValidForRuntime('codex', 'high')).toBe(true);
    expect(reasoningEffortValidForRuntime('codex', 'max')).toBe(false);
    expect(reasoningEffortValidForRuntime('codex', 'none')).toBe(false);
    // qoder accepts the full canonical set.
    for (const v of ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(reasoningEffortValidForRuntime('qoder', v)).toBe(true);
    }
    // claude has no reasoning control → only null is valid.
    expect(reasoningEffortValidForRuntime('claude', 'low')).toBe(false);
    expect(reasoningEffortValidForRuntime('claude', null)).toBe(true);
  });
});
