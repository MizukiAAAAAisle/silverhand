// Channel agent-mutation error formatting (#task:1292), extracted verbatim from
// hooks.ts. Leaf module (only depends on the ApiError shape).
import { ApiError } from "@/lib/api";

function parseApiErrorBody(err: ApiError): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(err.body) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Start-agent refusals. Each named line states the fact the user can act on,
 * from the FINAL per-intent producer enumeration for this surface (Alice,
 * #task:1809 / doc §7 U5) — never the code's legacy name:
 *
 *  - `workspace_bundle_missing` — the daemon could not create or enter the
 *    agent's working directory before spawning it. A local OS admission
 *    failure (disk, permissions, path in use), NOT "the workspace is missing or
 *    out of sync": L1/L2 content is best-effort enrichment and never gates a
 *    spawn. Both halves of that producer are user-reachable — a fresh `mkdir`
 *    can fail AND an existing directory can be unenterable (mode/ownership) —
 *    so the line says the directory is not usable rather than "couldn't be
 *    created", which would state the wrong fact in the permission case. The
 *    host path is logged host-side and deliberately absent from the wire
 *    message, so the line must not send the user looking for a folder.
 *  - `registry_unavailable` — dominant producer: that computer's daemon has not
 *    finished registering with the server, so it has no agents root yet. Its
 *    other producer (an unsafe workspace-id segment) cannot be reached by a
 *    DB-minted id, so the line speaks to the reachable one.
 *  - `workspace_not_provisioned` — an `agent_home` reference that does not
 *    belong to this agent: an internal invariant refusal reachable only through
 *    a corrupt or forged reference, not through anything the user did. The code
 *    name still reads like "not set up yet" (a naming debt Alice priced as not
 *    worth a protocol bump for a near-unreachable producer), so the copy must
 *    NOT paraphrase it — it stays a plain internal error.
 *
 * `detail` is dropped from all three: it carries host-local paths and internal
 * taxonomy, which is exactly what these lines must not surface.
 */
export function formatStartAgentError(err: unknown): string {
  if (err instanceof ApiError) {
    const body = parseApiErrorBody(err);
    const code = typeof body?.code === "string" ? body.code : null;
    const detail =
      typeof body?.error === "string"
        ? body.error
        : typeof body?.message === "string"
          ? body.message
          : err.body || err.message;
    if (code === "host_attach_pending") {
      return "Can't start the agent: its computer is not connected yet.";
    }
    if (code === "workspace_bundle_missing") {
      return "Can't start the agent: its working directory on that computer isn't usable. Check the computer's disk space and permissions, then try again.";
    }
    if (code === "registry_unavailable") {
      return "Can't start the agent: its computer hasn't finished registering with the server. Try again in a moment.";
    }
    if (code === "workspace_not_provisioned") {
      return "Can't start the agent: its computer reported an internal error. Try again, and report it if it keeps happening.";
    }
    return `Can't start the agent: ${detail}`;
  }
  return `Can't start the agent: ${err instanceof Error ? err.message : String(err)}`;
}

export function formatRemoveAgentError(err: unknown): string {
  if (err instanceof ApiError) {
    const body = parseApiErrorBody(err);
    const code = typeof body?.code === "string" ? body.code : null;
    if (code === "conversation_member_remove_unsupported") {
      // Capability, not kind (#task:2044): a direct pair and a fixed-roster
      // agent-space channel both land here, so the line can't name one of them.
      return "This conversation's members are fixed and can't be changed.";
    }
    if (code === "conversation_closed") {
      return "This conversation is closed. Members can't be removed.";
    }
    if (err.status === 403) return "You don't have permission to remove this agent.";
    if (err.status === 404) return "This agent is no longer a member.";
    const detail =
      typeof body?.error === "string"
        ? body.error
        : typeof body?.message === "string"
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
    const code = typeof body?.code === "string" ? body.code : null;
    if (code === "conversation_member_remove_unsupported") {
      // Same capability line as the agent path above — one fact, one wording.
      return "This conversation's members are fixed and can't be changed.";
    }
    if (code === "conversation_closed") {
      return "This channel is closed. Members can't be removed.";
    }
    if (code === "channel_archived") {
      return "Restore the channel before changing its members.";
    }
    if (code === "target_outranks_actor") {
      return "This member holds a higher workspace role than you.";
    }
    if (code === "channel_owner") {
      return "The owner of a private channel can't be removed.";
    }
    if (code === "last_human_member") {
      return "The last member of a private channel can't be removed.";
    }
    if (err.status === 403) return "You don't have permission to remove this member.";
    // 404 on this route means the CHANNEL is gone, never the member: a target
    // with no membership row is an idempotent 200.
    if (err.status === 404) return "This channel no longer exists.";
    const detail =
      typeof body?.error === "string"
        ? body.error
        : typeof body?.message === "string"
          ? body.message
          : `HTTP ${err.status}`;
    return `Can't remove the member: ${detail}`;
  }
  return `Can't remove the member: ${err instanceof Error ? err.message : String(err)}`;
}
