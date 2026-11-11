package com.silverhand.android;

/** Read-only system queries, isolated so a failed field does not hide other fields. */
final class NotificationSnapshot {
    interface Reader {
        String runtimePermission();
        Boolean appEnabled();
        /** Null means absent; an exception means unknown. */
        Channel channel();
    }
    static final class Channel {
        final boolean blocked;
        Channel(boolean blocked) { this.blocked = blocked; }
    }
    final String runtimePermission, channel;
    final Boolean appEnabled, channelBlocked;
    private NotificationSnapshot(String permission, Boolean enabled, String channel, Boolean blocked) {
        this.runtimePermission = permission; this.appEnabled = enabled;
        this.channel = channel; this.channelBlocked = blocked;
    }
    static NotificationSnapshot read(Reader reader) {
        String permission = "unknown", channel = "unknown";
        Boolean enabled = null, blocked = null;
        try {
            String value = reader.runtimePermission();
            if ("granted".equals(value) || "not-granted".equals(value) || "not-required".equals(value)) permission = value;
        } catch (RuntimeException ignored) { /* This field remains unknown. */ }
        try { enabled = reader.appEnabled(); } catch (RuntimeException ignored) { }
        try {
            Channel value = reader.channel();
            channel = value == null ? "absent" : "present";
            blocked = value == null ? null : value.blocked;
        } catch (RuntimeException ignored) { }
        return new NotificationSnapshot(permission, enabled, channel, blocked);
    }
}
