import { User as UserIcon } from 'lucide-react';
import type { UserDto } from '@silverhand/shared';
import {
  HeroDot,
  PersonHero,
} from '@/features/common/PersonHero';
import { useViewerAvatarObjectUrl } from './hooks';

interface HumanHeaderProps {
  user: UserDto;
}

/**
 * Human panel header. Thin wrapper over {@link PersonHero} that wires
 * the viewer's avatar object URL and renders the `you` indicator next
 * to the handle. v1 humans have no bio and no agent-style actions
 * (no Stop, no Delete), so the Hero is purely an identity strip — the
 * editable counterparts (avatar picker, display-name input) live in
 * the Profile section below.
 *
 * Symmetry-by-purpose, not symmetry-by-shape: we deliberately do NOT
 * mirror Agent's runtime/model/presence on the Human surface (Cindy
 * review #5), because humans don't have those affordances and leaving
 * them as empty placeholders would advertise functionality that doesn't
 * exist.
 */
export function HumanHeader({ user }: HumanHeaderProps): JSX.Element {
  // v1: only the viewer is ever rendered, so the viewer's avatar URL
  // is always the right one. v2 multi-human will replace this with a
  // `useUserAvatarObjectUrl(userId)` hook keyed off the prop.
  const avatarObjectUrl = useViewerAvatarObjectUrl();

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
        <>
          <HeroDot />
          <span>you</span>
        </>
      }
    />
  );
}
