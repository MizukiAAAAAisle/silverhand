import { MessageSquare, type LucideIcon } from 'lucide-react';

/**
 * Single source of truth for the Thread icon. "Thread" is one product concept,
 * so it has exactly ONE glyph — reused across the thread list, thread detail
 * header, the collapse toggle, a message's thread entry / reply badge, a quoted
 * thread reference, and the activity thread-root. Seeing the same glyph
 * everywhere reinforces the "this icon = thread" mental model. The single-bubble
 * `MessageSquare` is the chosen form (not the compound `MessagesSquare`).
 *
 * Not part of this vocabulary: `ExternalLink` (locate a source message) and
 * NavRail's Chat tab glyph (the compound `MessagesSquare`) — separate concepts,
 * never thread consumers. The DM group header is a third: it uses
 * `DirectMessageIcon` (oval bubbles) precisely so it does NOT rhyme with the
 * square thread bubble. Change the glyph here, once, and every thread surface
 * follows.
 */
export const ThreadIcon: LucideIcon = MessageSquare;
