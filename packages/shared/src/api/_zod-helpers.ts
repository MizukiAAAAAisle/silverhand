// Private api-local helpers split out of the former monolithic api/dto.ts
// (#task:963). Intentionally NOT re-exported from api/index.ts: these are
// shared internal zod preprocessors (currently SearchOptionalStringSchema,
// used by both message search and the agent search_messages MCP input), not
// part of the public @silverhand/shared surface.
import { z } from 'zod';

export const SearchOptionalStringSchema = z.preprocess(
  value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().optional(),
);
