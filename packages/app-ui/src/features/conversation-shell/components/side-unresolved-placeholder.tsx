import { MessageRowsSkeleton } from "./conversation-view-skeleton";
import { CloseIcon } from "@/icons";
import { paneChrome } from "../../../components/layout/pane-chrome";
import { t } from "@/lib/i18n";

export type SidePlaceholderStatus = "loading" | "unauthorized" | "not_found" | "unresolved";

interface SidePlaceholderProps {
  /** The conversation id that came in via `?side=<id>`. Shown verbatim
   *  (truncated) so the user can correlate the reference with whatever
   *  they clicked. */
  conversationId: string;
  /** PR-2: distinguishes the non-resolved states surfaced by the
   *  identity resolution. The render branches per status to give the
   *  user actionable feedback rather than the original PR-1 single
   *  "unresolved" message. */
  status: SidePlaceholderStatus;
  /** Dispatched close handler — same one the resolved secondary pane
   *  uses, so the X button behaves identically (clears `?side` and any
   *  paired `?fullscreen` from the URL). */
  onClose: () => void;
}

const statusCopy = (): Record<
  SidePlaceholderStatus,
  { header: string; body: string; hint?: string }
> => ({
  loading: {
    header: t("conversationShell.resolvingReference"),
    body: t("conversationShell.loadingThisConversation"),
  },
  unauthorized: {
    header: t("conversationShell.noAccess"),
    // No LEVEL is named: a 403 from `/ref` is not evidence of a missing
    // workspace. With a public-aware gate (#task:1692) most of what still
    // refuses is same-workspace — a private channel, an archived public one, a
    // DM the viewer isn't in — so "you don't have access to the workspace"
    // would be a false statement about the one thing the viewer can verify.
    body: t("conversationShell.youDontHaveAccess"),
    hint: t("conversationShell.itMayBePrivate"),
  },
  not_found: {
    header: t("conversationShell.conversationNotFound"),
    body: t("conversationShell.thisReferencePointsTo"),
    hint: t("conversationShell.closeTheReferenceOr"),
  },
  // Distinct from `not_found` on purpose (#task:2038): a private line can only be
  // named by the viewer's direct-pair list, so when THAT read fails nothing has
  // been proven about the reference. Claiming deletion here would be a false
  // statement, and a loader would never end — nothing is in flight.
  unresolved: {
    header: t("conversationShell.referenceUnavailable"),
    body: t("conversationShell.couldntResolveThisConversation"),
  },
});

/**
 * Placeholder pane shown for non-resolved `?side=<id>` states. Cindy
 * review point 6 of PR-1: never silently strip the URL — the user
 * should see that the reference can't be loaded right now and have an
 * explicit Close affordance.
 *
 * PR-2: unified placeholder for the non-resolved statuses surfaced by
 * the `?side` identity resolution (loading / unauthorized / not_found /
 * unresolved). The component is intentionally state-only — it doesn't
 * read the route or the descriptor; the parent passes the status
 * derived from the secondary descriptor.
 */
export function SideUnresolvedPlaceholder({
  conversationId,
  status,
  onClose,
}: SidePlaceholderProps): JSX.Element {
  // Truncate long ids so the placeholder doesn't overflow narrow panes.
  const shortId =
    conversationId.length > 20
      ? `${conversationId.slice(0, 8)}…${conversationId.slice(-4)}`
      : conversationId;
  const copy = statusCopy()[status];
  return (
    <main data-panel="side" className="flex h-full min-w-0 flex-1 flex-col" style={paneChrome}>
      <header
        data-conversation-header
        className="flex h-(--titlebar-height,44px) shrink-0 items-center justify-between border-b border-border px-3"
      >
        <div className="min-w-0 flex-1 truncate text-sm font-medium text-text-muted">
          {copy.header}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("conversationShell.closeSidePane")}
          title={t("conversationShell.closeSidePane")}
          className="ml-2 flex size-7 shrink-0 items-center justify-center rounded text-text-secondary hover:bg-bg-hover hover:text-text-primary"
        >
          <CloseIcon className="size-4" />
        </button>
      </header>
      {status === "loading" ? (
        <MessageRowsSkeleton />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-text-muted">
          <p>{copy.body}</p>
          <p className="font-mono text-xs text-text-faint">#conv:{shortId}</p>
          {copy.hint ? <p className="text-xs text-text-faint">{copy.hint}</p> : null}
        </div>
      )}
    </main>
  );
}
