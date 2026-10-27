package com.silverhand.android;

/** Chooser Activity results alone do not confirm selection or cancellation. */
final class ShareResult {
    enum Reason { SELECTED, UNCONFIRMED, LAUNCH_FAILED, OWNER_DESTROYED }
    private final String token;
    private Reason reason;
    private boolean selected;

    ShareResult(String token) { this.token = token; }
    Reason getReason() { return reason; }
    boolean chosen(String token, boolean hasComponent) {
        if (!this.token.equals(token) || reason != null || selected || !hasComponent) return false;
        selected = true;
        return true;
    }
    boolean returned(String token) { return finish(token, selected ? Reason.SELECTED : Reason.UNCONFIRMED); }
    boolean failed(String token) { return finish(token, Reason.LAUNCH_FAILED); }
    boolean destroyed(String token) { return finish(token, Reason.OWNER_DESTROYED); }
    private boolean finish(String token, Reason next) {
        if (!this.token.equals(token) || reason != null) return false;
        reason = next;
        return true;
    }
}
