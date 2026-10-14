import { isAbsolute } from 'node:path';
import { HOOK_EVENTS, HOOK_LIMITS, type HookRule } from '@silverhand/client';
import { z } from 'zod';

const Rule = z
  .object({
    id: z.string().trim().min(1).max(128),
    name: z.string().trim().min(1).max(160),
    enabled: z.boolean(),
    event: z.enum(['notification', 'task_changed']),
    match: z.record(z.string().max(512).nullable()).optional(),
    action: z
      .object({
        type: z.literal('command'),
        command: z
          .string()
          .min(1)
          .max(16384)
          .refine((value) => value.trim().length > 0),
        cwd: z.string().refine(isAbsolute, 'Working directory must be absolute').optional(),
        async: z.literal(true).optional(),
        env: z
          .record(
            z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
            z
              .string()
              .max(16384)
              .refine((value) => !value.includes('\0')),
          )
          .optional(),
        timeoutMs: z.number().int().min(1).max(HOOK_LIMITS.maxTimeoutMs).optional(),
      })
      .strict(),
  })
  .strict();

export function parseHookRule(input: unknown): HookRule {
  const rule = Rule.parse(input);
  const fields: Record<string, readonly string[]> = HOOK_EVENTS[rule.event].fields;
  for (const [key, value] of Object.entries(rule.match ?? {})) {
    if (!Object.hasOwn(fields, key)) throw new Error(`Unsupported match field: ${key}`);
    const values = fields[key]!;
    if (value === null ? key !== 'workspace_id' : values.length > 0 && !values.includes(value))
      throw new Error(`Invalid match value for ${key}`);
  }
  return rule;
}
