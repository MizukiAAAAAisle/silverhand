import { User as UserIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { AVATAR_PX_DEFAULT } from './avatar-scale';

interface UserAvatarProps {
  /** Pixel size of the square. Sizes come from the `AVATAR_PX` scale
   *  (#task:1440); defaults to `md` (28), matching `AgentAvatar`. */
  size?: number;
  className?: string;
  title?: string;
  /**
   * When provided and non-null, render the bytes as the avatar image.
   * When null/undefined, render the generic `UserIcon` placeholder.
   * The URL is expected to be an `URL.createObjectURL(...)` result
   * owned by the caller — this component never fetches or revokes it.
   *
   * Wiring rationale: same firm constraint as `AgentAvatar` — leaves
   * never fetch internally. Callers thread the resolved URL down via
   * a parent batch hook (e.g. `useAgentAvatarObjectUrls(humanMembers)`,
   * which is structurally generic over `{id, avatar_url}` and works
   * for users too).
   */
  avatarObjectUrl?: string | null;
  /** Alt text rendered when an avatar image is shown. */
  alt?: string;
}

/**
 * Compact human avatar — the human counterpart to `AgentAvatar`.
 *
 * No runtime tint and no brand frame: humans don't have a runtime, and
 * the placeholder is deliberately neutral so the strip reads "person"
 * even without an uploaded image. When the user has uploaded an
 * avatar (resolved object URL passed in), we render those bytes
 * full-bleed inside the same square silhouette as agent avatars.
 */
export function UserAvatar({
  size = AVATAR_PX_DEFAULT,
  className,
  title,
  avatarObjectUrl,
  alt,
}: UserAvatarProps): JSX.Element {
  if (avatarObjectUrl) {
    return (
      <span
        className={cn(
          'inline-flex shrink-0 items-center justify-center overflow-hidden bg-bg-muted rounded-none align-middle',
          className,
        )}
        style={{ width: size, height: size }}
        title={title}
      >
        <img
          src={avatarObjectUrl}
          alt={alt ?? title ?? 'avatar'}
          className="h-full w-full object-cover"
          draggable={false}
        />
      </span>
    );
  }

  const inner = Math.round(size * 0.55);
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-none bg-bg-elevated text-text-muted align-middle',
        className,
      )}
      style={{ width: size, height: size }}
      title={title}
      aria-hidden
    >
      <UserIcon style={{ width: inner, height: inner }} />
    </span>
  );
}
