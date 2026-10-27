package com.silverhand.android;

/** Pure JVM check; no emulator or product build required. */
public final class ShareResultTest {
    private static int assertions = 0, cases = 0;
    private static ShareResult state(String id) { cases++; return new ShareResult(id); }
    private static void check(boolean yes) { assertions++; if (!yes) throw new AssertionError(); }
    public static void main(String[] args) {
        ShareResult selected = state("a");
        check(!selected.chosen("wrong", true)); check(!selected.chosen("a", false));
        check(selected.chosen("a", true)); check(selected.returned("a"));
        check(!selected.chosen("a", true)); check(selected.getReason() == ShareResult.Reason.SELECTED);
        ShareResult unknown = state("b");
        check(unknown.returned("b")); check(!unknown.chosen("b", true));
        check(!unknown.returned("b")); check(unknown.getReason() == ShareResult.Reason.UNCONFIRMED);
        ShareResult failed = state("c");
        check(failed.failed("c")); check(!failed.chosen("c", true));
        check(failed.getReason() == ShareResult.Reason.LAUNCH_FAILED);
        ShareResult destroyed = state("d");
        check(destroyed.destroyed("d")); check(!destroyed.returned("d"));
        check(!destroyed.chosen("d", true)); check(destroyed.getReason() == ShareResult.Reason.OWNER_DESTROYED);
        System.out.println("{\"cases\":" + cases + ",\"assertions\":" + assertions + ",\"failed\":0}");
    }
}
