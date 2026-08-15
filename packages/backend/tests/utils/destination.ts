// The AGENT send door's destination, for tests (#task:2021 P4-4).
//
// `sendMessage` takes an ALREADY-RESOLVED destination, and the two doors express
// different things: `own_main_line` / `own_reply_cluster` are what a person's
// client can say, while every agent request arrives as an absolute stream that
// `resolveDeliveryTarget` produced. A test standing in for the agent route must
// therefore build the `stream` arm, or it would be exercising an arm no agent can
// reach.
import type { AddressableId } from '@silverhand/shared';
import type { SendMessageDestination } from '../../src/services/conversation-message-service.js';

/**
 * A resolved stream destination.
 *
 * `threadRootId` is a ROOT id and is used verbatim — a mid-cluster id never
 * reaches the service, because the resolver refuses it upstream
 * (`thread_root_not_a_root`), so there is no normalization here to lean on.
 *
 * Brands without validating: the grammar is the ROUTE's gate, and a few cases
 * deliberately name a conversation that cannot exist in order to reach the
 * service's own refusals.
 */
export function stream(
  conversationId: string,
  threadRootId: string | null = null,
): SendMessageDestination {
  return {
    kind: 'stream',
    stream: {
      conversationId: conversationId as AddressableId,
      threadRootId: threadRootId as AddressableId | null,
    },
  };
}
