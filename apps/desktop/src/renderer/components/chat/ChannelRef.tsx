import { Hash } from 'lucide-react';

export interface ChannelReference {
  id: string;
  title: string;
  closed_at?: number | null;
  archived_at?: number | null;
}

interface ChannelRefProps {
  /** The handle as it appeared in the source text (without `#`). */
  name: string;
  /** Resolved channel from the current message's workspace.
   *  - undefined        → no match in this workspace
   *  - null (sentinel)  → ambiguous (multiple channels share this title)
   *  - ChannelReference → unique match in this workspace
   *
   *  Cross-workspace and exact-id references should use `#conv:<id>`,
   *  not `#<name>`.
   */
  channel: ChannelReference | null | undefined;
  /** Optional click-to-navigate handler. When omitted (or when the
   *  ref couldn't be resolved unambiguously) the chip renders as
   *  inert muted text — `#name` is not clickable when we don't know
   *  where to send the user.
   *
   *  The conversation's workspace_id is wired in by ChannelView so
   *  the handler can call `nav.toChannel(workspaceId, channelId)`
   *  on the right workspace, even on a cross-workspace `?side` pane.
   */
  onOpen?: (channelId: string) => void;
}

/**
 * Inline rendering of a `#<channel_name>` reference inside a chat
 * message.
 *
 * Resolution scope is the **message's workspace** (not the primary-
 * selected workspace). Cross-workspace and id-precise references go
 * through `#conv:<id>` instead, which never participates in this
 * branch (the markdown tokenizer's negative lookahead excludes it).
 *
 * Visible states:
 *   - resolved + handler → clickable accent pill, click navigates
 *   - resolved, no handler → tooltip-only accent pill
 *   - ambiguous (null sentinel) → muted `#name` text, no navigation
 *   - unresolved (undefined) → muted `#name` text, no navigation
 *
 * Ambiguity is intentional: when two channels share a title we can't
 * pick the right destination silently, so we degrade to inert text
 * rather than guess. Same-name disambiguation is the user's
 * responsibility (rename one, or use `#conv:<id>` to point exactly).
 */
export function ChannelRef({ name, channel, onOpen }: ChannelRefProps): JSX.Element {
  // Unresolved / ambiguous → muted text. `data-channel-ref-state` is
  // exposed for tests so they can assert which branch fired.
  if (!channel) {
    return (
      <span
        className="text-text-muted"
        data-channel-ref-state={channel === null ? 'ambiguous' : 'unresolved'}
      >
        #{name}
      </span>
    );
  }
  const tooltip = `#${channel.title}`;
  const dim = channel.closed_at != null;

  if (!onOpen) {
    return (
      <span
        className="inline-flex items-baseline gap-0.5 rounded-[var(--chip-radius)] px-1 -mx-0.5 font-medium text-accent"
        title={tooltip}
        data-channel-ref-state="resolved-no-handler"
        data-channel-ref-id={channel.id}
      >
        <Hash className="size-3 shrink-0 self-center" />
        {channel.title}
      </span>
    );
  }
  return (
    <span
      role="button"
      tabIndex={0}
      className={
        'inline-flex cursor-pointer items-baseline gap-0.5 rounded-[var(--chip-radius)] px-1 -mx-0.5 font-medium text-accent transition-colors hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus' +
        (dim ? ' opacity-60' : '')
      }
      title={tooltip}
      data-channel-ref-state="resolved"
      data-channel-ref-id={channel.id}
      onClick={event => {
        event.preventDefault();
        event.stopPropagation();
        onOpen(channel.id);
      }}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        onOpen(channel.id);
      }}
    >
      <Hash className="size-3 shrink-0 self-center" />
      {channel.title}
    </span>
  );
}
