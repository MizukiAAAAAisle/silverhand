import { z } from 'zod';

/** Max length for user-chosen entity names (agents, workspaces). The QUANTITY
 *  is shared; the unit is per-schema (see each schema's docblock). */
export const ENTITY_NAME_MAX_LENGTH = 64;

/**
 * Stored participant-name grammar. A participant name is a durable mention
 * handle, so every name admitted here must also be representable by the
 * message and renderer `@mention` parsers. The optional display `@` belongs to
 * command inputs (`HandleSchema`), never to the stored value.
 *
 * Agent input paths validate against this schema directly. User names are
 * currently system-generated (`local` or an alpha-first `user-*`/email-derived
 * name) and satisfy it by construction; any future user-selected signup or
 * invite name must validate here before persistence.
 *
 * Kept separate from {@link WorkspaceNameSchema}: workspace names are display
 * labels and must not inherit participant-addressing constraints.
 *
 * Length counts UTF-16 code units, which is exact here because the grammar is
 * ASCII-only. Workspace names admit astral characters and therefore count code
 * points instead — the max is shared, the unit is not.
 */
export const ParticipantNameSchema = z
  .string()
  .min(1)
  .max(ENTITY_NAME_MAX_LENGTH)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_-]*$/,
    'participant name must start with a letter and contain only letters, numbers, dash, or underscore',
  );

/**
 * Canonical form for a stored workspace name.
 *
 * A workspace name is display text AND a selector: it carries a uniqueness
 * index and resolves `--workspace <name>` on the agent task commands. Unicode
 * lets one visible name be spelled with different code-point sequences, so
 * without a normal form two identical-looking names compare unequal — the user
 * reads a name off the screen and cannot select it. NFC is an equivalence
 * relation over spellings of the SAME characters, so normalizing costs no name.
 *
 * Deliberately NOT folded: full-width/half-width and simplified/traditional
 * variants. Those are lossy product policies rather than equivalences (not 1:1,
 * region-dependent); folding them would report a legal name as taken with no
 * recourse, whereas merely looking alike is visible and fixable by renaming.
 */
export function normalizeWorkspaceName(name: string): string {
  return name.normalize('NFC');
}

/**
 * Code points that must not appear in a workspace name. All of them are barred
 * for ONE reason — they are unreadable in the field that has to be RETYPED to
 * select a workspace, so two different names can be pixel-identical:
 *   - `Cc` / `Zl` / `Zp` — controls and line separators; not renderable on one
 *     line at all.
 *   - `Cf` / `Cs` — zero-width spaces, BOM, bidi overrides, lone surrogates.
 *   - `Default_Ignorable_Code_Point` — the binary property is what actually
 *     names "renders as nothing": the general categories above miss members
 *     that are `Mn` or `Lo`, e.g. U+034F COMBINING GRAPHEME JOINER, U+115F
 *     HANGUL CHOSEONG FILLER, U+FE0F VARIATION SELECTOR-16. Approximating this
 *     class by general category is what let those through.
 *   - `Noncharacter_Code_Point` — U+FDD0..U+FDEF and the U+xFFFE/U+xFFFF pairs
 *     are permanently reserved as non-interchange, so no future revision can
 *     assign them a glyph.
 *
 * Costs, stated rather than hidden: a family emoji (a ZWJ sequence, U+1F468
 * U+200D U+1F469 U+200D U+1F467) and a heart with the emoji presentation
 * selector (U+2764 U+FE0F) are rejected; their single-code-point neighbours
 * (`🎨`, `❤`) are fine. Named by code point on purpose — a docblock that pastes
 * the joiner raw hides the very character being discussed. Unassigned code
 * points (`Cn`) are NOT barred as a class: that class shrinks with every
 * Unicode revision, so blocking it would reject tomorrow's characters on
 * today's engine; only the permanent subset (`Noncharacter_Code_Point`) is
 * listed.
 */
const WORKSPACE_NAME_FORBIDDEN =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{Noncharacter_Code_Point}]/u;

/**
 * Stored workspace-name FORMAT rule, and the NFC normalizer for the value it
 * admits (parse output is the canonical form, so every write path that goes
 * through this schema stores one spelling).
 *
 * A workspace name is a LABEL, not a handle: shiki's 2026-08-05 ruling is that
 * it must accept Chinese, and it deliberately does not inherit the participant
 * addressing grammar ({@link ParticipantNameSchema}). `@`, `#` and `/` are
 * legal — no reference form spells a workspace (the renderer's `REF_RE` has
 * five forms, none of them a workspace), so there is no contract to protect by
 * banning them, and channel titles already set the precedent of free text.
 *
 * Length is 64 CODE POINTS (`Array.from`), not UTF-16 units, so an astral
 * character costs one. Grapheme clusters are explicitly not promised: a
 * base+combining-mark pair that NFC cannot compose (a Devanagari or Thai
 * cluster, say) costs more than one, which `Intl.Segmenter` would be needed to
 * avoid — a name is an identifier-shaped field, not prose, so the precision is
 * not worth the dependency. The overflow issue is raised as `too_big` on
 * purpose: the renderer's advisory validator classifies length-vs-charset by
 * issue code, and a plain `.refine` would report `custom` and be shown as a
 * charset error.
 *
 * FORMAT only — uniqueness is a separate, server-only concern (see the
 * name-availability endpoints + {@link NameAvailabilityDtoSchema}), and it is
 * judged on the normalized form because every write stores it normalized.
 */
export const WorkspaceNameSchema = z
  .string()
  .transform(normalizeWorkspaceName)
  .superRefine((name, ctx) => {
    if (name.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_small,
        minimum: 1,
        type: 'string',
        inclusive: true,
        message: 'workspace name must not be empty',
      });
      return;
    }
    if (Array.from(name).length > ENTITY_NAME_MAX_LENGTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: ENTITY_NAME_MAX_LENGTH,
        type: 'string',
        inclusive: true,
        message: `workspace name must be at most ${ENTITY_NAME_MAX_LENGTH} characters`,
      });
    }
    if (name !== name.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'workspace name must not start or end with whitespace',
      });
    }
    if (WORKSPACE_NAME_FORBIDDEN.test(name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'workspace name must not contain control or invisible characters',
      });
    }
  });

/** Why a proposed name is / isn't usable. Invariant: a name is usable iff
 *  `reason === 'available'`. `taken` = uniqueness collision; `invalid` = fails
 *  the queried entity kind's authoritative name schema. */
export const NameAvailabilityReasonSchema = z.enum([
  'available',
  'invalid',
  'taken',
]);
export type NameAvailabilityReason = z.infer<
  typeof NameAvailabilityReasonSchema
>;

/** Response of `GET /api/{agents,workspaces}/name-availability?name=`.
 *  A create-form onBlur probe: the endpoint shares ONE uniqueness predicate
 *  with the matching create path, so the form can never report `available`
 *  for a name that create would reject.
 *
 *  The `available ⇔ reason === 'available'` invariant is enforced here in the
 *  shared schema, not left to route discipline: as a wire DTO this is the
 *  boundary both producer and consumer trust, so a contradictory pair like
 *  `{ available: true, reason: 'taken' }` must be structurally unrepresentable
 *  rather than merely "not produced today". */
export const NameAvailabilityDtoSchema = z
  .object({
    available: z.boolean(),
    reason: NameAvailabilityReasonSchema,
  })
  .strict()
  .refine(dto => dto.available === (dto.reason === 'available'), {
    message: "available must be true iff reason === 'available'",
  });
export type NameAvailabilityDto = z.infer<typeof NameAvailabilityDtoSchema>;
