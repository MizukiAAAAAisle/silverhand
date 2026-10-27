"""Finite f7 installation/controller preconditions; no fixture or business runner."""
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import ssl
import subprocess
import time

PRODUCT = 'f7a69c503ccedaf012a98425cbd82f07a0e35e6dbc11a98148f1636738c41672'
TEST = '9fabca8bb86f01abed4bc7ba37aee9478547e75f5e2fa65e031daa1150e4226e'
PKG = 'com.silverhand.android.stage1'

# Closed consumer mapping,not marker/file names supplied by a binding.
EVIDENCE_UNITS = {
    'task-read': ('PRE.T1.fixture-login', 't1-new-origin-native-tls-complete', 't1-tls-events.jsonl'),
    'task-write': ('PRE.T2.fixture-login', 't2-new-origin-native-tls-complete', 't2-tls-events.jsonl'),
}

def expected_packages(origin, unit='task-read'):
    assert unit in EVIDENCE_UNITS, 'Unknown origin evidence unit'
    if unit == 'task-read':
        assert origin['kind'] == 'fixed-f7-ca-asset-origin-v1', 'T1 origin kind differs'
        expected = PRODUCT, TEST
    else:
        # No historical f7 default: a future reviewed binding supplies both identities.
        assert origin.get('kind') in {'t2-renewed-ca-asset-origin-v1', 'source-built-acceptance-origin-v1'}, 'T2 origin kind differs'
        product, test = origin['frozen_product'], origin['test']
        assert Path(product['path']).is_absolute() and Path(test['path']).is_absolute(), 'Origin package paths must be absolute'
        assert all(re.fullmatch(r'[0-9a-f]{64}', value) for value in [product['sha256'],test['sha256'],origin['ca_sha256'],origin['server_certificate_der_sha256']]), 'Incomplete new origin identity'
        assert product['sha256'] != PRODUCT, 'T2 requires the new product identity,not historical f7'
        if origin['kind'] == 'source-built-acceptance-origin-v1':
            validate_source_build(origin)
        expected = product['sha256'], test['sha256']
    return expected


def validate_source_build(origin):
    """Bind the original build, independently of later acceptance-driver inputs."""
    reference = origin.get('source_build_binding')
    assert isinstance(reference, dict), 'Source build binding required'
    path = Path(reference['path'])
    assert path.is_absolute() and path.is_file() and not path.is_symlink(), 'Source build binding file differs'
    assert re.fullmatch(r'[0-9a-f]{64}', reference['sha256']) and hashlib.sha256(path.read_bytes()).hexdigest() == reference['sha256'], 'Source build binding digest differs'
    build = json.loads(path.read_text())
    inputs, actual = build['inputs'], build['actual_apk']
    assert inputs['repository'] and all(re.fullmatch(r'[0-9a-f]{64}', value) for value in inputs['repository'].values()) and re.fullmatch(r'[0-9a-f]{64}', inputs['environment_config']), 'Source build inputs incomplete'
    assert origin.get('CA_asset_only_derivation') is False, 'Source build cannot be CA-only'
    for name, item in [('product', origin['frozen_product']), ('test', origin['test'])]:
        original = build['packages'][name]
        assert Path(original['path']).is_absolute() and original['sha256'] == item['sha256'], 'Source build package identity differs'
        assert hashlib.sha256(Path(original['path']).read_bytes()).hexdigest() == item['sha256'], 'Source build package bytes differ'
    assert actual['apk'] == build['packages']['product']['path'] and actual['apk_sha256'] == origin['frozen_product']['sha256'] and actual['actual_APK_inputs_match'] is True, 'Source build APK evidence differs'
    assert actual['packaged_input_hashes'] and all(re.fullmatch(r'[0-9a-f]{64}', value) for value in actual['packaged_input_hashes'].values()), 'Source build payload evidence incomplete'
    assert re.fullmatch(r'[0-9a-f]{64}', actual['core_manifest_sha256']) and hashlib.sha256((path.parent / 'core-build/manifest.json').read_bytes()).hexdigest() == actual['core_manifest_sha256'], 'Source build core manifest differs'
    assert actual['ca_sha256'] == origin['ca_sha256'], 'Source build CA identity differs'
    certs = path.parent / 'acceptance/certs'
    assert hashlib.sha256((certs / 'ca.pem').read_bytes()).hexdigest() == origin['ca_sha256'], 'Source build CA bytes differ'
    der = ssl.PEM_cert_to_DER_cert((certs / 'server.pem').read_text())
    assert hashlib.sha256(der).hexdigest() == origin['server_certificate_der_sha256'], 'Source build server DER differs'


