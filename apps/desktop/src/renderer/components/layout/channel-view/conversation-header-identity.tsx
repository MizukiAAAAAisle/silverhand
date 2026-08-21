/**
 * The chat header's identity — the glyph and the name a conversation wears
 * (#task:2039).
 *
 * ONE identity primitive per entity, chosen by the pane's mode rather than by
 * each header: a workspace channel wears the canonical `#`
 * (`[data-conversation-hash-icon]`, painted per theme), a `direct_pair` wears its
 * COUNTERPART'S FACE — the same avatar that endpoint has in the sidebar row and
 * in its bylines. shiki, #task:2039: «DM channel 的 header 应该显示 DM 对象的
 * avatar，而不是一个 # icon». The earlier ruling that every channel header carries
 * the `#` with no branch (#task:1373) is untouched: it was about channels, and a
 * pair is not one.
 *
 * The `title` stays the caller's — for a pair it is already the counterpart's
 * resolved label (`presentCounterpart`) — so the face and the name can never
 * disagree, and the pre-mint draft pane converges onto the real pair without the
 * title moving.
 *
 * `title_only` is the third arm's honest answer (a placement with no pane mode,
 * or a pair whose carrier resolved no counterpart): no borrowed chrome, no
 * invented face.
 */
import { useMemo } from 'react';
import { Hash } from 'lucide-react';
import type { DirectPairCounterpart } from '@silverhand/shared';
import { AVATAR_PX } from '@/components/avatar-scale';
import {
  AuthorAvatarView,
  DeletedActorMarker,
} from '@/components/chat/author-avatar-view';
import { useAgentAvatarObjectUrls } from '@/features/agents/avatar-hooks';
import { useAgentPresence } from '@/features/agents/hooks';
import { usePresenceById } from '@/features/presence/hooks';
import { useUserAvatarObjectUrls } from '@/features/users/avatar-hooks';
import {
  collectCounterpartAvatarSources,
  presentCounterpart,
} from '@/features/direct-pairs/counterpart-presentation';
import type { ConversationPaneCapabilities } from '@/features/conversations/pane-mode';

const TITLE_CLASS =
  'min-w-0 truncate font-serif text-base font-semibold text-text-primary';

export function ConversationHeaderIdentity({
  identity,
  title,
  counterpart,
}: {
  identity: ConversationPaneCapabilities['headerIdentity'];
  title: string;
  /** Only consulted for `counterpart` identity; `null` falls back to the title
   *  alone. */
  counterpart?: DirectPairCounterpart | null;
}): JSX.Element {
  if (identity === 'counterpart' && counterpart) {
    return <CounterpartIdentity title={title} counterpart={counterpart} />;
  }
  return (
    <span data-conversation-title className={TITLE_CLASS}>
      {identity === 'channel_hash' ? (
        <Hash
          data-conversation-hash-icon
          data-sticker
          data-sticker-tone="channel"
          className="size-4 shrink-0 align-[-0.15em]"
        />
      ) : null}
      {title}
    </span>
  );
}

/**
 * The pair's face + name. The avatar is a SIBLING of the title span, not a child:
 * the title truncates and an avatar must never be clipped by that, and the theme
 * hooks are attribute-scoped (`[data-conversation-title]`), so nothing depends on
 * the glyph living inside it.
 *
 * `sm` (20px) — one tier above the sidebar row's `xs`, because this is the pane's
 * hero identity, and still well inside the 48px header so the face keeps its
 * padding instead of filling the bar.
 *
 * A deleted endpoint carries the same quiet marker its byline shows; it is also
 * the header's only explanation for the read-only composer below.
 */
