import { z } from 'zod';

/** A JSON number that every JavaScript consumer represents exactly and that can
 * name a persisted sequence coordinate. This is the one numeric authority used
 * by task/schedule request bodies; callers must move to a decimal string before
 * this ceiling can ever be widened. */
export const PositiveJsSafeIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

/** Canonical positive decimal query grammar. Query numbers are deliberately
 * narrower than JSON numbers: ASCII base-10 only, no sign, exponent, whitespace,
 * hex prefix, or leading zero. The transformed value is still checked against
 * the shared exact-binary64 ceiling. */
export const CanonicalPositiveIntegerQuerySchema = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .transform(raw => Number(raw))
  .pipe(PositiveJsSafeIntegerSchema);
