import type { ConversationAgentStatus } from '@silverhand/shared';

/**
 * ONE DOT GROUND for run state, keyed by the runtime status word.
 *
 * Three surfaces express the SAME state on the SAME dot — the header member
 * chips, the members modal (which dropped its status column precisely because
 * this dot already says it: shiki, #task:1687) and the identity popover's
 * presence pip (#task:2123). Humans map their presence onto two of these keys
 * via `presenceDotStatus`, so a human's dot and an agent's dot are one recipe
 * rather than two that happen to look alike.
 *
 * It lives in its own leaf module because the popover is a placement-agnostic
 * component: importing a class table out of `channel-view/` would make a generic
 * identity card depend on one particular placement's folder.
 *
 * `MUTED_DOT` is deliberately NOT one of these keys. Statements that do not come
 * from the runtime authority at all (`Not here` — membership; `Away` / `Offline`
 * — global availability) use it, so a future change to the Idle ground cannot
 * silently restyle them.
 *
 * ITS VALUE IS THE SAME AS `idle` TODAY, ON PURPOSE (@Norman, #task:2123 review).
 * The key separation is what prevents the coupling; a different shade would have
 * to carry information, and this one did not — one card draws one presence line,
 * so `Not here` and `Idle` never appear together to be compared, and the same
 * class of non-runtime statement already renders on the `idle` ground elsewhere
 * (a human's Away / Offline reaches it through `presenceDotStatus` in the member
 * strip and the members modal). Splitting the values again needs a reason a user
 * can see, not a distinction only the code knows about.
 */
export const STATUS_DOT: Record<ConversationAgentStatus, string> = {
  active: 'bg-success',
  starting: 'bg-warning',
  crashed: 'bg-error',
  idle: 'bg-text-muted/50',
};

export const MUTED_DOT = 'bg-text-muted/50';
