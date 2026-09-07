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
  const globalCss = readFileSync(new URL('../styles/global.css', import.meta.url), 'utf8');
  const studioLightCss = readFileSync(
    new URL('../styles/themes/studio-light.css', import.meta.url),
    'utf8',
  );
  const forza6Css = readFileSync(new URL('../styles/themes/forza6.css', import.meta.url), 'utf8');
  const forza6ComponentsCss = readFileSync(
    new URL('../styles/themes/forza6-components.css', import.meta.url),
    'utf8',
  );
  const slackDarkCss = readFileSync(
    new URL('../styles/themes/slack-dark.css', import.meta.url),
    'utf8',
  );
  const irisCss = readFileSync(new URL('../styles/themes/iris.css', import.meta.url), 'utf8');

  // Cascade STRUCTURE guards: the whole no-leak model rests on the default
  // theme owning `:root` and being imported before any override theme. If
  // another theme declares `:root`, or the default imports after an override,
  // the default's festival-only values leak globally / get clobbered — a
  // cross-theme corruption TS can't catch. (Structural boundaries, not values.)
  it('imports the default :root theme before the themes that override it', () => {
    const order = [...globalCss.matchAll(/@import ['"]\.\/themes\/([^'"]+)['"];/g)].map(
      (m) => m[1],
    );
    const forzaIdx = order.indexOf('forza6.css');
    expect(forzaIdx).toBeGreaterThanOrEqual(0);
    for (const override of ['studio-light.css', 'slack-dark.css', 'iris.css']) {
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
    expect(irisCss).not.toContain(':root');
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
  // festival-only value via the :root fallback. This catches the real recurring
  // bug (a new theme forgets a token). We assert the token is DECLARED per theme
  // — never its value (14px / a hue / a radius), a visual concern for dogfood.
  //
  // The required set is DERIVED from the default theme, not hand-listed. forza6
  // owns `:root`, so every token it declares there becomes the global default;
  // any token another theme omits resolves back to forza6's festival value — the
  // exact leak. So the contract is simply "whatever forza6 declares, every other
  // theme must declare too." Adding a token to forza6 auto-extends the contract;
  // deleting a dead one auto-retracts it — the fence maintains itself, no manual
  // token list to drift out of sync.
  it('every theme explicitly declares the full promoted-token set (no :root leak)', () => {
    const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
    // A declaration is `--name:`; `var(--name)` usages end in `)`, not `:`, so
    // this matches definitions only.
    const declaredTokens = (css: string) =>
      new Set([...stripComments(css).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));

    // Excluded from the per-theme contract:
    //  --forza6-*  private palette (namespaced; each theme owns its own palette)
    //  --color-*   Tailwind bridge (lives in global.css @theme inline, not here)
    //  --app-corner-radius  intentionally forza6-only. NavRail reads it as
    //              `var(--app-corner-radius, var(--card-radius, 0))`, so other
    //              themes resolve to their own card radius by design — not a leak.
    //  --task-num  intentionally forza6-only (#task:1914). The `#nnn` number hue
    //              (`[data-tasks-num]`) is painted ONLY in forza6-components.css
    //              `[data-theme='forza6']` rules; other themes render the number
    //              as `text-text-muted` and never read the token, so it can't leak.
    const FORZA6_ONLY = new Set(['--app-corner-radius', '--task-num']);
    const isPromoted = (t: string) =>
      !t.startsWith('--forza6-') && !t.startsWith('--color-') && !FORZA6_ONLY.has(t);

    const required = [...declaredTokens(forza6Css)].filter(isPromoted);
    // Sanity: if the regex ever breaks, the set collapses and the test would
    // pass vacuously. The real set is ~130 tokens.
    expect(required.length).toBeGreaterThan(100);

    for (const [name, css] of [
      ['studio-light', studioLightCss],
      ['slack-dark', slackDarkCss],
      ['iris', irisCss],
    ] as const) {
      const declared = declaredTokens(css);
      const missing = required.filter((t) => !declared.has(t));
      expect(missing, `${name} is missing promoted token(s)`).toEqual([]);
    }
  });
});
