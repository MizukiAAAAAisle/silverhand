import os
from datetime import datetime, timezone
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from acceptance_certificates import certificate_window, validate_certificates, MIN_REMAINING_SECONDS, ISSUANCE_DAYS
from trust_test_fixtures import pki


class CertificateWindows(unittest.TestCase):
    now = int(datetime(2026, 11, 16, tzinfo=timezone.utc).timestamp())

    def window(self, start, end):
        def date(epoch):
            return datetime.fromtimestamp(epoch, timezone.utc).strftime('%b %d %H:%M:%S %Y GMT')
        return f'notBefore={date(start)}\nnotAfter={date(end)}'

    def test_seven_day_boundary(self):
        for seconds in [MIN_REMAINING_SECONDS, MIN_REMAINING_SECONDS + 1, ISSUANCE_DAYS * 86400]:
            self.assertEqual(certificate_window(self.window(self.now, self.now + seconds), self.now)['remaining_seconds'], seconds)
        for seconds in [-1, 0, MIN_REMAINING_SECONDS - 1, 2 * 86400]:
            with self.assertRaises(ValueError):
                certificate_window(self.window(self.now - 86400, self.now + seconds), self.now)

    def test_not_yet_valid_and_malformed_refuse(self):
        with self.assertRaisesRegex(ValueError, 'not currently valid'):
            certificate_window(self.window(self.now + 1, self.now + 30 * 86400), self.now)
        with self.assertRaises((ValueError, KeyError)):
            certificate_window('invalid', self.now)


class ActualCertificates(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(); cls.root = Path(cls.temporary.name)
        pki(cls.root)
        cls.openssl = os.environ['OPENSSL_BIN']
        cls.chain = cls.root / 'chain'; cls.chain.mkdir()

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def chain_for(self, name):
        for source, target in [(name+'.pem', 'ca.pem'), (name+'-server.pem', 'server.pem'), (name+'-server.key', 'server.key')]:
            shutil.copy(self.root / source, self.chain / target)

    def test_valid_chain_and_real_openssl_current_dates(self):
        self.chain_for('valid')
        report = validate_certificates(self.chain, self.openssl)
        self.assertGreater(report['ca.pem']['remaining_seconds'], MIN_REMAINING_SECONDS)

    def test_expired_and_future_refused(self):
        for name in ['expired', 'future']:
            self.chain_for(name)
            with self.assertRaisesRegex(ValueError, 'not currently valid'):
                validate_certificates(self.chain, self.openssl)

    def test_chain_purpose_hostname_and_key_still_required(self):
        self.chain_for('valid')
        shutil.copy(self.root / 'system.pem', self.chain / 'ca.pem')
        with self.assertRaises(subprocess.CalledProcessError):
            validate_certificates(self.chain, self.openssl)
        self.chain_for('valid')
        shutil.copy(self.root / 'system-server.key', self.chain / 'server.key')
        with self.assertRaisesRegex(ValueError, 'key mismatch'):
            validate_certificates(self.chain, self.openssl)
        self.chain_for('valid')
        shutil.copy(self.root / 'valid.pem', self.chain / 'server.pem')
        with self.assertRaises(subprocess.CalledProcessError):
            validate_certificates(self.chain, self.openssl)

    def test_actual_prepare_issues_and_reuses_thirty_day_certificates_before_services(self):
        run = self.root / 'issued-run'
        command = [os.environ.get('PYTHON', 'python3'), str(Path(__file__).with_name('prepare-acceptance.py'))]
        env = {**os.environ, 'SILVERHAND_ANDROID_RUN_ROOT': str(run),
               'SILVERHAND_ACCEPTANCE_BACKEND': str(self.root / 'deliberately-missing-backend')}
        before = None
        for flag in ['--renew-ca', '--existing-ca']:
            result = subprocess.run([*command, flag], env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 1)
            self.assertIn('Acceptance certificate validity:', result.stdout)
            self.assertIn('Missing freshly built acceptance backend:', result.stderr)
            certs = run / 'acceptance/certs'
            report = validate_certificates(certs, self.openssl)
            for name in ['ca.pem', 'server.pem']:
                self.assertGreaterEqual(report[name]['remaining_seconds'], 29 * 86400)
                self.assertLessEqual(report[name]['remaining_seconds'], 30 * 86400)
            current = {name: (certs/name).read_bytes() for name in ['ca.pem', 'server.pem', 'server.key']}
            if before is not None:
                self.assertEqual(before, current)
            before = current
            self.assertFalse((run/'acceptance/backend.pid').exists())
            self.assertFalse((run/'app-build/acceptance-assets').exists())

    def test_thirty_day_issuance_and_two_day_failure(self):
        self.chain_for('valid')
        for days in [30, 2]:
            for name, args in [('ca.pem', ['-signkey', 'valid.key', '-extfile', 'ca.ext']),
                               ('server.pem', ['-CA', str(self.chain/'ca.pem'), '-CAkey', 'valid.key', '-extfile', 'server.ext'])]:
                csr = 'valid.csr' if name == 'ca.pem' else 'valid-server.csr'
                subprocess.run([self.openssl, 'x509', '-req', '-in', csr, *args, '-days', str(days), '-out', str(self.chain/name)],
                               cwd=self.root, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            if days == 30:
                report = validate_certificates(self.chain, self.openssl)
                self.assertGreater(report['server.pem']['remaining_seconds'], 29 * 86400)
            else:
                with self.assertRaisesRegex(ValueError, '604800'):
                    validate_certificates(self.chain, self.openssl)
            # The actual existing-ca entry must reject before it looks for a backend or launches services.
            if days == 2:
                run = self.root / 'run'; certs = run / 'acceptance/certs'; certs.mkdir(parents=True)
                for file in self.chain.iterdir():
                    shutil.copy(file, certs / file.name)
                result = subprocess.run([os.environ.get('PYTHON', 'python3'), str(Path(__file__).with_name('prepare-acceptance.py')), '--existing-ca'],
                                        env={**os.environ, 'SILVERHAND_ANDROID_RUN_ROOT': str(run)}, capture_output=True, text=True, timeout=10)
                self.assertNotEqual(result.returncode, 0); self.assertIn('604800', result.stderr)
                self.assertFalse((run/'acceptance/backend.pid').exists())
                self.assertFalse((run/'app-build/acceptance-assets').exists())


if __name__ == '__main__':
    unittest.main()
