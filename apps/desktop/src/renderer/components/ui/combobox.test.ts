import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Combobox source fence — locks a load-bearing invariant that can't be
 * reached in a `node` vitest env (Popover mounts inside a Portal + Radix
 * DismissableLayer, both jsdom-only).
 *
 * The runtime bug this replaces: chevron's toggle path calls
 * `inputRef.focus()` after `setOpen(false)`; an onFocus handler that
 * re-opens would race with the close and produce a single-frame
 * flicker. Removing the auto-open-on-focus handler cuts the loop at
 * the source. If a future refactor re-introduces it, this test flags
 * it before it hits dogfood again. (#1472 shiki 2026-07-12.)
 */

const SRC = readFileSync(
  path.join(fileURLToPath(new URL('./combobox.tsx', import.meta.url))),
  'utf8',
);

describe('Combobox source invariants', () => {
  it('does NOT auto-open on input focus (regression: chevron-close → focus → reopen flicker)', () => {
    // The input element must have no `onFocus={...setOpen(true)...}` handler.
    // Opens via click, ArrowDown, or typing. Tab-focus never auto-opens
    // (WAI-ARIA combobox convention).
    expect(SRC).not.toMatch(/onFocus=\{[^}]*setOpen\(\s*true\s*\)/);
  });
});
