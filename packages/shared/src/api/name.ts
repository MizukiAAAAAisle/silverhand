import { z } from 'zod';

/** Max length for user-chosen entity names (agents, workspaces). */
export const ENTITY_NAME_MAX_LENGTH = 64;

/** Single source for the entity-name FORMAT rule (agents + workspaces).
 *  Referenced by every create/update schema, the name-availability endpoints,
 *  and the renderer's onBlur format check so no second hand-copied regex can
 *  drift. FORMAT only — uniqueness is a separate, server-only concern (see the
 *  name-availability endpoints + {@link NameAvailabilityDtoSchema}). */
export const EntityNameSchema = z
  .string()
  .min(1)
  .max(ENTITY_NAME_MAX_LENGTH)
  .regex(/^[a-zA-Z0-9_\-]+$/, 'name must be alphanumeric / dash / underscore');

/** Why a proposed name is / isn't usable. Invariant: a name is usable iff
 *  `reason === 'available'`. `taken` = uniqueness collision; `invalid` = fails
 *  {@link EntityNameSchema} format. */
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
 *  for a name that create would reject. */
export const NameAvailabilityDtoSchema = z
  .object({
    available: z.boolean(),
    reason: NameAvailabilityReasonSchema,
  })
  .strict();
export type NameAvailabilityDto = z.infer<typeof NameAvailabilityDtoSchema>;
