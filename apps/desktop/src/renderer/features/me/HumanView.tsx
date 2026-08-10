import { useEffect } from 'react';
import { useUsers } from '@/features/users/hooks';
import { useViewerUser, isRegistrationRequired, isBackendUnreachable, isUpdateRequired } from './hooks';
import { HumanHeader } from './HumanHeader';
import { HumanProfileCard } from './HumanProfileCard';

interface HumanViewProps {
  /** Identifier from the URL (`/members/u/:userId`). */
  userId: string;
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
}: HumanViewProps): JSX.Element {
  const viewer = useViewerUser();
  const users = useUsers();

  const viewerDto =
    viewer.data
    && !isRegistrationRequired(viewer.data)
    && !isBackendUnreachable(viewer.data) && !isUpdateRequired(viewer.data)
      ? viewer.data
      : null;
  const dto = viewerDto?.id === userId
    ? viewerDto
    : users.data?.find(user => user.id === userId) ?? null;
  const isLoading = viewer.isLoading || users.isLoading;
  const reachable = dto != null;

  useEffect(() => {
    if (isLoading) return;
    if (!reachable) onUnreachable?.();
  }, [reachable, isLoading, onUnreachable]);

  if (isLoading) {
    return (
      <main
        className="flex h-full flex-1 items-center justify-center bg-bg-base text-sm text-text-muted"
        style={{
          borderRadius: 'var(--pane-radius, var(--card-radius, 0))',
          boxShadow: 'var(--pane-shadow, var(--card-shadow, none))',
          overflow: 'hidden',
        }}
      >
        Loading profile…
      </main>
    );
  }

  if (!reachable) {
    return (
      <main
        className="flex h-full flex-1 items-center justify-center bg-bg-base text-sm text-text-muted"
        style={{
          borderRadius: 'var(--pane-radius, var(--card-radius, 0))',
          boxShadow: 'var(--pane-shadow, var(--card-shadow, none))',
          overflow: 'hidden',
        }}
      >
        This human is not viewable in this version.
      </main>
    );
  }

  return (
    <main
      className="flex h-full flex-1 flex-col overflow-hidden bg-bg-base"
      style={{
        borderRadius: 'var(--pane-radius, var(--card-radius, 0))',
        boxShadow: 'var(--pane-shadow, var(--card-shadow, none))',
      }}
    >
      <HumanHeader user={dto} />
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="px-8 py-6">
          <HumanProfileCard user={dto} />
        </div>
      </div>
    </main>
  );
}