function CounterpartIdentity({
  title,
  counterpart,
}: {
  title: string;
  counterpart: DirectPairCounterpart;
}): JSX.Element {
  const presentation = presentCounterpart(counterpart);
  // One batch for one face: the header holds a single counterpart, so this is the
  // same hook every other surface uses, over a one-element source set.
  const { agents, users } = useMemo(
    () => collectCounterpartAvatarSources([{ counterpart }]),
    [counterpart],
  );
  const agentAvatarUrls = useAgentAvatarObjectUrls(agents);
  const humanAvatarUrls = useUserAvatarObjectUrls(users);
  return (
    <>
      <AuthorAvatarView
        avatar={presentation.avatar}
        size={AVATAR_PX.sm}
        label={presentation.label}
        className="shrink-0"
        agentAvatarUrls={agentAvatarUrls}
        humanAvatarUrls={humanAvatarUrls}
      />
      <span data-conversation-title className={TITLE_CLASS}>
        {title}
      </span>
      {presentation.isDeleted ? (
        <span className="flex shrink-0 items-center">
          <DeletedActorMarker />
        </span>
      ) : (
        <CounterpartPresenceDot counterpart={counterpart} />
      )}
    </>
  );
}

/**
 * The counterpart's online dot, right after the name (shiki #task:2114:「DM channel
 * header 中，在 agent 名字后面加上 online status dot」).
 *
 * A dot, not the Online/Away/Offline word: the header is identity at a glance and
 * the word already lives in the counterpart's info card. `title` carries it for
 * anyone who asks.
 *
 * Which authority — a pair has NO roster (that is what makes it a pair), so this
 * is the agent's GLOBAL presence, the same composition the agent page's hero and
 * the info popover use (`useAgentPresence`: availability × presence deadline).
 * Deliberately NOT the roster seat status the member strip's dot shows: there is
 * no seat here. `null` (no definite answer yet) draws NOTHING rather than assert a
 * speculative state, and a deleted endpoint never reaches this component — it
 * wears the deleted marker instead, which is a fact about the principal, not a
 * state it could be in.
 */
function CounterpartPresenceDot({
  counterpart,
}: {
  counterpart: DirectPairCounterpart;
}): JSX.Element | null {
  if (counterpart.status !== 'active') return null;
  return counterpart.kind === 'agent' ? (
    <AgentPresenceDot agentId={counterpart.id} />
  ) : (
    <HumanPresenceDot userId={counterpart.id} />
  );
}

/** Dot ground: green is earned by a live, available agent; Away and Offline share
 *  the muted pip (the distinction is a word, not a colour — an idle agent that
 *  will answer the next message must not read as an alarm). Same palette as
 *  `AgentInfoPopover`'s global presence line, which is the same projection.
 *
 *  Carries `data-status-pip` and reads `--pill-radius` — the SAME status-pip
 *  contract the sidebar rail dot uses (shiki #task:2127). The attribute is what
 *  keeps the dot informational across themes: forza6 re-inks plain status colours
 *  but exempts `[data-status-pip]`, and the radius token makes the pip square in
 *  forza6 (`--pill-radius: 0`) and round elsewhere, so this dot matches every
 *  other presence pip instead of staying a hardcoded circle. Size stays the
 *  header's own (one tier above the rail) — that is layout, the consumer's call. */
const PRESENCE_DOT_CLASS =
  'size-2 shrink-0 rounded-[var(--pill-radius)]';

function AgentPresenceDot({ agentId }: { agentId: string }): JSX.Element | null {
  const presence = useAgentPresence(agentId);
  if (presence === null) return null;
  return (
    <span
      data-status-pip
      title={presence === 'online' ? 'Online' : presence === 'away' ? 'Away' : 'Offline'}
      className={`${PRESENCE_DOT_CLASS} ${presence === 'online' ? 'bg-success' : 'bg-text-muted/40'}`}
    />
  );
}

/** The human arm of the same dot. A pair's counterpart can be a human, and the
 *  chip strip already gives humans this pip from the presence map — a DM header
 *  that dotted only agents would answer the same question twice differently. */
function HumanPresenceDot({ userId }: { userId: string }): JSX.Element {
  const presence = usePresenceById().get(userId)?.presence;
  const online = presence === 'online';
  return (
    <span
      data-status-pip
      title={online ? 'Online' : 'Offline'}
      className={`${PRESENCE_DOT_CLASS} ${online ? 'bg-success' : 'bg-text-muted/40'}`}
    />
  );
}
