import { UserIcon } from "@/icons";
import { cn } from "@/lib/cn";
import { AVATAR_PX_DEFAULT } from "./avatar-scale";

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
 *
 * Both branches carry `data-avatar-ground` (painted in surfaces.css), so
 * the fallback occupies the same visible square as an uploaded image
 * instead of reading as a floating glyph — an agent fallback is always a
 * filled square (its runtime tint), and a person's must be too.
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
        data-avatar-ground
        className={cn(
          "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-none align-middle",
          className,
        )}
        style={{ width: size, height: size }}
        title={title}
      >
        <img
          src={avatarObjectUrl}
          alt={alt ?? title ?? "avatar"}
          className="h-full w-full object-cover"
          draggable={false}
        />
      </span>
    );
  }

  // Same `size × 0.6` glyph ratio as AgentAvatar's runtime marks, so a
  // human fallback and an agent fallback carry the same visual mass in a
  // mixed list.
  const inner = Math.round(size * 0.6);
  return (
    <span
      data-avatar-ground
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-none text-text-muted align-middle",
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
