import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyAppearanceOverrides, APPEARANCE_TOKENS } from './apply';
import { parseAppearance, parseAppearanceJson } from './parse';
import { LEGACY_THEME_IDS, THEME_IDS } from './types';

class StyleStub {
  values = new Map<string, string>();
  removed: string[] = [];

  setProperty(property: string, value: string | null): void {
    if (value !== null) this.values.set(property, value);
  }

  removeProperty(property: string): string {
    this.removed.push(property);
    const prev = this.values.get(property) ?? '';
    this.values.delete(property);
    return prev;
  }
}

describe('parseAppearance', () => {
  it('keeps the legacy theme-only shape', () => {
    expect(parseAppearance({ theme: 'forza6' })).toEqual({
      theme: 'forza6',
    });
  });

  it('falls back to the current default theme when input is missing or bad', () => {
    expect(parseAppearance(null)).toEqual({ theme: 'forza6' });
    expect(parseAppearanceJson('{bad json')).toEqual({ theme: 'forza6' });
    expect(parseAppearance({ theme: 'unknown' })).toEqual({
      theme: 'forza6',
    });
  });

  it('normalizes shared font size and trims font families', () => {
    expect(
      parseAppearance({
        theme: 'forza6',
        fontSize: 100,
        prose: { fontFamily: '  Georgia, serif  ' },
        code: { fontFamily: '   ' },
      }),
    ).toEqual({
      theme: 'forza6',
      // Clamped to FONT_SIZE_MAX.
      fontSize: 22,
      prose: { fontFamily: 'Georgia, serif' },
      // code's fontFamily was empty after trim, so the slot drops.
    });
  });

  it('drops non-number sizes instead of coercing strings', () => {
    expect(
      parseAppearance({
        theme: 'studio-light',
        fontSize: '16',
      }),
    ).toEqual({ theme: 'studio-light' });
  });

  // Renamed-theme compatibility (#task:1656). A user who had picked the
  // old id still carries it in localStorage; without the alias step the
  // unknown id would fail the enum and reset them to the default theme —
  // a silently lost preference, which no type check can catch. Every
  // entry in LEGACY_THEME_IDS must land on a live id, and the rest of
  // the settings blob must survive the rewrite.
  it('maps every legacy theme id onto a current one', () => {
    for (const [legacy, current] of Object.entries(LEGACY_THEME_IDS)) {
      expect(THEME_IDS).toContain(current);
      expect(parseAppearance({ theme: legacy, fontSize: 16 })).toEqual({
        theme: current,
        fontSize: 16,
      });
      expect(parseAppearanceJson(JSON.stringify({ theme: legacy }))).toEqual({
        theme: current,
      });
    }
  });
});

describe('applyAppearanceOverrides', () => {
  it('writes the shared font size into a single appearance token', () => {
    const style = new StyleStub();
    applyAppearanceOverrides(style, {
      theme: 'studio-light',
      fontSize: 16,
      prose: { fontFamily: 'Georgia, serif' },
      code: { fontFamily: 'Menlo, monospace' },
    });

    expect(style.values).toEqual(
      new Map([
        [APPEARANCE_TOKENS.PROSE_FONT, 'Georgia, serif'],
        [APPEARANCE_TOKENS.CODE_FONT, 'Menlo, monospace'],
        [APPEARANCE_TOKENS.MARKDOWN_FONT_SIZE, '16px'],
      ]),
    );
  });

  it('removes markdown override tokens when settings reset', () => {
    const style = new StyleStub();
    applyAppearanceOverrides(style, { theme: 'forza6' });

    expect(style.removed).toEqual([
      APPEARANCE_TOKENS.PROSE_FONT,
      APPEARANCE_TOKENS.CODE_FONT,
      APPEARANCE_TOKENS.MARKDOWN_FONT_SIZE,
    ]);
  });
});

