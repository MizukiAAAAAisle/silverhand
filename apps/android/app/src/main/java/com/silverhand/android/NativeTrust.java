package com.silverhand.android;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.cert.CertificateFactory;
import java.security.cert.CertificateException;
import java.security.cert.CertificateExpiredException;
import java.security.cert.CertificateNotYetValidException;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Arrays;

/** The PEM supplied to FoundationNetworking/libcurl, not WebView's trust policy. */
final class NativeTrust {
    interface Environment { void set(String caInfoPath) throws Exception; }
    interface Commit { void write(byte[] bytes, File destination) throws Exception; }
    interface Asset { InputStream open() throws IOException; }

    static final class Bundle {
        final byte[] pem;
        final byte[] acceptanceCa;
        final String status;

        Bundle(byte[] pem, byte[] acceptanceCa, String status) {
            this.pem = pem;
            this.acceptanceCa = acceptanceCa;
            this.status = status;
        }
    }

    static void install(Bundle bundle, File destination, File identity, Environment environment) throws Exception {
        install(bundle, destination, identity, environment, NativeTrust::commit);
    }

    static void install(Bundle bundle, File destination, File identity, Environment environment, Commit commit) throws Exception {
        // This observer file is not a second trust source. Remove the previous
        // identity even when the new optional asset cannot be accepted.
        Files.deleteIfExists(identity.toPath());
        if (bundle.acceptanceCa != null) {
            install(bundle.acceptanceCa, identity, ignored -> {}, commit);
        }
        install(bundle.pem, destination, environment, commit);
    }

    static void install(byte[] bytes, File destination, Environment environment) throws Exception {
        install(bytes, destination, environment, NativeTrust::commit);
    }

    // A commit seam permits failure injection while exercising the actual
    // readback/environment gate. Production always uses the fsync/rename below.
    static void install(byte[] bytes, File destination, Environment environment, Commit commit) throws Exception {
        if (bytes.length == 0) throw new IllegalArgumentException("Native trust bundle is empty");
        commit.write(bytes, destination);
        if (!Arrays.equals(bytes, Files.readAllBytes(destination.toPath()))) {
            throw new IllegalStateException("Native trust bundle commit did not match");
        }
        Files.setPosixFilePermissions(destination.toPath(), PosixFilePermissions.fromString("rw-------"));
        environment.set(destination.getAbsolutePath());
    }

    private static void commit(byte[] bytes, File destination) throws Exception {
        var path = destination.toPath();
        var temporary = Files.createTempFile(path.getParent(), ".native-trust-", ".pem",
                PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
        try {
            try (var output = new FileOutputStream(temporary.toFile())) {
                output.write(bytes);
                output.getFD().sync();
            }
            // Unlike AtomicFile.finishWrite, failures are reported to the caller.
            Files.move(temporary, path, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    static Bundle bundle(KeyStore store, boolean acceptance, Asset acceptanceCa) throws Exception {
        if (acceptance != (acceptanceCa != null)) {
            throw new IllegalArgumentException("Acceptance CA does not match build configuration");
        }
        var certificates = new LinkedHashMap<String, byte[]>();
        var aliases = new ArrayList<String>();
        var names = store.aliases();
        while (names.hasMoreElements()) aliases.add(names.nextElement());
        Collections.sort(aliases);
        for (String alias : aliases) {
            var certificate = store.getCertificate(alias);
            if (!(certificate instanceof X509Certificate x509)) {
                throw new IllegalStateException("Trust store entry is not an X509 certificate");
            }
            add(certificates, x509);
        }
        // An acceptance fixture must never hide a missing native trust store.
        if (certificates.isEmpty()) throw new IllegalStateException("Native trust store is empty");
        byte[] accepted = null;
        String status = "disabled";
        if (acceptance) {
            byte[] candidate = null;
            X509Certificate ca = null;
            // Only the optional asset's I/O and certificate validation degrade.
            // System-store access and bundle/storage failures remain fatal.
            try {
                try (InputStream input = acceptanceCa.open(); var bytes = new ByteArrayOutputStream()) {
                    byte[] buffer = new byte[4096];
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        if (bytes.size() + count > 65536) throw new CertificateException("Oversize CA");
                        bytes.write(buffer, 0, count);
                    }
                    candidate = bytes.toByteArray();
                }
                String text = new String(candidate, StandardCharsets.US_ASCII);
                if (!text.matches("(?s)\\s*-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\\r\\n]+-----END CERTIFICATE-----\\s*")) {
                    throw new CertificateException("Expected exactly one PEM certificate");
                }
                ca = (X509Certificate) CertificateFactory.getInstance("X.509")
                        .generateCertificate(new ByteArrayInputStream(candidate));
                boolean[] usage = ca.getKeyUsage();
                if (ca.getBasicConstraints() < 0 || (usage != null && (usage.length <= 5 || !usage[5]))) {
                    status = "skipped-not-ca";
                    ca = null;
                } else {
                    ca.checkValidity();
                    status = "accepted";
                }
            } catch (CertificateExpiredException error) {
                status = "skipped-expired";
                ca = null;
            } catch (CertificateNotYetValidException error) {
                status = "skipped-not-yet-valid";
                ca = null;
            } catch (CertificateException error) {
                status = "skipped-malformed";
                ca = null;
            } catch (IOException | SecurityException error) {
                status = "skipped-unreadable";
                ca = null;
            }
            if (ca != null) {
                add(certificates, ca);
                accepted = candidate;
            }
        }
        var pem = new StringBuilder();
        var encoder = Base64.getMimeEncoder(64, new byte[] {'\n'});
        for (byte[] der : certificates.values()) {
            pem.append("-----BEGIN CERTIFICATE-----\n")
                    .append(encoder.encodeToString(der))
                    .append("\n-----END CERTIFICATE-----\n");
        }
        return new Bundle(pem.toString().getBytes(StandardCharsets.US_ASCII), accepted, status);
    }

    private static void add(LinkedHashMap<String, byte[]> certificates, X509Certificate certificate) throws Exception {
        byte[] der = certificate.getEncoded();
        // Validate the exact bytes that curl will consume. Do not filter legacy
        // anchors by date here: TLS validates the chain actually selected.
        CertificateFactory.getInstance("X.509").generateCertificate(new ByteArrayInputStream(der));
        String key = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(der));
        certificates.putIfAbsent(key, der);
    }
}
