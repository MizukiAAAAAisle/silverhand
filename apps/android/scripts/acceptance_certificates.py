"""One validity policy for newly issued, reused and packaged acceptance certificates."""
from datetime import datetime, timezone
from pathlib import Path
import subprocess
import time

ISSUANCE_DAYS = 30
MIN_REMAINING_SECONDS = 7 * 24 * 60 * 60


def certificate_window(text, now):
    fields = dict(line.split('=', 1) for line in text.splitlines() if '=' in line)
    dates = {key: int(datetime.strptime(fields[key], '%b %d %H:%M:%S %Y GMT')
                      .replace(tzinfo=timezone.utc).timestamp()) for key in ['notBefore', 'notAfter']}
    remaining = dates['notAfter'] - now
    report = {**dates, 'remaining_seconds': remaining,
              'not_after_utc': datetime.fromtimestamp(dates['notAfter'], timezone.utc).isoformat()}
    if dates['notBefore'] > now or dates['notAfter'] <= now:
        raise ValueError(f'Certificate not currently valid: {report}')
    if remaining < MIN_REMAINING_SECONDS:
        raise ValueError(f'Certificate needs >= {MIN_REMAINING_SECONDS} seconds remaining: {report}')
    return report


def validate_certificates(directory, openssl, *, now=None, output=None):
    directory = Path(directory)
    if not Path(openssl).is_absolute():
        raise ValueError('OPENSSL_BIN must be an explicit absolute path')
    if output is None:
        def output(command):
            return subprocess.check_output(list(map(str, command)), text=True,
                                           stderr=subprocess.STDOUT, timeout=30).strip()
    now = int(time.time()) if now is None else int(now)
    report = {'checked_at_epoch': now, 'minimum_remaining_seconds': MIN_REMAINING_SECONDS}
    for name in ['ca.pem', 'server.pem']:
        dates = output([openssl, 'x509', '-in', directory / name, '-noout', '-startdate', '-enddate'])
        try:
            report[name] = certificate_window(dates, now)
        except (ValueError, KeyError) as error:
            raise ValueError(f'{directory / name}: {error}') from error
    # Verify CA constraints, server purpose, dates and localhost name together.
    output([openssl, 'verify', '-attime', str(now), '-purpose', 'sslserver', '-CAfile', directory / 'ca.pem',
            '-verify_hostname', 'localhost', directory / 'server.pem'])
    certificate_key = output([openssl, 'x509', '-in', directory / 'server.pem', '-pubkey', '-noout'])
    private_key = output([openssl, 'pkey', '-in', directory / 'server.key', '-pubout'])
    if certificate_key.strip() != private_key.strip():
        raise ValueError('Acceptance server certificate/private key mismatch')
    return report
