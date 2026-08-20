// Which of a message's references addressed NOBODY (#task:2021 P4-5-b).
//
// The addressing contract (#task:2000) decides who a message is aimed at, and
// every consumer of it fails CLOSED: a reference naming a principal this send
// cannot reach simply has no effect — no follower row, no delivery, no
// notification. That is the right delivery behaviour and the wrong reporting
// behaviour: the author wrote a token believing it addressed someone, and until
// now nothing anywhere said otherwise.
//
// So this module answers the REPORTING question, and only that:
//
//     a reference is ADDRESSED by this send iff the principal it names is a
//     participant of the TARGET conversation, or the send copied the message to
//     it out of band (mention CC). Everything else is UNRESOLVED.
//
// Three properties of that definition are load-bearing:
//
//  1. IT IS DERIVED FROM THE SAME AUTHORITY THE EFFECTS USE. Participation is
//     asked of the one placement authority (§4.2) — the same predicate the thread
//     auto-follow funnels gate on and the same one the main-line recipient
//     enumeration is built from — so "addressed" cannot claim a reach the send did
//     not have. A private rule here would be a second definition of addressing,
//     free to drift into telling the author their mention landed when no row was
//     written.
//
//  2. IT CARRIES NO REASON. `unknown handle` and `exists but is not a
//     participant here` are ONE outcome, exactly as in the P4-2 resolver: split
//     them and the send response becomes an existence oracle — anyone could probe
//     whether a name exists anywhere in the deployment by mentioning it. The
//     author's own text is echoed back; nothing else is added to it.
//
//  3. IT IS FOR THE SENDER. The result goes to the send's own caller and to the
//     structured log, never into the message body, the committed row, or any
//     frame a recipient reads. A reference that addressed nobody is a fact about
//     the AUTHOR's attempt, and publishing it to the channel would both leak the
//     probe of (2) and rewrite what everyone else sees of the message.
//
// LIVENESS needs no separate conjunct here, unlike the follow funnels, which
// start from a principal id and must ask `get()` because participation
// deliberately survives an endpoint tombstone. This path starts from a HANDLE: a
// row returned by `getByName` is a live principal by construction, and a deleted
// one resolves to nothing and is reported unresolved — which is what the author
// needs to hear either way.
import type { Reference } from '@silverhand/shared';
import type { MessageTxScope } from '../services/conversation-message/ports.js';

/**
 * The transactional capability this READ needs, as a subset of the send's own
 * scope. Three ports, no writes: stated as a `Pick` so a widening is visible
 * here — a reporting derivation that gained the ability to insert anything would
 * stop being a report.
 */
export type ReferenceAddressingTxScope = Pick<
  MessageTxScope,
  'agents' | 'users' | 'conversations'
>;

export interface UnresolvedReferenceInput {
  /** The send boundary's single derivation of what this message addresses
   *  (#task:2000). Required, never re-parsed: one send, one parse. */
  references: readonly Reference[];
  /** The conversation delivery is judged against — the TARGET, not the source.
   *  They differ only for an agent's cross-conversation send, where the
   *  reference has to be answered by the place the message landed. */
  targetConversationId: string;
  /** Agents the send reached OUT OF BAND, by writing a mention CC copy into the
   *  author's direct line with them. They are addressed BECAUSE they are not
   *  participants here — the CC exists for exactly that case — so without this
   *  set the one mechanism built to reach a non-participant would report as a
   *  failure to reach them. Empty for an actor kind whose policy carries no CC,
   *  and for a mention the CC declined to copy (an agent the author may open no
   *  direct line to), which is then reported as unresolved — reason-free, like
   *  every other arm here. */
  ccReachedAgentIds: ReadonlySet<string>;
}

/**
 * The references this send addressed nobody with, in the author's own order and
 * spelling. Empty for a message that addressed everyone it named — and for one
 * that named nobody.
 */
export function collectUnresolvedReferences(
  tx: ReferenceAddressingTxScope,
  input: UnresolvedReferenceInput,
): Reference[] {
  const unresolved: Reference[] = [];
  for (const ref of input.references) {
    if (!isAddressed(tx, input, ref)) unresolved.push(ref);
  }
  return unresolved;
}

function isAddressed(
  tx: ReferenceAddressingTxScope,
  input: UnresolvedReferenceInput,
  ref: Reference,
): boolean {
  // The reference's KIND decides which namespace answers, with no fallback
  // (#task:2000): a handle is unique across both tables, so an agent-kind
  // pointer that resolved to a human `x` would make the kind decorative — and
  // would report "addressed" for a token that addressed nobody.
  if (ref.kind === 'agent') {
    const agent = tx.agents.getByName(ref.handle);
    if (!agent) return false;
    if (input.ccReachedAgentIds.has(agent.id)) return true;
    return tx.conversations.isAgentParticipant(
      input.targetConversationId,
      agent.id,
    );
  }
  const user = tx.users.getByName(ref.handle);
  if (!user) return false;
  return tx.conversations.isUserParticipant(
    input.targetConversationId,
    user.id,
  );
}
