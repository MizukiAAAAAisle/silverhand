import {
  BellIcon,
  BellOffIcon,
  BellPlusIcon,
  BellRingIcon,
  CheckIcon,
  type IconComponent,
} from "@/icons";
import type { ChannelAttentionMode } from "@silverhand/shared";
import { AppContextMenuItem, AppContextMenuSeparator } from "@/components/menus/app-context-menu";
import {
  useSetChannelAttentionPreference,
  useSetWorkspaceAttentionPreference,
  useWorkspaceAttentionPreference,
} from "@/features/attention/hooks";
import { resolveWorkspaceMuteToggle } from "@/features/attention/attention-mode";
import { t } from "@/lib/i18n";

/**
 * The context-menu surfaces of the two Attention write aggregates (#task:1227
 * §13.3, extended to three tiers + the workspace suppressor in #task:1870).
 * Both write per-viewer view-state, gated only by "can you see it" — never an
 * owner/admin role — and neither ever touches Follow / thread delivery
 * (delivery ⊥ attention, §5.2).
 *
 * Shared options for context menus and the channel settings personal control.
 * These preferences change only the current viewer's projection; the settings
 * control uses the same viewer-only authority alongside shared channel configuration.
 *
 * The internal vocabulary (eligibility / ambient / tier / suppressor) never
 * surfaces; the user sees only the three labels below (§3 / §13.5).
 */
export const attentionOptions = (): {
  mode: ChannelAttentionMode;
  label: string;
  Icon: IconComponent;
}[] => [
  { mode: "all", label: t("conversationShell.allMessages"), Icon: BellRingIcon },
  { mode: "mentions", label: t("conversationShell.mentionsOnly"), Icon: BellPlusIcon },
  { mode: "mute", label: t("conversationShell.mute"), Icon: BellOffIcon },
];

/** The glyph for a channel's current tier; the plain bell before it is known. */
export function attentionIcon(mode: ChannelAttentionMode | undefined): IconComponent {
  return attentionOptions().find((option) => option.mode === mode)?.Icon ?? BellIcon;
}

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
      {attentionOptions().map((o) => (
        <AppContextMenuItem
          key={o.mode}
          icon={<o.Icon className="size-3.5" />}
          trailing={o.mode === mode ? <CheckIcon className="size-3.5" /> : undefined}
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
            {t("conversationShell.mutedByProject")}
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
      icon={
        next === false ? (
          <BellRingIcon className="size-3.5" />
        ) : (
          <BellOffIcon className="size-3.5" />
        )
      }
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
