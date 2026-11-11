package com.silverhand.android;

public final class DiagnosticNotificationPolicyTest {
    private static void require(boolean value) { if (!value) throw new AssertionError(); }
    public static void main(String[] args) {
        boolean acceptance = args[0].equals("acceptance");
        NotificationState state = new NotificationState();
        String owner = state.session();
        var real = state.prepare(owner, "diagnostic:diagnostic-test");
        state.post(real, () -> {});
        require(DiagnosticNotificationPolicy.accepts("Silverhand 通知测试", "这是一条验收测试通知", null, null, null, true) == acceptance);
        if (!acceptance) {
            try { DiagnosticNotificationPolicy.prepare(state, owner); throw new AssertionError(); }
            catch (IllegalStateException expected) { }
            require(state.click(owner, real.tag, real.token) == real);
            System.out.println("Normal policy controls passed: refusal and real ticket unchanged");
            return;
        }
        require(!DiagnosticNotificationPolicy.accepts("custom", "这是一条验收测试通知", null, null, null, true));
        require(!DiagnosticNotificationPolicy.accepts("Silverhand 通知测试", "这是一条验收测试通知", null, null, "business-id", true));
        require(!DiagnosticNotificationPolicy.accepts("Silverhand 通知测试", "这是一条验收测试通知", null, null, null, false));
        var first = DiagnosticNotificationPolicy.prepare(state, owner);
        var next = DiagnosticNotificationPolicy.prepare(state, owner);
        require(first.notificationId == null && !first.tag.equals(real.tag));
        require(first.tag.equals(next.tag) && !first.token.equals(next.token));
        state.post(first, () -> {});
        require(state.post(next, () -> {}) == first);
        require(state.click(owner, first.tag, first.token) == null);
        require(state.deleted(owner, first.tag, first.token) == null);
        require(state.click(owner, next.tag, next.token) == next);
        require(state.takeClicks(owner).isEmpty());
        require(state.click(owner, real.tag, real.token) == real);
        state.takeClicks(owner);
        var deleted = DiagnosticNotificationPolicy.prepare(state, owner);
        state.post(deleted, () -> {});
        require(state.deleted(owner, deleted.tag, deleted.token) == deleted);
        var stale = DiagnosticNotificationPolicy.prepare(state, owner);
        state.post(stale, () -> {});
        state.reset();
        require(state.click(owner, stale.tag, stale.token) == null);
        require(state.deleted(owner, stale.tag, stale.token) == null);
        System.out.println("Acceptance policy controls passed: fixed payload, separate tag, nonce replacement/delete, no business click, reset");
    }
}
