import { z } from 'zod';

export const ProfileMessageCountsSchema = z.object({
  subject: z.object({ kind: z.enum(['user', 'agent']), id: z.string().min(1) }),
  year: z.number().int().min(1970).max(9998),
  time_zone: z.literal('Asia/Shanghai'),
  days: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        count: z.number().int().nonnegative(),
      }),
    )
    .max(366),
  available_years: z.array(z.number().int().min(1970).max(9998)).max(8029),
});
export type ProfileMessageCounts = z.infer<typeof ProfileMessageCountsSchema>;
