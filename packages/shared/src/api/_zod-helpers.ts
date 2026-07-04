// Private api-local helpers split out of the former monolithic api/dto.ts
// (#task:963). Intentionally NOT re-exported from api/index.ts: these are
// shared internal zod preprocessors (currently SearchOptionalStringSchema,
// used by both message search and the agent search_messages MCP input), not
// part of the public @silverhand/shared surface.
import { z } from 'zod';
import { AttachmentRefInputSchema } from './attachment.js';

export const SearchOptionalStringSchema = z.preprocess(
  value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().optional(),
);

/** A send references attachments as bare id strings (agent CLI `--attachment`,
 *  daemon relay — no compose-time label) OR as `{id, label}` refs (the composer
 *  carries the label the user saw). Both branches normalize to a uniform ref
 *  list at the route boundary (`normalizeAttachmentRefs`); the union is confined
 *  to the wire edge. */
export const MessageAttachmentIdsInputSchema = z
  .array(z.union([z.string().min(1), AttachmentRefInputSchema]))
  .max(20)
  .optional();

export function hasMessagePayload(value: {
  content: string;
  attachment_ids?: readonly unknown[];
}): boolean {
  return value.content.trim().length > 0 || (value.attachment_ids?.length ?? 0) > 0;
}
