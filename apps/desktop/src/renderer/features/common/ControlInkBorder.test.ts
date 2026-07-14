import { describe, expect, it } from 'vitest';
import { CONTROL_INK_BORDER } from './ControlInkBorder';

// The shared control-chrome recipe is layered onto any Button variant. The one
// contract worth locking is a structural separation, not a visual value: the
// recipe must stay identity-only (border chrome) and NEVER carry fill/text —
// otherwise it would hijack the variant's fill/action hierarchy at every
// consumer, re-coupling the shared identity layer with per-variant colour.
// Exact token values, the hover-lift px, per-consumer occurrence counts, and
// per-variant hover-colour recipes are visual concerns, verified by dogfood.

describe('CONTROL_INK_BORDER stays chrome-only', () => {
  it('never carries fill or text colour (so it cannot hijack a variant)', () => {
    expect(CONTROL_INK_BORDER).not.toMatch(/\bbg-/);
    expect(CONTROL_INK_BORDER).not.toMatch(/\btext-/);
  });
});
