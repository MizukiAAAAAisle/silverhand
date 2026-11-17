package com.silverhand.android;

import java.util.List;

/** Pure JVM identity/lifecycle controls, not evidence of Android OS delivery. */
public final class NotificationStateTest {
    private static void require(boolean value) { if (!value) throw new AssertionError(); }
    private static NotificationState.Ticket post(NotificationState state, NotificationState.Ticket ticket) {
        return state.post(ticket, () -> {});
    }
    public static void main(String[] args) {
        NotificationState state = new NotificationState();
        String session = state.session();
        // Exercise the same production post entry while the fake OS has only queued
        // the item. Its current active snapshot is empty until publication later.
        System.out.println("control=post-before-active-visibility");
        var activeSnapshot = new java.util.ArrayList<String>();
        var enqueued = new java.util.ArrayList<String>();
        var delayed = state.prepare(session, "queued");
        state.post(delayed, () -> enqueued.add(delayed.tag));
        require(activeSnapshot.isEmpty() && enqueued.equals(List.of(delayed.tag)));
        activeSnapshot.addAll(enqueued);
        require(state.click(session, delayed.tag, delayed.token) == delayed);
        require(state.click(session, delayed.tag, delayed.token) == null);
        state.takeClicks(session);
        // Deliberate Java hash collision must never alias two OS tags or click destinations.
        require("Aa".hashCode() == "BB".hashCode());
        var first = state.prepare(session, "Aa"); var other = state.prepare(session, "BB");
        require(!first.tag.equals(other.tag));
        post(state, first); post(state, other);
        var replacement = state.prepare(session, "Aa");
        require(replacement.tag.equals(first.tag) && !replacement.token.equals(first.token));
        require(post(state, replacement) == first);
        require(state.click(session, first.tag, first.token) == null);
        require(state.click(session, replacement.tag, replacement.token) == replacement);
        require(state.click(session, replacement.tag, replacement.token) == null);
        require(state.takeClicks(session).get(0).notificationId.equals("Aa"));
        require(state.takeClicks(session).isEmpty());
        require(state.dismiss(session, "Aa") == null); // Idempotent, does not remove another ID.
        require(state.click(session, other.tag, other.token) == other);
        require(state.takeClicks(session).get(0).notificationId.equals("BB"));

        var failure1 = state.prepare(session, null); var failure2 = state.prepare(session, null);
        require(!failure1.tag.equals(failure2.tag));
        post(state, failure1); post(state, failure2);
        require(state.click(session, failure1.tag, failure1.token) == failure1);
        require(state.takeClicks(session).isEmpty()); // No invented message destination.
        // A replacement Activity uses the same process owner without resetting it.
        NotificationState replacementActivityOwner = state;
        require(replacementActivityOwner.click(session, failure2.tag, failure2.token) == failure2);

        var old = state.prepare(session, "old"); post(state, old);
        require(state.click(session, old.tag, old.token) == old);
        var oldDelete = state.prepare(session, "delete-after-switch"); post(state, oldDelete);
        require(state.reset().contains(oldDelete)); // Owner can cancel both old PendingIntents.
        String next = state.session();
        require(!next.equals(session) && !state.current(session));
        require(state.takeClicks(next).isEmpty());
        require(state.click(session, old.tag, old.token) == null);
        try { state.prepare(session, "stale"); throw new AssertionError(); }
        catch (IllegalStateException expected) { /* Stale pending permission work cannot post. */ }
        var dismissed = state.prepare(next, "dismissed"); post(state, dismissed);
        require(state.dismiss(next, "dismissed") == dismissed);
        require(state.click(next, dismissed.tag, dismissed.token) == null);
        System.out.println("control=delete-old-vs-new");
        var oldVersion = state.prepare(next, "deleted"); post(state, oldVersion);
        var newVersion = state.prepare(next, "deleted"); post(state, newVersion);
        require(state.deleted(next, oldVersion.tag, oldVersion.token) == null);
        require(state.click(next, newVersion.tag, newVersion.token) == newVersion);
        state.takeClicks(next);
        var currentDelete = state.prepare(next, "current-delete"); post(state, currentDelete);
        require(state.deleted(next, currentDelete.tag, currentDelete.token) == currentDelete);
        require(state.click(next, currentDelete.tag, currentDelete.token) == null);
        var anonymousDelete = state.prepare(next, null); post(state, anonymousDelete);
        require(state.deleted(next, anonymousDelete.tag, anonymousDelete.token) == anonymousDelete);
        require(state.click(next, anonymousDelete.tag, anonymousDelete.token) == null);
        var switched = state.prepare(next, "delete-after-switch"); post(state, switched);
        require(state.deleted(session, oldDelete.tag, oldDelete.token) == null);
        require(state.click(next, switched.tag, switched.token) == switched);
        state.takeClicks(next);
        for (int n=0;n<40;n++) {
            var item = state.prepare(next, "pending-"+n); post(state, item);
            state.click(next,item.tag,item.token);
        }
        require(state.takeClicks(next).size() == 32);
        System.out.println("control=retained-click-target-current-session");
        var target = new NotificationState.ClickTarget("channel", "message", "thread", "workspace");
        var retained = state.prepare(next, "alert:message", target);
        post(state, retained); // The JS owner may now be destroyed; this process-owned ticket remains.
        require(state.click(next, retained.tag, retained.token) == retained);
        var recovered = state.takeClicks(next).get(0);
        require(recovered.clickTarget == target && recovered.clickTarget.threadRootId.equals("thread") &&
            recovered.clickTarget.workspaceId.equals("workspace") && recovered.clickTarget.channelId.equals("channel"));
        require(state.takeClicks(next).isEmpty() && state.click(next, retained.tag, retained.token) == null);
        System.out.println("control=target-only-successful-post");
        var unposted = state.prepare(next, "alert:message", target);
        require(state.click(next, unposted.tag, unposted.token) == null);
        try { state.post(unposted, () -> { throw new IllegalStateException("OS post refused"); }); }
        catch (IllegalStateException expected) { }
        require(state.click(next, unposted.tag, unposted.token) == null);
        System.out.println("control=dm-and-legacy-target-payloads");
        var dmTarget = new NotificationState.ClickTarget("direct", "dm", null, null);
        var dm = state.prepare(next, "alert:dm", dmTarget); post(state, dm);
        state.click(next, dm.tag, dm.token);
        require(state.takeClicks(next).get(0).clickTarget.workspaceId == null && dm.clickTarget.threadRootId == null);
        var legacy = state.prepare(next, "legacy"); post(state, legacy); state.click(next, legacy.tag, legacy.token);
        require(state.takeClicks(next).get(0).clickTarget == null);
        System.out.println("control=invalid-target-and-id-refused");
        try { state.prepare(next, "alert:other", target); throw new AssertionError(); }
        catch (IllegalArgumentException expected) { }
        try { new NotificationState.ClickTarget("", "message", null, null); throw new AssertionError(); }
        catch (IllegalArgumentException expected) { }
        try { new NotificationState.ClickTarget("c", "message", "", null); throw new AssertionError(); }
        catch (IllegalArgumentException expected) { }
        System.out.println("control=dismiss-delete-reset-drop-targets");
        var drop = state.prepare(next, "alert:message", target); post(state, drop);
        state.click(next, drop.tag, drop.token); state.dismiss(next, "alert:message");
        require(state.takeClicks(next).isEmpty());
        drop = state.prepare(next, "alert:message", target); post(state, drop);
        state.deleted(next, drop.tag, drop.token); require(state.click(next, drop.tag, drop.token) == null);
        drop = state.prepare(next, "alert:message", target); post(state, drop); state.reset();
        require(state.click(next, drop.tag, drop.token) == null);
        try { state.takeClicks(next); throw new AssertionError(); } catch (IllegalStateException expected) { }
        System.out.println("Notification identity controls passed: exact tags, replacement, one-shot clicks, anonymous, Activity owner, reset, dismiss, bounded queue");
    }
}
