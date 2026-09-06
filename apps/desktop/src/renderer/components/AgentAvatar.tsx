import type { RuntimeKind } from '@silverhand/shared';
import {
  ClaudeIcon,
  CodexIcon,
  CursorIcon,
  GeminiIcon,
  OPENCODE_LOGO_DATA_URI,
  PI_LOGO_DATA_URI,
  QODER_LOGO_DATA_URI,
} from '@/icons/agents';
import { cn } from '@/lib/cn';
import { AVATAR_PX_DEFAULT } from './avatar-scale';

interface AgentAvatarProps {
  runtime: RuntimeKind;
  /** Pixel size of the square. Sizes come from the `AVATAR_PX` scale
   *  (#task:1440); defaults to `md` (28). */
  size?: number;
  className?: string;
  title?: string;
  /**
   * When provided and non-null, render the bytes as the avatar image
   * (rounded to the same silhouette as the runtime fallback). When
   * null/undefined, render the runtime icon. The URL is expected to
   * be an `URL.createObjectURL(...)` result owned by the caller —
   * this component never fetches or revokes it.
   *
   * Wiring rationale: avoiding internal fetches here is a firm PR-2
   * constraint. The same agent rendered in 100 message rows would
   * otherwise trigger 100 fetches and 100 object URL allocations;
   * the parent uses `useAgentAvatarObjectUrl` (single) or
   * `useAgentAvatarObjectUrls` (batch) and threads the resolved URL
   * down as a prop.
   */
  avatarObjectUrl?: string | null;
  /** Alt text rendered when an avatar image is shown. Falls back to
   *  the agent display_name or runtime name. */
  alt?: string;
}

// Monochrome vector marks, tinted via `currentColor` on a soft badge.
// Runtimes with a full-bleed raster brand logo (see `BRAND_LOGOS`) are
// NOT here — they render edge-to-edge and skip the tinted badge.
const ICONS: Partial<
  Record<RuntimeKind, (p: { style?: React.CSSProperties }) => JSX.Element>
> = {
  claude: ClaudeIcon,
  codex: CodexIcon,
  cursor: CursorIcon,
  gemini: GeminiIcon,
};

// Full-color brand logos that carry their own background + corner
// radius — rendered edge-to-edge (like an uploaded avatar), no badge tint.
const BRAND_LOGOS: Partial<Record<RuntimeKind, string>> = {
  opencode: OPENCODE_LOGO_DATA_URI,
  qoder: QODER_LOGO_DATA_URI,
  pi: PI_LOGO_DATA_URI,
};

// Tints picked to match each brand's primary color when one exists.
// `bg` is the badge fill, `fg` is the icon `currentColor`. Claude's
// path carries its own `#d97757` fill so `fg` is a no-op there.
// Only runtimes rendered as tinted vector marks need an entry.
const TINTS: Partial<Record<RuntimeKind, { bg: string; fg: string }>> = {
  claude: { bg: 'bg-[#fdf3ec]', fg: 'text-[#d97757]' },
  codex: { bg: 'bg-[#1f1f1f]', fg: 'text-white' },
  cursor: { bg: 'bg-[#0f0f0f]', fg: 'text-white' },
  gemini: { bg: 'bg-[#e8f0fe]', fg: 'text-[#1a73e8]' },
};

export function AgentAvatar({
  runtime,
  size = AVATAR_PX_DEFAULT,
  className,
  title,
  avatarObjectUrl,
  alt,
}: AgentAvatarProps): JSX.Element {
  // When an uploaded avatar URL is available, render the image and
  // skip the runtime tint — the bytes already encode the agent's
  // identity so the brand-color frame would be visual noise.
  if (avatarObjectUrl) {
    return (
      <span
        data-avatar-ground
        className={cn(
          'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-none align-middle',
          className,
        )}
        style={{ width: size, height: size }}
        title={title}
      >
        <img
          src={avatarObjectUrl}
          alt={alt ?? title ?? `${runtime} avatar`}
          className="h-full w-full object-cover"
          draggable={false}
        />
      </span>
    );
  }

  // Full-bleed brand logo (own background + corners) — render edge-to-edge
  // like an uploaded avatar, no tinted badge.
  const brandLogo = BRAND_LOGOS[runtime];
  if (brandLogo) {
    return (
      <span
        className={cn(
          'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-none align-middle',
          className,
        )}
        style={{ width: size, height: size }}
        title={title}
        aria-hidden
      >
        <img
          src={brandLogo}
          alt=""
          className="h-full w-full object-cover"
          draggable={false}
        />
      </span>
    );
  }

  const Icon = ICONS[runtime];
  const tint = TINTS[runtime];
  const inner = Math.round(size * 0.6);
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-none align-middle',
        tint?.bg,
        tint?.fg,
        className,
      )}
      style={{ width: size, height: size }}
      title={title}
      aria-hidden
    >
      {Icon ? <Icon style={{ width: inner, height: inner }} /> : null}
    </span>
  );
}
