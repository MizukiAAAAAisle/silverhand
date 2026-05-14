import { z } from 'zod';
import {
  DEFAULT_APPEARANCE,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  THEME_IDS,
  type AppearanceSettings,
  type MarkdownTextSettings,
} from './types';

/** Internal: font-size schema. Out-of-range values are clamped (not
 *  rejected) so a user editing localStorage by hand or a stale value
 *  from a future build that widened the range still survives. NaN /
 *  non-finite / non-number → drop. */
const FontSizeSchema = z
  .number()
  .finite()
  .transform(n => Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(n))));

/** Trim whitespace; drop if empty after trim. */
const FontFamilySchema = z
  .string()
  .transform(s => s.trim())
  .refine(s => s.length > 0, { message: 'empty' });

const MarkdownTextSchema = z
  .object({
    fontFamily: FontFamilySchema.optional().catch(undefined),
    fontSize: FontSizeSchema.optional().catch(undefined),
  })
  .strip()
  .transform((raw): MarkdownTextSettings => {
    const out: MarkdownTextSettings = {};
    if (typeof raw.fontFamily === 'string') out.fontFamily = raw.fontFamily;
    if (typeof raw.fontSize === 'number') out.fontSize = raw.fontSize;
    return out;
  });

const ThemeIdSchema = z.enum(THEME_IDS).catch(DEFAULT_APPEARANCE.theme);

const AppearanceSchema = z
  .object({
    theme: ThemeIdSchema.optional().catch(DEFAULT_APPEARANCE.theme),
    prose: MarkdownTextSchema.optional().catch(undefined),
    code: MarkdownTextSchema.optional().catch(undefined),
  })
  .passthrough()
  .transform((raw): AppearanceSettings => {
    const out: AppearanceSettings = {
      theme: raw.theme ?? DEFAULT_APPEARANCE.theme,
    };
    if (raw.prose && (raw.prose.fontFamily || typeof raw.prose.fontSize === 'number')) {
      out.prose = raw.prose;
    }
    if (raw.code && (raw.code.fontFamily || typeof raw.code.fontSize === 'number')) {
      out.code = raw.code;
    }
    return out;
  });

/** Parse appearance settings from any (untrusted) source — typically a
 *  JSON.parse'd string out of localStorage. Bad inputs degrade
 *  gracefully to `DEFAULT_APPEARANCE`; partial inputs keep what
 *  parsed and drop the rest. Never throws. */
export function parseAppearance(raw: unknown): AppearanceSettings {
  if (raw === null || typeof raw !== 'object') return DEFAULT_APPEARANCE;
  const parsed = AppearanceSchema.safeParse(raw);
  if (!parsed.success) return DEFAULT_APPEARANCE;
  return parsed.data;
}

/** Parse a JSON string read from localStorage. Empty / malformed JSON
 *  → default. Same forgiving semantics as `parseAppearance`. */
export function parseAppearanceJson(raw: string | null): AppearanceSettings {
  if (!raw) return DEFAULT_APPEARANCE;
  try {
    return parseAppearance(JSON.parse(raw));
  } catch {
    return DEFAULT_APPEARANCE;
  }
}
