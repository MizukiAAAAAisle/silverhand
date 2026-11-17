package com.silverhand.android;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/** Process owner only: no Activity references, credentials or persisted business read state.
 * Android's full string tag is the identity; neither hashes nor group/title identify a notice.
 * The caller serializes this state on the main thread. */
final class NotificationState {
    static final class ClickTarget {
        final String channelId, messageId, threadRootId, workspaceId;
        ClickTarget(String channelId, String messageId, String threadRootId, String workspaceId) {
            if (channelId == null || channelId.trim().isEmpty() || messageId == null || messageId.trim().isEmpty() ||
                (threadRootId != null && threadRootId.trim().isEmpty()) || (workspaceId != null && workspaceId.trim().isEmpty()))
                throw new IllegalArgumentException("Invalid notification click coordinates");
            this.channelId=channelId; this.messageId=messageId; this.threadRootId=threadRootId; this.workspaceId=workspaceId;
        }
    }
    static final class Ticket {
        final String session, tag, token, notificationId;
        final ClickTarget clickTarget;
        Ticket(String session, String tag, String token, String notificationId, ClickTarget clickTarget) {
            this.session = session; this.tag = tag; this.token = token; this.notificationId = notificationId;
            this.clickTarget = clickTarget;
        }
    }

    private String session = UUID.randomUUID().toString();
    private final Map<String, Ticket> issued = new LinkedHashMap<>();
    private final LinkedHashMap<String, Ticket> pendingClicks = new LinkedHashMap<>();

    String session() { return session; }
    boolean current(String value) { return session.equals(value); }
    String tag(String id) { return "silverhand:" + session + ":id:" + id; }

    Ticket prepare(String owner, String id) { return prepare(owner, id, null); }
    Ticket prepare(String owner, String id, ClickTarget target) {
        if (target != null && !Objects.equals(id, "alert:" + target.messageId))
            throw new IllegalArgumentException("Notification id does not match click target");
        if (!current(owner)) throw new IllegalStateException("Notification session expired");
        String tag = id == null ? "silverhand:" + session + ":anonymous:" + UUID.randomUUID() : tag(id);
        return new Ticket(session, tag, UUID.randomUUID().toString(), id, target);
    }

    Ticket post(Ticket ticket, Runnable enqueue) {
        if (!current(ticket.session)) throw new IllegalStateException("Notification session expired");
        enqueue.run();
        // Enqueue success does not make an OS active-notification snapshot authoritative.
        return issued.put(ticket.tag, ticket);
    }

    private Ticket remove(String owner, String tag, String token) {
        Ticket ticket = issued.get(tag);
        if (!current(owner) || ticket == null || !Objects.equals(ticket.token, token)) return null;
        issued.remove(tag);
        return ticket;
    }

    Ticket deleted(String owner, String tag, String token) { return remove(owner, tag, token); }

    Ticket click(String owner, String tag, String token) {
        Ticket ticket = remove(owner, tag, token);
        if (ticket == null) return null; // Duplicate/superseded intents cannot deliver again.
        if (ticket.notificationId != null) {
            pendingClicks.put(ticket.token, ticket);
            while (pendingClicks.size() > 32) pendingClicks.remove(pendingClicks.keySet().iterator().next());
        }
        return ticket;
    }

    List<Ticket> takeClicks(String owner) {
        if (!current(owner)) throw new IllegalStateException("Notification session expired");
        List<Ticket> clicks = new ArrayList<>(pendingClicks.values());
        pendingClicks.clear();
        return clicks;
    }

    Ticket dismiss(String owner, String id) {
        if (!current(owner)) throw new IllegalStateException("Notification session expired");
        pendingClicks.values().removeIf(ticket -> Objects.equals(ticket.notificationId, id));
        return issued.remove(tag(id));
    }

    List<Ticket> reset() {
        List<Ticket> previous = new ArrayList<>(issued.values());
        session = UUID.randomUUID().toString();
        issued.clear();
        pendingClicks.clear();
        return previous;
    }
}
