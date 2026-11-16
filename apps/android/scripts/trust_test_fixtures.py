"""Ephemeral local PKI with fixed date windows; never uses a user's key/store/time."""
import os
from pathlib import Path
import subprocess


def pki(directory):
    directory = Path(directory)
    openssl = os.environ['OPENSSL_BIN']
    def run(*args):
        subprocess.run([openssl, *map(str, args)], check=True, cwd=directory,
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=30)
    (directory / 'ca.ext').write_text('basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n')
    (directory / 'server.ext').write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n')
    for name, start, end in [('system', '20200101000000Z', '20400101000000Z'),
                             ('valid', '20200101000000Z', '20400101000000Z'),
                             ('expired', '20200101000000Z', '20210101000000Z'),
                             ('future', '20350101000000Z', '20400101000000Z')]:
        run('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', name+'.key', '-out', name+'.csr', '-subj', '/CN=Host Fixture '+name)
        run('x509', '-req', '-in', name+'.csr', '-signkey', name+'.key', '-out', name+'.pem',
            '-not_before', start, '-not_after', end, '-extfile', 'ca.ext')
        run('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', name+'-server.key', '-out', name+'-server.csr', '-subj', '/CN=localhost')
        run('x509', '-req', '-in', name+'-server.csr', '-CA', name+'.pem', '-CAkey', name+'.key', '-CAcreateserial',
            '-out', name+'-server.pem', '-not_before', '20200101000000Z', '-not_after', '20400101000000Z', '-extfile', 'server.ext')
    for key in directory.glob('*.key'):
        key.chmod(0o600)
