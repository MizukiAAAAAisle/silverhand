import { ProfileSkeleton } from "./profile-skeleton";
import { useNav } from "@/router";
import { useDirectPairs } from "@/features/direct-pairs/hooks";
import { SidePanelHeader } from "@/components/layout/side-panel-header";
import { useEffect } from "react";
import { useUsers } from "@/features/users/hooks";
import {
  useViewerUser,
  isRegistrationRequired,
  isBackendUnreachable,
  isUpdateRequired,
} from "../session/hooks";
import { HumanHeader } from "./human-header";
import { HumanProfileCard } from "./human-profile-card";
import { paneChrome } from "@/components/layout/pane-chrome";
import { t } from "@/lib/i18n";

interface HumanViewProps {
  /** Identifier from the URL (`/members/u/:userId`). */
  userId: string;
  variant?: "full" | "side";
  onClose?: () => void;
  /** Called when the routed user is unreachable so the parent can
   *  navigate the right pane back to the agent fallback. */
  onUnreachable?: () => void;
}

/**
 * Right-pane container for `/members/u/:userId`. Mirrors AgentView's
 * job (resolve target → render the profile card) but trims the
 * sub-sidebar — humans only have a Profile section in v1, no
 * runtime/workspace/schedules to navigate between, so a single section
 * doesn't earn its own rail.
 *
 * Human profile route. The viewer row comes from `useViewerUser`; other
 * registered humans are resolved from the shared `GET /api/users` list.
 */
export function HumanView({
  userId,
  onUnreachable,
  variant = "full",
  onClose,
}: HumanViewProps): JSX.Element {
  const nav = useNav();
  const pairs = useDirectPairs();
  const viewer = useViewerUser();
  const users = useUsers();

  const viewerDto =
    viewer.data &&
    !isRegistrationRequired(viewer.data) &&
    !isBackendUnreachable(viewer.data) &&
    !isUpdateRequired(viewer.data)
      ? viewer.data
      : null;
  const dto =
    viewerDto?.id === userId ? viewerDto : (users.data?.find((user) => user.id === userId) ?? null);
  const isLoading = viewer.isLoading || users.isLoading;
  const reachable = dto != null;

  useEffect(() => {
    if (isLoading) {
      return;
    }
    if (!reachable) {
      onUnreachable?.();
    }
  }, [reachable, isLoading, onUnreachable]);

  if (isLoading || !dto) {
    return (
      <main
        data-panel={variant === "side" ? "side" : "detail"}
        className="flex h-full min-w-0 flex-1 flex-col overflow-hidden"
        style={paneChrome}
      >
        {variant === "side" ? (
          <SidePanelHeader
            onClose={onClose}
            nativeBar={{
              title: t("profile.profile"),
              subtitle: undefined,
              titleAction: null,
              actions: [],
              tabs: null,
              addTabs: null,
            }}
          >
            <span className="text-sm text-text-muted">{t("profile.profile")}</span>
          </SidePanelHeader>
        ) : null}
        {isLoading ? (
          <ProfileSkeleton />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-text-muted">
            {t("profile.profileUnavailable")}
          </div>
        )}
      </main>
    );
  }

  return (
    <main
      data-panel={variant === "side" ? "side" : "detail"}
      data-profile-host={variant === "side" ? "side" : "human"}
      className="flex h-full flex-1 flex-col overflow-hidden"
      style={paneChrome}
    >
      <HumanHeader
        user={dto}
        compact={variant === "side"}
        onClose={onClose}
        onMessage={
          viewerDto && viewerDto.id !== dto.id
            ? () => {
                const pair = pairs.find(
                  (pair) => pair.counterpart.kind === "human" && pair.counterpart.id === dto.id,
                );
                if (pair) nav.toDirect(pair.conversation_id);
                else nav.toDirectDraft({ kind: "human", id: dto.id });
              }
            : undefined
        }
      />
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="human-profile-content">
          <HumanProfileCard user={dto} />
        </div>
      </div>
    </main>
  );
}
