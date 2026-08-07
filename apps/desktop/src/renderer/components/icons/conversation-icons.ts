import { MessageSquare, type LucideIcon } from 'lucide-react';

/**
 * Single source of truth for the Thread icon. "Thread" is one product concept,
 * so it has exactly ONE glyph — reused across the thread list, thread detail
 * header, the collapse toggle, a message's thread entry / reply badge, a quoted
 * thread reference, and the activity thread-root. Seeing the same glyph
 * everywhere reinforces the "this icon = thread" mental model. The single-bubble
 * `MessageSquare` is the chosen form (not the compound `MessagesSquare`).
 *
 * Not part of this vocabulary: `ExternalLink` (locate a source message) and the
 * compound `MessagesSquare` — NavRail's Chat tab and the sidebar's DM group
 * header both use that one, and neither is a thread consumer. The compound form
 * is what keeps them apart: thread is the SINGLE bubble. Change the glyph here,
 * once, and every thread surface follows.
 */
export const ThreadIcon: LucideIcon = MessageSquare;
