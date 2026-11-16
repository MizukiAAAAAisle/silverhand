package com.silverhand.android;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.util.Arrays;
import java.util.Collection;
import java.util.HashSet;

/** Product PEM/storage gates on fixed-date host fixtures; not Android startup evidence. */
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
    private static NativeTrust.Asset asset(byte[] bytes) { return () -> new ByteArrayInputStream(bytes); }
    private static KeyStore empty() throws Exception {
        KeyStore store = KeyStore.getInstance("JKS"); store.load(null); return store;
    }
    private static NativeTrust.Bundle skipped(KeyStore store, NativeTrust.Asset asset, String status) throws Exception {
        cases++;
        var result = NativeTrust.bundle(store, true, asset);
        check(result.status.equals(status)); check(result.acceptanceCa == null);
        check(Arrays.equals(result.pem, NativeTrust.bundle(store, false, null).pem));
        return result;
    }
    public static void main(String[] args) throws Exception {
        Path fixtures = Path.of(args[0]), output = Path.of(args[1]);
        byte[] system = Files.readAllBytes(fixtures.resolve("system.pem"));
        byte[] user = Files.readAllBytes(fixtures.resolve("valid.pem"));
        byte[] expired = Files.readAllBytes(fixtures.resolve("expired.pem"));
        byte[] future = Files.readAllBytes(fixtures.resolve("future.pem"));
        byte[] leaf = Files.readAllBytes(fixtures.resolve("valid-server.pem"));
        Certificate a = parse(system).iterator().next(), b = parse(user).iterator().next();
        KeyStore store = empty(); store.setCertificateEntry("system:fixture", a);
        cases++;
        var normal = NativeTrust.bundle(store, false, null);
        check(normal.status.equals("disabled")); check(normal.acceptanceCa == null);
        check(parse(normal.pem).size() == 1); check(parse(normal.pem).contains(a)); check(!parse(normal.pem).contains(b));
        cases++;
        store.setCertificateEntry("user:fixture", b);
        store.setCertificateEntry("system:duplicate", a);
        var withUser = parse(NativeTrust.bundle(store, false, null).pem);
        check(withUser.size() == 2); check(new HashSet<>(withUser).equals(new HashSet<>(java.util.List.of(a, b))));
        cases++;
        check(parse(NativeTrust.bundle(store, true, asset(user)).pem).size() == 2);
        store.deleteEntry("user:fixture");
        cases++;
        var acceptance = NativeTrust.bundle(store, true, asset(user));
        check(acceptance.status.equals("accepted")); check(Arrays.equals(acceptance.acceptanceCa, user));
        check(parse(acceptance.pem).size() == 2);
        refuses(() -> NativeTrust.bundle(store, false, asset(user)));
        refuses(() -> NativeTrust.bundle(store, true, null));
        refuses(() -> NativeTrust.bundle(empty(), false, null));
        refuses(() -> NativeTrust.bundle(empty(), true, asset(user)));
        refuses(() -> NativeTrust.bundle(KeyStore.getInstance("JKS"), false, null));
        var expiredResult = skipped(store, asset(expired), "skipped-expired");
        skipped(store, asset(future), "skipped-not-yet-valid");
        skipped(store, asset(new byte[] {1, 2, 3}), "skipped-malformed");
        skipped(store, asset(leaf), "skipped-not-ca");
        skipped(store, asset(new byte[65537]), "skipped-malformed");
        skipped(store, asset((new String(user, java.nio.charset.StandardCharsets.US_ASCII) + "garbage").getBytes()), "skipped-malformed");
        byte[] two = new byte[system.length + user.length];
        System.arraycopy(system, 0, two, 0, system.length); System.arraycopy(user, 0, two, system.length, user.length);
        skipped(store, asset(two), "skipped-malformed");
        skipped(store, () -> { throw new java.io.FileNotFoundException("missing"); }, "skipped-unreadable");
        skipped(store, () -> { throw new SecurityException("denied"); }, "skipped-unreadable");
        skipped(store, () -> new java.io.InputStream() {
            @Override public int read() throws IOException { throw new IOException("read failed"); }
        }, "skipped-unreadable");
        skipped(store, () -> new ByteArrayInputStream(user) {
            @Override public void close() throws IOException { throw new IOException("close failed"); }
        }, "skipped-unreadable");
        Files.createDirectories(output);
        Files.write(output.resolve("roots.pem"), normal.pem);
        Files.write(output.resolve("accepted.pem"), acceptance.pem);
        Files.write(output.resolve("expired-skipped.pem"), expiredResult.pem);
        Path directory = Files.createTempDirectory("native-trust-control-");
        try {
            var destination = directory.resolve("urlsession-ca.pem").toFile();
            var identity = directory.resolve("acceptance-ca.pem").toFile();
            int[] environment = {0};
            var setEnv = (NativeTrust.Environment) path -> {
                check(path.equals(destination.getAbsolutePath())); environment[0]++;
            };
            cases++;
            NativeTrust.install(acceptance, destination, identity, setEnv);
            check(Arrays.equals(user, Files.readAllBytes(identity.toPath())));
            check(Arrays.equals(acceptance.pem, Files.readAllBytes(destination.toPath())));
            cases++;
            NativeTrust.install(expiredResult, destination, identity, setEnv);
            check(!identity.exists()); check(Arrays.equals(normal.pem, Files.readAllBytes(destination.toPath())));
            check(environment[0] == 2); // Accepted -> expired replaces old bundle and clears old identity.
            cases++;
            NativeTrust.install(acceptance, destination, identity, setEnv);
            NativeTrust.install(normal, destination, identity, setEnv);
            check(!identity.exists()); check(Arrays.equals(normal.pem, Files.readAllBytes(destination.toPath())));
            environment[0] = 0;
            Files.createDirectory(identity.toPath()); Files.writeString(identity.toPath().resolve("occupied"), "old");
            refuses(() -> NativeTrust.install(expiredResult, destination, identity, setEnv));
            check(environment[0] == 0); // Cannot remove stale observer -> stop, never advertise CAINFO.
            Files.delete(identity.toPath().resolve("occupied")); Files.delete(identity.toPath());
            Files.writeString(destination.toPath(), "old acceptance bundle");
            refuses(() -> NativeTrust.install(normal, destination, identity, setEnv, (bytes, file) -> {}));
            check(environment[0] == 0); // Silent write/readback failure cannot reuse the old bundle.
            refuses(() -> NativeTrust.install(normal, destination, identity, setEnv, (bytes, file) -> { throw new IOException("commit failed"); }));
            check(environment[0] == 0);
            refuses(() -> NativeTrust.install(acceptance, destination, identity, setEnv, (bytes, file) -> {}));
            check(environment[0] == 0); // Identity readback failure also stops startup.
            refuses(() -> NativeTrust.install(new byte[0], destination, setEnv));
            refuses(() -> NativeTrust.install(normal, destination, identity, path -> { throw new IOException("environment failed"); }));
            cases++;
            NativeTrust.install(normal, destination, identity, setEnv);
            check(environment[0] == 1);
            check(Files.getPosixFilePermissions(destination.toPath()).equals(
                    java.nio.file.attribute.PosixFilePermissions.fromString("rw-------")));
            Files.delete(destination.toPath());
        } finally { Files.delete(directory); }
        System.out.println("{\"cases\":" + cases + ",\"assertions\":" + assertions + ",\"failed\":0}");
    }
}
