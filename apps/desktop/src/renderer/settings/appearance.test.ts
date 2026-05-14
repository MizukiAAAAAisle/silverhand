import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyAppearanceOverrides, MD_TOKENS } from './apply';
import { parseAppearance, parseAppearanceJson } from './parse';

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
    expect(parseAppearance({ theme: 'paper-ink' })).toEqual({
      theme: 'paper-ink',
    });
  });

  it('falls back to the current default theme when input is missing or bad', () => {
    expect(parseAppearance(null)).toEqual({ theme: 'warm-script' });
    expect(parseAppearanceJson('{bad json')).toEqual({ theme: 'warm-script' });
    expect(parseAppearance({ theme: 'unknown' })).toEqual({
      theme: 'warm-script',
    });
  });

  it('normalizes markdown font overrides and clamps font size', () => {
    expect(
      parseAppearance({
        theme: 'warm-coral',
        prose: { fontFamily: '  Georgia, serif  ', fontSize: 100 },
        code: { fontFamily: '   ', fontSize: 4 },
      }),
    ).toEqual({
      theme: 'warm-coral',
      prose: { fontFamily: 'Georgia, serif', fontSize: 22 },
      code: { fontSize: 12 },
    });
  });

  it('drops non-number sizes instead of coercing strings', () => {
    expect(
      parseAppearance({
        theme: 'warm-script',
        prose: { fontSize: '16' },
        code: { fontSize: Number.NaN },
      }),
    ).toEqual({ theme: 'warm-script' });
  });
});

describe('applyAppearanceOverrides', () => {
  it('sets prose and code markdown override tokens', () => {
    const style = new StyleStub();
    applyAppearanceOverrides(style, {
      theme: 'warm-script',
      prose: { fontFamily: 'Georgia, serif', fontSize: 16 },
      code: { fontFamily: 'Menlo, monospace', fontSize: 13 },
    });

    expect(style.values).toEqual(
      new Map([
        [MD_TOKENS.PROSE_FONT, 'Georgia, serif'],
        [MD_TOKENS.PROSE_SIZE, '16px'],
        [MD_TOKENS.CODE_FONT, 'Menlo, monospace'],
        [MD_TOKENS.CODE_SIZE, '13px'],
      ]),
    );
  });

  it('removes markdown override tokens when settings reset', () => {
    const style = new StyleStub();
    applyAppearanceOverrides(style, { theme: 'paper-ink' });

    expect(style.removed).toEqual([
      MD_TOKENS.PROSE_FONT,
      MD_TOKENS.PROSE_SIZE,
      MD_TOKENS.CODE_FONT,
      MD_TOKENS.CODE_SIZE,
    ]);
  });
});

describe('theme markdown token cascade contract', () => {
  const globalCss = readFileSync(
    new URL('../styles/global.css', import.meta.url),
    'utf8',
  );
  const warmScriptCss = readFileSync(
    new URL('../styles/themes/warm-script.css', import.meta.url),
    'utf8',
  );
  const paperInkCss = readFileSync(
    new URL('../styles/themes/paper-ink.css', import.meta.url),
    'utf8',
  );
  const warmCoralCss = readFileSync(
    new URL('../styles/themes/warm-coral.css', import.meta.url),
    'utf8',
  );

  it('imports the default :root theme before themes that override it', () => {
    const themeImports = [...globalCss.matchAll(/@import "\.\/themes\/([^"]+)";/g)].map(
      m => m[1],
    );

    expect(themeImports).toEqual([
      'warm-script.css',
      'paper-ink.css',
      'warm-coral.css',
    ]);
  });

  it('keeps :root only on the default theme', () => {
    expect(warmScriptCss).toContain(':root,\n[data-theme=\'warm-script\']');
    expect(paperInkCss).not.toContain(':root');
    expect(warmCoralCss).not.toContain(':root');
  });

  it('defaults prose and code markdown font sizes to 12px in every theme', () => {
    for (const css of [warmScriptCss, paperInkCss, warmCoralCss]) {
      expect(css).toContain('--md-prose-size: 12px;');
      expect(css).toContain('--md-code-size: 12px;');
    }
  });
});
