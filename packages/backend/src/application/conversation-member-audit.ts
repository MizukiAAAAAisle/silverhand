/**
 * The `conversation_member_added` / `conversation_member_removed` system-message
 * language (#task:1982 W5).
 *
 * Extracted from `conversation-member.ts` because it is PURE: two identity
 * snapshots in, a sentence and a metadata object out. That file also owns the
 * add/remove orchestration and therefore names six repos; a use case that only
 * needs the wording had to import all of that to get it. Keeping the language
 * here means the audit text has exactly one definition and no persistence
 * dependency — the removal cascade composes its messages inside a UnitOfWork
 * scope without the module tree dragging a `Database` handle in behind it.
 *
 * `conversationMemberAddedActorSnapshot` deliberately stays behind: resolving a
 * principal into a snapshot is a directory read, not language.
 */
import { formatReferenceToken, systemSubtype } from '@silverhand/shared';

export type ConversationMemberAddedActorSnapshot = {
  kind: 'user' | 'agent' | 'system';
  id: string;
  name: string;
  displayName: string | null;
};

export type ConversationMemberAddedMemberSnapshot = {
  kind: 'human' | 'agent';
  id: string;
  name: string;
  displayName: string | null;
};

export function conversationMemberAddedAgentSnapshot(agent: {
  id: string;
  name: string;
  display_name?: string | null;
}): ConversationMemberAddedMemberSnapshot {
  return {
    kind: 'agent',
    id: agent.id,
    name: agent.name,
    displayName: agent.display_name ?? null,
  };
}

export function conversationMemberAddedHumanSnapshot(
  // Structural, like {@link conversationMemberAddedAgentSnapshot}: the snapshot
  // reads three identity fields, so a caller holding a `UserRow` (repo read) is
  // as valid as one holding a `UserDto` (resolved DTO) — the helper has no reason
  // to demand the wider shape.
  user: { id: string; name: string; display_name?: string | null },
): ConversationMemberAddedMemberSnapshot {
  return {
    kind: 'human',
    id: user.id,
    name: user.name,
    displayName: user.display_name ?? null,
  };
}

export function conversationMemberAddedContent(input: {
  actor: ConversationMemberAddedActorSnapshot;
  member: ConversationMemberAddedMemberSnapshot;
}): string {
  return `${conversationMemberAddedLabel(input.actor)} added ${conversationMemberAddedLabel(input.member)} to this conversation.`;
}

/**
 * How this sentence names a participant: a canonical reference (#task:2000), not
 * the plain `@name` alias.
 *
 * This is a behavior-PRESERVING choice, not decoration. "X added you to this
 * conversation" is how a human learns they were added — it reaches them as a
 * `mention_self` notification because the sentence names them — and only the
 * canonical form still delivers. The actor's snapshot spells its human kind
 * `user` while a member's spells it `human`; the reference vocabulary is
 * `human`, so the mapping happens here rather than leaking a third spelling.
 */
export function conversationMemberAddedLabel(
  participant:
    | ConversationMemberAddedActorSnapshot
    | ConversationMemberAddedMemberSnapshot,
): string {
  if (participant.kind === 'system') return 'system';
  return formatReferenceToken({
    kind: participant.kind === 'agent' ? 'agent' : 'human',
    handle: participant.name,
  });
}

export function conversationMemberAddedMetadata(input: {
  actor: ConversationMemberAddedActorSnapshot;
  member: ConversationMemberAddedMemberSnapshot;
}): Record<string, unknown> {
  return {
    subtype: systemSubtype('conversation_member_added'),
    actor_kind: input.actor.kind,
    actor_id: input.actor.id,
    actor_name: input.actor.name,
    actor_display_name: input.actor.displayName,
    member_kind: input.member.kind,
    member_id: input.member.id,
    member_name: input.member.name,
    member_display_name: input.member.displayName,
  };
}

/**
 * Sentence for a `conversation_member_removed` system message. `content` is the
 * ONLY rendered carrier (the metadata below has no production reader), so the
 * self-departure case needs its own wording rather than the third-party one:
 * a workspace self-leave (`POST /api/workspaces/:id/leave`, #task:1930) cascades
 * through every channel of the workspace with actor === member, and "@x removed
 * @x from this conversation." would read as somebody else's moderation. Same
 * subtype either way — `actor_id === member_id` is what structurally marks the
 * self case, so a later first-class `left` event can derive history mechanically.
 */
export function conversationMemberRemovedContent(input: {
  actor: ConversationMemberAddedActorSnapshot;
  member: ConversationMemberAddedMemberSnapshot;
}): string {
  if (
    input.actor.kind === 'user'
    && input.member.kind === 'human'
    && input.actor.id === input.member.id
  ) {
    return `${conversationMemberAddedLabel(input.member)} left this conversation.`;
  }
  return `${conversationMemberAddedLabel(input.actor)} removed ${conversationMemberAddedLabel(input.member)} from this conversation.`;
}

export function conversationMemberRemovedMetadata(input: {
  actor: ConversationMemberAddedActorSnapshot;
  member: ConversationMemberAddedMemberSnapshot;
}): Record<string, unknown> {
  return {
    subtype: systemSubtype('conversation_member_removed'),
    actor_kind: input.actor.kind,
    actor_id: input.actor.id,
    actor_name: input.actor.name,
    actor_display_name: input.actor.displayName,
    member_kind: input.member.kind,
    member_id: input.member.id,
    member_name: input.member.name,
    member_display_name: input.member.displayName,
  };
}
