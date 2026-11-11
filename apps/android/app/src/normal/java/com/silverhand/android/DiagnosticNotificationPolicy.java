package com.silverhand.android;

/** Normal debug/release contain only refusal, never the fixed test payload/identity. */
final class DiagnosticNotificationPolicy {
    static boolean accepts(String title, String body, String subtitle, String group, String id, boolean force) { return false; }
    static NotificationState.Ticket prepare(NotificationState state, String owner) {
        throw new IllegalStateException("Diagnostic notifications unavailable");
    }
}
