import type { DirectPairCounterpart } from "@silverhand/shared";
import {
  senderFilterForEndpoint,
  type SenderFilterValue,
} from "@/components/ui/sender-filter-select";

/**
 * What an in-conversation find carries when it hands off to advanced search
 * (#task:1335, extended #task:2114).
 *
 * The seed names AXES the advanced panel actually has (workspace / sender), not
 * the source conversation — the panel has no conversation axis, and inventing
 * one here would promise a scope the results cannot honour. So each pane
 * translates its own coordinate into the nearest expressible narrowing:
 *
 *  - a workspace channel → `workspaceId`, the container the results share;
 *  - a `direct_pair` → `sender`, its counterpart. A pair has NO workspace
 *    (`workspace_id IS NULL`), so the container axis cannot express it at all,
 *    and its counterpart is the one thing every message in it is about.
 *
 * A seed with NEITHER axis is legal and still meaningful: the hand-off itself
 * says "these are the filters now" (it travels as `reset=1`, see
 * `routes.chatSearch`), so a pair whose counterpart is deleted still clears the
 * filters it cannot replace instead of inheriting them.
 *
 * TRADE-OFF, stated because it is visible: a sender-seeded search returns the
 * counterpart's messages across every conversation, and drops the viewer's own
 * side of the DM. It is a narrowing, not the DM's scope. Scoping results to one
 * conversation would need a new axis in the panel (and in the search route) —
 * a product decision, not something this hand-off should fake.
 */
export interface AdvancedSearchSeed {
  /** The inline find's current keyword; may be empty (the user can open the
   *  advanced panel before typing). */
  query: string;
  /** Container axis — a workspace channel's workspace. Absent for a pair. */
  workspaceId?: string;
  /** Sender axis — see above. Absent when the pane has no single principal to
   *  name (any workspace channel). */
  sender?: SenderFilterValue;
}

/**
 * The sender seed for a `direct_pair` pane, or `undefined` when the pane cannot
 * name one principal.
 *
 * `deleted` counterparts yield nothing on purpose: the id survives the
 * principal (an endpoint outlives its person, see `DirectPairCounterpartSchema`),
 * but the sender picker's option domain is the LIVE directory, so a seed
 * pointing at a deleted principal would render as a selection with no matching
 * option — a filter the user can see is active but cannot read or clear.
 */
export function directPairSenderSeed(
  counterpart: DirectPairCounterpart | null | undefined,
): SenderFilterValue | undefined {
  if (!counterpart || counterpart.status !== "active") return undefined;
  return senderFilterForEndpoint(counterpart.kind, counterpart.id);
}
