import { Bell, BellOff, Check } from "lucide-react";
import type { ChannelAttentionMode } from "@silverhand/shared";
import { AppContextMenuItem, AppContextMenuSeparator } from "@/components/menus/AppContextMenu";
import {
  useSetChannelAttentionPreference,
  useSetWorkspaceAttentionPreference,
  useWorkspaceAttentionPreference,
} from "@/features/attention/hooks";
import { resolveWorkspaceMuteToggle } from "@/lib/attention-mode";

/**
 * The context-menu surfaces of the two Attention write aggregates (#task:1227
 * §13.3, extended to three tiers + the workspace suppressor in #task:1870).
 * Both write per-viewer view-state, gated only by "can you see it" — never an
 * owner/admin role — and neither ever touches Follow / thread delivery
 * (delivery ⊥ attention, §5.2).
 *
 * They live ONLY in context menus, not in the channel/workspace settings modal:
 * settings holds SHARED config (rename / archive — changes everyone sees),
 * whereas these are personal preferences that reshape only your own projection.
 * Putting a personal preference inside a shared-config panel would mis-signal
 * that it affects all members (shiki + Cindy + Alice, thread:iCBmcCRydgONVpLd).
 *
 * The internal vocabulary (eligibility / ambient / tier / suppressor) never
 * surfaces; the user sees only the three labels below (§3 / §13.5).
 */
export const ATTENTION_OPTIONS: {
  mode: ChannelAttentionMode;
  label: string;
}[] = [
  { mode: "all", label: "All messages" },
  { mode: "mentions", label: "Mentions only" },
  { mode: "mute", label: "Mute" },
];

/**
 * Context-menu items for a channel's three attention tiers.
 *
 * `mode` comes from the caller's workspace tier batch rather than a per-channel
 * GET of this channel's preference. That batch is already loaded for the
 * sidebar's badges, so this is one carrier instead of two — and it also retires
 * the old pre-load wart, where the menu showed nothing checked until its own GET
 * resolved and every option then fired a redundant PUT.
 *
 * When the workspace suppressor is on, the options stay ENABLED and the channel's
 * own choice stays checked: muting the workspace silences without rewriting, so
 * what the user picked here is still their choice and still applies the moment
 * they un-mute. The caption says what they currently hear instead.
 */
export function ChannelAttentionMenuItems({
  channelId,
  mode,
  workspaceMuted,
}: {
  channelId: string;
  /** The channel's OWN stored/defaulted tier. `undefined` before the workspace
   *  tier batch has loaded — nothing is checked then, deliberately: a fabricated
   *  "current" swallows a write (current === mode → no-op PUT) while the server
   *  holds the other value. */
  mode: ChannelAttentionMode | undefined;
  /** The workspace suppressor; `undefined` while the batch is unresolved, which
   *  reads the same as "off" here — the caption is an explanation, so it must not
   *  appear until the suppressor is actually known to be on. */
  workspaceMuted: boolean | undefined;
}): JSX.Element {
  const setPref = useSetChannelAttentionPreference(channelId);

  return (
    <>
      {ATTENTION_OPTIONS.map((o) => (
        <AppContextMenuItem
          key={o.mode}
          icon={o.mode === mode ? <Check className="size-3.5" /> : null}
          onSelect={() => {
            if (o.mode !== mode) setPref.mutate(o.mode);
          }}
        >
          {o.label}
        </AppContextMenuItem>
      ))}
      {workspaceMuted ? (
        <>
          <AppContextMenuSeparator />
          {/* States what the viewer currently hears, since it differs from the
              checked row above. Not an action and not a second control — the
              suppressor is flipped on the workspace, which is where it applies. */}
          <AppContextMenuItem icon={null} disabled>
            Muted by workspace
          </AppContextMenuItem>
        </>
      ) : null}
    </>
  );
}

/**
 * The workspace mute suppressor as ONE toggle item — a boolean gets a toggle, not
 * a submenu of two options. Since #task:1900 it is the container menu's only item.
 *
 * PEOPLE-OWNED workspaces only: an agent space can never carry a suppressor row
 * — a DB trigger refuses it for an agent-owned workspace — because those
 * conversations are directed-grade and have no ambient traffic to silence. Callers
 * gate on OWNERSHIP (`canMuteWorkspace` → `isAgentSpace`, #task:2078); this
 * component fires its GET lazily with the menu, so a right-click on an agent
 * space's row costs nothing.
 *
 * A toggle cannot be built from an unknown current value — unlike the channel
 * tiers above, whose three options are absolute assignments that write correctly
 * regardless. So until the GET resolves the item is DISABLED rather than
 * defaulted: see `resolveWorkspaceMuteToggle` for why a `false` default silently
 * turns the user's Unmute into a second `true`.
 */
export function WorkspaceMuteMenuItem({ workspaceId }: { workspaceId: string }): JSX.Element {
  const { data } = useWorkspaceAttentionPreference(workspaceId);
  const setPref = useSetWorkspaceAttentionPreference(workspaceId);
  const { label, next } = resolveWorkspaceMuteToggle(data?.muted);

  return (
    <AppContextMenuItem
      icon={next === false ? <Bell className="size-3.5" /> : <BellOff className="size-3.5" />}
      disabled={next === null}
      onSelect={() => {
        // Belt and braces with `disabled`: the guarantee is "never write a
        // fabricated reverse value", and that belongs on the write path, not on a
        // presentational prop.
        if (next === null) return;
        setPref.mutate(next);
      }}
    >
      {label}
    </AppContextMenuItem>
  );
}
