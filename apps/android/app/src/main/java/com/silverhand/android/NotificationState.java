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
    static final class Ticket {
        final String session, tag, token, notificationId;
        Ticket(String session, String tag, String token, String notificationId) {
            this.session = session; this.tag = tag; this.token = token; this.notificationId = notificationId;
        }
    }

    private String session = UUID.randomUUID().toString();
    private final Map<String, Ticket> issued = new LinkedHashMap<>();
    private final LinkedHashMap<String, Ticket> pendingClicks = new LinkedHashMap<>();

    String session() { return session; }
    boolean current(String value) { return session.equals(value); }
    String tag(String id) { return "silverhand:" + session + ":id:" + id; }

    Ticket prepare(String owner, String id) {
        if (!current(owner)) throw new IllegalStateException("Notification session expired");
        String tag = id == null ? "silverhand:" + session + ":anonymous:" + UUID.randomUUID() : tag(id);
        return new Ticket(session, tag, UUID.randomUUID().toString(), id);
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