def instrumentation_terminal(text, returncode, natural_exit):
    """Frozen instrumentation result contract;not an ADB exit-only verdict."""
    assert len(text.encode()) <= 131072, 'Controller protocol bytes exceeded'
    codes = re.findall(r'^INSTRUMENTATION_CODE: (-?\d+)\r?$', text, re.MULTILINE)
    assert codes == ['-1'], 'Controller instrumentation result differs'
    assert 'B1_DEVICE_CONTROL_COMPLETED' in text and 'B1_DEVICE_CONTROL_FAILED' not in text, 'Controller completion text differs'
    assert natural_exit is True and returncode == 0, 'Controller natural exit differs'
    return {'kind': 'frozen-instrumentation-terminal-v1', 'instrumentation_code': -1,
            'completed': True, 'failed_text': False, 'natural_exit': True, 'returncode': 0}


def installed_identity(adb, package, expected):
    paths = adb('shell', 'pm', 'path', package).splitlines()
    assert len(paths) == 1 and paths[0].startswith('package:'), 'Ambiguous installed APK'
    path = paths[0].removeprefix('package:')
    assert re.fullmatch(r'/data/app/[A-Za-z0-9_./=+~\-]+/base\.apk', path), 'Unexpected installed APK path'
    value = adb('shell', 'sha256sum', path)
    assert value.split() == [expected, path], 'Installed APK digest differs'
    return {'package': package, 'installed_path': path, 'sha256sum_output': value,
            'expected_sha256': expected, 'status': 'passed'}


