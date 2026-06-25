import { Check } from 'lucide-react';
import type { ChannelAttentionMode } from '@silverhand/shared';
import { AppContextMenuItem } from '@/components/menus/AppContextMenu';
import {
  useChannelAttentionPreference,
  useSetChannelAttentionPreference,
} from '@/features/attention/hooks';

/**
 * The sidebar context-menu surface of the per-channel `所有消息 / 仅提及`
 * attention preference (#task:1227 §13.3). It writes the per-viewer
 * `ChannelAttentionPreference` — personal view-state, gated only by
 * `canViewConversation` (every member who can see the channel has their own),
 * never an owner/admin role. It deliberately lives ONLY in the context menu,
 * not in the channel settings modal: settings holds channel-level SHARED config
 * (rename / archive — changes everyone sees), whereas this is a per-viewer
 * preference that only reshapes your own Activity projection. Putting a personal
 * preference inside a shared-config panel would mis-signal that it affects all
 * members (shiki + Cindy + Alice, msgs in thread:iCBmcCRydgONVpLd).
 *
 * Writes never touch Follow / thread delivery (delivery ⊥ attention, §5.2) and
 * emit no `unread_updated`; the mutation hook invalidates `['activity']` only.
 *
 * Render ONLY for `kind === 'channel'` — the backend `getChannel` 404s DM
 * channels and threads, which have no ambient preference.
 *
 * The internal vocabulary (eligibility / ambient / attention) never surfaces;
 * the user only ever sees All messages / Mentions only (§3 / §13.5). Mentions
 * only does NOT mute @you / tasks — those are directed and always enter
 * Activity regardless of this switch (§6).
 */
export const ATTENTION_OPTIONS: {
  mode: ChannelAttentionMode;
  label: string;
}[] = [
  { mode: 'all', label: 'All messages' },
  { mode: 'mentions', label: 'Mentions only' },
];

/**
 * Context-menu items for the attention modes — the caller wraps them in an
 * `AppContextMenuSub`. Because Radix `SubContent` mounts its children only
 * while the submenu is open, this component (and its GET) is lazy: it does not
 * fire a request for every channel row, only when the submenu is opened.
 */
export function ChannelAttentionMenuItems({
  channelId,
}: {
  channelId: string;
}): JSX.Element {
  const { data } = useChannelAttentionPreference(channelId);
  const setPref = useSetChannelAttentionPreference(channelId);
  // Do NOT fabricate a "current" before the GET resolves — a fallback treated
  // as authoritative swallows a write (current===mode → no-op PUT) while the
  // server holds the other value. Pre-load, nothing is checked and every
  // option fires a PUT (Cindy review, carried over from the popover impl).
  const resolvedMode = data?.mode;

  return (
    <>
      {ATTENTION_OPTIONS.map(o => (
        <AppContextMenuItem
          key={o.mode}
          icon={
            o.mode === resolvedMode ? <Check className="size-3.5" /> : null
          }
          onSelect={() => {
            if (o.mode !== resolvedMode) setPref.mutate(o.mode);
          }}
        >
          {o.label}
        </AppContextMenuItem>
      ))}
    </>
  );
}
