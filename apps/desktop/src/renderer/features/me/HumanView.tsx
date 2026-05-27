import { useEffect } from 'react';
import { useViewerUser, isRegistrationRequired, isBackendUnreachable } from './hooks';
import { HumanHeader } from './HumanHeader';
import { HumanProfileCard } from './HumanProfileCard';

interface HumanViewProps {
  /** Identifier from the URL (`/members/u/:userId`). v1 only ever
   *  resolves the viewer's own id; the not-self branch renders a
   *  defensive fallback rather than a broken card. */
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
 * v1 contract: the only routable userId IS the viewer's. The backend
 * does not expose `GET /api/users/:id` (only `GET /api/users/:id/avatar`),
 * so non-self ids cannot be resolved into a `UserDto` here. We render
 * a clear "not viewable" fallback rather than guessing — and call
 * `onUnreachable` so the App can redirect.
 */
export function HumanView({
  userId,
  onUnreachable,
}: HumanViewProps): JSX.Element {
  const viewer = useViewerUser();

  // v2 multi-human will swap in a `useUserById(userId)` query that can
  // resolve any user. For now we treat any non-viewer id as a routing
  // miss — the App-level redirect picks the viewer's id (or the
  // agents-first fallback) on the next paint.
  const dto =
    viewer.data
    && !isRegistrationRequired(viewer.data)
    && !isBackendUnreachable(viewer.data)
      ? viewer.data
      : null;
  const reachable = dto != null && dto.id === userId;

  useEffect(() => {
    if (viewer.isLoading) return;
    if (!reachable) onUnreachable?.();
  }, [reachable, viewer.isLoading, onUnreachable]);

  if (viewer.isLoading) {
    return (
      <main
        className="flex h-full flex-1 items-center justify-center bg-bg-base text-sm text-text-muted"
        style={{
          borderRadius: 'var(--card-radius, 0)',
          boxShadow: 'var(--card-shadow, none)',
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
          borderRadius: 'var(--card-radius, 0)',
          boxShadow: 'var(--card-shadow, none)',
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
        borderRadius: 'var(--card-radius, 0)',
        boxShadow: 'var(--card-shadow, none)',
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
