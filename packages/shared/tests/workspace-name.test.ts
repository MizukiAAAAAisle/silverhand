import { describe, expect, it } from 'vitest';
import {
  WorkspaceNameSchema,
  type CanonicalWorkspaceName,
  fixedWorkspaceName,
  formatWorkspaceAddressSegment,
  normalizeWorkspaceName,
  parseWorkspaceAddressSegment,
} from '../src/index.js';

/**
 * Workspace-name grammar (#task:1827). shiki's ruling: workspace names are
 * labels that must accept Chinese, and they do NOT inherit the participant
 * addressing grammar. The three properties worth locking are the ones a future
 * "simplification" would silently break:
 *   1. parse OUTPUT is NFC — the schema normalizes, it does not merely accept.
 *   2. length counts CODE POINTS, and overflow is reported as `too_big`,
 *      because the renderer's advisory validator classifies length-vs-charset
 *      by issue code (a plain `.refine` would report `custom` and be shown as
 *      a charset error).
 *   3. invisible code points are rejected while ordinary punctuation is not.
 *
 * Every invisible fixture below is written with an explicit `\uXXXX` escape: a
 * zero-width character pasted raw is invisible in the source too, so the
 * negative case itself would be unauditable (and editors silently strip some).
 */
describe('WorkspaceNameSchema', () => {
  it('makes name/key construction a branded terminal value', () => {
    const canonical: CanonicalWorkspaceName = fixedWorkspaceName('General');
    expect(canonical).toMatchObject({ name: 'General', key: 'general' });
    // @ts-expect-error a second folder cannot construct the terminal pair
    const forged: CanonicalWorkspaceName = { name: 'General', key: 'wrong' };
    expect(forged.key).toBe('wrong');
  });
  it('accepts Chinese, internal spaces, and @ # / punctuation', () => {
    for (const name of ['设计评审', 'UI 优化', '设计　评审', '@ # / ok', '2b', '🎨']) {
      expect(WorkspaceNameSchema.safeParse(name)).toMatchObject({
        success: true,
      });
    }
  });

  it('normalizes the parsed value to NFC instead of just accepting it', () => {
    // 'é' spelled as e + U+0301 (what macOS often pastes) must be stored as
    // the single-code-point form, or a name read off the screen cannot be
    // selected with `--workspace <name>`.
    const decomposed = 'cafe\u0301-team';
    const parsed = WorkspaceNameSchema.safeParse(decomposed);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.name).toBe('café-team'.normalize('NFC'));
    expect(parsed.success && parsed.data.name).not.toBe(decomposed);
    expect(parsed.success && parsed.data.key).toBe('café-team');
  });

  it('normalizeWorkspaceName is idempotent', () => {
    const once = normalizeWorkspaceName('cafe\u0301');
    expect(normalizeWorkspaceName(once)).toBe(once);
  });

  it('rejects empty/all-whitespace and canonicalizes edge whitespace', () => {
    for (const name of ['', '   ', '　']) {
      expect(WorkspaceNameSchema.safeParse(name).success).toBe(false);
    }
    expect(WorkspaceNameSchema.parse(' lead ').name).toBe('lead');
    expect(WorkspaceNameSchema.parse('\u3000trail\u00A0').name).toBe('trail');
  });

  it('rejects control and invisible code points', () => {
    const cases = {
      newline: 'a\nb',
      tab: 'a\tb',
      zeroWidthSpace: 'a\u200Bb',
      zeroWidthJoiner: 'a\u200Db',
      bom: 'a\uFEFFb',
      bidiOverride: 'a\u202Eb',
      lineSeparator: 'a\u2028b',
      loneSurrogate: 'a\uD800b',
      // Default-ignorable but NOT in any C*/Z* general category — which is why
      // the rule is named by binary property instead of approximated by
      // category. These render as nothing (or only shift presentation) yet
      // spell a different raw name, so two names could be pixel-identical.
      combiningGraphemeJoiner: 'a\u034Fb',
      hangulChoseongFiller: 'a\u115Fb',
      variationSelector16: 'a\uFE0Fb',
      mongolianFreeVariationSelector: 'a\u180Bb',
      // Permanently reserved as non-interchange: no future Unicode revision
      // can assign them a glyph.
      noncharacterFDD0: 'a\uFDD0b',
      noncharacterFFFE: 'a\uFFFEb',
    };
    for (const [label, name] of Object.entries(cases)) {
      expect(WorkspaceNameSchema.safeParse(name).success, `${label} must be rejected`).toBe(false);
    }
  });

  it('keeps assigned-but-unusual characters legal under the shipped Unicode table', () => {
    for (const name of ['❤', '🎨', 'ᅡ', '设计', 'ß']) {
      expect(
        WorkspaceNameSchema.safeParse(name).success,
        `${JSON.stringify(name)} must be accepted`,
      ).toBe(true);
    }
  });

  it('uses the same pinned verdict as conversation titles', () => {
    // Unassigned code points fail closed until the reviewed Unicode table is
    // regenerated; a workspace cannot admit a segment a channel refuses.
    expect(WorkspaceNameSchema.safeParse('a\u0378b').success).toBe(false);
    expect(WorkspaceNameSchema.safeParse('👩‍💻').success).toBe(false);
    expect(WorkspaceNameSchema.safeParse('🎨').success).toBe(true);
  });

  it('measures length in code points, not UTF-16 units', () => {
    // 64 astral characters = 128 UTF-16 units. A `.max(64)` on the raw string
    // would reject this legal name.
    const astral = '𠮷'.repeat(64);
    expect(astral.length).toBe(128);
    expect(WorkspaceNameSchema.safeParse(astral).success).toBe(true);
    expect(WorkspaceNameSchema.safeParse('𠮷'.repeat(65)).success).toBe(false);
  });

  it('reports overflow as too_big so the renderer can say "too long"', () => {
    const parsed = WorkspaceNameSchema.safeParse('设'.repeat(65));
    expect(parsed.success).toBe(false);
    expect(!parsed.success && parsed.error.issues.some((i) => i.code === 'too_big')).toBe(true);
  });

  it('does not report too_big for a charset-only rejection', () => {
    // The renderer maps "any issue is too_big" → length, everything else →
    // charset. An invisible-character rejection must therefore carry no
    // too_big, or the inline hint would talk about length.
    const parsed = WorkspaceNameSchema.safeParse('a\u200Db');
    expect(parsed.success).toBe(false);
    expect(!parsed.success && parsed.error.issues.some((i) => i.code === 'too_big')).toBe(false);
  });

  it('round-trips readable segments without slugifying display text', () => {
    for (const name of ['Design Review', '设计/评审', '100% Ready', '🎨']) {
      const canonical = fixedWorkspaceName(name);
      const segment = formatWorkspaceAddressSegment(canonical);
      expect(parseWorkspaceAddressSegment(segment)).toEqual(canonical);
    }
    expect(formatWorkspaceAddressSegment(fixedWorkspaceName('设计/100% Ready'))).toBe(
      '设计%2F100%25%20Ready',
    );
  });

  it('rejects delimiter injection and non-canonical equivalent spellings', () => {
    for (const segment of [
      'Design/Review',
      'Design%2fReview',
      '%44esign',
      '%20Design',
      'Design%',
      'Design%ZZ',
      'cafe\u0301',
    ]) {
      expect(parseWorkspaceAddressSegment(segment), segment).toBeNull();
    }
    // One decode only: this is the canonical address of the literal name
    // `Design%2FReview`, never an alias for `Design/Review`.
    expect(parseWorkspaceAddressSegment('Design%252FReview')?.name).toBe('Design%2FReview');
  });
});
