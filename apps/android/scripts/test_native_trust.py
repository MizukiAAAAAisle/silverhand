"""Execute product Java and real local TLS. Host evidence, not AndroidCAStore/WebView."""
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest
import urllib.request
from trust_test_fixtures import pki

APP = Path(__file__).resolve().parents[1]


class NativeTrust(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temporary.name)
        pki(cls.root)
        cls.output = cls.root / 'output'
        java = Path(os.environ['JAVA_HOME']) / 'bin'
        subprocess.run([java / 'javac', '-d', cls.root / 'classes',
                        APP / 'app/src/main/java/com/silverhand/android/NativeTrust.java',
                        APP / 'app/src/test/java/com/silverhand/android/NativeTrustTest.java'], check=True, timeout=30)
        result = subprocess.check_output([java / 'java', '-cp', cls.root / 'classes',
                                          'com.silverhand.android.NativeTrustTest', cls.root, cls.output], text=True, timeout=30)
        cls.report = json.loads(result)
        print('NativeTrust Java: ' + result.strip(), flush=True)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def test_product_storage_and_optional_ca_controls(self):
        self.assertEqual(self.report['failed'], 0)
        self.assertGreaterEqual(self.report['cases'], 30)

    def connect(self, authority, bundle):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200); self.end_headers(); self.wfile.write(b'fixture healthy')
            def log_message(self, *args):
                pass
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(self.root / (authority+'-server.pem'), self.root / (authority+'-server.key'))
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        server.socket = context.wrap_socket(server.socket, server_side=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            with urllib.request.urlopen(f'https://localhost:{server.server_port}/',
                    context=ssl.create_default_context(cafile=self.output / bundle), timeout=3) as response:
                self.assertEqual(response.read(), b'fixture healthy')
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=3)

    def test_roots_only_preserves_system_trusted_tls(self):
        self.connect('system', 'expired-skipped.pem')

    def test_valid_acceptance_ca_adds_only_its_test_service(self):
        self.connect('valid', 'accepted.pem')
        with self.assertRaisesRegex(urllib.error.URLError, 'CERTIFICATE_VERIFY_FAILED'):
            self.connect('valid', 'roots.pem')

    def test_expired_optional_ca_service_still_fails_tls(self):
        with self.assertRaisesRegex(urllib.error.URLError, 'CERTIFICATE_VERIFY_FAILED'):
            self.connect('expired', 'expired-skipped.pem')
        # Explicitly trusting an expired anchor must not bypass TLS date checks either.
        shutil.copy(self.root / 'expired.pem', self.output / 'expired-direct.pem')
        with self.assertRaisesRegex(urllib.error.URLError, 'certificate has expired'):
            self.connect('expired', 'expired-direct.pem')


if __name__ == '__main__':
    unittest.main()
