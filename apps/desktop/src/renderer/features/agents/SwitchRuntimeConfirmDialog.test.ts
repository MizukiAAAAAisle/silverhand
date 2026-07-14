import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SRC = readFileSync(
  path.join(
    fileURLToPath(new URL('./SwitchRuntimeConfirmDialog.tsx', import.meta.url)),
  ),
  'utf8',
);

describe('SwitchRuntimeConfirmDialog invariants', () => {
  it('renders `errorMessage` inline so switch failures are visible above the modal overlay', () => {
    expect(SRC).toMatch(/errorMessage/);
    expect(SRC).toMatch(/role=["']alert["']/);
  });

  it('restores focus to `returnFocusRef` on close (Radix has no trigger to return to)', () => {
    expect(SRC).toMatch(/onCloseAutoFocus/);
    // Handler must preventDefault to override Radix's `<body>` fallback
    // AND focus the ref explicitly.
    expect(SRC).toMatch(
      /onCloseAutoFocus=\{[\s\S]*?e\.preventDefault\(\)[\s\S]*?focus\(\{\s*preventScroll:\s*true\s*\}\)/,
    );
  });
});
