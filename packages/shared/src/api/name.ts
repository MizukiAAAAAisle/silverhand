import { z } from 'zod';

/** Max length for user-chosen entity names (agents, workspaces). */
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
 * Kept separate from {@link EntityNameSchema}: workspace names are display
 * labels and must not inherit participant-addressing constraints.
 */
export const ParticipantNameSchema = z
  .string()
  .min(1)
  .max(ENTITY_NAME_MAX_LENGTH)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_-]*$/,
    'participant name must start with a letter and contain only letters, numbers, dash, or underscore',
  );

/** Generic entity-name FORMAT rule. Participant names deliberately use the
 *  narrower {@link ParticipantNameSchema}; workspace names currently use this
 *  schema and therefore remain allowed to start with a digit. FORMAT only —
 *  uniqueness is a separate, server-only concern (see the name-availability
 *  endpoints + {@link NameAvailabilityDtoSchema}). */
export const EntityNameSchema = z
  .string()
  .min(1)
  .max(ENTITY_NAME_MAX_LENGTH)
  .regex(/^[a-zA-Z0-9_\-]+$/, 'name must be alphanumeric / dash / underscore');

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
