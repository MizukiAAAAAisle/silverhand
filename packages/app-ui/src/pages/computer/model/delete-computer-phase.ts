import type { HostAgentResource, HostResourcesResponse } from "@silverhand/shared";
import { ComputerHasPendingAgentsError } from "../../../features/computers/hooks/hooks";

/**
 * #task:1618 — what the delete-computer dialog shows, derived from the
 * `/resources` read it takes when it opens.
 *
 * Two steps, not a discovery loop: read what is rooted on the computer, show it,
 * take one confirm. So the structural branch is decided by the READ, before
 * anything destructive is offered — which is why this function's input is query
 * state rather than an error.
 *
 * The impact is AGENTS ONLY (#task:1809, shiki 2026-08-04). Deleting a computer
 * destroys the agents that live on it — their homes and DM bytes — and nothing
 * else; a workspace is not rooted on a computer, so shared workspaces, their
 * channels, messages and attachments all survive, even when that leaves a
 * workspace with no agent members. There is therefore no ownership dimension
 * here anymore: every impact this read can name is cascade-able by definition,
 * which is what retired the old `blocked` phase (it existed only to name
 * workspaces the viewer did not own).
 *
 * Phases:
 *  - `loading`     — a read is in flight (first open, OR a reopen still
 *                    refetching over last open's cached rows). The confirm exists
 *                    but must not be armed yet; confirming here would approve an
 *                    impact that is not the current one.
 *  - `unavailable` — the read FAILED. Fail closed: no destructive confirm at all,
 *                    only retry/cancel. Empty and unknown are different facts and
 *                    must never render the same screen (an "assume empty"
 *                    fallback would silently delete a full computer).
 *  - `confirm`     — the impact is known. Lists it (possibly nothing — an empty
 *                    computer is a legitimate read, not a missing one) and takes
 *                    ONE confirm.
 */
export type DeleteComputerPhase =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "confirm"; agents: HostAgentResource[] };

export interface DeleteComputerPreviewState {
  /** React Query `isPending` — no settled data yet. */
  isPending: boolean;
  /**
   * React Query `isFetching` — a read is in flight, INCLUDING a refetch that
   * still has last-open's data in cache.
   *
   * Load-bearing, not belt-and-braces (Cindy #task:1618 BLOCKER): `staleTime: 0`
   * makes a reopen refetch, it does NOT drop the cached rows. So the second time
   * the dialog opens, the typical state is `data = last open's list`,
   * `isPending: false`, `isFetching: true` — and gating on `isPending` alone
   * would arm Delete against a list from the previous visit. A computer that was
   * empty then and holds an agent now would be destroyed from a screen showing
   * no impact at all, which is exactly the two-step contract being bypassed. This
   * is the ordinary reopen path, not a race.
   */
  isFetching: boolean;
  isError: boolean;
  /**
   * Narrowed to the one dimension this dialog reads. The response still carries
   * other fields; naming only `agents` keeps the retired workspace dimension out
   * of the renderer entirely, so removing it from the DTO is a backend-only cut.
   */
  data: Pick<HostResourcesResponse, "agents"> | undefined;
}

/**
 * Pure mapping from the `/resources` query state to the dialog phase.
 *
 * `isError` wins over cached data on purpose. Data left from an earlier open is
 * not a substitute for a read we KNOW failed — for an irreversible action, "I
 * could not check" must show as "I could not check", never as a stale list the
 * user would reasonably read as current. It is also checked FIRST so that
 * retrying from `unavailable` (error still set, `isFetching` true) keeps Delete
 * unavailable until the retry actually settles.
 */
export function resolveDeleteComputerPhase(
  preview: DeleteComputerPreviewState,
): DeleteComputerPhase {
  if (preview.isError) return { kind: "unavailable" };
  if (preview.isPending || preview.isFetching || !preview.data) {
    return { kind: "loading" };
  }
  return { kind: "confirm", agents: preview.data.agents };
}

/**
 * Pure mapping from a failed DELETE to what the dialog adds to the screen it is
 * already on. Deliberately two outcomes, not a screen per error code:
 *
 *  - `pending` — an agent is mid-materialization. Its own transient screen
 *    because this is the ONLY path on which the user can learn that state; the
 *    preview does not predict it (a query lists objects, it does not forecast the
 *    command — shiki 2026-07-25).
 *  - `generic` — everything else, including `has_dependents`. That describes a
 *    fact the preview already showed, so reaching it means drift or a caller that
 *    skipped the preview; a named screen for each would rebuild
 *    discovery-through-error.
 */
export type DeleteComputerFailure = "pending" | "generic";

export function resolveDeleteFailure(err: unknown): DeleteComputerFailure {
  return err instanceof ComputerHasPendingAgentsError ? "pending" : "generic";
}
