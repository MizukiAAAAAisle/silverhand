import { User as UserIcon } from 'lucide-react';
import type { UserDto } from '@silverhand/shared';
import {
  HeroDot,
  PersonHero,
} from '@/features/common/PersonHero';
import {
  isBackendUnreachable,
  isRegistrationRequired,
  useViewerAvatarObjectUrl,
  useViewerUser,
} from './hooks';
import { useUserAvatarObjectUrl } from '@/features/users/avatar-hooks';

interface HumanHeaderProps {
  user: UserDto;
}

/**
 * Human panel header. Thin wrapper over {@link PersonHero} that renders
 * the supplied human's avatar + identity. v1 humans have no bio and no
 * agent-style actions (no Stop, no Delete), so the Hero is purely an
 * identity strip — the editable counterparts (avatar picker,
 * display-name input) live in the Profile section below.
 *
 * Symmetry-by-purpose, not symmetry-by-shape: we deliberately do NOT
 * mirror Agent's runtime/model/presence on the Human surface (Cindy
 * review #5), because humans don't have those affordances and leaving
 * them as empty placeholders would advertise functionality that doesn't
 * exist.
 *
 * Multi-human note (Alice audit 2026-06-03 #task:857 P0.8): both the
 * avatar object URL and the "you" meta tag are now scoped to the
 * `user` prop. Previously this hook hard-wired the viewer's avatar
 * regardless of `user.id`, so visiting `/members/u/<other>` rendered
 * the viewer's own avatar with a "you" badge against a stranger.
 */
export function HumanHeader({ user }: HumanHeaderProps): JSX.Element {
  const { data: viewerState } = useViewerUser();
  const viewer =
    viewerState
    && !isRegistrationRequired(viewerState)
    && !isBackendUnreachable(viewerState)
      ? viewerState
      : null;
  const isSelf = viewer?.id === user.id;

  // The viewer's own avatar route is auth-resolved (uses /api/me cache),
  // so it works even before the public /api/users directory hydrates.
  // For non-self rows we fall through to the directory-backed
  // resolver — null until /api/users responds, then the right blob.
  const viewerAvatar = useViewerAvatarObjectUrl();
  const otherAvatar = useUserAvatarObjectUrl({ userId: isSelf ? null : user.id });
  const avatarObjectUrl = isSelf ? viewerAvatar : otherAvatar;

  return (
    <PersonHero
      avatar={
        <span className="grid size-12 place-items-center overflow-hidden rounded-none border border-border-subtle bg-bg-row-hover">
          {avatarObjectUrl ? (
            // eslint-disable-next-line jsx-a11y/img-redundant-alt
            <img
              src={avatarObjectUrl}
              alt={user.display_name || user.name}
              className="size-full object-cover"
            />
          ) : (
            <UserIcon className="size-6 text-text-muted" />
          )}
        </span>
      }
      displayName={user.display_name || user.name}
      handle={user.name}
      meta={
        isSelf ? (
          <>
            <HeroDot />
            <span>you</span>
          </>
        ) : undefined
      }
    />
  );
}
