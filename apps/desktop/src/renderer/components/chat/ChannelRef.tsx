import { Hash } from 'lucide-react';
import type { ChannelDto } from '@silverhand/shared';

interface ChannelRefProps {
  /** The handle as it appeared in the source text (without `#`). */
  name: string;
  /** Resolved channel — undefined when the name doesn't match any
   *  known channel. */
  channel: ChannelDto | undefined;
}

/**
 * Inline rendering of a `#channel` reference inside a chat message.
 * Visual-only for v1: a styled pill with a tooltip — no navigation
 * (the wiring would need to dispatch up to App.tsx, which is a
 * separate concern). Unresolved refs render as plain muted text so a
 * stray `#todo` doesn't look interactive.
 */
export function ChannelRef({ name, channel }: ChannelRefProps): JSX.Element {
  if (!channel) {
    return <span className="text-text-muted">#{name}</span>;
  }
  const tooltip = channel.description
    ? `#${channel.name} — ${channel.description}`
    : `#${channel.name}`;
  return (
    <span
      className="inline-flex items-baseline gap-0.5 rounded px-1 -mx-0.5 font-medium text-accent"
      title={tooltip}
    >
      <Hash className="size-3 shrink-0 self-center" />
      {channel.name}
    </span>
  );
}
