import { describe, expect, it } from 'vitest';
import { destructiveAction, destructiveCancel } from './DestructiveAction';

// The stickers themselves are painted by the theme on the data hook, so the
// contract worth locking is structural: the hook and its classes always ship
// together, the two halves declare DIFFERENT ranks (a commit and its Cancel must
// never resolve to the same rule), and neither carries fill/text colour of its
// own — that belongs to the Button variant and, in forza6, to the theme rule.
// The commit additionally must not thin its fill on hover. Exact px, hues, and
// hover tints are visual and verified by dogfood.

describe('destructiveAction', () => {
  it('always emits the hook the theme paints', () => {
    expect(destructiveAction()['data-destructive-action']).toBe('commit');
    expect(destructiveAction('gap-2')['data-destructive-action']).toBe(
      'commit',
    );
  });

  it('cancels the danger variant opacity fade', () => {
    expect(destructiveAction().className).toContain('hover:opacity-100');
  });

  it('carries no fill or text colour of its own', () => {
    const { className } = destructiveAction();
    expect(className).not.toMatch(/\bbg-/);
    expect(className).not.toMatch(/\btext-/);
  });

  it('appends consumer layout classes without dropping the recipe', () => {
    const { className } = destructiveAction('w-full gap-2');
    expect(className).toContain('w-full');
    expect(className).toContain('gap-2');
    expect(className).toContain('hover:opacity-100');
  });
});

describe('destructiveCancel', () => {
  it('emits its own rank, never the commit hook', () => {
    expect(destructiveCancel()['data-destructive-action']).toBe('cancel');
    expect(destructiveCancel('w-full')['data-destructive-action']).toBe(
      'cancel',
    );
    expect(destructiveCancel()['data-destructive-action']).not.toBe(
      destructiveAction()['data-destructive-action'],
    );
  });

  it('is a framed surface with a hover, not a bare ghost', () => {
    const { className } = destructiveCancel();
    // The frame is what makes it read as a designed peer rather than an
    // unstyled button next to a red sticker.
    expect(className).toContain('border-[length:var(--control-border-width)]');
    expect(className).toContain('hover:border-[color:var(--border-control-hover)]');
    expect(className).toContain('hover:bg-[var(--bg-option-hover)]');
  });

  it('appends consumer layout classes without dropping the recipe', () => {
    const { className } = destructiveCancel('w-full');
    expect(className).toContain('w-full');
    expect(className).toContain('hover:bg-[var(--bg-option-hover)]');
  });
});
