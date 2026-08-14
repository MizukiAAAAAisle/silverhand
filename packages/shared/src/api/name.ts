import { z } from 'zod';

/** Max length for user-chosen entity names (agents, workspaces). The QUANTITY
 *  is shared; the unit is per-schema (see each schema's docblock). */
export const ENTITY_NAME_MAX_LENGTH = 64;

/**
 * The participant-handle CHARACTER grammar, as a regex source fragment with no
 * anchors and no capture group.
 *
 * Exported because a handle is spelled in more than one syntax and every one of
 * them must admit exactly the same set of names: the stored value
 * ({@link ParticipantNameSchema} below), the plain `@name` display alias
 * (`PLAIN_MENTION_PATTERN` in `api/message.ts`), and the handle segment of a
 * canonical reference destination (`reference.ts`). A second copy of the
 * character class is how one syntax comes to accept a name another rejects —
 * which, for the destination form, means a chip that never delivers. The LENGTH
 * half of the domain is {@link ENTITY_NAME_MAX_LENGTH}; a consumer that needs
 * the full stored domain must apply both.
 */
export const PARTICIPANT_HANDLE_PATTERN = '[a-zA-Z][a-zA-Z0-9_-]*';

/**
 * The conversation-NAME character grammar (#task:2016), as an unanchored regex
 * source fragment with no capture group — same shape and same reason as
 * {@link PARTICIPANT_HANDLE_PATTERN} above.
 *
 * A conversation name is an ADDRESS, not a label: `conversations.title` keeps
 * the display half and may be renamed freely, while the name is the stable
 * coordinate a `#<name>` reference resolves through. Three properties are
 * load-bearing, and each one is a constraint the title deliberately does not
 * carry:
 *
 *  - **Lowercase only.** Uniqueness is enforced by a DB index, so binary
 *    equality has to mean visual equality. Admitting `Design` next to `design`
 *    would need `COLLATE NOCASE` — which is ASCII-only in SQLite and therefore
 *    silently inconsistent the moment the domain grows — so the domain excludes
 *    the confusion instead of folding it.
 *  - **First character a LETTER, last character alphanumeric.** Not cosmetic:
 *    the chat tokenizer (`REF_RE`, renderer `Markdown.tsx`) spells the channel
 *    form as `#[a-zA-Z][a-zA-Z0-9_-]*` and reserves bare `#<number ≥ 11>` for
 *    tasks. A digit-leading name is therefore either inert (`#2`) or resolves to
 *    a TASK (`#42`) — an address that silently points at another entity kind.
 *    Admitting one would require settling that collision and changing the target
 *    grammar, which is a different ticket (@Cindy, B4). A separator on either
 *    end is barred for the milder reason that it is invisible in a chip.
 *  - **A subset of the tokenizer's character class.** A name the tokenizer
 *    cannot capture is a name nobody can reference, so an admissible name is
 *    always spellable — and, with the rule above, always spellable AS A CHANNEL.
 *
 * The LENGTH half of the domain is {@link ENTITY_NAME_MAX_LENGTH}, shared with
 * the other entity names; a consumer that needs the full stored domain must
 * apply both, or just use {@link ConversationNameSchema}.
 */
export const CONVERSATION_NAME_PATTERN = '[a-z](?:[a-z0-9_-]*[a-z0-9])?';

/**
 * Stored conversation-name grammar: FORMAT only.
 *
 * Uniqueness is a database fact, not a schema fact — a name is allocated in the
 * `conversation_names` registry, whose primary key spans current AND retired
 * names so a retired name can never be reallocated. This schema therefore says
 * nothing about availability, and passing it is not permission to write.
 *
 * Kept separate from `ChannelTitleSchema` on purpose: they are two concepts with
 * two rules (freeform display text vs. addressable identity), and the whole
 * point of #task:2016 is that renaming the first does not touch the second.
 */
export const ConversationNameSchema = z
  .string()
  .min(1)
  .max(ENTITY_NAME_MAX_LENGTH)
  .regex(
    new RegExp(`^${CONVERSATION_NAME_PATTERN}$`),
    'conversation name must be lowercase letters, numbers, dash or underscore, starting with a letter and ending alphanumeric',
  );

/**
 * Stored participant-name grammar. A participant name is a durable mention
 * handle, so every name admitted here must also be representable by the
 * message and renderer `@mention` parsers. The optional display `@` belongs to
 * command inputs (`HandleSchema`), never to the stored value.
 *
 * Agent AND user input paths validate against this schema directly: password
 * signup takes the handle from the user (`AuthSignupInputSchema.name`,
 * #task:1830), and `UserRepo.create` re-asserts it at the persistence boundary
 * (#task:1828). The remaining system-generated user names — embedded bootstrap's
 * `local` and the legacy `user-<4hex>` registration suggestion — satisfy it by
 * construction.
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
    new RegExp(`^${PARTICIPANT_HANDLE_PATTERN}$`),
    'participant name must start with a letter and contain only letters, numbers, dash, or underscore',
  );

/**
 * Suggest a participant name from an email address, for PREFILLING a signup
 * handle field. Advisory only: the returned value is a starting point the user
 * may overwrite, and it says nothing about uniqueness.
 *
 * This is the retired half of the old signup deriver (#task:1830). The stored
 * `users.name` used to be whatever that deriver computed, which is how a
 * permanent, non-renamable handle came to be decided by the shape of an email
 * address. Now the user chooses and this only seeds the field — so it lives next
 * to the grammar it must respect, with no second copy in the renderer.
 *
 * Output is either **empty** or admissible by {@link ParticipantNameSchema}:
 * after the leading non-letters are dropped the first character is a letter,
 * every surviving character is in the allowed class, and slicing a prefix cannot
 * break either property. Empty is deliberate rather than a `user` placeholder
 * (@Norman, #task:1830): when nothing of the local-part survives — a fully
 * non-ASCII address, say — a plausible-looking default on the one field that can
 * never be changed invites being accepted unread. An empty required field asks
 * the question instead.
 */
export function suggestParticipantNameFromEmail(email: string): string {
  const localPart = email.trim().toLowerCase().split('@')[0] ?? '';
  const cleaned = localPart
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/[-_]+$/g, '');
  return cleaned.slice(0, ENTITY_NAME_MAX_LENGTH);
}

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
