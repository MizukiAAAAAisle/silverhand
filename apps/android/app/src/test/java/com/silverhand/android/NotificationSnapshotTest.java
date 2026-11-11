package com.silverhand.android;

/** Pure read-path controls. No Android permission/channel side effects are mocked into a read. */
public final class NotificationSnapshotTest {
    private static void require(boolean value) { if (!value) throw new AssertionError(); }
    public static void main(String[] args) {
        for (int failing = -1; failing < 3; failing++) {
            final int field = failing;
            int[] calls = {0, 0, 0};
            NotificationSnapshot value = NotificationSnapshot.read(new NotificationSnapshot.Reader() {
                public String runtimePermission() { calls[0]++; if (field == 0) throw new SecurityException(); return "not-granted"; }
                public Boolean appEnabled() { calls[1]++; if (field == 1) throw new SecurityException(); return true; }
                public NotificationSnapshot.Channel channel() { calls[2]++; if (field == 2) throw new SecurityException(); return new NotificationSnapshot.Channel(true); }
            });
            require(calls[0] == 1 && calls[1] == 1 && calls[2] == 1);
            require(value.runtimePermission.equals(field == 0 ? "unknown" : "not-granted"));
            require(field == 1 ? value.appEnabled == null : value.appEnabled);
            require(value.channel.equals(field == 2 ? "unknown" : "present"));
            require(field == 2 ? value.channelBlocked == null : value.channelBlocked);
        }
        NotificationSnapshot absent = NotificationSnapshot.read(new NotificationSnapshot.Reader() {
            public String runtimePermission() { return "not-required"; }
            public Boolean appEnabled() { return false; }
            public NotificationSnapshot.Channel channel() { return null; }
        });
        require(absent.channel.equals("absent") && absent.channelBlocked == null);
        require(absent.runtimePermission.equals("not-required") && !absent.appEnabled);
        System.out.println("Read snapshot controls passed: independent unknown fields, current states, absent channel, one query per field");
    }
}
