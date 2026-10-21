/**
 * Per-process environment context the CLI operates within. The Agent identity,
 * server and bearer come from immutable spawn env. A ConversationSlot also has
 * one ambient conversation used only for the ruled C″ reach/correction policy;
 * an AgentSlot deliberately has none. HTTP routing is agent-global for both.
 *
 * RuntimePrincipal authenticates exact live custody. The backend then applies
 * the ruled C″ per-operation reach policy: three established operations may
 * cross streams from either slot, while four write/source operations confine a
 * ConversationSlot to its own stream. AgentSlot reach follows participation.
 */
import {
  SILVERHAND_AGENT_ID_ENV,
  SILVERHAND_AUTH_TOKEN_ENV,
  SILVERHAND_CONVERSATION_ID_ENV,
  SILVERHAND_DAEMON_SOCKET_ENV,
  SILVERHAND_LAST_DELIVERED_SEQ_FILE_ENV,
  SILVERHAND_SERVER_URL_ENV,
} from '@silverhand/shared';
import { CliError } from './errors.js';

interface CliEnvBase {
  agentId: string;
  serverUrl: string;
  authToken: string;
  daemonSocketPath?: string;
  lastDeliveredSeqFile?: string;
}

export type CliEnv = CliEnvBase &
  (
    | {
        /** A ConversationSlot's ambient stream is its only correction target. */
        slot: 'conversation';
        conversationId: string;
      }
    | { slot: 'agent'; conversationId: null }
  );

/** Resolves the four command inputs. Throws a `CliError` (validation_error,
 *  exit 1) listing every missing key when any is absent — agents see one
 *  actionable error on stderr instead of trial-and-error. */
export function loadEnv(env: NodeJS.ProcessEnv = process.env): CliEnv {
  const missing: string[] = [];
  const ambientConversationId = env[SILVERHAND_CONVERSATION_ID_ENV]?.trim();
  const agentId = env[SILVERHAND_AGENT_ID_ENV];
  const serverUrl = env[SILVERHAND_SERVER_URL_ENV];
  const authToken = env[SILVERHAND_AUTH_TOKEN_ENV];
  const daemonSocketPath = env[SILVERHAND_DAEMON_SOCKET_ENV];
  const lastDeliveredSeqFile = env[SILVERHAND_LAST_DELIVERED_SEQ_FILE_ENV];
  if (!agentId) missing.push(SILVERHAND_AGENT_ID_ENV);
  if (!serverUrl) missing.push(SILVERHAND_SERVER_URL_ENV);
  if (!authToken) missing.push(SILVERHAND_AUTH_TOKEN_ENV);
  if (missing.length > 0) {
    throw new CliError({
      code: 'validation_error',
      message: `silverhand CLI is missing required env: ${missing.join(', ')}`,
      retriable: false,
    });
  }
  // URL sanity — every internal path is built off this string.
  try {
    new URL(serverUrl!);
  } catch {
    throw new CliError({
      code: 'validation_error',
      message: `${SILVERHAND_SERVER_URL_ENV} is not a valid URL: ${serverUrl}`,
      retriable: false,
    });
  }
  const runtimeIdentity = ambientConversationId
    ? { conversationId: ambientConversationId, slot: 'conversation' as const }
    : { conversationId: null, slot: 'agent' as const };
  return {
    ...runtimeIdentity,
    agentId: agentId!,
    serverUrl: serverUrl!,
    authToken: authToken!,
    ...(daemonSocketPath ? { daemonSocketPath } : {}),
    ...(lastDeliveredSeqFile ? { lastDeliveredSeqFile } : {}),
  };
}

/** Like `loadEnv` but returns `null` instead of throwing when env is
 *  incomplete. Used by best-effort observability paths
 *  (`cli-trace.ts`) that must never escalate a missing-env condition
 *  into a visible failure. */
export function tryLoadEnv(env: NodeJS.ProcessEnv = process.env): CliEnv | null {
  try {
    return loadEnv(env);
  } catch {
    return null;
  }
}
