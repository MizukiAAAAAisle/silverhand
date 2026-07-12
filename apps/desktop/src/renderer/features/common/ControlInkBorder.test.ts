import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  CONTROL_HOVER_LIFT,
  CONTROL_INK_BORDER,
} from './ControlInkBorder';

const HOST_DETAIL_SRC = readFileSync(
  path.join(
    fileURLToPath(
      new URL('../hosts/HostDetailView.tsx', import.meta.url),
    ),
  ),
  'utf8',
);

const HOST_DIAGNOSTICS_SRC = readFileSync(
  path.join(
    fileURLToPath(
      new URL('../hosts/HostDiagnosticsAction.tsx', import.meta.url),
    ),
  ),
  'utf8',
);

const CONNECTION_PANE_SRC = readFileSync(
  path.join(
    fileURLToPath(
      new URL('../settings/ConnectionPane.tsx', import.meta.url),
    ),
  ),
  'utf8',
);

const strip = (s: string): string =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const HOST_DETAIL_CODE = strip(HOST_DETAIL_SRC);
const HOST_DIAGNOSTICS_CODE = strip(HOST_DIAGNOSTICS_SRC);
const CONNECTION_PANE_CODE = strip(CONNECTION_PANE_SRC);

describe('CONTROL_INK_BORDER', () => {
  it('carries both theme-owned border tokens and nothing else', () => {
    expect(CONTROL_INK_BORDER).toContain(
      'border-[length:var(--control-border-width)]',
    );
    expect(CONTROL_INK_BORDER).toContain('border-border-focus');
    expect(CONTROL_INK_BORDER).not.toMatch(/\bbg-/);
    expect(CONTROL_INK_BORDER).not.toMatch(/\btext-/);
    expect(CONTROL_INK_BORDER).not.toMatch(/\bhover:/);
    expect(CONTROL_INK_BORDER).not.toMatch(/\btransition-/);
  });
});

describe('CONTROL_HOVER_LIFT', () => {
  it('carries the transition tuple + a 1px translateY hover, no colour', () => {
    expect(CONTROL_HOVER_LIFT).toContain('hover:-translate-y-px');
    expect(CONTROL_HOVER_LIFT).toContain('transition-');
    expect(CONTROL_HOVER_LIFT).toContain('transform');
    expect(CONTROL_HOVER_LIFT).not.toMatch(/\bbg-/);
    expect(CONTROL_HOVER_LIFT).not.toMatch(/\btext-/);
    expect(CONTROL_HOVER_LIFT).not.toMatch(/hover:bg-/);
    expect(CONTROL_HOVER_LIFT).not.toMatch(/hover:text-/);
    expect(CONTROL_HOVER_LIFT).not.toMatch(/hover:opacity-/);
  });
});

// Per-file count fences: a single cross-file total would let a drop in
// one file be silently balanced by a duplicate in another. Each file
// locks its own imports + consumer count.

describe('HostDetailView consumes both control-chrome constants', () => {
  it('five Computer action buttons consume the ink border', () => {
    // Refresh + Revoke trigger + dialog Cancel + dialog Confirm + Save
    // settings (ProxySection). 5 consumers + 1 import statement.
    const matches = HOST_DETAIL_CODE.match(/CONTROL_INK_BORDER/g) ?? [];
    expect(matches).toHaveLength(6);
  });

  it('same five buttons consume the hover lift (count parity locks the pair)', () => {
    const matches = HOST_DETAIL_CODE.match(/CONTROL_HOVER_LIFT/g) ?? [];
    expect(matches).toHaveLength(6);
  });
});

describe('HostDiagnosticsAction consumes both control-chrome constants', () => {
  it('Copy diagnostics button consumes ink border (single consumer + import)', () => {
    const matches =
      HOST_DIAGNOSTICS_CODE.match(/CONTROL_INK_BORDER/g) ?? [];
    expect(matches).toHaveLength(2);
  });

  it('Copy diagnostics button consumes hover lift (parity)', () => {
    const matches =
      HOST_DIAGNOSTICS_CODE.match(/CONTROL_HOVER_LIFT/g) ?? [];
    expect(matches).toHaveLength(2);
  });
});

describe('ConnectionPane Save consumes both control-chrome constants', () => {
  it('Save button consumes ink border', () => {
    expect(CONNECTION_PANE_CODE).toMatch(
      /type="submit"[\s\S]{0,300}?CONTROL_INK_BORDER/,
    );
  });

  it('Save button consumes hover lift', () => {
    expect(CONNECTION_PANE_CODE).toMatch(
      /type="submit"[\s\S]{0,400}?CONTROL_HOVER_LIFT/,
    );
  });
});

describe('per-variant hover colour is neutralized at the consumer edge', () => {
  it('outline group pins hover bg back to bg-floating', () => {
    // outline variant's own `hover:bg-bg-hover` would swap the fill on
    // hover; overriding with `hover:bg-bg-floating` (resting fill) keeps
    // the fill static while the lift carries the interaction.

    // Revoke trigger + Cancel — both live in RevokeComputerSection.
    const revokeSection = HOST_DETAIL_CODE.match(
      /function RevokeComputerSection[\s\S]*?^}/m,
    );
    expect(revokeSection, 'RevokeComputerSection block').not.toBeNull();
    const revokeBody = revokeSection![0];
    expect(revokeBody).toMatch(
      /openConfirm[\s\S]{0,500}?hover:bg-bg-floating/,
    );
    expect(revokeBody).toMatch(
      /setOpen\(false\)[\s\S]{0,500}?hover:bg-bg-floating/,
    );

    // Save in ConnectionPane.
    expect(CONNECTION_PANE_CODE).toMatch(
      /type="submit"[\s\S]{0,400}?hover:bg-bg-floating/,
    );

    // Copy diagnostics in HostDiagnosticsAction.
    expect(HOST_DIAGNOSTICS_CODE).toMatch(
      /handleCopy[\s\S]{0,500}?hover:bg-bg-floating/,
    );
  });

  it('default fill group pins hover bg back to the resting control fill', () => {
    // Both default-fill buttons in HostDetailView (Refresh credentials
    // + Save settings) override the variant's `hover:bg-[var(--bg-control-primary-hover)]`
    // so the fill does not shift on hover — only the lift moves.
    expect(HOST_DETAIL_CODE).toMatch(
      /handleRefresh[\s\S]{0,500}?hover:bg-\[var\(--bg-control-primary\)\]/,
    );
    // Save settings (ProxySection submit): the submit button here has
    // no user-managed handler name to anchor on, so anchor on the
    // adjacent "Save settings" label unique to this button.
    expect(HOST_DETAIL_CODE).toMatch(
      /hover:bg-\[var\(--bg-control-primary\)\][\s\S]{0,500}?Save settings/,
    );
  });

  it('danger (Revoke confirm) pins hover opacity to 100', () => {
    // Overrides the variant's default `hover:opacity-90` so the red
    // fill does not fade on hover — only the lift moves.
    expect(HOST_DETAIL_CODE).toMatch(
      /handleRevoke[\s\S]{0,500}?hover:opacity-100/,
    );
  });
});
