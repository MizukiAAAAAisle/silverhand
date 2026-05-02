import { z } from 'zod';
import { AUTH_TOKEN_ENV } from '@silverhand/shared';

const ArgsSchema = z.object({
  sessionId: z.string().min(1),
  agentId: z.string().min(1),
  serverUrl: z.string().url(),
  runtime: z.string().default('claude'),
  authToken: z.string().min(8),
});

export type BridgeArgs = z.infer<typeof ArgsSchema>;

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): BridgeArgs {
  const map: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg || !arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      map[key] = next;
      i++;
    } else {
      map[key] = 'true';
    }
  }

  return ArgsSchema.parse({
    sessionId: map['session-id'],
    agentId: map['agent-id'],
    serverUrl: map['server-url'],
    runtime: map['runtime'] ?? 'claude',
    authToken: env[AUTH_TOKEN_ENV] ?? map['auth-token'],
  });
}
