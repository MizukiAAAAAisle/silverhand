import {
  HumanCreateTaskErrorCodeSchema,
  type HumanCreateTaskErrorCode,
} from '@silverhand/shared';
import { ApiError } from '@/lib/api';

/**
 * Map a create failure to manual-quality copy, classified on the typed `code`
 * discriminant ALONE (never the free-text `reason`). This is a cross-layer error
 * CONTRACT, not UI structure: closed and archived read as one thing to the actor
 * — the channel won't take a new task; non-member and unknown-target were already
 * fused server-side into one code so existence never leaks, and both read as
 * "unavailable". Anything else — a 400 validation envelope, an unreachable
 * backend, a shape we don't recognise, or a rejection that carries only a
 * free-text `reason` and no typed `code` — is the generic failure, never
 * surfaced as a specific claim we cannot substantiate. `createTaskError.test.ts`
 * locks these classes.
 */
export function createTaskErrorMessage(err: unknown): string {
  const code = err instanceof ApiError ? readCreateTaskErrorCode(err.body) : null;
  switch (code) {
    case 'conversation_closed':
    case 'conversation_archived':
      return 'This channel no longer accepts new tasks.';
    case 'not_conversation_member':
    case 'conversation_not_found':
      return 'This channel is unavailable.';
    default:
      return 'The task could not be created.';
  }
}

/**
 * Read the typed `code` off a rejection body, or null. Only a value that Zod
 * accepts as a `HumanCreateTaskErrorCode` is honoured — a `reason`-only body, a
 * validation envelope, or malformed JSON all yield null, so no free-text field
 * can ever be parsed into a specific message.
 */
function readCreateTaskErrorCode(body: string): HumanCreateTaskErrorCode | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { code?: unknown };
    const result = HumanCreateTaskErrorCodeSchema.safeParse(parsed.code);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
