package com.silverhand.android;

import java.io.ByteArrayInputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.util.Collection;
import java.util.HashSet;

/** Executes the product's PEM builder on host fixtures; not AndroidCAStore evidence. */
public final class NativeTrustTest {
    private static int assertions;
    private static int cases;
    private static void check(boolean value) { assertions++; if (!value) throw new AssertionError(); }
    private interface Attempt { void run() throws Exception; }
    private static void refuses(Attempt action) throws Exception {
        cases++;
        try { action.run(); } catch (Exception expected) { assertions++; return; }
        throw new AssertionError("Expected rejection");
    }
    private static Collection<? extends Certificate> parse(byte[] pem) throws Exception {
        return CertificateFactory.getInstance("X.509").generateCertificates(new ByteArrayInputStream(pem));
    }
    private static KeyStore empty() throws Exception {
        KeyStore store = KeyStore.getInstance("JKS"); store.load(null); return store;
    }
    public static void main(String[] args) throws Exception {
        byte[] system = Files.readAllBytes(Path.of(args[0]));
        byte[] user = Files.readAllBytes(Path.of(args[1]));
        byte[] leaf = Files.readAllBytes(Path.of(args[2]));
        Certificate a = parse(system).iterator().next(), b = parse(user).iterator().next();
        KeyStore store = empty(); store.setCertificateEntry("system:fixture", a);
        cases++;
        var normal = parse(NativeTrust.bundle(store, false, null));
        check(normal.size() == 1); check(normal.contains(a)); check(!normal.contains(b));
        cases++;
        store.setCertificateEntry("user:fixture", b);
        store.setCertificateEntry("system:duplicate", a);
        var withUser = parse(NativeTrust.bundle(store, false, null));
        check(withUser.size() == 2); check(new HashSet<>(withUser).equals(new HashSet<>(java.util.List.of(a, b))));
        cases++;
        var acceptance = parse(NativeTrust.bundle(store, true, new ByteArrayInputStream(user)));
        check(acceptance.size() == 2); // Extra already trusted CA is not duplicated.
        store.deleteEntry("user:fixture");
        cases++;
        check(parse(NativeTrust.bundle(store, true, new ByteArrayInputStream(user))).size() == 2);
        check(parse(NativeTrust.bundle(store, false, null)).size() == 1); // No acceptance state leaks between calls.
        refuses(() -> NativeTrust.bundle(store, false, new ByteArrayInputStream(user)));
        refuses(() -> NativeTrust.bundle(store, true, null));
        refuses(() -> NativeTrust.bundle(empty(), false, null));
        refuses(() -> NativeTrust.bundle(empty(), true, new ByteArrayInputStream(user)));
        refuses(() -> NativeTrust.bundle(store, true, new ByteArrayInputStream(new byte[] {1, 2, 3})));
        refuses(() -> NativeTrust.bundle(store, true, new ByteArrayInputStream(leaf)));
        refuses(() -> NativeTrust.bundle(KeyStore.getInstance("JKS"), false, null)); // Query failure is not empty/success.
        byte[] two = new byte[system.length + user.length];
        System.arraycopy(system, 0, two, 0, system.length); System.arraycopy(user, 0, two, system.length, user.length);
        refuses(() -> NativeTrust.bundle(store, true, new ByteArrayInputStream(two)));
        Path directory = Files.createTempDirectory("native-trust-control-");
        try {
            var destination = directory.resolve("urlsession-ca.pem").toFile();
            byte[] current = NativeTrust.bundle(store, false, null);
            int[] environment = {0};
            var setEnv = (NativeTrust.Environment) path -> {
                check(path.equals(destination.getAbsolutePath()));
                check(java.util.Arrays.equals(current, Files.readAllBytes(destination.toPath())));
                environment[0]++;
            };
            Files.writeString(destination.toPath(), "old acceptance bundle");
            refuses(() -> NativeTrust.install(current, destination, setEnv, (bytes, file) -> {}));
            check(environment[0] == 0); // Silent commit failure with an old destination cannot set CAINFO.
            refuses(() -> NativeTrust.install(current, destination, setEnv, (bytes, file) -> { throw new java.io.IOException("commit failed"); }));
            check(environment[0] == 0);
            cases++;
            NativeTrust.install(current, destination, setEnv);
            check(environment[0] == 1);
            check(Files.getPosixFilePermissions(destination.toPath()).equals(
                    java.nio.file.attribute.PosixFilePermissions.fromString("rw-------")));
            Files.delete(destination.toPath());
        } finally { Files.delete(directory); }
        System.out.println("{\"cases\":" + cases + ",\"assertions\":" + assertions + ",\"failed\":0}");
    }
}
