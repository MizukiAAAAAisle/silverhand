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
      ) : null}
    </>
  );
}
