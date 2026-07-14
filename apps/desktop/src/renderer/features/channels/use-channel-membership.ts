import { useChannelDetail } from '@/features/workspaces/hooks';
import {
  channelGateFor,
  deriveChannelMembership,
  type ChannelGate,
  type MembershipCarrier,
  type MembershipState,
} from './membership';

export interface ResolvedChannelMembership {
  membership: MembershipState;
  gate: ChannelGate;
}

/**
 * Resolve a channel's per-viewer membership to the fail-closed three-state,
 * shared by `ChannelView` (the primary/side pane) and `App` (for the open
 * `ThreadPanel`) so both consume the SAME authority instead of each collapsing
 * it their own way. The carrier's own `is_member` wins when present (a
 * discovery-union list item or a channel-detail response); a carrier that lacks
 * it — a cross-workspace `?side` ref / deep link — is `unknown`, resolved by a
 * channel-detail fetch (a read allowed to anyone who can view the channel). The
 * fetch is `enabled`-gated to the `unknown` case only, so a member hot path
 * (carrier already stamped) fires zero extra network and never flickers.
 *
 * `channelId` null (no channel selected) leaves the fetch disabled → `unknown`.
 */
export function useChannelMembership(
  carrier: MembershipCarrier | null | undefined,
  channelId: string | null,
): ResolvedChannelMembership {
  const carrierMembership = deriveChannelMembership(carrier ?? undefined);
  const needsDetail = carrierMembership === 'unknown' && !!channelId;
  const { data: detail } = useChannelDetail(channelId, needsDetail);
  const membership = needsDetail
    ? deriveChannelMembership(carrier ?? undefined, detail?.is_member)
    : carrierMembership;
  return { membership, gate: channelGateFor(membership) };
}
