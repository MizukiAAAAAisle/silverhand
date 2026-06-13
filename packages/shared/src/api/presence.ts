import { z } from 'zod';

export const UserPresenceSchema = z.enum(['online', 'offline']);
export type UserPresence = z.infer<typeof UserPresenceSchema>;

export const UserPresenceDtoSchema = z.object({
  user_id: z.string(),
  presence: UserPresenceSchema,
  last_seen_at: z.number().nullable(),
});
export type UserPresenceDto = z.infer<typeof UserPresenceDtoSchema>;

export const UserPresenceEventSchema = UserPresenceDtoSchema;
export type UserPresenceEvent = z.infer<typeof UserPresenceEventSchema>;

export const PresenceResponseSchema = z.object({
  users: z.array(UserPresenceDtoSchema),
});
export type PresenceResponse = z.infer<typeof PresenceResponseSchema>;
