#!/usr/bin/env python3
"""Test the exact Console ingress snippets against an isolated Rust process.

Requires Python 3, nginx and openssl. No production paths, root privileges,
certificate installation or existing service changes. All processes/stores are
owned by this run; artifacts remain in the printed temporary directory.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import ssl
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


def free_port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


def request(url, token=None, context=None):
    headers = {} if token is None else {'Authorization': f'Bearer {token}'}
    try:
        response = urllib.request.urlopen(urllib.request.Request(url, headers=headers), context=context, timeout=10)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, {k.lower(): v for k, v in response.headers.items()}, response.read()


def wait_ready(process, url):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError('isolated process exited before readiness')
        try:
            if request(url)[0] == 200:
                return
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(0.05)
    raise RuntimeError('isolated process readiness deadline')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', required=True, type=Path)
    parser.add_argument('--nginx', default=shutil.which('nginx'))
    args = parser.parse_args()
    if not args.nginx or not shutil.which('openssl'):
        parser.error('nginx and openssl must be installed')
    binary = args.binary.resolve(strict=True)
    repo = Path(__file__).resolve().parent.parent
    root = Path(tempfile.mkdtemp(prefix='silverhand-console-https-'))
    print(f'Isolated artifacts: {root}', flush=True)
    ports = set()
    while len(ports) < 3:
        ports.add(free_port())
    api, metrics, tls = sorted(ports)
    token = secrets.token_urlsafe(36)
    processes = []
    outputs = []

    try:
        (root / 'tmp').mkdir()
        env = {
            'PATH': os.environ.get('PATH', ''),
            'TMPDIR': str(root / 'tmp'),
            'SILVERHAND_DIR': str(root / 'silverhand'),
            'SILVERHAND_DEPLOYMENT_PROFILE': 'remote-only',
            'SILVERHAND_DATABASE_PATH': str(root / 'data' / 'test.sqlite'),
            'SILVERHAND_BLOBS_ROOT': str(root / 'blobs'),
            'SILVERHAND_LOG_DIR': str(root / 'app-logs'),
            'SILVERHAND_LISTEN_ADDR': f'127.0.0.1:{api}',
            'SILVERHAND_ALLOWED_ORIGINS': f'https://127.0.0.1:{tls}',
            'SILVERHAND_METRICS_LISTEN': f'127.0.0.1:{metrics}',
            'SILVERHAND_CONSOLE_TOKEN': token,
            'RUST_LOG': 'error',
        }
        app_output = open(root / 'app.stderr', 'wb')
        outputs.append(app_output)
        app = subprocess.Popen([str(binary)], env=env, stdout=app_output, stderr=app_output)
        processes.append(app)
        wait_ready(app, f'http://127.0.0.1:{api}/readyz')

        cert, key = root / 'cert.pem', root / 'key.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                        '-subj', '/CN=console.test', '-addext', 'subjectAltName=IP:127.0.0.1',
                        '-keyout', str(key), '-out', str(cert)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        key.chmod(0o600)
        http = (repo / 'ops/deployment/silverhand-console-http.conf').read_text().replace('127.0.0.1:8080', f'127.0.0.1:{api}')
        routes = (repo / 'ops/deployment/silverhand-console-routes.conf').read_text().replace('/var/log/nginx/silverhand-console.access.log', str(root / 'console-access.log'))
        (root / 'http.conf').write_text(http)
        (root / 'routes.conf').write_text(routes)
        config = root / 'nginx.conf'
        config.write_text(f'''daemon off;
master_process off;
pid "{root}/nginx.pid";
error_log "{root}/nginx-error.log" warn;
events {{ worker_connections 64; }}
http {{
    access_log off;
    include "{root}/http.conf";
    server {{
        listen 127.0.0.1:{tls} ssl;
        server_name console.test;
        ssl_certificate "{cert}";
        ssl_certificate_key "{key}";
        ssl_protocols TLSv1.2 TLSv1.3;
        include "{root}/routes.conf";
        location / {{ return 404; }}
    }}
}}
''')
        command = [args.nginx, '-p', str(root), '-c', str(config)]
        subprocess.run(command + ['-t'], check=True, capture_output=True)
        nginx_output = open(root / 'nginx.stderr', 'wb')
        outputs.append(nginx_output)
        edge = subprocess.Popen(command, stdout=nginx_output, stderr=nginx_output)
        processes.append(edge)
        context = ssl.create_default_context(cafile=str(cert))
        base = f'https://127.0.0.1:{tls}'
        deadline = time.monotonic() + 10
        while True:
            try:
                status, headers, html = request(base + '/console', context=context)
                break
            except urllib.error.URLError:
                if edge.poll() is not None or time.monotonic() >= deadline:
                    raise
                time.sleep(0.05)
        assert status == 200 and b'Silverhand Console' in html
        assert token.encode() not in html
        assert 'no-store' in headers['cache-control']
        assert headers['x-frame-options'] == 'DENY'
        assert 'content-security-policy' in headers
        assert request(base + '/console/', context=context)[0] == 200

        for path in ['/console/api/overview', '/console/api/users', '/console/api/users/unknown']:
            for offered in [None, 'wrong-bearer-canary']:
                code, headers, body = request(base + path, offered, context)
                assert code == 401 and body == b''
                assert 'no-store' in headers['cache-control']
                assert 'Bearer' in headers['www-authenticate']
        assert request(base + '/console/api/overview?token=query-canary', context=context)[0] == 401
        for path in ['/console/api/overview', '/console/api/users?days=30&page=1&q=test']:
            code, headers, body = request(base + path, token, context)
            assert code == 200 and 'no-store' in headers['cache-control']
            json.loads(body)
        assert request(base + '/console/api/users/unknown?days=7', token, context)[0] == 404
        assert request(base + '/console/api/users?days=365', token, context)[0] == 400
        for path in ['/metrics', '/metrics/anything']:
            assert request(base + path, token, context)[0] == 403
        assert request(base + '/console/api/../metrics', token, context)[0] != 200
        assert request(f'http://127.0.0.1:{api}/metrics', token)[0] == 403
        code, _, scrape = request(f'http://127.0.0.1:{metrics}/metrics')
        assert code == 200
        for result in ['accepted', 'rejected']:
            assert any(
                line.startswith(b'silverhand_console_auth_requests_total{')
                and f'result="{result}"'.encode() in line
                and float(line.rsplit(b' ', 1)[1]) > 0
                for line in scrape.splitlines()
            )
        assert request(f'http://127.0.0.1:{metrics}/console', token)[0] == 404

        deadline = time.monotonic() + 5
        while True:
            audit = ''.join(path.read_text() for path in (root / 'app-logs').glob('*.log*'))
            if 'operator_console_access' in audit:
                break
            assert time.monotonic() < deadline, 'missing rejection audit at ERROR floor'
            time.sleep(0.05)
        all_logs = audit + ''.join(
            (root / name).read_text()
            for name in ['console-access.log', 'nginx-error.log', 'app.stderr', 'nginx.stderr']
        )
        for secret in [token, 'wrong-bearer-canary', 'query-canary']:
            assert secret not in all_logs, 'credential appeared in logs'
        print('PASS: verified TLS, shell/redirect, all API bearer gates, forwarding/query preservation, no-store, metrics isolation, rejection audit and credential-free logs.', flush=True)
    finally:
        for process in reversed(processes):
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    # Only this script's disposable child, never an existing service.
                    process.kill()
                    process.wait()
        for output in outputs:
            output.close()


if __name__ == '__main__':
    main()
