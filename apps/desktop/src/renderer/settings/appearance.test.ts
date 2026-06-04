import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyAppearanceOverrides, APPEARANCE_TOKENS } from './apply';
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
  it('writes the shared font size into a single appearance token', () => {
    const style = new StyleStub();
    applyAppearanceOverrides(style, {
      theme: 'warm-script',
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
  const warmScriptCss = readFileSync(
    new URL('../styles/themes/warm-script.css', import.meta.url),
    'utf8',
  );
  const forza6Css = readFileSync(
    new URL('../styles/themes/forza6.css', import.meta.url),
    'utf8',
  );
  const slackDarkCss = readFileSync(
    new URL('../styles/themes/slack-dark.css', import.meta.url),
    'utf8',
  );

  it('imports the default :root theme before themes that override it', () => {
    const themeImports = [...globalCss.matchAll(/@import "\.\/themes\/([^"]+)";/g)].map(
      m => m[1],
    );

    expect(themeImports).toEqual([
      'forza6.css',
      'warm-script.css',
      'slack-dark.css',
      'forza6-components.css',
    ]);
  });

  it('keeps :root only on the default theme', () => {
    expect(forza6Css).toContain(':root,\n[data-theme=\'forza6\']');
    expect(warmScriptCss).not.toContain(':root');
    expect(slackDarkCss).not.toContain(':root');
  });

  it('defaults prose and code markdown font sizes to 14px in every theme', () => {
    for (const css of [warmScriptCss, forza6Css, slackDarkCss]) {
      expect(css).toContain('--md-prose-size: 14px;');
      expect(css).toContain('--md-code-size: 14px;');
    }
  });

  it('defaults system-message-row size to 12px in every theme', () => {
    // System messages live one tier below markdown body — chrome, not
    // content. The token is intentionally independent of `--md-*-size`
    // so themes can drift system size without dragging markdown.
    // shiki spec msg `cN9u0jopk9w5nafo`.
    for (const css of [warmScriptCss, forza6Css, slackDarkCss]) {
      expect(css).toContain('--system-message-size: 12px;');
    }
  });

  it('defaults inline-code chip size to 0.88em in every theme', () => {
    // Inline code is emphasis in prose, not a standalone block — the
    // chip wants cap-height ≈ surrounding body x-height (same rule as
    // [data-task-ref] in v7). Independent of `--md-code-size` (which
    // drives fenced code blocks) — two surfaces, two sizes.
    // shiki accepted msg `H7DHYMS5mu1xNiJ3`.
    for (const css of [warmScriptCss, forza6Css, slackDarkCss]) {
      expect(css).toContain('--inline-code-size: 0.88em;');
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
    for (const css of [warmScriptCss, forza6Css, slackDarkCss]) {
      for (const token of NEW_TOKENS) {
        expect(css).toContain(`${token}:`);
      }
    }
  });

  /* Review fix (#task:912): `--profile-section-radius` was added in
     #task:814 for forza6's poster hard-cut treatment. forza6 sets `0`
     on its `:root,[data-theme='forza6']` block; the CSS rule in
     global.css falls back to `var(--card-radius)` if not defined. But
     because forza6 owns `:root`, themes that didn't redeclare leaked
     forza6's `0` — silently turning warm-script + slack-dark profile
     sections into square corners against design intent. This contract
     test pins the leak shut: every theme MUST declare its own value. */
  it('every theme explicitly defines the profile-section radius token', () => {
    for (const css of [warmScriptCss, forza6Css, slackDarkCss]) {
      expect(css).toContain('--profile-section-radius:');
    }
  });

  /* Review round 2 (#task:912): `--row-radius` covers the 5 row-style
     surfaces (sidebar rows / NavRail buttons / Saved item / schedule +
     activity row cards / MessageItem hover frame). Single token because
     each theme moves all five surfaces in the same direction —
     warm/forza6 keep `0` (chat-surface scan-line vocabulary); slack-dark
     uses `6px` for Slack-style subtle list rounding. Same leak-pin
     reasoning as `--profile-section-radius`: forza6's `:root` block
     would leak `0` to any theme that forgets to declare. */
  it('every theme explicitly defines the row-radius token', () => {
    for (const css of [warmScriptCss, forza6Css, slackDarkCss]) {
      expect(css).toContain('--row-radius:');
    }
  });

  /* Review round 3 (#task:912): control-surface hover border. The
     TaskFilterBar trigger had been borrowing `--border-row-hover`
     (sidebar/NavRail row hover). slack-dark sets that to `transparent`
     — sidebar rows express hover via bg veil, not stroke — but a
     borderless control trigger is a hover dead zone. `--border-control-
     hover` decouples the two surfaces: forza6/warm = same as row hover
     (poster ink / accent, pixel-zero); slack-dark = `--border` 10% white
     (visible step up from resting `--border-subtle` 6%). */
  it('every theme explicitly defines the control-hover border token', () => {
    for (const css of [warmScriptCss, forza6Css, slackDarkCss]) {
      expect(css).toContain('--border-control-hover:');
    }
  });

  /* Review round 3 (#task:912): tab-segment radius. `[data-panel-tabs]
     button` had been hard-coded `border-radius: 0` so forza6's poster
     "hard wedge inside the bracket" reads. slack-dark wants the active
     segment rounded to match its hairline-rounded language. Token-route
     it: forza6 / warm = `0`, slack-dark = `4px`. */
  it('every theme explicitly defines the tab-segment radius token', () => {
    for (const css of [warmScriptCss, forza6Css, slackDarkCss]) {
      expect(css).toContain('--tab-segment-radius:');
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
    for (const css of [warmScriptCss, forza6Css, slackDarkCss]) {
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
    for (const css of [warmScriptCss, forza6Css, slackDarkCss]) {
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
    for (const css of [warmScriptCss, forza6Css, slackDarkCss]) {
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
    for (const css of [warmScriptCss, forza6Css, slackDarkCss]) {
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
    for (const css of [warmScriptCss, forza6Css, slackDarkCss]) {
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
    for (const css of [warmScriptCss, forza6Css, slackDarkCss]) {
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
    for (const css of [warmScriptCss, forza6Css, slackDarkCss]) {
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
    for (const css of [warmScriptCss, forza6Css, slackDarkCss]) {
      for (const token of CTA_TOKENS) {
        expect(css).toContain(`${token}:`);
      }
    }
  });

  /* PR follow-up (#task:417, updated #task:912 review round 2): panel
     radius is token-driven. Every panel hook reads its `border-radius`
     from `--card-radius` / `--chip-radius` / `--control-radius` /
     `--row-radius` via global.css, so a theme-author change to one
     token reaches every panel surface and JSX never carries a
     `rounded-*` class on the hook elements that would fight the
     contract.

     This test pins the four invariants that make that work:

       1. The panel block lives in `global.css`, NOT in
          `forza6-components.css` (the previous override pass had it
          there and depended on cascade-layer + specificity tricks
          to win over Tailwind — see #task:415 retro).
       2. Long rows + placeholders consume `--row-radius` (warm /
          forza6 = 0 chat-surface scan-line vocabulary; slack-dark =
          6px Slack-style subtle list rounding).
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
    //     `row` + `placeholder` route through `--row-radius` so each
    //     theme can opt into Slack-style 6px (slack-dark) while warm /
    //     forza6 stay at 0 (chat-surface scan-line vocabulary). The
    //     value-side change happens at the theme layer, not here.
    expect(globalCss).toMatch(
      /\[data-panel-card='row'\][\s\S]{0,400}border-radius:\s*var\(--row-radius\)/,
    );
    expect(globalCss).toMatch(
      /\[data-panel-card='placeholder'\][\s\S]{0,400}border-radius:\s*var\(--row-radius\)/,
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
      /\[data-panel-tabs\]\s+button[\s\S]{0,400}border-radius:\s*var\(--tab-segment-radius\)/,
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
      // P2 v6 (#task:917) — chrome poster colours promoted from
      // hex literals to named raws so `--bg-app` and `--bg-nav-rail`
      // derive via var(...) like every other forza6 semantic token.
      '--forza6-poster-teal',
      '--forza6-poster-teal-deep',
      // P2 v6.4 (#task:917) — NavRail moved to poster paper white;
      // promoted to a named raw so `--bg-nav-rail` keeps deriving
      // via var(...) (no bare hex in L2). The previous L2 raw
      // `--forza6-poster-teal-deep` stays declared as dormant for
      // backwards-compatibility / future deep-strip surface; not
      // currently consumed.
      '--forza6-paper',
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
    // `--border-focus` live value (deep magenta = `--accent`) was
    // previously set in the component-layer root block (P1 pulled it
    // back to root); v6.10 (#task:920) further dialed it down from
    // festival magenta (`--brand-primary`) to the deep-magenta accent
    // to kill the loud focus ring shiki flagged on Composer (v6.9.7 D)
    // and MemberPicker. Same hue family, ~30% lower saturation.
    expect(forza6Css).toContain('--border-focus: var(--accent);');
    // Brand + chrome semantic tokens derive from raws, not inline hex.
    expect(forza6Css).toContain('--brand-primary: var(--forza6-pink);');
    // P2 v6 (#task:917) — chrome master color migrated from
    // `--forza6-pink` to the poster's deep teal-green; NavRail dropped
    // the pale-lime carrier (which collapsed onto channels-sidebar) and
    // adopted the poster's deep湖青 chrome strip color.
    expect(forza6Css).toContain('--bg-app: var(--forza6-poster-teal);');
    // P2 v6.4 (#task:917) — NavRail moved to poster paper white;
    // 「跟青色 chrome 搭配不好」+「整体偏暗」issues with the v6.1-
    // v6.3 deep湖青 NavRail. Paper white delivers strongest chrome-
    // vs-rail contrast and matches forza6's 暖色系 family.
    expect(forza6Css).toContain('--bg-nav-rail: var(--forza6-paper);');
  });
});