describe('theme markdown token cascade contract', () => {
  const globalCss = readFileSync(
    new URL('../styles/global.css', import.meta.url),
    'utf8',
  );
  const studioLightCss = readFileSync(
    new URL('../styles/themes/studio-light.css', import.meta.url),
    'utf8',
  );
  const forza6Css = readFileSync(
    new URL('../styles/themes/forza6.css', import.meta.url),
    'utf8',
  );
  const forza6ComponentsCss = readFileSync(
    new URL('../styles/themes/forza6-components.css', import.meta.url),
    'utf8',
  );
  const slackDarkCss = readFileSync(
    new URL('../styles/themes/slack-dark.css', import.meta.url),
    'utf8',
  );

  // Cascade STRUCTURE guards: the whole no-leak model rests on the default
  // theme owning `:root` and being imported before any override theme. If
  // another theme declares `:root`, or the default imports after an override,
  // the default's festival-only values leak globally / get clobbered — a
  // cross-theme corruption TS can't catch. (Structural boundaries, not values.)
  it('imports the default :root theme before the themes that override it', () => {
    const order = [...globalCss.matchAll(/@import "\.\/themes\/([^"]+)";/g)].map(
      m => m[1],
    );
    const forzaIdx = order.indexOf('forza6.css');
    expect(forzaIdx).toBeGreaterThanOrEqual(0);
    for (const override of ['studio-light.css', 'slack-dark.css']) {
      expect(order.indexOf(override)).toBeGreaterThan(forzaIdx);
    }
  });

  it('keeps :root only on the default theme', () => {
    // Whitespace-insensitive: the default theme owns a `:root, [data-theme='forza6']`
    // block. Match the selector pair structurally so this guard doesn't itself
    // relock the exact newline/spacing formatting.
    expect(forza6Css).toMatch(/:root\s*,\s*\[data-theme=['"]forza6['"]\]/);
    expect(studioLightCss).not.toContain(':root');
    expect(slackDarkCss).not.toContain(':root');
  });

  // Component-layer root-ownership guard (restored, #task:788 failure path).
  // `forza6-components.css` may add element-/state-scoped overrides and may
  // redefine tokens INSIDE those scoped bundles, but must NOT reintroduce a
  // bare `[data-theme='forza6'] { --token: … }` block or a `:root` block —
  // root-level token reassignment has a single source in `forza6.css`. A bare
  // theme block here would silently fork the token SSOT (values drift between
  // the two files, invisible to TS). This is a stable layering boundary
  // (guideline 5), not a CSS re-lock: it names the concrete corruption path.
  it('forbids root-level token reassignment in the forza6 component layer', () => {
    // Strip CSS comments first — the file's own header prose mentions the
    // removed `[data-theme='forza6'] {}` block, which must not trip the guard.
    const code = forza6ComponentsCss.replace(/\/\*[\s\S]*?\*\//g, '');
    // A bare theme selector = the attribute selector directly followed by `{`
    // (only whitespace between). Qualified selectors like
    // `[data-theme='forza6'] header[...] {` have another selector before `{`,
    // so they don't match.
    expect(code).not.toMatch(/\[data-theme=['"]forza6['"]\]\s*\{/);
    expect(code).not.toContain(':root');
  });

  // The ONE cascade-safety token test: every promoted token MUST be declared
  // explicitly in every theme, so a switch away from the default can't leak its
  // festival-only value via the :root fallback. This is the contract that
  // catches the real recurring bug (a new theme forgets a token). We assert the
  // token is DECLARED per theme — never its value (14px / a hue / a radius),
  // which is a visual concern verified by dogfood.
  it('every theme explicitly declares the full promoted-token set (no :root leak)', () => {
    const REQUIRED_TOKENS = [
      // markdown + chrome sizes (declaration only — the px value is visual)
      '--md-prose-size',
      '--md-code-size',
      '--system-message-size',
      // forza6-introduced identity tokens
      '--font-display',
      '--bg-pattern-image',
      '--bg-pattern-opacity',
      '--accent-2',
      '--text-on-accent-2',
      '--bg-structure-dark',
      '--text-on-structure',
      '--text-on-dark-pop',
      // radius family
      '--profile-section-radius',
      '--row-radius',
      '--tab-segment-radius',
      '--control-radius',
      '--chip-radius',
      '--select-content-radius',
      '--select-item-radius',
      // border / hover state
      '--border-control-hover',
      '--border-row-hover',
      '--border-row-selected',
      // inline-code chip
      '--bg-inline-code',
      '--border-inline-code',
      '--radius-inline-code',
      // chrome-label utility
      '--font-chrome-label',
      '--chrome-label-tracking',
      '--chrome-label-transform',
      // primary control surface (CTA)
      '--bg-control-primary',
      '--bg-control-primary-hover',
      '--text-on-control-primary',
      // floating frame
      '--floating-border',
      '--floating-radius',
      '--floating-item-radius',
      // task-status badge family (5 statuses × {bg, text, border, solid})
      '--task-status-todo-bg',
      '--task-status-todo-text',
      '--task-status-todo-border',
      '--task-status-todo-solid',
      '--task-status-in-progress-bg',
      '--task-status-in-progress-text',
      '--task-status-in-progress-border',
      '--task-status-in-progress-solid',
      '--task-status-in-review-bg',
      '--task-status-in-review-text',
      '--task-status-in-review-border',
      '--task-status-in-review-solid',
      '--task-status-done-bg',
      '--task-status-done-text',
      '--task-status-done-border',
      '--task-status-done-solid',
      '--task-status-closed-bg',
      '--task-status-closed-text',
      '--task-status-closed-border',
      '--task-status-closed-solid',
    ];
    for (const css of [studioLightCss, forza6Css, slackDarkCss]) {
      for (const token of REQUIRED_TOKENS) {
        expect(css).toContain(`${token}:`);
      }
    }
  });
});