def controller(w, out):
    """One owned JVM controller session: identity, stop, wait; failures block PRE."""
    command = [str(Path(w.ENV['ANDROID_HOME']) / 'platform-tools/adb'), '-s',
               w.ENV['ANDROID_SERIAL'], 'shell', 'am', 'instrument', '-w', '-r',
               PKG + '.test/com.silverhand.android.B1Instrumentation']
    log_path = out / 'origin-controller.log'
    record = {'command': command, 'status': 'running', 'first_error': None, 'natural_exit': False,
              'cleanup_errors': [], 'requests': [], 'outside_group_descendants': 'unattributed'}
    child = None
    first = None
    started = time.monotonic()
    def control(operation):
        request = {'id': 'f7-precondition-' + operation, 'operation': operation}
        args = command[:3] + ['shell',
            "run-as " + PKG + " sh -c 'cat > files/b1-request.tmp && mv files/b1-request.tmp files/b1-request.json'"]
        sent = {'request': request, 'response': None}
        record['requests'].append(sent)
        sent['sent_at'] = time.time()
        response = subprocess.run(args, input=json.dumps(request), text=True, capture_output=True,
                                  env=w.ENV, cwd=w.REPO, timeout=10, check=False)
        sent['write_exit'] = response.returncode
        sent['write_stdout'] = response.stdout
        sent['write_stderr'] = response.stderr
        sent['write_completed_at'] = time.time()
        assert response.returncode == 0, 'Controller request write failed'
        if operation == 'stop':
            # Frozen controller deletes response.json in finally immediately
            # after publishing stop. Never poll that transient file.
            sent['response_read'] = False
            sent['completion_contract'] = 'same instrumentation terminal log and natural exit'
            return None
        deadline = time.monotonic() + 25
        last = None
        for _ in range(250):
            try:
                value = json.loads(w.adb('exec-out', 'run-as', PKG, 'cat', 'files/b1-response.json'))
            except (subprocess.CalledProcessError, json.JSONDecodeError) as error:
                last = str(error)
            else:
                if value.get('id') == request['id']:
                    sent['response'] = value
                    sent['returned_at'] = time.time()
                    assert value.get('ok') is True, 'Controller response rejected'
                    return value['result']
            if time.monotonic() >= deadline:
                break
            time.sleep(.1)
        sent['last_read_error'] = last
        raise AssertionError('Controller response deadline: ' + operation)
    try:
        with log_path.open('x') as log:
            child = subprocess.Popen(command, cwd=w.REPO, env=w.ENV, stdin=subprocess.DEVNULL,
                                     stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            record['pid'] = child.pid
            deadline = time.monotonic() + 60
            for _ in range(600):
                text = log_path.read_text()
                assert len(text.encode()) <= 131072, 'Controller protocol bytes exceeded'
                if 'B1_DEVICE_CONTROL_READY' in text:
                    record['ready'] = True
                    break
                assert child.poll() is None, 'Controller exited before ready'
                if time.monotonic() >= deadline:
                    raise AssertionError('Controller ready deadline')
                time.sleep(.1)
            else:
                raise AssertionError('Controller ready reads exceeded')
            identity = control('identity')
            assert all(isinstance(identity.get(k), int) and not isinstance(identity[k], bool)
                       and identity[k] > 0 for k in ['pid', 'activity', 'webViewIdentity']), 'Controller identity missing'
            assert w.adb('shell', 'pidof', PKG).split() == [str(identity['pid'])], 'Controller target PID differs'
            record['identity'] = identity
            control('stop')
            record['raw_returncode'] = child.wait(timeout=15)
            record['natural_returncode'] = record['raw_returncode']
            record['natural_exit'] = True
            text = log_path.read_text()
            record['terminal'] = instrumentation_terminal(text, record['natural_returncode'], record['natural_exit'])
            record['status'] = 'passed'
    except BaseException as error:
        first = error
        record['first_error'] = {'type': type(error).__name__, 'message': str(error)}
        record['status'] = 'failed'
    finally:
        if child is not None:
            try:
                if child.poll() is None:
                    assert os.getpgid(child.pid) == child.pid, 'Controller group ownership changed'
                    os.killpg(child.pid, signal.SIGTERM)
                    record['term_sent'] = True
                    try:
                        child.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        record['kill_sent'] = True
                        child.wait(timeout=5)
                record['wait_finished'] = True
                record['raw_returncode'] = child.returncode
            except BaseException as error:
                record['cleanup_errors'].append({'type': type(error).__name__, 'message': str(error)})
                record['status'] = 'failed'
        record['seconds_including_cleanup'] = time.monotonic() - started
        record['log'] = str(log_path)
        if log_path.exists():
            record['log_sha256'] = hashlib.sha256(log_path.read_bytes()).hexdigest()
        exit_record = {'command': command, 'pid': record.get('pid'),
                       'natural_exit': record['natural_exit'],
                       'natural_returncode': record.get('natural_returncode'),
                       'final_returncode': record.get('raw_returncode'),
                       'wait_finished': record.get('wait_finished', False),
                       'term_sent': record.get('term_sent', False), 'kill_sent': record.get('kill_sent', False),
                       'cleanup_errors': record['cleanup_errors']}
        w.write(out / 'origin-controller-exit.json', exit_record)
        record['exit_record'] = {'path': str(out / 'origin-controller-exit.json'),
                                'sha256': hashlib.sha256((out / 'origin-controller-exit.json').read_bytes()).hexdigest()}
        w.write(out / 'origin-controller.json', record)
    if first is not None:
        raise first
    assert not record['cleanup_errors'] and record['status'] == 'passed', 'Controller cleanup failed'
    return record


def device_preconditions(w, out, origin, unit='task-read'):
    product_sha, test_sha = expected_packages(origin, unit)
    record = {'kind': 'fixed-f7-device-preconditions-v1', 'status': 'running',
              'first_error': None, 'phase': 'installed-product'}
    try:
        record['product'] = installed_identity(w.adb, PKG, product_sha)
        record['phase'] = 'installed-test'
        record['test'] = installed_identity(w.adb, PKG + '.test', test_sha)
        record['phase'] = 'controller-identity-stop'
        record['controller'] = controller(w, out)
        # Instrumentation finish can end the target process; launch the ordinary
        # activity once before observing its new public CA copy and logging in.
        record['phase'] = 'ordinary-activity'
        record['launch_output'] = w.adb('shell', 'am', 'start', '-n', PKG + '/com.silverhand.android.MainActivity')
        w.wait_for_webview(out)
        record['phase'] = 'installed-public-CA'
        value = w.adb('exec-out', 'run-as', PKG, 'sha256sum', 'files/acceptance-ca.pem')
        assert value.split() == [origin['ca_sha256'], 'files/acceptance-ca.pem'], 'Installed CA bytes differ'
        record['public_CA'] = {'sha256sum_output': value, 'expected_sha256': origin['ca_sha256'],
                               'claim': 'public bytes on disk only;not TLS trust by itself'}
        record['status'] = 'passed'
    except BaseException as error:
        record['status'] = 'failed'
        record['first_error'] = {'type': type(error).__name__, 'message': str(error)}
        raise
    finally:
        w.write(out / 'origin-device-preconditions.json', record)


def validate_evidence(out, origin, raw, unit='task-read'):
    """Consume original attempt records,not merely completion marker presence."""
    product_sha, test_sha = expected_packages(origin, unit)
    _, marker_name, tls_name = EVIDENCE_UNITS[unit]
    device = json.loads((out / 'origin-device-preconditions.json').read_text())
    assert device == raw.get('new_origin_device_preconditions') and device['status'] == 'passed', 'Device evidence differs'
    for key, expected in [('product', product_sha), ('test', test_sha)]:
        item = device[key]
        assert item['status'] == 'passed' and item['expected_sha256'] == expected and \
            item['sha256sum_output'].split() == [expected, item['installed_path']], 'Installed identity evidence differs'
    control = json.loads((out / 'origin-controller.json').read_text())
    assert control == device['controller'] and control['status'] == 'passed' and control['ready'] is True and \
        control['wait_finished'] is True and control['raw_returncode'] == 0 and control['first_error'] is None and \
        control['cleanup_errors'] == [], 'Controller completion evidence differs'
    requests = control['requests']
    assert len(requests) == 2 and [r['request']['operation'] for r in requests] == ['identity','stop'], 'Controller original request sequence differs'
    identity, stop = requests
    assert identity['response']['ok'] is True and identity['response']['id'] == identity['request']['id'] and \
        identity['response']['result'] == control['identity'], 'Controller original identity differs'
    assert stop['write_exit'] == 0 and stop['response'] is None and stop['response_read'] is False, 'Controller original stop write differs'
    assert control['log'] == str(out / 'origin-controller.log') and \
        hashlib.sha256((out / 'origin-controller.log').read_bytes()).hexdigest() == control['log_sha256'], 'Controller original log differs'
    exit_path = out / 'origin-controller-exit.json'
    assert control['exit_record'] == {'path': str(exit_path), 'sha256': hashlib.sha256(exit_path.read_bytes()).hexdigest()}, 'Controller original exit file differs'
    exited = json.loads(exit_path.read_text())
    assert exited['pid'] == control['pid'] and exited['command'] == control['command'] and exited['wait_finished'] is True and \
        exited['final_returncode'] == 0 and not exited['term_sent'] and not exited['kill_sent'] and exited['cleanup_errors'] == [], 'Controller original exit differs'
    terminal = instrumentation_terminal((out / 'origin-controller.log').read_text(), exited['natural_returncode'], exited['natural_exit'])
    assert terminal == control['terminal'], 'Controller original terminal differs'
    assert device['public_CA']['expected_sha256'] == origin['ca_sha256'] and \
        device['public_CA']['sha256sum_output'].split() == [origin['ca_sha256'], 'files/acceptance-ca.pem'], 'CA disk evidence differs'
    # Only use the non-secret ID;never place the private fixture payload in logs.
    user = json.loads((out / 'fixture-private.json').read_text())['userId']
    markers = [row['value'] for row in raw.get('observations', []) if row['name'] == marker_name]
    assert len(markers) == 1, 'TLS completion count differs'
    marker = markers[0]
    assert marker['status'] == 'passed' and marker['nativeServerUrl'] == 'https://localhost:29443' and \
        marker['fixtureUserId'] == user and marker['infoStatus'] == marker['meStatus'] == 200, 'Native TLS projection differs'
    text = (out / tls_name).read_text()
    assert len(text.encode()) <= 131072 and text.endswith('\n'), 'TLS original bytes differ'
    rows = [json.loads(line) for line in text.splitlines()]
    assert len(rows) <= 64, 'TLS original count differs'
    selected = [row for row in rows if row['id'] == marker['nativeTraceId']]
    assert len(selected) == 1 and selected[0] == marker['response'], 'TLS original correlation differs'
    response = selected[0]
    if unit == 'task-write':
        assert response.get('attempt') == str(out), 'TLS attempt differs'
    assert response['event'] == 'fixture_me_tls_response' and response['fixtureUserId'] == user and \
        response['method'] == 'GET' and response['pathname'] == '/api/me' and response['host'] == 'localhost:29443' and \
        response['upstream'] == {'host': '127.0.0.1', 'port': 18480, 'status': 200}, 'TLS original source differs'
    assert response['bodySha256'] == marker['nativeBodySha256'] and response['bodyBytes'] == marker['nativeBodyBytes'], 'TLS native response digest differs'
    tls = response['tls']
    assert tls['encrypted'] is True and tls['protocol'] in ['TLSv1.2','TLSv1.3'] and \
        tls['localPort'] == 29443 and tls['serverCertificateSha256'] == origin['server_certificate_der_sha256'], 'TLS original connection differs'


def validate_t2_final_events(out):
    """Post-writer/service-cleanup journal gate,using the existing T2 reader bounds."""
    path = out / 't2-events.jsonl'
    assert path.is_file() and not path.is_symlink(), 'T2 final journal file identity differs'
    with path.open('rb') as source:
        data = source.read(4 * 1024 * 1024 + 1)
    assert len(data) <= 4 * 1024 * 1024 and data.endswith(b'\n'), 'T2 final journal bytes/incomplete line'
    rows = [json.loads(line) for line in data.decode('utf-8').splitlines()]
    assert rows and len(rows) <= 512 and rows[0].get('event') == 'observer_start', 'T2 final journal incomplete'
    assert all(isinstance(row, dict) and type(row.get('seq')) is int and row['seq'] == index + 1 and row.get('event') != 'observation_failure' for index, row in enumerate(rows)), 'T2 final journal incomplete or observation_failure'
    return {'status': 'passed', 'path': str(path), 'sha256': hashlib.sha256(data).hexdigest(), 'events': len(rows)}
