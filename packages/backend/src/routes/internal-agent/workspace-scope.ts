// Where an agent's WORKSPACE-scoped queries get their workspace from
// (agent-scoped-session-v1 §4.1 / §6, #task:2014).
//
// Several internal-agent reads are workspace-scoped by their own domain —
// `list_channels`, agent-profile lookup by handle, the task board, message
// search — and they have always DEFAULTED that workspace to "the one my calling
// conversation lives in". From v71 that default is no longer total: an
// `agent_inbox` placement has no workspace at all, and a session can run in one
// (a mention CC is delivered there).
//
// So the default becomes a partial function, and this module is the one place
// that says what happens where it is undefined: the route answers
// `workspace_scope_required` (400) and names the argument that fixes it. It does
// NOT fall back to the agent's home workspace — that would silently answer a
// DIFFERENT question than the caller asked (and re-introduce `agent_home` as an
// ambient coordinate, which §7.5 removes), and it does not fail as 404/403,
// which would read as "your conversation is gone" / "you may not look".
//
// The alternative — letting the surface answer with a workspace-less "empty" —
// is exactly the silent-vanish this feature exists to remove (§1): the caller
// cannot tell "no channels here" from "this question has no answer for my
// placement".
import type { Context } from 'hono';
import type { ConversationRow } from '@silverhand/shared';

/** The subset both `ConversationRow` and the DM/channel DTOs satisfy. */
export interface WorkspaceScopeSource {
  id: string;
  workspace_id: string | null;
  placement_kind?: ConversationRow['placement_kind'];
}

export type WorkspaceScopeResolution =
  | { ok: true; workspaceId: string }
  | { ok: false; response: Response };

/**
 * Resolve the workspace a workspace-scoped agent query lands in: the explicit
 * argument when given, else the SOURCE conversation's placement.
 *
 * The source is the calling conversation for the reads that default to "here",
 * and the ADDRESSED conversation for a door whose operand is named
 * (`channel create --target`, #task:2021 P4-4) — same partial function either
 * way, which is why it takes a row rather than reading the credential itself.
 *
 * `explicit` wins even when the source conversation has no workspace — that is
 * precisely how an inbox session asks a workspace question. Authorization of a
 * non-source workspace stays with the caller (`canAgentAccessWorkspace` +
 * `requireAgentCapability`); this only decides WHICH id is under discussion.
 */
export function resolveAgentQueryWorkspaceId(
  c: Context,
  source: WorkspaceScopeSource,
  explicit: string | null | undefined,
  /** The request argument that can name a workspace explicitly, or `null` for a
   *  surface that has none — then the only honest answer is that this act needs
   *  a workspace-placed conversation, and inventing an argument name in the
   *  error would send the caller after a parameter that does not exist. */
  argumentName: string | null = 'workspace_id',
): WorkspaceScopeResolution {
  const workspaceId = explicit ?? source.workspace_id;
  if (workspaceId === null || workspaceId === undefined) {
    // Name the placement only when the caller actually handed us one: the wire
    // DTO most routes hold does not carry `placement_kind`, and inventing a
    // label for it would put a coordinate in the error that the row never had.
    const placement = source.placement_kind
      ? ` (placement_kind=${source.placement_kind})`
      : '';
    return {
      ok: false,
      response: c.json(
        {
          error:
            `this conversation has no workspace${placement}, `
            + (argumentName === null
              ? 'and this act is workspace-scoped: name a workspace-placed conversation'
              : `so a workspace-scoped query must name one: pass ${argumentName}`),
          code: 'workspace_scope_required',
        },
        400,
      ),
    };
  }
  return { ok: true, workspaceId };
}
