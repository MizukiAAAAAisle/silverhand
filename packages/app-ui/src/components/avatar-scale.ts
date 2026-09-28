/**
 * Identity-avatar square scale (#task:1440).
 *
 * The single source of truth for the pixel size of an identity avatar square —
 * both {@link AgentAvatar} and {@link UserAvatar}. Before this, sizes were
 * hand-tuned literals scattered across ~30 call-sites (9+ distinct values), so
 * an agent and its human peer in the SAME row could drift apart. Every avatar
 * call-site now consumes a named tier from here, so a row's agent/human
 * branches provably share one token and the whole app speaks one scale.
 *
 * Each tier is a *surface density*, not an arbitrary number:
 *
 * - `chip`  14 — avatar inside a compact tag/chip (leaves ~5px of breathing
 *                room so it reads as an identity glyph, not a filled tile;
 *                round 9.1 tuning "头像占的太满了").
 * - `xs`    16 — inline / list / search-result / meta rows.
 * - `sm`    20 — member & candidate management rows (member strips, add-member
 *                and role popovers). Absorbs the former off-scale 18/22/24
 *                (#task:1440 normalize, shiki-confirmed).
 * - `md`    28 — the default: composer mention chips, message rows.
 * - `lg`    32 — the primary message-sender avatar.
 * - `xl`    36 — popover / identity-card headers.
 * - `2xl`   48 — the agent profile header.
 * - `3xl`   56 — the agent profile card (settings hero).
 *
 * Intentionally NOT a function of the icon — it is a function of the surface.
 */
export const AVATAR_PX = {
  chip: 14,
  xs: 16,
  sm: 20,
  md: 28,
  lg: 32,
  xl: 36,
  "2xl": 48,
  "3xl": 56,
  profileCompact: 72,
  profile: 80,
} as const;

export type AvatarSize = keyof typeof AVATAR_PX;

/** The default square size for {@link AgentAvatar} / {@link UserAvatar} when a
 *  caller omits `size`. Kept === `AVATAR_PX.md` (28) — a value both components
 *  historically defaulted to; a test locks this so the default never drifts. */
export const AVATAR_PX_DEFAULT = AVATAR_PX.md;
