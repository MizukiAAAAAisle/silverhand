// Channel agent-mutation error formatting (#task:1292), extracted verbatim from
// hooks.ts. Leaf module (only depends on the ApiError shape).
import { ApiError } from '@/lib/api';

function parseApiErrorBody(err: ApiError): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(err.body) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function formatStartAgentError(err: unknown): string {
  if (err instanceof ApiError) {
    const body = parseApiErrorBody(err);
    const code = typeof body?.code === 'string' ? body.code : null;
    const detail =
      typeof body?.error === 'string'
        ? body.error
        : typeof body?.message === 'string'
          ? body.message
          : err.body || err.message;
    if (code === 'host_attach_pending') {
      return "Can't start the agent: its computer is not connected yet.";
    }
    if (code === 'workspace_path_missing') {
      return `Can't start the agent: ${detail}`;
    }
    if (code === 'workspace_not_provisioned') {
      return `Can't start the agent: the workspace is not provisioned yet. ${detail}`;
    }
    if (code === 'registry_unavailable') {
      return `Can't start the agent: the workspace registry on its computer is unavailable. ${detail}`;
    }
    return `Can't start the agent: ${detail}`;
  }
  return `Can't start the agent: ${err instanceof Error ? err.message : String(err)}`;
}

export function formatRemoveAgentError(err: unknown): string {
  if (err instanceof ApiError) {
    const body = parseApiErrorBody(err);
    const code = typeof body?.code === 'string' ? body.code : null;
    if (code === 'conversation_member_remove_unsupported') {
      return 'Members can be removed from a channel or a thread, not a DM.';
    }
    if (code === 'conversation_closed') {
      return "This conversation is closed. Members can't be removed.";
    }
    if (err.status === 403)
      return "You don't have permission to remove this agent.";
    if (err.status === 404) return 'This agent is no longer a member.';
    const detail =
      typeof body?.error === 'string'
        ? body.error
        : typeof body?.message === 'string'
          ? body.message
          : `HTTP ${err.status}`;
    return `Can't remove the agent: ${detail}`;
  }
  return `Can't remove the agent: ${err instanceof Error ? err.message : String(err)}`;
}
