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

/**
 * Refusals of `DELETE /api/conversations/:id/members/users/:userId` (#task:1688).
 * The members modal already HIDES the control per the `member_removability`
 * carrier, so every line here is reached only through a stale carrier (the
 * target's role or the channel's state changed after the read) — which is
 * precisely why the carrier is advisory and the route authoritative.
 *
 * Each guard keeps its own sentence because it names a DIFFERENT fact about the
 * target, and the viewer's next step differs (restore the channel vs. nothing
 * they can do). `self_target` is intentionally not special-cased: the modal
 * renders Leave — never Remove — on the viewer's own row.
 */
export function formatRemoveHumanError(err: unknown): string {
  if (err instanceof ApiError) {
    const body = parseApiErrorBody(err);
    const code = typeof body?.code === 'string' ? body.code : null;
    if (code === 'conversation_member_remove_unsupported') {
      return 'Members can be removed from a channel, not a DM.';
    }
    if (code === 'conversation_closed') {
      return "This channel is closed. Members can't be removed.";
    }
    if (code === 'channel_archived') {
      return 'Restore the channel before changing its members.';
    }
    if (code === 'target_outranks_actor') {
      return 'This member holds a higher workspace role than you.';
    }
    if (code === 'channel_owner') {
      return "The owner of a private channel can't be removed.";
    }
    if (code === 'last_human_member') {
      return "The last member of a private channel can't be removed.";
    }
    if (err.status === 403)
      return "You don't have permission to remove this member.";
    // 404 on this route means the CHANNEL is gone, never the member: a target
    // with no membership row is an idempotent 200.
    if (err.status === 404) return 'This channel no longer exists.';
    const detail =
      typeof body?.error === 'string'
        ? body.error
        : typeof body?.message === 'string'
          ? body.message
          : `HTTP ${err.status}`;
    return `Can't remove the member: ${detail}`;
  }
  return `Can't remove the member: ${err instanceof Error ? err.message : String(err)}`;
}
