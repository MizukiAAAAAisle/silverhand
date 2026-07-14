import { Hash, Lock } from 'lucide-react';
import type { ConversationVisibility } from '@silverhand/shared';
import { cn } from '@/lib/cn';

/**
 * Named density tiers for the channel `#` identity glyph. Each tier is a
 * SEMANTIC surface density — pick by the surface, not by eye:
 *  - `sm` (12px): dense result / message-header rows — SearchPanel AND
 *    SavedListView message headers. In the sticker variant a theme's chip
 *    chrome (forza6's `content-box` border + padding) lands the physical box at
 *    16px, aligning with the row's `WorkspaceIcon` / sender avatar.
 *  - `md` (14px): the default — sidebar rows, filter controls, activity rows,
 *    dropdown option rows.
 *  - `lg` (24px): spacious list panels (ArchivedChannelsPanel).
 *
 * `sm` / `lg` are intentional per shiki (#task:1438) — do NOT collapse them
 * into `md`; the goal is "every size has a reason", not "one size". The
 * chat-header HERO `#` is a different glyph (`data-conversation-hash-icon`,
 * ChannelView) and is out of this scale.
 */
export const CHANNEL_ICON_PX = { sm: 12, md: 14, lg: 24 } as const;
export type ChannelIconDensity = keyof typeof CHANNEL_ICON_PX;

export interface ChannelIconProps {
  /**
   * REQUIRED discriminant, NO default (#task:1438). The single knob that
   * decides whether the glyph wears the `data-channel-icon` theme sticker
   * hook — call-sites pick a role, never the hook:
   *  - `'sticker'` → identity surfaces (sidebar / row / search / activity).
   *    The hook lets a theme paint its `#` chip (forza6: a bordered/padded
   *    yellow sticker). Use only where the `#` IS the channel's identity
   *    object.
   *  - `'utility'` → compact / subordinate controls (filter trigger, chips).
   *    A plain glyph with NO hook, so a theme's sticker chrome (forza6's
   *    `content-box` border + padding) can never inflate the box past its
   *    siblings. #task:1437 was exactly this hook riding a utility trigger:
   *    14px `#` → 18px.
   *
   * Required and validated at runtime, so a call-site can NEVER silently fall
   * back to one branch — "sticker crept onto a compact surface" and "identity
   * surface lost its hook" are unrepresentable by construction, not by
   * convention (Alice/Cindy #task:1438).
   */
  variant: 'sticker' | 'utility';
  /** Surface density (default `md` = 14px). Drives the box from the shared
   *  {@link CHANNEL_ICON_PX} scale. */
  density?: ChannelIconDensity;
  /**
   * Channel visibility — selects the GLYPH, orthogonal to `variant`. A
   * `'private'` channel is membership-gated, so it wears a `Lock`; `'public'`
   * (or omitted) wears the canonical `#` `Hash`. The sticker/utility hook
   * behaviour is unchanged either way — a private channel is still a channel
   * identity, so it keeps the same theme treatment, only the glyph differs.
   * Omitted defaults to `Hash`, so every existing call-site (and every
   * non-`channel` kind, e.g. a `dm_channel` row) renders exactly as before —
   * the Lock is opt-in, keyed on a real `visibility === 'private'` regular
   * channel by the caller.
   */
  visibility?: ConversationVisibility;
  /** Extra classes (colour / context). Layout (`shrink-0`) and size are owned
   *  by the primitive; consumers only tint. */
  className?: string;
}

/**
 * The canonical channel `#` glyph and the ONE place that decides whether the
 * `data-channel-icon` sticker hook is applied. Every channel-`#` surface routes
 * through this so the sticker/utility split is enforced in the type + at
 * construction, not by a doc that decays into a reminder.
 */
export function ChannelIcon({
  variant,
  density = 'md',
  visibility,
  className,
}: ChannelIconProps): JSX.Element {
  // Fail-loud: `variant` is required with no default. A missing / invalid value
  // must NOT silently render as one branch — that reopens the exact drift this
  // primitive closes (a silent utility fallback would strip the hook off an
  // identity surface). TS makes omission a compile error; this guards the JS
  // boundary (untyped callers, `undefined` at runtime).
  if (variant !== 'sticker' && variant !== 'utility') {
    throw new Error(
      `ChannelIcon: \`variant\` is required and must be 'sticker' | 'utility' (got ${String(variant)}).`,
    );
  }
  const px = CHANNEL_ICON_PX[density];
  // Glyph = identity of the channel's visibility axis: `Lock` for a private
  // channel, the canonical `#` otherwise. Orthogonal to `variant` (which only
  // decides the sticker hook), so both branches below select it the same way.
  const Glyph = visibility === 'private' ? Lock : Hash;
  // Two explicit branches (not a spread) so the `data-channel-icon` hook is
  // literally present only for `sticker` — mirrors the working JSX form and
  // keeps the sticker markup byte-identical to the pre-primitive call-sites.
  if (variant === 'sticker') {
    return (
      <Glyph data-channel-icon size={px} className={cn('shrink-0', className)} />
    );
  }
  return <Glyph size={px} className={cn('shrink-0', className)} />;
}
