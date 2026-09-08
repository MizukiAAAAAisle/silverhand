import { SidePanelHeader } from "@/components/layout/SidePanelHeader";
import { useEffect } from "react";
import { useUsers } from "@/features/users/hooks";
import {
  useViewerUser,
  isRegistrationRequired,
  isBackendUnreachable,
  isUpdateRequired,
} from "./hooks";
import { HumanHeader } from "./HumanHeader";
import { HumanProfileCard } from "./HumanProfileCard";
import { paneChrome } from "@/components/layout/pane-chrome";

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
        className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-bg-base"
        style={paneChrome}
      >
        {variant === "side" ? (
          <SidePanelHeader onClose={onClose}>
            <span className="text-sm text-text-muted">Profile</span>
          </SidePanelHeader>
        ) : null}
        <div className="flex flex-1 items-center justify-center text-sm text-text-muted">
          {isLoading ? "Loading profile…" : "Profile unavailable."}
        </div>
      </main>
    );
  }

  return (
    <main
      data-profile-host={variant === "side" ? "side" : "human"}
      className="flex h-full flex-1 flex-col overflow-hidden bg-bg-base"
      style={paneChrome}
    >
      <HumanHeader user={dto} compact={variant === "side"} onClose={onClose} />
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="human-profile-content">
          <HumanProfileCard user={dto} />
        </div>
      </div>
    </main>
  );
}
