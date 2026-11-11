package com.silverhand.android;

import java.util.UUID;

/** Compiled only into the acceptance variant. No caller-provided test identity. */
final class DiagnosticNotificationPolicy {
    static boolean accepts(String title, String body, String subtitle, String group, String id, boolean force) {
        return "Silverhand 通知测试".equals(title) && "这是一条验收测试通知".equals(body)
            && subtitle == null && group == null && id == null && force;
    }
    static NotificationState.Ticket prepare(NotificationState state, String owner) {
        if (!state.current(owner)) throw new IllegalStateException("Notification session expired");
        return new NotificationState.Ticket(owner, "silverhand:" + owner + ":diagnostic:diagnostic-test", UUID.randomUUID().toString(), null);
    }
}
