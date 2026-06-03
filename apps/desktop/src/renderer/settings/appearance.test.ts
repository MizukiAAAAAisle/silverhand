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
        theme: 'warm-script',
        fontSize: '16',
      }),
    ).toEqual({ theme: 'warm-script' });
  });
});

describe('applyAppearanceOverrides', () => {
  it('writes the shared font size into both prose and code tokens', () => {
    const style = new StyleStub();
    applyAppearanceOverrides(style, {
      theme: 'warm-script',
      fontSize: 16,
      prose: { fontFamily: 'Georgia, serif' },
      code: { fontFamily: 'Menlo, monospace' },
    });

    expect(style.values).toEqual(
      new Map([
        [MD_TOKENS.PROSE_FONT, 'Georgia, serif'],
        [MD_TOKENS.PROSE_SIZE, '16px'],
        [MD_TOKENS.CODE_FONT, 'Menlo, monospace'],
        [MD_TOKENS.CODE_SIZE, '16px'],
      ]),
    );
  });

  it('removes markdown override tokens when settings reset', () => {
    const style = new StyleStub();
    applyAppearanceOverrides(style, { theme: 'forza6' });

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
  const forza6Css = readFileSync(
    new URL('../styles/themes/forza6.css', import.meta.url),
    'utf8',
  );

  it('imports the default :root theme before themes that override it', () => {
    const themeImports = [...globalCss.matchAll(/@import "\.\/themes\/([^"]+)";/g)].map(
      m => m[1],
    );

    expect(themeImports).toEqual([
      'forza6.css',
      'warm-script.css',
      'forza6-components.css',
    ]);
  });

  it('keeps :root only on the default theme', () => {
    expect(forza6Css).toContain(':root,\n[data-theme=\'forza6\']');
    expect(warmScriptCss).not.toContain(':root');
  });

  it('defaults prose and code markdown font sizes to 13px in every theme', () => {
    for (const css of [warmScriptCss, forza6Css]) {
      expect(css).toContain('--md-prose-size: 13px;');
      expect(css).toContain('--md-code-size: 13px;');
    }
  });

  /* Forza6 introduced 8 new tokens — every theme MUST define them
     explicitly so a theme switch from forza6 doesn't leak the
     festival-only values via :root fallback (design-new-theme §3.1
     关键 3). */
  it('every theme explicitly defines forza6-introduced tokens', () => {
    const NEW_TOKENS = [
      '--font-display',
      '--bg-pattern-image',
      '--bg-pattern-opacity',
      '--accent-2',
      '--text-on-accent-2',
      '--bg-structure-dark',
      '--text-on-structure',
      '--text-on-dark-pop',
    ];
    for (const css of [warmScriptCss, forza6Css]) {
      for (const token of NEW_TOKENS) {
        expect(css).toContain(`${token}:`);
      }
    }
  });

  /* PR-3 token promotion (#task:344): inline-code chip is now a
     4-token contract (bg / border / radius + the existing
     --text-inline-code). Every theme MUST declare the three new
     tokens so a theme switch from forza6 doesn't leak the lime
     poster recipe via :root fallback. */
  it('every theme explicitly defines inline-code chip tokens', () => {
    const INLINE_CODE_TOKENS = [
      '--bg-inline-code',
      '--border-inline-code',
      '--radius-inline-code',
    ];
    for (const css of [warmScriptCss, forza6Css]) {
      for (const token of INLINE_CODE_TOKENS) {
        expect(css).toContain(`${token}:`);
      }
    }
  });

  /* PR-5 token promotion (#task:345; closed status #task:770): the
     task-status badge is now a 15-token contract (5 statuses × {bg /
     text / border} — todo / in_progress / in_review / done / closed).
     `closed` is a terminal status (not a separate visibility axis), so
     it joins the same family; its forza6 indigo poster chip / warm
     low-noise chip must be declared per theme so a switch doesn't leak
     forza6's indigo via :root fallback. Domain-prefixed
     (`--task-status-*`) over generic (`--status-*`) because the
     namespace must stay narrow — these values are tuned for a single
     ~10px poster-display badge, not a general "status colour"
     vocabulary. */
  it('every theme explicitly defines task-status badge tokens', () => {
    const TASK_STATUS_TOKENS = [
      '--task-status-todo-bg',
      '--task-status-todo-text',
      '--task-status-todo-border',
      '--task-status-in-progress-bg',
      '--task-status-in-progress-text',
      '--task-status-in-progress-border',
      '--task-status-in-review-bg',
      '--task-status-in-review-text',
      '--task-status-in-review-border',
      '--task-status-done-bg',
      '--task-status-done-text',
      '--task-status-done-border',
      '--task-status-closed-bg',
      '--task-status-closed-text',
      '--task-status-closed-border',
    ];
    for (const css of [warmScriptCss, forza6Css]) {
      for (const token of TASK_STATUS_TOKENS) {
        expect(css).toContain(`${token}:`);
      }
    }
  });

  /* PR-4 token promotion (#task:350): floating frame (menu /
     popover / hover-card outer chrome + inner item radius) is now a
     3-token contract. Every theme MUST declare all three so a theme
     switch from forza6 doesn't leak its 2px black + 0-radius poster
     sticker frame into warm themes via :root fallback. Border is a
     shorthand (width + style + color) so a single token captures the
     full edge identity per theme; per Cindy `GZJAggfU2U8kcIV0` we
     intentionally skipped a separate `--floating-border-width` until
     a real consumer needs the width for layout/inset math. */
  it('every theme explicitly defines floating frame tokens', () => {
    const FLOATING_FRAME_TOKENS = [
      '--floating-border',
      '--floating-radius',
      '--floating-item-radius',
    ];
    for (const css of [warmScriptCss, forza6Css]) {
      for (const token of FLOATING_FRAME_TOKENS) {
        expect(css).toContain(`${token}:`);
      }
    }
  });

  /* PR-5 token promotion (#task:352): sidebar / NavRail row border
     colour for hover + selected states is now a 2-token contract.
     Every theme MUST declare both so a theme switch from forza6
     doesn't leak its poster-sticker near-black into warm themes via
     :root fallback. Per Cindy `tBslbxNV5QSi8x3s` we kept this scoped
     to row state border colour only — width + radius stay on
     `.sidebar-row-border` (global.css) because they don't vary by
     theme today. */
  it('every theme explicitly defines row-state border tokens', () => {
    const ROW_STATE_TOKENS = [
      '--border-row-hover',
      '--border-row-selected',
    ];
    for (const css of [warmScriptCss, forza6Css]) {
      for (const token of ROW_STATE_TOKENS) {
        expect(css).toContain(`${token}:`);
      }
    }
  });

  /* PR-6 token promotion (#task:354): `.chrome-label` utility reads a
     3-token contract (font family / tracking / text transform). Every
     theme MUST declare all three so a theme switch from forza6 doesn't
     leak the display font + 0.06em tracking into warm themes via :root
     fallback. The utility is intentionally narrow — size / weight /
     color stay at the call site so existing Tailwind vocabulary isn't
     overridden. */
  it('every theme explicitly defines chrome-label tokens', () => {
    const CHROME_LABEL_TOKENS = [
      '--font-chrome-label',
      '--chrome-label-tracking',
      '--chrome-label-transform',
    ];
    for (const css of [warmScriptCss, forza6Css]) {
      for (const token of CHROME_LABEL_TOKENS) {
        expect(css).toContain(`${token}:`);
      }
    }
  });

  /* PR-8 token promotion (#task:359): control + chip radius is now a
     2-token contract. Every theme MUST declare both so a theme switch
     from forza6 doesn't leak the `0` poster radius into warm themes
     via :root fallback. Scope is intentionally narrow:
     - `--control-radius` → input / textarea / button / select trigger /
       small icon button (everything that was Tailwind `rounded-md` on
       a control surface).
     - `--chip-radius` → inline reference chip / filter chip / small
       data chip (everything that was Tailwind `rounded` ≈ 4px on a
       chip surface).
     `--pill-radius` deliberately NOT introduced — TaskStatusPill is
     the sole `rounded-full` consumer and shiki decided to keep it
     capsule (forza6 expresses status via saturated fill, not shape).
     Open a `pill-radius` PR if/when a second pill consumer lands. */
  it('every theme explicitly defines control + chip radius tokens', () => {
    const RADIUS_TOKENS = ['--control-radius', '--chip-radius'];
    for (const css of [warmScriptCss, forza6Css]) {
      for (const token of RADIUS_TOKENS) {
        expect(css).toContain(`${token}:`);
      }
    }
  });

  /* PR-9 token promotion (#task:361): Select listbox radius is now a
     2-token contract. Radix `Select.Content` + `Select.Item` get
     dedicated radius so forza6 can square them without inheriting the
     heavy 2px poster border meant for full menus (PR-4 boundary
     preserved). Every theme MUST declare both so a theme switch
     doesn't leak the `0` value into warm themes via :root fallback. */
  it('every theme explicitly defines select listbox radius tokens', () => {
    const SELECT_RADIUS_TOKENS = ['--select-content-radius', '--select-item-radius'];
    for (const css of [warmScriptCss, forza6Css]) {
      for (const token of SELECT_RADIUS_TOKENS) {
        expect(css).toContain(`${token}:`);
      }
    }
  });

  /* PR-10 token promotion (#task:365): primary control surface
     (Button `default` variant CTA — Create / Save / Register submit
     buttons) is now a 3-token contract. forza6 needed CTAs to use
     `--brand-primary` (#FF2C7A "theme pink") instead of `--accent`
     (#B3186A deep magenta — pressed dark for text-accent浅底 AA per
     Cindy `JzkPVNV3svN97WSR`); the previous coupling of CTA bg to
     accent foreground meant forza6 CTAs read as muddy dark pink
     (shiki `Ao2TTCQ6Q2r5OG-a`). Every theme MUST declare all three
     so the brand vs accent decision is explicit per-theme. warm-script
     degenerates each to the accent family (pixel-zero — warm's accent
     is intentionally a single warm-near-black hue serving both bg and
     fg). */
  it('every theme explicitly defines primary control surface tokens', () => {
    const CTA_TOKENS = [
      '--bg-control-primary',
      '--bg-control-primary-hover',
      '--text-on-control-primary',
    ];
    for (const css of [warmScriptCss, forza6Css]) {
      for (const token of CTA_TOKENS) {
        expect(css).toContain(`${token}:`);
      }
    }
  });

  /* PR follow-up (#task:417): panel radius is token-driven. Every
     panel hook reads its `border-radius` from `--card-radius` /
     `--chip-radius` / `--control-radius` (or hard-zero for rows /
     placeholders) via global.css, so a theme-author change to one
     token reaches every panel surface and JSX never carries a
     `rounded-*` class on the hook elements that would fight the
     contract.

     This test pins the four invariants that make that work:

       1. The panel block lives in `global.css`, NOT in
          `forza6-components.css` (the previous override pass had it
          there and depended on cascade-layer + specificity tricks
          to win over Tailwind — see #task:415 retro).
       2. Long rows + placeholders are hard zero (chat-surface scan
          line vocabulary; same as message items / saved items).
       3. Static cards consume `--card-radius`; pills consume
          `--chip-radius`; tabs + controls consume `--control-radius`.
          Inner tab segment buttons are explicitly squared so the
          active tab reads as a hard wedge inside the bracket.
       4. `forza6-components.css` carries NO `border-radius` on the
          panel hooks — its job is now non-radius identity only
          (poster border, lime hover, dashed stroke, display caps).

     This test replaces the previous "forza6-components.css unlayered
     + post-tailwind import" lock (#task:415), which became
     unnecessary once the radius contract no longer depends on the
     unlayered/layered cascade order. */
  it('routes every agent-panel hook radius through global.css tokens', () => {
    // (1) global.css owns the panel radius block.
    expect(globalCss).toMatch(
      /\[data-panel-card='row'\][\s\S]{0,200}border-radius:\s*0\b/,
    );
    expect(globalCss).toMatch(
      /\[data-panel-card='placeholder'\][\s\S]{0,200}border-radius:\s*0\b/,
    );
    expect(globalCss).toMatch(
      /\[data-panel-card='profile-section'\][\s\S]{0,200}border-radius:\s*var\(--profile-section-radius,\s*var\(--card-radius\)\)/,
    );
    expect(globalCss).toMatch(
      /\[data-panel-pill\][\s\S]{0,200}border-radius:\s*var\(--chip-radius\)/,
    );
    expect(globalCss).toMatch(
      /\[data-panel-tabs\][\s\S]{0,200}border-radius:\s*var\(--control-radius\)/,
    );
    expect(globalCss).toMatch(
      /\[data-panel-tabs\]\s+button[\s\S]{0,200}border-radius:\s*0\b/,
    );
    expect(globalCss).toMatch(
      /\[data-panel-control\][\s\S]{0,200}border-radius:\s*var\(--control-radius\)/,
    );

    // (4) forza6-components.css must NOT redeclare radius on these
    // hooks — its scope is now non-radius identity only.
    const forza6ComponentsCss = readFileSync(
      new URL('../styles/themes/forza6-components.css', import.meta.url),
      'utf8',
    );
    const panelHookRadiusRegex =
      /\[data-panel-(?:card|pill|tabs|control)[^\]]*\][\s\S]{0,400}?\bborder-radius:/g;
    expect(forza6ComponentsCss.match(panelHookRadiusRegex)).toBeNull();
  });

  /* #task:788 forza6 colour-system refactor — three-layer token model.
     L1 raw palette is the ONLY place a forza6 brand hex literal lives;
     L2 semantic tokens derive via var(--forza6-*); L3
     (forza6-components.css) carries NO second root-level token block —
     root tokens are defined once in forza6.css. See design-new-theme
     §12.1.1. */
  it('defines the forza6 raw palette in forza6.css', () => {
    const RAW_PALETTE = [
      '--forza6-pink',
      '--forza6-pink-deep',
      '--forza6-lime',
      '--forza6-lime-pale',
      '--forza6-lime-deep',
      '--forza6-cyan',
      '--forza6-yellow',
      '--forza6-ink',
      '--forza6-teal-island',
      '--forza6-teal-deep',
      '--forza6-carrier-channels',
      '--forza6-carrier-sessions',
    ];
    for (const token of RAW_PALETTE) {
      expect(forza6Css).toContain(`${token}:`);
    }
  });

  it('keeps forza6 root tokens defined once (no component-layer root reassign)', () => {
    const forza6ComponentsCss = readFileSync(
      new URL('../styles/themes/forza6-components.css', import.meta.url),
      'utf8',
    );
    // Strip CSS block comments so prose mentions of a token (e.g. the
    // header rationale) don't count as declarations.
    const code = forza6ComponentsCss.replace(/\/\*[\s\S]*?\*\//g, '');
    // No bare `[data-theme='forza6'] {` block — every selector in the
    // component layer must be element-scoped, never a second root-level
    // token reassignment.
    expect(code).not.toMatch(/\[data-theme='forza6'\]\s*\{/);
    // The tokens the deleted root-reassign block used to own are now
    // owned solely by forza6.css; the component layer must not redefine
    // them (which would re-create the dead-root-value bug).
    for (const token of ['--bg-app', '--bg-nav-rail', '--border-focus']) {
      expect(code).not.toContain(`${token}:`);
    }
  });

  it('homes the live forza6 root token values in forza6.css (not dead values)', () => {
    // `--border-focus` live value (festival magenta) was previously set
    // in the component-layer root block; P1 pulled it back to root.
    expect(forza6Css).toContain('--border-focus: var(--brand-primary);');
    // Brand + carrier semantic tokens derive from raws, not inline hex.
    expect(forza6Css).toContain('--brand-primary: var(--forza6-pink);');
    expect(forza6Css).toContain('--bg-nav-rail: var(--forza6-carrier-channels);');
  });
});
