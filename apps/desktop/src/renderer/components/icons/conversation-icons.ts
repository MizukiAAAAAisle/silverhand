import { MessageSquare, type LucideIcon } from "lucide-react";

/**
 * Single source of truth for the Thread icon. "Thread" is one product concept,
 * so it has exactly ONE glyph — reused across the thread list, thread detail
 * header, the collapse toggle, a message's thread entry / reply badge, a quoted
 * thread reference, and the activity thread-root. Seeing the same glyph
 * everywhere reinforces the "this icon = thread" mental model. The single-bubble
 * `MessageSquare` is the chosen form (not the compound `MessagesSquare`).
 *
 * Not part of this vocabulary: `ExternalLink` (locate a source message) and the
 * compound `MessagesSquare`, worn by non-thread surfaces such as the rail's Chat
 * tab, the sidebar's AGENT SPACES header and the agent view's Chats tab. The
 * compound form is what keeps them apart: thread is the SINGLE bubble. Change the
 * glyph here, once, and every thread surface follows.
 *
 * The single bubble is also drawn raw outside this module, in two roles that do
 * not claim to NAME an entity and so do not read as the thread word: as a verb
 * beside a "Message" label (agent header / agent view) and as an event-kind mark
 * in the agent activity timeline. Where it does land as an entity glyph, it
 * collides: the sidebar's DIRECT MESSAGES header (`DirectMessagesPanel`) paints
 * the thread word on a non-thread section. That one passes this fence (not a
 * thread consumer) but reads as the same word — a glyph choice for @shiki,
 * recorded rather than changed (#task:2088).
 */
export const ThreadIcon: LucideIcon = MessageSquare;
