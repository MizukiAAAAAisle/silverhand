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
  it('uses per-theme `--warning-surface` for the callout fill (not the amber tint)', () => {
    expect(SRC).toMatch(/bg-\[var\(--warning-surface\)\]/);
    expect(SRC).not.toMatch(/bg-warning-soft\b/);
  });

  it('renders the four consequence bullets with the target label interpolated', () => {
    expect(SRC).toContain(
      '<li>Runtime sessions for all conversations are reset.</li>',
    );
    expect(SRC).toContain('<li>Responses in progress stop.</li>');
    expect(SRC).toContain(
      '<li>{`Running conversations restart with ${label}.`}</li>',
    );
    expect(SRC).toContain('<li>Messages and memory are preserved.</li>');
    // The bullets sit inside a real `<ul>` so screen readers announce
    // them as a list, not a paragraph of run-on sentences.
    expect(SRC).toMatch(/<ul[^>]*list-disc/);
  });

  it('titles the dialog as a switch question and labels the primary button `Switch runtime`', () => {
    expect(SRC).toContain('`Switch to ${label}?`');
    expect(SRC).toContain('Switch runtime');
    expect(SRC).toContain('Cancel');
  });

  it('does not use the destructive Button variant', () => {
    expect(SRC).not.toMatch(/variant=["']danger["']/);
  });

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
