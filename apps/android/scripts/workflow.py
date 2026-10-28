#!/usr/bin/env python3
"""Pinned environment checks and explicit build/acceptance checkpoints. No retries."""
import argparse
import hashlib
import json
import os
from pathlib import Path
from types import SimpleNamespace
import re
import signal
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
import zipfile
from build_environment import build_environment
from b3_origin import device_preconditions as new_origin_device_preconditions, validate_evidence as validate_new_origin_evidence, expected_packages as origin_expected_packages, EVIDENCE_UNITS as ORIGIN_EVIDENCE_UNITS, validate_t2_final_events

APP = Path(__file__).resolve().parents[1]
REPO = APP.parents[1]
LOCK = json.loads((APP / 'toolchain-lock.json').read_text())
ENV_ROOT = Path(os.environ['SILVERHAND_ANDROID_HOME']).resolve()
ENV = build_environment(os.environ)


def digest(path):
    with Path(path).open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + '\n')


def output(command, **kwargs):
    return subprocess.check_output(list(map(str, command)), cwd=REPO, env=ENV,
                                   stderr=subprocess.STDOUT, text=True, timeout=60, **kwargs).strip()


def scan_links(roots):
    failures = []
    count = 0
    for root in roots:
        for base, dirs, files in os.walk(root, followlinks=False):
            for name in dirs + files:
                path = Path(base) / name
                if not path.is_symlink():
                    continue
                count += 1
                raw = os.readlink(path)
                try:
                    resolved = str(path.resolve(strict=True))
                    if raw in {'/tmp', '/private/tmp'} or resolved in {'/tmp', '/private/tmp'} or raw.startswith(('/tmp/', '/private/tmp/')) or resolved.startswith(('/tmp/', '/private/tmp/')):
                        failures.append({'path': str(path), 'target': raw, 'reason': 'temporary dependency'})
                except (OSError, RuntimeError) as error:
                    failures.append({'path': str(path), 'target': raw, 'reason': str(error)})
    return {'checked': count, 'failures': failures}


def openssl_preflight():
    executable = Path(ENV['OPENSSL_BIN'])
    if not executable.is_absolute() or str(executable.resolve(strict=True)).startswith(('/tmp/', '/private/tmp/')):
        raise RuntimeError('OPENSSL_BIN must select an absolute persistent executable')
    version = output([executable, 'version'])
    if not re.search(r'(?<![\d.])' + re.escape(LOCK['tools']['openssl']) + r'(?![\d.])', version):
        raise RuntimeError('OpenSSL version mismatch: ' + version)
    required = {'verify': ['-verify_hostname', '-CAfile'],
                'x509': ['-checkend', '-req', '-CA', '-CAkey', '-CAcreateserial'],
                'req': ['-newkey', '-x509', '-config']}
    for command, flags in required.items():
        help_text = output([executable, command, '-help'])
        if any(not re.search(r'(?<!\S)' + re.escape(flag) + r'(?=\s|$)', help_text) for flag in flags):
            raise RuntimeError('Required OpenSSL capability missing: ' + command)
    return {'executable': str(executable.resolve()), 'configured_executable': str(executable),
            'version_output': version, 'required_capabilities': required}


def preflight():
    executables = {
        'node': [ENV['NODE_BIN'], '--version'],
        'pnpm': [ENV['PNPM_BIN'], '--version'],
        'swift': [Path(ENV['SWIFT_ANDROID_TOOLCHAIN']) / 'usr/bin/swift', '--version'],
        'java': [Path(ENV['JAVA_HOME']) / 'bin/java', '-version'],
        'gradle': [ENV['GRADLE_BIN'], '--version'],
        'cargo': [ENV['CARGO_BIN'], '+1.99.0', '--version'],
    }
    versions = {}
    for name, command in executables.items():
        selected = str(Path(command[0]).resolve(strict=True))
        assert not selected.startswith(('/tmp/', '/private/tmp/')), f'{name} executable uses temporary storage'
        actual = output(command)
        assert re.search(r'(?<![\d.])' + re.escape(LOCK['tools'][name]) + r'(?![\d.])', actual), f'{name} version mismatch: {actual}'
        versions[name] = {'executable': str(Path(command[0]).resolve()), 'version_output': actual}
    versions['openssl'] = openssl_preflight()
    assert json.loads((REPO / 'package.json').read_text())['packageManager'] == 'pnpm@' + LOCK['tools']['pnpm']
    current_pins = json.loads((APP / 'native/Package.resolved').read_text())['pins']
    assert current_pins == LOCK['swift_pins'], 'Swift dependency revisions drifted'
    sdk = Path(ENV['SWIFT_ANDROID_SDK_BUNDLE'])
    assert 'swift-6.4.1-RELEASE_android' in json.loads((sdk / 'info.json').read_text())['artifacts']
    ndk_properties = (Path(ENV['ANDROID_NDK_HOME']) / 'source.properties').read_text()
    assert LOCK['ndk_revision'] in ndk_properties, 'NDK revision mismatch'
    for component, revision in LOCK['sdk_packages'].items():
        props = (Path(ENV['ANDROID_HOME']) / component / 'source.properties').read_text()
        assert re.search(r'^Pkg.Revision\s*=\s*(.+)$', props, re.M).group(1).strip() == revision, component
    assert ENV['ANDROID_HOME'] == ENV['ANDROID_SDK_ROOT']
    assert json.loads((APP / 'node_modules/@capacitor/android/package.json').read_text())['version'] == LOCK['capacitor']
    assert 'useVersion("' + LOCK['agp'] + '")' in (APP / 'gradle-root.gradle.kts').read_text()
    for path in ['platforms/android-36/android.jar', 'system-images/android-36/google_apis/arm64-v8a/system.img']:
        assert (Path(ENV['ANDROID_HOME']) / path).is_file(), path
    for name in ['silverhand_stage1_api36', 'silverhand_probe_api35', 'silverhand_probe_api35_16k']:
        ini = Path(ENV['ANDROID_AVD_HOME']) / (name + '.ini')
        lines = dict(line.split('=', 1) for line in ini.read_text().splitlines() if '=' in line)
        assert Path(lines['path']).resolve() == (ini.parent / (name + '.avd')).resolve(), str(ini)
    links = scan_links([sdk, Path(ENV['ANDROID_NDK_HOME']), Path(ENV['ANDROID_HOME']), Path(ENV['ANDROID_AVD_HOME']), Path(ENV['GRADLE_USER_HOME'])])
    assert not links['failures'], json.dumps(links)
    helper_paths = {}
    assert sys.version_info >= (3, 11), 'Python 3.11+ required'
    for name in ['python3', 'node', 'patch']:
        selected = str(Path(shutil.which(name) or '/missing-tool').resolve(strict=True))
        assert not selected.startswith(('/tmp/', '/private/tmp/')), f'{name} uses temporary storage'
        helper_paths[name] = selected
    return {'status': 'passed', 'repository': str(REPO), 'head': output(['git','rev-parse','HEAD']), 'tools': versions, 'helper_paths': helper_paths, 'links': links,
            'child_environment_keys': sorted(ENV),
            'swift_pins': current_pins, 'environment': {k: ENV[k] for k in [
                'ANDROID_HOME', 'ANDROID_NDK_HOME', 'ANDROID_AVD_HOME', 'SWIFT_ANDROID_TOOLCHAIN',
                'SWIFT_ANDROID_SDK_BUNDLE', 'GRADLE_USER_HOME', 'ANDROID_SERIAL']}}


def configure(run):
    ENV.update(SILVERHAND_ANDROID_RUN_ROOT=str(run), SILVERHAND_ANDROID_BUILD=str(run / 'core-build'),
               CARGO_TARGET_DIR=str(run / 'backend-build'),
               SILVERHAND_ACCEPTANCE_BACKEND=str(run / 'backend-build/debug/silverhand-backend'))


def host_resume_inputs(run):
    inputs = {}
    roots = [('ios-source', REPO / 'apps/ios/native'), ('android-source', APP / 'native'),
             ('extracted-core', run / 'core-build/core'), ('extracted-native', run / 'core-build/native')]
    for label, root in roots:
        if not root.is_dir():
            raise RuntimeError(f'Missing resume input directory: {root}')
        for path in sorted(root.rglob('*')):
            relative = path.relative_to(root)
            if any(part in {'.build', '.swiftpm'} for part in relative.parts):
                continue
            if path.is_symlink():
                raise RuntimeError(f'Unexpected resume source symlink: {path}')
            if path.is_file():
                inputs[f'{label}/{relative}'] = digest(path)
    for path in [APP / 'toolchain-lock.json', APP / 'scripts/core-extraction.patch',
                 APP / 'scripts/write-protocol.mjs', REPO / 'pnpm-lock.yaml', REPO / 'apps/ios/native-protocol.ts',
                 REPO / 'packages/shared/src/backend-admission.json', REPO / 'packages/shared/src/api/paths.ts']:
        inputs[str(path.relative_to(REPO))] = digest(path)
    inputs['environment-config'] = digest(ENV_ROOT / 'env.sh')
    return inputs


def validate_host_resume(run, baseline):
    if Path(baseline['run']).resolve() != run.resolve():
        raise RuntimeError('Resume baseline belongs to another run')
    if (run / 'build-complete.json').exists() or (run / 'core-build/cross').exists():
        raise RuntimeError('Only the first failed host checkpoint can be resumed')
    if set(baseline['first_evidence']) != {'steps/dependencies.json', 'steps/core.json', 'core-build/swift-host.log'} or \
       set(baseline['plugin_cache']) != {'core-build/native/.build/plugins/cache/skipstone',
                                       'core-build/native/.build/plugins/cache/skipstone-state.json'}:
        raise RuntimeError('Incomplete first-host resume baseline')
    for name, expected in baseline['first_evidence'].items():
        if digest(run / name) != expected:
            raise RuntimeError(f'First-attempt evidence changed: {name}')
    if json.loads((run / 'steps/dependencies.json').read_text())['exit_code'] != 0 or \
       json.loads((run / 'steps/core.json').read_text())['exit_code'] == 0:
        raise RuntimeError('Resume requires completed dependencies and failed core')
    actual = host_resume_inputs(run)
    if actual != baseline['inputs']:
        changed = sorted(k for k in set(actual) | set(baseline['inputs']) if actual.get(k) != baseline['inputs'].get(k))
        raise RuntimeError('Resume source/locked inputs changed: ' + ', '.join(changed))
    for name, expected in baseline['plugin_cache'].items():
        if digest(run / name) != expected:
            raise RuntimeError(f'Resume plugin/cache changed: {name}')
    return {'status': 'passed', 'input_count': len(actual), 'baseline': baseline}


def android_resume_artifacts(run, previous_attempt=None):
    if previous_attempt is None:  # B2's first build already passed host, then failed Android.
        files = ['reviewed-inputs.json', 'preflight.json', 'steps/dependencies.json', 'steps/core.json',
                 'logs/core.log', 'core-build/swift-host.log', 'core-build/swift-android-release.log']
    else:
        if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]*', previous_attempt):
            raise RuntimeError('Invalid preceding Android attempt')
        previous = Path('attempts') / previous_attempt
        files = ['steps/dependencies.json', 'steps/core.json', 'core-build/swift-host.log',
                 previous / 'steps/core.json', previous / 'preflight.json', previous / 'resume-validation.json',
                 *[previous / 'core-logs' / name for name in ['swift-host.exit.json', 'swift-host.log',
                                                            'swift-android-release.exit.json', 'swift-android-release.log']]]
    files += ['core-build/native/.build/out/Products/Debug/libSilverhandCore.dylib',
              'core-build/native/.build/out/Products/Debug/SilverhandCore.o']
    for scratch in ['native/.build', 'cross']:
        base = Path('core-build') / scratch
        files += [base / 'workspace-state.json', base / 'plugins/cache/skipstone',
                  base / 'plugins/cache/skipstone-state.json',
                  base / 'checkouts/skip/Plugins/SkipPlugin/SkipPlugin.swift']
        artifact = base / 'artifacts/skip/skip/skip.artifactbundle'
        files += [artifact / name for name in ['info.json', 'bin/skip', 'macos/skip']]
    artifacts = {str(name): digest(run / name) for name in files}
    # Preserve generated Kotlin/Gradle inputs and link identities without following directory links.
    generated = run / 'core-build/native/.build/plugins/outputs'
    generated_count = 0
    for path in sorted(generated.rglob('*')):
        if path.is_symlink():
            target = path.resolve(strict=True)
            if not target.is_relative_to(run.resolve()):
                raise RuntimeError(f'Generated host link leaves this run: {path}')
            artifacts[str(path.relative_to(run))] = {'link': os.readlink(path), 'target': str(target.relative_to(run))}
        elif path.is_file():
            artifacts[str(path.relative_to(run))] = digest(path)
            generated_count += 1
    if not generated_count:
        raise RuntimeError('Missing successful host generated outputs')
    for name in ['workflow.py', 'build-core.py', 'build_environment.py']:
        artifacts['engineering/' + name] = digest(APP / 'scripts' / name)
    if previous_attempt is not None:
        entry = ENV_ROOT / 'evidence' / run.name / previous / 'entry-exit.raw.json'
        artifacts['previous-entry-result'] = digest(entry)
    return artifacts


def android_resume_revisions(run):
    expected = {p['identity']: p['state']['revision']
                for p in json.loads((APP / 'native/Package.resolved').read_text())['pins']}
    actual_pins = {p['identity']: p['state']['revision']
                   for p in json.loads((run / 'core-build/native/Package.resolved').read_text())['pins']}
    if actual_pins != expected:
        raise RuntimeError('Android resume pins changed')
    revisions = {}
    for scratch in ['native/.build', 'cross']:
        for identity, revision in sorted(expected.items()):
            checkout = run / 'core-build' / scratch / 'checkouts' / identity
            command = ['git', '--no-optional-locks', '-C', checkout]
            actual = output(command + ['rev-parse', 'HEAD'])
            if actual != revision or output(command + ['status', '--porcelain']):
                raise RuntimeError(f'Android resume checkout changed: {scratch}/{identity}')
            revisions[scratch + '/' + identity] = actual
    return revisions


def validate_b2_android_resume(run, baseline, reviewed_inputs):
    if baseline.get('kind') != 'b2-initial-android' or reviewed_inputs is None:
        raise RuntimeError('B2 resume requires its initial Android checkpoint and reviewed inputs')
    descriptor = json.loads((run / 'reviewed-inputs.json').read_text())
    original_path = Path(descriptor['path'])
    if digest(original_path) != descriptor['sha256']:
        raise RuntimeError('Original reviewed input record changed')
    original = json.loads(original_path.read_text())
    changed = {name for name in set(original['repository']) | set(reviewed_inputs['repository'])
               if original['repository'].get(name) != reviewed_inputs['repository'].get(name)}
    allowed = {'apps/android/scripts/workflow.py', 'apps/android/scripts/test_b2_workflow.py'}
    if changed - allowed or set(original['repository']) != set(reviewed_inputs['repository']) or \
       original['environment_config'] != reviewed_inputs['environment_config'] or apk_resume_inputs() != reviewed_inputs:
        raise RuntimeError('B2 resume inputs changed outside reviewed entry fixes')
    entry_path = Path(baseline['entry_result']['path'])
    if digest(entry_path) != baseline['entry_result']['sha256']:
        raise RuntimeError('Original B2 entry result changed')
    entry = json.loads(entry_path.read_text())['entry']
    command = ['bash', str(APP / 'scripts/android.sh'), 'build', run.name, '--suite', 'b2',
               '--reviewed-inputs', str(original_path)]
    if entry['command'] != command or entry['raw_returncode'] != 1 or not entry.get('writer_exited') or \
       entry.get('collector_error') or entry.get('stop_actions'):
        raise RuntimeError('B2 requires the original naturally failed build entry')
    core = json.loads((run / 'steps/core.json').read_text())
    combined = (run / 'logs/core.log').read_text()
    host = (run / 'core-build/swift-host.log').read_text()
    android = (run / 'core-build/swift-android-release.log').read_text()
    if json.loads((run / 'steps/dependencies.json').read_text())['exit_code'] != 0 or core['exit_code'] != 1 or \
       core['command'] != ['python3', str(APP / 'scripts/build-core.py'), '--configuration', 'release'] or \
       combined.splitlines().count('swift-host passed') != 1 or \
       not re.search(r'^swift-android-release failed \(1\);', combined, re.M) or \
       not re.search(r'^Build complete!', host, re.M) or \
       'error: build planning stopped due to build-tool plugin failures' not in android:
        raise RuntimeError('B2 host success / Android planning failure evidence missing')
    if android_resume_artifacts(run) != baseline['artifacts'] or host_resume_inputs(run) != baseline['inputs'] or \
       android_resume_revisions(run) != baseline['checkout_revisions']:
        raise RuntimeError('B2 checkpoint artifacts, source or revisions changed')
    return {'status': 'passed', 'checkpoint': 'android', 'kind': baseline['kind'],
            'engineering_changes': sorted(changed), 'baseline': baseline}


def validate_android_resume(run, baseline, suite='original12', reviewed_inputs=None):
    if Path(baseline['run']).resolve() != run.resolve():
        raise RuntimeError('Android resume baseline belongs to another run')
    if any((run / name).exists() for name in ['build-complete.json', 'backend.json', 'apk.json',
                                             'core-build/manifest.json', 'core-build/gradle']):
        raise RuntimeError('Android resume requires the failed planning checkpoint before packaging')
    if suite == 'b2':
        return validate_b2_android_resume(run, baseline, reviewed_inputs)
    if baseline.get('kind') == 'b2-initial-android':
        raise RuntimeError('B2 checkpoint requires --suite b2')
    previous_attempt = baseline['previous_attempt']
    # The artifact collector validates the attempt name before any path is read.
    artifacts = android_resume_artifacts(run, previous_attempt)
    if artifacts != baseline['artifacts']:
        changed = sorted(k for k in set(artifacts) | set(baseline['artifacts'])
                         if artifacts.get(k) != baseline['artifacts'].get(k))
        raise RuntimeError('Android checkpoint evidence/cache changed: ' + ', '.join(changed))
    previous = run / 'attempts' / previous_attempt
    host = json.loads((previous / 'core-logs/swift-host.exit.json').read_text())
    android = json.loads((previous / 'core-logs/swift-android-release.exit.json').read_text())
    entry = json.loads((ENV_ROOT / 'evidence' / run.name / 'attempts' / previous_attempt / 'entry-exit.raw.json').read_text())
    swift = Path(ENV['SWIFT_ANDROID_TOOLCHAIN']) / 'usr/bin/swift'
    host_command = list(map(str, [swift, 'build', '--disable-sandbox', '--package-path',
                                  run / 'core-build/native', '--product', 'SilverhandCore']))
    android_command = host_command + list(map(str, ['-c', 'release', '--scratch-path', run / 'core-build/cross',
        '--swift-sdks-path', Path(ENV['SWIFT_ANDROID_SDK_BUNDLE']).parent, '--swift-sdk',
        'swift-6.4.1-RELEASE_android', '--triple', 'aarch64-unknown-linux-android28',
        '-Xswiftc', '-DSKIP_BRIDGE', '-Xswiftc', '-DTARGET_OS_ANDROID']))
    if host['raw_subprocess_returncode'] != 0 or host['command'] != host_command or \
       android['raw_subprocess_returncode'] != 1 or android['command'] != android_command or \
       host.get('launch_error') or android.get('launch_error') or \
       entry['raw_subprocess_returncode'] != 1 or entry.get('stop_reason') or entry.get('stop_actions') or \
       json.loads((previous / 'steps/core.json').read_text())['exit_code'] != 1 or \
       json.loads((run / 'steps/dependencies.json').read_text())['exit_code'] != 0:
        raise RuntimeError('Android resume requires successful pinned host and naturally failed Android')
    inputs = host_resume_inputs(run)
    original = json.loads((previous / 'resume-validation.json').read_text())['baseline']['inputs']
    if inputs != original or inputs != baseline['inputs']:
        raise RuntimeError('Android resume source/locked inputs changed')
    revisions = android_resume_revisions(run)
    if revisions != baseline['checkout_revisions']:
        raise RuntimeError('Android resume revisions do not match baseline')
    return {'status': 'passed', 'checkpoint': 'android', 'input_count': len(inputs),
            'artifact_count': len(artifacts), 'baseline': baseline}


def apk_resume_inputs():
    names = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
                                    cwd=REPO, env=ENV).decode().split('\0')
    return {'repository': {name: digest(REPO / name) for name in names if name},
            'environment_config': digest(ENV_ROOT / 'env.sh')}


def apk_resume_artifacts(run, previous_attempt, b2=False):
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]*', previous_attempt):
        raise RuntimeError('Invalid preceding APK attempt')
    previous = Path('attempts') / previous_attempt
    files = [previous / 'preflight.json', previous / 'resume-validation.json',
             previous / 'core-logs/swift-android-release.exit.json', previous / 'core-logs/swift-android-release.log',
             'core-build/manifest.json', 'backend.json', 'cleanup.json', 'steps/dependencies.json',
             'acceptance/certs/ca.pem', 'acceptance/certs/server.pem']
    if b2:
        files += ['logs/core.log', 'core-build/swift-host.log']
    else:
        files += ['attempts/002-host-after-user-allow/core-logs/swift-host.exit.json',
                  'attempts/002-host-after-user-allow/core-logs/swift-host.log']
    for folder in ['steps', 'logs']:
        files += [p.relative_to(run) for p in sorted((run / previous / folder).glob('*')) if p.is_file()]
    artifacts = {str(name): digest(run / name) for name in files}
    for relative in ['core-build/gradle', 'web', 'app-build/web-assets', 'app-build/core-assets', 'app-build/acceptance-assets']:
        directory = run / relative
        if not directory.is_dir():
            raise RuntimeError('Missing completed APK input: ' + relative)
        for path in sorted(directory.rglob('*')):
            if relative == 'core-build/gradle' and any(p in {'.gradle', 'build'} for p in path.relative_to(directory).parts):
                continue  # Bind source/config here and the prepared JNI files explicitly below.
            if path.is_symlink():
                raise RuntimeError(f'Unexpected APK input symlink: {path}')
            if path.is_file():
                artifacts[str(path.relative_to(run))] = digest(path)
    manifest = json.loads((run / 'core-build/manifest.json').read_text())
    for name, expected in manifest['packagedLibraryHashes'].items():
        path = run / 'core-build/gradle/SilverhandCore/build/jni-libs/arm64-v8a' / name
        if digest(path) != expected:
            raise RuntimeError('Prepared JNI/runtime library changed: ' + name)
        artifacts[str(path.relative_to(run))] = expected
    backend = json.loads((run / 'backend.json').read_text())
    binary = run / 'backend-build/debug/silverhand-backend'
    if backend['path'] != str(binary) or digest(binary) != backend['sha256'] or digest(REPO / 'rust/Cargo.lock') != backend['cargo_lock_sha256']:
        raise RuntimeError('Prepared backend/source identity changed')
    artifacts[str(binary.relative_to(run))] = digest(binary)
    if not b2:
        entry = ENV_ROOT / 'evidence' / run.name / previous / 'entry-exit.raw.json'
        artifacts['previous-entry-result'] = digest(entry)
    return artifacts


def validate_apk_resume(run, baseline, suite='original12', reviewed_inputs=None):
    if Path(baseline['run']).resolve() != run.resolve() or (run / 'build-complete.json').exists() or (run / 'apk.json').exists():
        raise RuntimeError('APK resume requires this unfinished run')
    b2 = suite == 'b2'
    if b2 and (baseline.get('kind') != 'b2-apk-compile-fix' or reviewed_inputs is None):
        raise RuntimeError('B2 APK resume requires its reviewed compile-fix checkpoint')
    if not b2 and baseline.get('kind') == 'b2-apk-compile-fix':
        raise RuntimeError('B2 APK checkpoint requires --suite b2')
    previous_attempt = baseline['previous_attempt']
    artifacts = apk_resume_artifacts(run, previous_attempt, b2=True) if b2 else apk_resume_artifacts(run, previous_attempt)
    if artifacts != baseline['artifacts']:
        raise RuntimeError('APK checkpoint evidence/prepared artifacts changed')
    previous = run / 'attempts' / previous_attempt
    steps = {p.stem: json.loads(p.read_text()) for p in (previous / 'steps').glob('*.json')}
    required = {'core', 'test-swift-version', 'host-tests', 'typecheck', 'platform-test', 'ios-contracts',
                'web', 'web-assets', 'backend-build', 'prepare-acceptance', 'apk'}
    if b2:
        entry_path = Path(baseline['entry_result']['path'])
        original_path = Path(baseline['original_inputs']['path'])
        if digest(entry_path) != baseline['entry_result']['sha256'] or digest(original_path) != baseline['original_inputs']['sha256']:
            raise RuntimeError('B2 executed entry/input evidence changed')
        entry = json.loads(entry_path.read_text())['entry']
        expected = ['bash', str(APP / 'scripts/android.sh'), 'resume-android', run.name, '--suite', 'b2', '--attempt', previous_attempt]
        if entry['command'][:8] != expected or entry['command'][-2:] != ['--reviewed-inputs', str(original_path)] or not entry.get('writer_exited'):
            raise RuntimeError('B2 original APK failure entry does not match this checkpoint')
        code, interrupted = entry['raw_returncode'], entry.get('collector_error') or entry.get('stop_actions')
    else:
        entry = json.loads((ENV_ROOT / 'evidence' / run.name / 'attempts' / previous_attempt / 'entry-exit.raw.json').read_text())
        code, interrupted = entry['raw_subprocess_returncode'], entry.get('stop_reason') or entry.get('stop_actions')
    android = json.loads((previous / 'core-logs/swift-android-release.exit.json').read_text())
    if set(steps) != required or any(v['exit_code'] != (1 if name == 'apk' else 0) for name, v in steps.items()) or \
       code != 1 or interrupted or android['raw_subprocess_returncode'] != 0:
        raise RuntimeError('APK resume requires successful upstream steps and the failed APK checkpoint')
    inputs = apk_resume_inputs()
    if b2:
        original_inputs = json.loads(original_path.read_text())
        original = original_inputs['repository']
        allowed = {'apps/android/app/src/main/java/com/silverhand/android/SilverhandClientPlugin.kt',
                   'apps/android/scripts/workflow.py', 'apps/android/scripts/test_b2_workflow.py'}
        if reviewed_inputs != inputs or set(original) != set(inputs['repository']) or set(baseline['approved_source_changes']) - allowed:
            raise RuntimeError('B2 APK inputs differ outside the reviewed compile/entry repair')
        old_environment = original_inputs['environment_config']
        if old_environment != inputs['environment_config']:
            raise RuntimeError('B2 APK repair must not change the environment configuration')
    else:
        original = json.loads((ENV_ROOT / 'evidence' / run.name / 'attempts' / previous_attempt / 'source-inputs-before.json').read_text())
        old_environment = json.loads((previous / 'resume-validation.json').read_text())['baseline']['inputs']['environment-config']
    changed = {name for name in set(original) | set(inputs['repository']) if original.get(name) != inputs['repository'].get(name)}
    approved = baseline['approved_source_changes']
    if inputs != baseline['inputs'] or changed != set(approved) or any(
        row['before'] != original.get(name) or row['after'] != inputs['repository'].get(name) for name, row in approved.items()):
        raise RuntimeError('APK source inputs differ from the reviewed repair list')
    if baseline['environment_change'] != {'before': old_environment, 'after': inputs['environment_config']}:
        raise RuntimeError('APK environment change differs from the reviewed repair')
    if any(ENV.get(name) != '1' for name in ['SKIP_BRIDGE_ANDROID_BUILD_DISABLED', 'SKIP_BRIDGE_ROBOLECTRIC_BUILD_DISABLED']):
        raise RuntimeError('APK resume must retain the disabled Gradle Swift rebuild hooks')
    if list((run / 'acceptance').glob('*.pid')):
        raise RuntimeError('Managed service PID files remain; refusing to disturb prior processes')
    tool = openssl_preflight()
    ca = prepared_ca_check(run)
    return {'status': 'passed', 'checkpoint': 'apk', 'artifact_count': len(artifacts),
            'openssl': tool, 'prepared_ca': ca, 'baseline': baseline}


def resume_build(run, attempt_name, baseline_path, checkpoint, suite='original12', reviewed_inputs_path=None):
    if not attempt_name or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]*', attempt_name):
        raise RuntimeError('Supply a new attempt name')
    attempt = run / 'attempts' / attempt_name
    if attempt.exists():
        raise RuntimeError('Resume attempt already exists; evidence must not be overwritten')
    baseline = json.loads(baseline_path.read_text())
    validators = {'host': validate_host_resume, 'android': validate_android_resume, 'apk': validate_apk_resume}
    inputs = None
    if suite == 'b2':
        if checkpoint not in {'android', 'apk'} or reviewed_inputs_path is None:
            raise RuntimeError('B2 recovery supports only reviewed Android/APK checkpoints')
        inputs = json.loads(reviewed_inputs_path.read_text())
        validation = validators[checkpoint](run, baseline, suite, inputs)
    else:
        validation = validators[checkpoint](run, baseline)
    attempt.mkdir(parents=True, exist_ok=False, mode=0o700)
    write(attempt / 'resume-validation.json', validation)
    if checkpoint == 'apk':
        if suite == 'b2':
            build_apk_checkpoint(run, attempt, baseline['previous_attempt'], suite)
        else:
            build_apk_checkpoint(run, attempt, baseline['previous_attempt'])
    else:
        build(run, resume_attempt=attempt, resume_stage=checkpoint)
    if suite == 'b2':
        finish_b2_packages(run, inputs, attempt)


def step(run, name, command):
    log = run / 'logs' / (name + '.log')
    log.parent.mkdir(parents=True, exist_ok=True)
    started = time.time()
    with log.open('x') as target:
        target.write('COMMAND ' + json.dumps(list(map(str, command))) + '\n')
        target.flush()
        if name == 'host-tests':
            subprocess.run([str(command[0]), '--version'], env=ENV, stdout=target, stderr=subprocess.STDOUT, check=True)
        result = subprocess.run(list(map(str, command)), cwd=REPO, env=ENV,
                                stdout=target, stderr=subprocess.STDOUT, restore_signals=False)
    write(run / 'steps' / (name + '.json'), {'command': list(map(str, command)),
          'exit_code': result.returncode, 'seconds': round(time.time() - started, 2), 'log': str(log)})
    if result.returncode:
        raise RuntimeError(f'{name} failed ({result.returncode}); first log retained: {log}')
    print(name + ' passed', flush=True)


def cleanup_services(run):
    root = run / 'acceptance'
    rows = []
    for name, expected in [('proxy', str(APP / 'scripts/acceptance-server.mjs')),
                           ('backend', str(run / 'backend-build/debug/silverhand-backend'))]:
        file = root / (name + '.pid')
        row = {'service': name, 'status': 'passed'}
        try:
            if not file.exists():
                row['result'] = 'no pid file'
                continue
            pid = int(file.read_text())
            row['pid'] = pid
            if pid <= 1:
                raise RuntimeError('Invalid managed PID; refusing signal')
            check = subprocess.run(['ps', '-p', str(pid), '-o', 'command='],
                                   capture_output=True, text=True, timeout=3, env=ENV)
            if check.returncode == 0:
                try:
                    group = os.getpgid(pid)
                except ProcessLookupError:
                    group = None
                if group is not None:
                    if expected not in check.stdout or group != pid:
                        raise RuntimeError('PID ownership changed; refusing signal and retaining pid file')
                    try:
                        os.killpg(pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass  # Verify absence below, including the exit-during-signal race.
            elif check.returncode != 1:
                raise RuntimeError(f'Cannot inspect PID ({check.returncode})')
            deadline = time.monotonic() + 10
            while True:
                try:
                    # Reap direct test children; real service children are reaped by their parent.
                    os.waitpid(pid, os.WNOHANG)
                except ChildProcessError:
                    pass
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    break
                if time.monotonic() >= deadline:
                    raise RuntimeError('Service still exists after stop deadline; retaining pid file')
                time.sleep(0.05)
            file.unlink(missing_ok=True)
            row['result'] = 'process absent; pid file removed'
        except Exception as error:
            row.update(status='failed', error=str(error))
        finally:
            rows.append(row)
    return {'status': 'failed' if any(r['status'] == 'failed' for r in rows) else 'passed',
            'services': rows}


def finish_cleanup(run, actions, primary_error):
    rows = []
    for name, action in actions:
        try:
            action()
            rows.append({'action': name, 'status': 'passed'})
        except Exception as error:
            rows.append({'action': name, 'status': 'failed', 'error': str(error)})
    try:
        services = cleanup_services(run)
    except Exception as error:
        services = {'status': 'failed', 'error': str(error)}
    failed = services['status'] != 'passed' or any(r['status'] == 'failed' for r in rows)
    report = {'status': 'failed' if failed else 'passed',
              'primary_error': str(primary_error) if primary_error is not None else None,
              'actions': rows, 'service_cleanup': services}
    try:
        write(run / 'cleanup.json', report)
    except Exception as error:
        failed = True
        print('Cannot persist cleanup report: ' + str(error), file=sys.stderr)
    if failed and primary_error is None:
        raise RuntimeError(f'Cleanup failed; see {run / "cleanup.json"}')


def wait_services():
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            for port in [18480, 29443]:
                with socket.create_connection(('127.0.0.1', port), timeout=1):
                    pass
            return
        except OSError:
            time.sleep(0.2)
    raise RuntimeError('Unclassified backend/proxy startup timeout; inspect service logs')


def adb(*args):
    return output([Path(ENV['ANDROID_HOME']) / 'platform-tools/adb', '-s', ENV['ANDROID_SERIAL'], *args])


def boot(run, log_path=None):
    assert ENV['ANDROID_SERIAL'] == 'emulator-5584', 'dedicated emulator serial required'
    with socket.socket() as probe:
        assert probe.connect_ex(('127.0.0.1', 5584)) != 0, 'emulator port already in use'
    command = [str(Path(ENV['ANDROID_HOME']) / 'emulator/emulator'), '-avd', 'silverhand_stage1_api36',
               '-port', '5584', '-no-window', '-no-audio', '-no-snapshot', '-gpu', 'host']
    log = log_path.open('a') if log_path is not None else (run / 'emulator.log').open('x')
    process = subprocess.Popen(command, cwd=REPO, env=ENV, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    process.silverhand_emulator_pgid = process.pid  # start_new_session binds this group's identity at spawn.
    try:
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError(f'emulator exited {process.returncode}; see {run / "emulator.log"}')
            try:
                if adb('shell', 'getprop', 'sys.boot_completed') == '1':
                    config = (Path(ENV['ANDROID_AVD_HOME']) / 'silverhand_stage1_api36.avd/config.ini').read_text()
                    write(run / 'emulator.json', {'status': 'booted', 'pid': process.pid, 'pgid': process.silverhand_emulator_pgid, 'command': command,
                        'repository_cwd': str(REPO), 'ANDROID_AVD_HOME': ENV['ANDROID_AVD_HOME'], 'serial': ENV['ANDROID_SERIAL'],
                        'boot_completed': '1', 'fingerprint': adb('shell', 'getprop', 'ro.build.fingerprint'),
                        'webview': adb('shell', 'dumpsys', 'webviewupdate'),
                        'avd_config': config, 'avd_names': output([Path(ENV['ANDROID_HOME']) / 'emulator/emulator', '-list-avds'])})
                    return process, log
            except subprocess.CalledProcessError:
                pass
            time.sleep(1)
        raise RuntimeError('Unclassified emulator boot timeout; inspect emulator.log')
    except BaseException as primary:
        try:
            stop_emulator(process, log)
        except Exception as error:
            try:
                write(run / 'emulator-cleanup-failure.json',
                      {'primary_error': str(primary), 'cleanup_error': str(error)})
            except Exception as report_error:
                print('Cannot persist emulator cleanup failure: ' + str(report_error), file=sys.stderr)
        raise


def stop_emulator(process, log):
    # One stop deadline covers parent exit and the actual spawn-owned group.
    deadline = time.monotonic() + 30
    report = {'pid': process.pid, 'pgid': getattr(process, 'silverhand_emulator_pgid', None),
              'budget_seconds': 30, 'status': 'running', 'group_samples': []}
    primary = None
    def remaining():
        value = deadline - time.monotonic()
        if value <= 0:
            raise TimeoutError('Owned emulator stop deadline; last group: ' + str(report['group_samples'][-1:]))
        return value
    try:
        assert type(report['pgid']) is int and report['pgid'] > 1 and report['pgid'] == process.pid, 'Missing spawn-owned emulator group'
        if process.poll() is None:
            try:
                command = [str(Path(ENV['ANDROID_HOME']) / 'platform-tools/adb'), '-s', ENV['ANDROID_SERIAL'], 'emu', 'kill']
                result = subprocess.run(command, capture_output=True, text=True, env=ENV, cwd=REPO,
                                        timeout=min(10, remaining()), check=True)
                report['adb_stop'] = {'command': command, 'exit': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}
                process.wait(timeout=min(20, remaining()))
            except (subprocess.SubprocessError, OSError):
                process.terminate()
                process.wait(timeout=min(10, remaining()))
        while True:
            members = group_members(report['pgid'], include_zombies=True, timeout=min(3, remaining()))
            report['group_samples'].append({'at': time.monotonic(), 'members': members})
            remaining()  # A late empty response does not satisfy the deadline.
            if not members:
                break
            time.sleep(min(.1, remaining()))
        report['status'] = 'passed'
    except BaseException as error:
        primary = error
        report.update(status='failed', error={'type': type(error).__name__, 'message': str(error)})
        raise
    finally:
        try:
            log.write('\nEMULATOR_STOP ' + json.dumps(report) + '\n')
            log.flush()
        except Exception:
            if primary is None:
                raise
        finally:
            log.close()


def prepared_ca_check(run):
    for name in ['ca.pem', 'server.pem']:
        output([ENV['OPENSSL_BIN'], 'x509', '-in', run / 'acceptance/certs' / name, '-checkend', '3600', '-noout'])
    ca = run / 'acceptance/certs/ca.pem'
    output([ENV['OPENSSL_BIN'], 'verify', '-CAfile', ca, '-verify_hostname', 'localhost', run / 'acceptance/certs/server.pem'])
    if (run / 'app-build/acceptance-assets/acceptance-ca.pem').read_bytes() != ca.read_bytes():
        raise RuntimeError('Prepared APK/proxy CA mismatch')
    return {'ca_sha256': digest(ca), 'server_sha256': digest(run / 'acceptance/certs/server.pem')}


def ca_check(run, apk=None):
    apk = Path(apk) if apk is not None else run / 'app-build/outputs/apk/acceptance/app-acceptance.apk'
    ca = run / 'acceptance/certs/ca.pem'
    with zipfile.ZipFile(apk) as bundle:
        packed = bundle.read('assets/acceptance-ca.pem')
        assert packed == ca.read_bytes(), 'APK/proxy CA mismatch'
    prepared_ca_check(run)
    return {'apk': str(apk), 'apk_sha256': digest(apk), 'ca_sha256': digest(ca), 'ca_matches_actual_apk': True}


def apk_artifact_check(run, apk=None):
    record = ca_check(run) if apk is None else ca_check(run, apk)
    manifest = json.loads((run / 'core-build/manifest.json').read_text())
    expected = {'lib/arm64-v8a/' + name: sha for name, sha in manifest['packagedLibraryHashes'].items()}
    for folder in ['web-assets', 'core-assets']:
        root = run / 'app-build' / folder
        for path in root.rglob('*'):
            if path.is_file():
                expected['assets/' + str(path.relative_to(root))] = digest(path)
    with zipfile.ZipFile(record['apk']) as bundle:
        for name, sha in expected.items():
            if hashlib.sha256(bundle.read(name)).hexdigest() != sha:
                raise RuntimeError('Actual APK input mismatch: ' + name)
        if any('XCTest' in name for name in bundle.namelist() if name.startswith('lib/')):
            raise RuntimeError('XCTest library unexpectedly packaged')
    return record | {'core_manifest_sha256': digest(run / 'core-build/manifest.json'),
                     'packaged_input_hashes': expected, 'actual_APK_inputs_match': True}


def build_apk_checkpoint(run, attempt, previous_attempt, suite='original12'):
    configure(run)
    # Resources and CA were verified before this attempt; do not renew/start services or replay upstream builds.
    try:
        step(attempt, 'apk', [ENV['GRADLE_BIN'], '-p', run / 'core-build/gradle', ':app:assembleAcceptance', '--no-daemon'])
        try:
            record = apk_artifact_check(run)
        except Exception as error:
            write(attempt / 'apk-validation.json', {'status': 'failed', 'error': str(error),
                  'tool_output': getattr(error, 'output', None)})
            raise
        write(attempt / 'apk-validation.json', {'status': 'passed', 'result': record})
        write(run / 'apk.json', record)
        write(run / 'build-complete.json', {'status': 'passed', 'run': str(run), 'checkpoint': 'A3',
              'evidence_root': str(attempt), 'resumed_from_checkpoint': 'apk', 'resumed_from_host': False,
              'source_attempts': {'host': 'initial-build' if suite == 'b2' else '002-host-after-user-allow',
                                  'upstream': previous_attempt, 'apk': attempt.name}})
    finally:
        write(attempt / 'cleanup.json', {'services_started': False, 'service_signals_sent': [],
              'prior_run_cleanup_preserved': True, 'no_service_or_CA_regeneration': True})


def startup_diagnostics(run):
    commands = {
        'app_process': ['shell', 'pidof', 'com.silverhand.android.stage1'],
        'logcat_tail': ['logcat', '-d', '-t', '120', '-v', 'brief',
                        'AndroidRuntime:E', 'ActivityManager:I', 'chromium:E', '*:S'],
    }
    report = {'classification': 'unclassified', 'reason': 'PID/WebView/CDP startup timed out',
              'serial': ENV['ANDROID_SERIAL'], 'commands': {}, 'ports': {}}
    for name, args in commands.items():
        try:
            result = subprocess.run([str(Path(ENV['ANDROID_HOME']) / 'platform-tools/adb'),
                                     '-s', ENV['ANDROID_SERIAL'], *args], cwd=REPO, env=ENV,
                                    capture_output=True, text=True, timeout=5)
            text = (result.stdout + result.stderr)[-20000:]
            text = re.sub(r'(?i)(bearer\s+)\S+', r'\1[redacted]', text)
            text = re.sub(r'(?i)((?:user_token|password|authorization)["\s:=]+)[^\s,}"]+',
                          r'\1[redacted]', text)
            report['commands'][name] = {'exit_code': result.returncode, 'output': text}
        except Exception as error:
            report['commands'][name] = {'error': str(error)}
    for port in [18480, 29443, 19322, 5584]:
        with socket.socket() as probe:
            probe.settimeout(0.2)
            report['ports'][str(port)] = {'connectable': probe.connect_ex(('127.0.0.1', port)) == 0}
    write(run / 'startup-failure.json', report)


def wait_for_webview(run, timeout=60):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            pid = adb('shell', 'pidof', 'com.silverhand.android.stage1')
            if pid:
                adb('forward', 'tcp:19322', 'localabstract:webview_devtools_remote_' + pid)
                with urllib.request.urlopen('http://127.0.0.1:19322/json', timeout=2) as response:
                    if any(t.get('type') == 'page' and t.get('url', '').startswith('https://localhost') for t in json.load(response)):
                        return
        except (OSError, subprocess.CalledProcessError, ValueError):
            pass
        time.sleep(0.5)
    try:
        startup_diagnostics(run)
    except Exception as error:
        print('Startup diagnostics could not be saved: ' + str(error), file=sys.stderr)
    raise RuntimeError(f'Unclassified PID/WebView/CDP startup timeout; see {run / "startup-failure.json"}')


def build(run, resume_attempt=None, resume_stage='host'):
    configure(run)
    evidence = resume_attempt or run
    write(evidence / 'preflight.json', preflight())
    pnpm = ENV['PNPM_BIN']
    if resume_attempt is None:
        step(evidence, 'dependencies', [pnpm, 'install', '--frozen-lockfile'])
    core_command = ['python3', APP / 'scripts/build-core.py', '--configuration', 'release']
    if resume_attempt is not None:
        core_command += ['--from-stage', resume_stage, '--log-dir', resume_attempt / 'core-logs']
    step(evidence, 'core', core_command)
    swift = Path(ENV['SWIFT_ANDROID_TOOLCHAIN']) / 'usr/bin/swift'
    step(evidence, 'test-swift-version', [swift, '--version'])
    step(evidence, 'host-tests', [swift, 'test', '--package-path', run / 'core-build/core', '--scratch-path', run / 'host-tests'])
    for name, args in [('typecheck', ['--dir', str(APP), 'typecheck']), ('platform-test', ['--dir', str(APP), 'test']),
                       ('ios-contracts', ['--dir', str(REPO / 'apps/ios'), 'exec', 'vitest', 'run', 'src/platform.test.ts', 'src/event-socket.test.ts'])]:
        step(evidence, name, [pnpm, *args])
    step(evidence, 'web', [pnpm, '--dir', APP, 'exec', 'vite', 'build', '--outDir', run / 'web', '--emptyOutDir'])
    step(evidence, 'web-assets', [ENV['NODE_BIN'], APP / 'scripts/prepare-web.mjs'])
    step(evidence, 'backend-build', [ENV['CARGO_BIN'], '+1.99.0', 'build', '--locked', '--manifest-path', REPO / 'rust/Cargo.toml', '-p', 'silverhand-backend-app', '--bin', 'silverhand-backend'])
    backend = Path(ENV['SILVERHAND_ACCEPTANCE_BACKEND'])
    write(run / 'backend.json', {'path': str(backend), 'sha256': digest(backend), 'mtime_ns': backend.stat().st_mtime_ns,
          'cargo_lock_sha256': digest(REPO / 'rust/Cargo.lock'), 'head': output(['git', 'rev-parse', 'HEAD'])})
    try:
        step(evidence, 'prepare-acceptance', ['python3', APP / 'scripts/prepare-acceptance.py', '--renew-ca'])
        wait_services()
        step(evidence, 'apk', [ENV['GRADLE_BIN'], '-p', run / 'core-build/gradle', ':app:assembleAcceptance', '--no-daemon'])
        write(run / 'apk.json', ca_check(run))
    finally:
        finish_cleanup(run, [], sys.exception())
    write(run / 'build-complete.json', {'status': 'passed', 'run': str(run), 'checkpoint': 'A3',
          'evidence_root': str(evidence), 'resumed_from_host': resume_attempt is not None and resume_stage == 'host',
          'resumed_from_checkpoint': resume_stage if resume_attempt is not None else None})




def finish_b2_packages(run, inputs, evidence=None):
    product = run / 'app-build/outputs/apk/acceptance/app-acceptance.apk'
    original = digest(product)
    step(evidence or run, 'test-apk', [ENV['GRADLE_BIN'], '-p', run / 'core-build/gradle',
                                     ':app:assembleAcceptanceAndroidTest', '--no-daemon'])
    assert digest(product) == original, 'Product APK changed during test APK build'
    assert apk_resume_inputs() == inputs, 'B2 inputs changed during build'
    write(run / 'b2-binding.json', {'inputs': inputs, 'packages': b2_package_check(run),
                                  'actual_apk': apk_artifact_check(run)})


def group_members(group, *, include_zombies=False, timeout=3):
    probe = subprocess.run(['ps', '-axo', 'pid=,pgid=,stat='], capture_output=True, text=True, env=ENV, timeout=timeout, check=True)
    return [int(fields[0]) for line in probe.stdout.splitlines() if len(fields := line.split()) == 3 and int(fields[1]) == group and (include_zombies or not fields[2].startswith('Z'))]


def record_entry(command, out, timeout=1200, grace=(10, 5, 5)):
    """Stop the known writer independently of optional group queries."""
    process = None
    entry = {'command': list(map(str, command)), 'started_at': time.time(),
             'launched': False, 'raw_returncode': None, 'collector_error': None, 'stop_actions': [],
             'group_remaining_after_stop': None, 'group_observation': 'not_checked', 'writer_exited': False}

    def observe_group():
        if entry['group_observation'] == 'unknown':
            return None  # A failed query never becomes an empty group.
        try:
            members = group_members(process.pid)
            entry['group_remaining_after_stop'] = members
            entry['group_observation'] = 'observed'
            return members
        except Exception as error:
            entry['group_observation'] = 'unknown'
            entry['group_remaining_after_stop'] = None
            entry['group_query_error'] = {'type': type(error).__name__, 'message': str(error)}
            return None

    try:
        with (out / 'log.txt').open('a') as log:
            process = subprocess.Popen(entry['command'], cwd=REPO, env=ENV, stdin=subprocess.DEVNULL,
                                       stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            entry.update(pid=process.pid, launched=True)
            try:
                process.wait(timeout=timeout)
            except BaseException as error:
                entry['collector_error'] = {'type': type(error).__name__, 'message': str(error)}
                for sig, seconds in zip([signal.SIGINT, signal.SIGTERM, signal.SIGKILL], grace):
                    if observe_group() == [] and process.poll() is not None:
                        break
                    try:
                        # This PGID was created by this Popen, not obtained from ps.
                        os.killpg(process.pid, sig)
                        entry['stop_actions'].append({'signal': sig.name, 'group': process.pid})
                    except ProcessLookupError:
                        pass
                    except OSError as signal_error:
                        entry.setdefault('signal_errors', []).append(str(signal_error))
                        if process.poll() is None:
                            try:
                                process.send_signal(sig)
                                entry['stop_actions'].append({'signal': sig.name, 'direct_pid': process.pid})
                            except OSError as direct_error:
                                entry.setdefault('signal_errors', []).append(str(direct_error))
                    deadline = time.monotonic() + seconds
                    while time.monotonic() < deadline:
                        try:
                            process.wait(timeout=max(.001, deadline - time.monotonic()))
                        except subprocess.TimeoutExpired:
                            break
                        if observe_group() == []:
                            break
                        time.sleep(min(.02, max(0, deadline - time.monotonic())))
                observe_group()
                try:
                    process.wait(timeout=.2)
                except subprocess.TimeoutExpired as wait_error:
                    entry['final_wait_error'] = str(wait_error)
    except BaseException as error:
        fault = {'type': type(error).__name__, 'message': str(error)}
        if entry['collector_error'] is None:
            entry['collector_error'] = fault
        else:
            entry['stop_error'] = fault
    finally:
        if process is not None:
            process.poll()
            entry['raw_returncode'] = process.returncode
        entry['writer_exited'] = process is None or process.returncode is not None
        entry['finished_at'] = time.time()
        if entry['writer_exited']:
            raw = json.loads((out / 'raw.json').read_text()) if (out / 'raw.json').exists() else {}
            raw['entry'] = entry
            write(out / 'raw.json', raw)  # Node is confirmed stopped; ownership transfers here.
        else:
            # Exceptional sidecar only. Neither this function nor its caller may
            # read-modify-write raw.json while Node might still be writing it.
            write(out / 'entry-unmerged.json', {'status': 'writer_exit_unconfirmed', 'entry': entry, 'raw_merged': False})
    return entry


def file_provider_resource_file(resources):
    # output() strips trailing whitespace; the last resource may have no newline.
    blocks = re.findall(r'resource [^\n]*xml/shared_image_paths\b[^\n]*\n(?:(?!\s*resource ).*\n)*', resources + '\n')
    assert len(blocks) == 1, 'Compiled FileProvider paths resource missing or ambiguous'
    files = re.findall(r'\(file\)\s+(res/\S+\.xml)', blocks[0])
    assert len(files) == 1, 'Compiled FileProvider resource file missing or ambiguous'
    return files[0]


def b2_package_check(run, product=None):
    import xml.etree.ElementTree as ET
    ns = '{http://schemas.android.com/apk/res/android}'
    pkg = 'com.silverhand.android.stage1'
    if product is None:
        product = run / 'app-build/outputs/apk/acceptance/app-acceptance.apk'
        with zipfile.ZipFile(product) as bundle:
            assert b'data-b2-startup-diagnostic' not in bundle.read('assets/public/index.html'), 'Diagnostic APK cannot be used as the ordinary product'
    product = Path(product)
    test = run / 'app-build/outputs/apk/androidTest/acceptance/app-acceptance-androidTest.apk'
    analyzer = Path(ENV['ANDROID_HOME']) / 'cmdline-tools/latest/bin/apkanalyzer'
    xml = {name: output([analyzer, 'manifest', 'print', path]) for name, path in [('product', product), ('test', test)]}
    product_root, test_root = ET.fromstring(xml['product']), ET.fromstring(xml['test'])
    providers = [p for p in product_root.findall('.//provider') if p.attrib.get(ns + 'name') == 'androidx.core.content.FileProvider']
    assert len(providers) == 1, 'Expected one product FileProvider'
    provider = providers[0]
    assert provider.attrib[ns + 'authorities'] == pkg + '.shared-images'
    assert provider.attrib[ns + 'exported'] == 'false' and provider.attrib[ns + 'grantUriPermissions'] == 'true'
    metadata = provider.find('meta-data')
    assert metadata is not None and metadata.attrib[ns + 'name'] == 'android.support.FILE_PROVIDER_PATHS'
    aapt = Path(ENV['ANDROID_HOME']) / 'build-tools/36.0.0/aapt2'
    resources = output([aapt, 'dump', 'resources', product])
    resource_file = file_provider_resource_file(resources)
    paths = output([aapt, 'dump', 'xmltree', product, '--file', resource_file])
    assert re.findall(r'E: ([\w-]+)', paths) == ['paths', 'cache-path'], 'Provider opens an unexpected path type'
    assert re.search(r'A: path[^\n]*="shared-images/"', paths), 'Provider path must be the exact cache child'
    instrument = test_root.find('instrumentation')
    assert instrument is not None and instrument.attrib[ns + 'targetPackage'] == pkg
    assert instrument.attrib[ns + 'name'] == 'com.silverhand.android.B1Instrumentation'
    signer = Path(ENV['ANDROID_HOME']) / 'build-tools/36.0.0/apksigner'
    signatures = {name: output([signer, 'verify', '--verbose', '--print-certs', path]) for name, path in [('product', product), ('test', test)]}
    certificates = {name: re.findall(r'Signer #1 certificate SHA-256 digest: ([0-9a-fA-F]+)', text) for name, text in signatures.items()}
    assert len(certificates['product']) == 1 and certificates['test'] == certificates['product'], 'Product/test signing identity mismatch'
    definitions = {name: output([analyzer, 'dex', 'packages', '--defined-only', path]) for name, path in [('product', product), ('test', test)]}
    for class_name in ['B1Instrumentation', 'B1DeviceControlTest', 'B2ShareReceiver', 'B2DocumentsProvider']:
        expected = 'com.silverhand.android.' + class_name
        assert re.search(r'\b' + re.escape(expected) + r'\b', definitions['test']), 'Missing defined test class ' + expected
        assert not re.search(r'\b' + re.escape(expected) + r'\b', definitions['product']), 'Test class leaked into product ' + expected
    assert test_root.attrib['package'] == pkg + '.test'
    assert not any(p.attrib.get(ns + 'name', '').startswith('com.silverhand.android.B2') for p in product_root.findall('.//provider'))
    return {'product': {'path': str(product), 'sha256': digest(product)},
            'test': {'path': str(test), 'sha256': digest(test)},
            'manifests': xml, 'file_provider_paths': paths, 'signatures': signatures,
            'target_package': pkg, 'test_classes_defined_only': True}


def inject_startup_diagnostic(index, nonce):
    assert re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9-]*', nonce), 'Invalid startup diagnostic identity'
    assert 'b2-appearance-startup.js' not in index and 'data-b2-startup-diagnostic' not in index, 'Startup diagnostic already injected'
    modules = list(re.finditer(r'<script\b[^>]*\btype=[\'"]module[\'"][^>]*>', index))
    assert len(modules) == 1, 'Expected one main module script'
    tag = '<script src="/b2-appearance-startup.js" data-b2-startup-diagnostic="' + nonce + '"></script>\n'
    return index[:modules[0].start()] + tag + index[modules[0].start():]


def validate_startup_diagnostic(run, baseline):
    assert baseline.get('kind') == 'appearance-startup' and baseline.get('diagnostic_only') is True, 'Expected diagnostic-only binding'
    assert digest(run / 'b2-binding.json') == baseline['normal_binding_sha256'], 'Normal product binding changed'
    normal = json.loads((run / 'b2-binding.json').read_text())
    base = Path(normal['packages']['product']['path'])
    assert digest(base) == normal['packages']['product']['sha256'] == baseline['base_product_sha256'], 'Normal product was not restored'
    nonce = baseline['nonce']
    assert re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9-]*', nonce), 'Invalid diagnostic identity'
    product = Path(baseline['packages']['product']['path'])
    assert product.resolve() == (run / 'diagnostics' / nonce / 'app-acceptance.apk').resolve() and not product.is_symlink(), 'Diagnostic APK must stay in its owned isolated directory'
    assert digest(product) == baseline['packages']['product']['sha256'], 'Diagnostic APK changed'
    script = (APP / 'scripts/appearance-startup-diagnostic.js').read_bytes()
    assert hashlib.sha256(script).hexdigest() == baseline['startup_script_sha256'], 'Diagnostic script changed'
    with zipfile.ZipFile(base) as original, zipfile.ZipFile(product) as diagnostic:
        prefix = 'assets/public/'
        base_web = {n: original.read(n) for n in original.namelist() if n.startswith(prefix) and not n.endswith('/')}
        expected = dict(base_web)
        expected[prefix + 'index.html'] = inject_startup_diagnostic(base_web[prefix + 'index.html'].decode(), nonce).encode()
        expected[prefix + 'b2-appearance-startup.js'] = script
        actual = {n: diagnostic.read(n) for n in diagnostic.namelist() if n.startswith(prefix) and not n.endswith('/')}
        assert actual == expected, 'Diagnostic Web assets differ outside the reviewed bootstrap injection'
        native = lambda archive: {n: hashlib.sha256(archive.read(n)).hexdigest() for n in archive.namelist() if (n.startswith('classes') and n.endswith('.dex')) or n.startswith('lib/') or n in ['assets/acceptance-ca.pem', 'assets/capacitor.config.json', 'assets/capacitor.plugins.json']}
        assert native(original) == native(diagnostic), 'Diagnostic native/config/CA payload changed'
    return {'kind': 'appearance-startup', 'nonce': nonce, 'startup_script_sha256': baseline['startup_script_sha256']}


def restore_normal_product(run):
    normal = json.loads((run / 'b2-binding.json').read_text())['packages']['product']
    assert digest(normal['path']) == normal['sha256'], 'Restoration APK changed'
    adb('install', '-r', normal['path'])
    paths = adb('shell', 'pm', 'path', 'com.silverhand.android.stage1').splitlines()
    assert len(paths) == 1 and paths[0].startswith('package:'), 'Restored package path unknown'
    actual = adb('shell', 'sha256sum', paths[0][len('package:'):]).split()
    assert actual and actual[0] == normal['sha256'], 'Restored installed product digest mismatch'



COVERAGE_DIAGNOSTICS = ('coverage-short', 'coverage-bars', 'coverage-b1')
DIAGNOSTICS = ('appearance-startup', 'appearance-short', 'photo-picker-menu') + COVERAGE_DIAGNOSTICS


def coverage_metadata(table, diagnostic):
    if diagnostic not in COVERAGE_DIAGNOSTICS:
        return None
    full = table['original12'] + ['B2.' + row['id'] for row in table['B2'] if row['scope'] == 'device'] + ['B1.' + table['B1'][i - 1] for i in table['B1_affected']]
    selected = table['diagnostics'][diagnostic]
    return {'kind': 'grouped', 'selector': diagnostic, 'planned': len(selected), 'selected_ids': selected,
            'ordinary33_count': len(full), 'ordinary33_selected': [name for name in full if name in selected],
            'ordinary33_not_selected': [name for name in full if name not in selected],
            'partial_of': table.get('coverage_partial', {}).get(diagnostic), 'group_counts_not_aggregated': True}


def coverage_attempt_paths(run, evidence, attempt):
    assert re.fullmatch(r'device-[0-9]{3,}', attempt), 'Invalid grouped coverage attempt'
    run, evidence = Path(run).resolve(), Path(evidence).resolve()
    inner = run / 'acceptance/attempts' / attempt
    outer = evidence / ('device-entry-' + attempt.removeprefix('device-'))
    assert inner.resolve() == inner and outer.resolve() == outer, 'Coverage output symlink or path mismatch'
    return inner, outer


def validate_coverage_inner(run, attempt, diagnostic, out, raw):
    assert diagnostic in COVERAGE_DIAGNOSTICS, 'Unknown grouped coverage selector'
    assert re.fullmatch(r'device-[0-9]{3,}', attempt), 'Invalid grouped coverage attempt'
    inner = Path(run).resolve() / 'acceptance/attempts' / attempt
    assert Path(out) == inner and inner.resolve() == inner, 'Inner attempt output mismatch'
    assert raw['suite'] == 'b2-diagnostic' and raw['diagnostic'] == diagnostic, 'Inner selector mismatch'
    table = json.loads((APP / 'scripts/acceptance-scenarios.json').read_text())
    assert [row['id'] for row in raw['steps']] == table['diagnostics'][diagnostic], 'Coverage case set mismatch'
    assert raw['coverage'] == coverage_metadata(table, diagnostic), 'Coverage metadata mismatch'
    node = raw['entry']
    expected = [str(ENV['NODE_BIN']), str(APP / 'scripts/acceptance.mjs'), 'b2', str(inner), diagnostic]
    if node.get('launched'):
        assert node['command'] == expected, 'Node output/selector mismatch'
        assert node['writer_exited'], 'Node writer exit unconfirmed'
    else:
        assert raw['status'] == 'failed' and node.get('launched') is False and all(row['status'] == 'not_executed' for row in raw['steps']), 'Missing Node entry is not an executed result'
        if 'command' in node:
            assert node['command'] == expected and node['writer_exited'], 'Unlaunched Node command mismatch'
    return inner


def validate_coverage_seal(run, evidence, attempt, diagnostic):
    # Read-only gate: callers must pass this before writing any outer seal/index file.
    inner, outer = coverage_attempt_paths(run, evidence, attempt)
    expected = ['bash', str(APP / 'scripts/android.sh'), 'acceptance', Path(run).name,
                '--suite', 'b2', '--attempt', attempt, '--diagnostic', diagnostic]
    outer_raw = json.loads((outer / 'raw.json').read_text())
    assert outer_raw['entry']['command'] == expected, 'Outer attempt/selector command mismatch'
    assert outer_raw['entry']['writer_exited'], 'Outer writer exit unconfirmed'
    raw = json.loads((inner / 'raw.json').read_text())
    validate_coverage_inner(run, attempt, diagnostic, inner, raw)
    return inner, outer


def b3_selection(table, unit, selection_name=None):
    assert unit in ['search-normal', 'search-isolation', 'task-read', 'task-write'], 'Unknown B3 unit'
    assert selection_name is None or (unit == 'task-read' and selection_name == 'faults'), 'Unknown B3 fixed selection'
    selected = table['B3']['task-read-faults' if selection_name == 'faults' else unit]
    preconditions, cases = selected['preconditions'], selected['cases']
    prefix = 'T2' if unit == 'task-write' else 'T1' if unit == 'task-read' else 'S1' if unit == 'search-normal' else 'S2'
    expected = ['mobile-entry', 'query-results', 'empty-clear', 'message-navigation', 'back-and-ime'] if unit == 'search-normal' else ['loading-error-retry', 'query-switch', 'page-lifecycles', 'filters', 'logout-login-isolation']
    if unit == 'task-read':
        expected = ['mobile-board', 'filters-empty', 'detail-back', 'conversation-anchor', 'board-column-error', 'detail-error-retry']
    if unit == 'task-write':
        expected = ['create', 'edit-cancel-save', 'status', 'restore']
    if selection_name == 'faults':
        assert selected['unit'] == unit and selected['selector'] == selection_name, 'B3 fixed selection registry mismatch'
        expected = ['mobile-board', 'board-column-error', 'detail-error-retry']
    assert preconditions == ['PRE.' + prefix + '.fixture-login']
    assert cases == ['B3.' + prefix + '.' + name for name in expected]
    return {**({'selector': selection_name} if selection_name is not None else {}), 'kind': 'independent-unit', 'unit': unit, 'precondition_ids': preconditions, 'business_ids': cases,
            'planned_preconditions': len(preconditions), 'planned_business': len(cases),
            'selected_ids': preconditions + cases, 'not_selected': selected['not_selected'],
            'historical_passes_used': False, 'credit': selected['credit']}


def b3_attempt_paths(run, evidence, attempt, unit):
    assert unit in ['search-normal', 'search-isolation', 'task-read', 'task-write'], 'Unknown B3 unit'
    assert attempt and re.fullmatch(r'device-[0-9]{3,}', attempt), 'Invalid B3 attempt'
    inner = run / 'acceptance/b3' / unit / 'attempts' / attempt
    outer = evidence / ('device-entry-' + attempt.removeprefix('device-'))
    assert inner.resolve() == inner.absolute() and outer.resolve() == outer.absolute(), 'B3 output identity changed'
    return inner, outer


def validate_b3_inner(run, attempt, unit, binding, out, raw, selection_name=None):
    assert out == b3_attempt_paths(run, out.parent, attempt, unit)[0], 'B3 output path changed'
    table = json.loads((APP / 'scripts/acceptance-scenarios.json').read_text())
    metadata = b3_selection(table, unit, selection_name)
    assert raw['suite'] == 'b3' and raw['unit'] == unit and raw['selection'] == metadata, 'B3 selection mismatch'
    assert [row['id'] for row in raw['steps']] == metadata['selected_ids'], 'B3 case identity mismatch'
    expected = list(map(str, [ENV['NODE_BIN'], APP / 'scripts/acceptance.mjs', 'b3', out, unit] + ([selection_name] if selection_name is not None else [])))
    if raw['entry']['launched']:
        assert raw['entry']['command'] == expected and raw['entry']['writer_exited'], 'B3 writer/command mismatch'
        if unit == 'search-isolation':
            assert raw.get('controls') == {'manifest': str(out / 's2-control.json'), 'events': str(out / 's2-proxy-events.jsonl'), 'default_transparent': True, 'receive_budget_ms': 20000}, 'S2 control/output identity mismatch'
        if unit == 'task-read':
            assert raw.get('controls') == {'manifest': str(out / 't1-control.json'), 'events': str(out / 't1-proxy-events.jsonl'), 'default_transparent': True, 'receive_budget_ms': 20000}, 'T1 control/output identity mismatch'
        if unit == 'task-write':
            assert raw.get('observer') == {'manifest': str(out / 't2-observer-private.json'), 'events': str(out / 't2-events.jsonl')}, 'T2 observer/output identity mismatch'
            assert 'controls' not in raw, 'T2 must not inherit T1/S2 controls'
            assert raw.get('bindings', {}).get('product_origin') is not None, 'T2 requires a reviewed new product origin'
    else:
        assert raw['status'] == 'failed' and all(row['status'] == 'not_executed' for row in raw['steps']), 'Unlaunched B3 case credited'
    if raw.get('bindings'):
        assert raw['bindings']['reviewed_binding'] == {'path': str(binding), 'sha256': digest(binding)}, 'B3 binding changed during attempt'
        origin = raw['bindings'].get('product_origin')
        if origin is not None:
            assert origin == json.loads(Path(binding).read_text())['product_origin'] and unit in ORIGIN_EVIDENCE_UNITS, 'New origin binding differs'
            expected = origin_expected_packages(origin, unit)
            assert expected == (raw['bindings']['packages']['product']['sha256'], raw['bindings']['packages']['test']['sha256']), 'Origin package binding differs'
            pre = next(row for row in raw['steps'] if row['id'] == ORIGIN_EVIDENCE_UNITS[unit][0])
            if pre['status'] == 'passed':
                validate_new_origin_evidence(out, origin, raw, unit)


def acceptance_b2(run, attempt, diagnostic=None, *, unit=None, binding=None, selection_name=None):
    assert selection_name is None or (unit == 'task-read' and selection_name == 'faults'), 'Unknown B3 fixed selection'
    configure(run)
    assert attempt and re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]*', attempt), 'Supply a unique acceptance attempt'
    b3 = unit is not None
    assert b3 == (binding is not None), 'B3 requires explicit independent binding'
    assert not b3 or diagnostic is None, 'B3 cannot select B2 diagnostics'
    out = b3_attempt_paths(run, run, attempt, unit)[0] if b3 else run / 'acceptance/attempts' / attempt
    out.mkdir(mode=0o700, parents=True, exist_ok=False)
    table = json.loads((APP / 'scripts/acceptance-scenarios.json').read_text())
    assert diagnostic is None or diagnostic in DIAGNOSTICS, 'Unknown diagnostic selection'
    selection = b3_selection(table, unit, selection_name) if b3 else None
    names = selection['selected_ids'] if b3 else table['diagnostics'][diagnostic] if diagnostic else table['original12'] + ['B2.' + row['id'] for row in table['B2'] if row['scope'] == 'device'] + ['B1.' + table['B1'][i - 1] for i in table['B1_affected']]
    initial = {'suite': 'b2-diagnostic' if diagnostic else 'b2', 'diagnostic': diagnostic, 'status': 'preflight', 'entry': {'launched': False, 'raw_returncode': None}, 'steps': [{'id': name, 'status': 'not_executed'} for name in names]}
    if b3:
        initial.update(suite='b3', unit=unit, selection=selection)
    coverage = coverage_metadata(table, diagnostic)
    if coverage is not None:
        initial['coverage'] = coverage
    write(out / 'raw.json', initial)
    process = log = None
    primary = None
    services_started = False
    writer_exited = True
    startup_diagnostic = diagnostic == 'appearance-startup'
    binding_file = Path(binding) if b3 else run / ('b2-startup-diagnostic-binding.json' if startup_diagnostic else 'b2-binding.json')
    try:
        assert shutil.disk_usage(ENV_ROOT).free >= 20 * 1024**3, 'Less than 20 GiB free'
        if b3:
            assert binding_file.is_absolute() and binding_file.resolve() == binding_file, 'B3 binding path changed'
        baseline = json.loads(binding_file.read_text())
        if b3:
            assert baseline['kind'] == 'b3-unit' and baseline['unit'] == unit and baseline['run'] == str(run), 'Wrong B3 binding'
            assert baseline['selection'] == selection, 'Reviewed B3 selection changed'
        assert baseline['inputs'] == apk_resume_inputs(), 'Reviewed source/config changed'
        startup = validate_startup_diagnostic(run, baseline) if startup_diagnostic else None
        packages = b2_package_check(run, Path(baseline['packages']['product']['path'])) if startup_diagnostic or b3 and baseline.get('product_origin') else b2_package_check(run)
        assert packages == baseline['packages'], 'B2 packages changed after binding'
        raw = json.loads((out / 'raw.json').read_text())
        raw['bindings'] = {'packages': packages, 'ca': ca_check(run, Path(packages['product']['path']))}
        if b3:
            assert raw['bindings']['ca'] == baseline['ca'], 'B3 reviewed CA changed'
            raw['bindings']['reviewed_binding'] = {'path': str(binding_file), 'sha256': digest(binding_file)}
            origin = baseline.get('product_origin')
            if unit == 'task-write':
                assert origin is not None, 'T2 requires a reviewed new product origin'
            if origin is not None:
                assert unit == 'task-write' and selection_name is None or unit == 'task-read' and selection_name == 'faults', 'New origin requires exact T1 faults or T2 selection'
                expected = origin_expected_packages(origin, unit)
                assert expected == (packages['product']['sha256'], packages['test']['sha256']), 'Origin package binding differs'
                assert origin['ca_sha256'] == raw['bindings']['ca']['ca_sha256'], 'Origin CA binding differs'
                raw['bindings']['product_origin'] = origin
        if startup_diagnostic:
            raw['bindings']['startup_diagnostic'] = startup
        write(out / 'raw.json', raw)
        for port in [18480, 29443, 19322, 5584, 5585]:
            with socket.socket() as probe:
                assert probe.connect_ex(('127.0.0.1', port)) != 0, 'Port already owned: ' + str(port)
        for service in ['backend', 'proxy']:
            assert not (run / 'acceptance' / (service + '.pid')).exists(), 'Previous service record remains'
        prepare = ['python3', str(APP / 'scripts/prepare-acceptance.py')]
        if b3 and unit == 'search-isolation':
            control, events = out / 's2-control.json', out / 's2-proxy-events.jsonl'
            write(control, {'version': 1, 'unit': unit, 'attempt': attempt, 'active': False, 'users': [], 'queries': [], 'rules': [], 'release': [], 'retry': []})
            control.chmod(0o600)
            prepare += ['--search-control', str(control), '--search-events', str(events)]
            raw['controls'] = {'manifest': str(control), 'events': str(events), 'default_transparent': True, 'receive_budget_ms': 20000}
            write(out / 'raw.json', raw)
        if b3 and unit == 'task-read':
            control, events = out / 't1-control.json', out / 't1-proxy-events.jsonl'
            write(control, {'version': 1, 'unit': unit, 'attempt': attempt, 'active': False, 'users': [], 'taskIds': [], 'channelIds': [], 'workspaceId': None, 'routes': [], 'faultTargets': {'columnChannelId': None, 'detailTaskId': None}, 'rules': [], 'release': [], 'disarmed': [], 'releaseAll': False})
            control.chmod(0o600)
            prepare += ['--task-control', str(control), '--task-events', str(events)]
            raw['controls'] = {'manifest': str(control), 'events': str(events), 'default_transparent': True, 'receive_budget_ms': 20000}
            write(out / 'raw.json', raw)
        if b3 and unit == 'task-write':
            observer, events = out / 't2-observer-private.json', out / 't2-events.jsonl'
            write(observer, {'version': 1, 'unit': 'task-write', 'active': False})
            observer.chmod(0o600)
            prepare += ['--task-write-observer', str(observer), '--task-write-events', str(events)]
            raw['observer'] = {'manifest': str(observer), 'events': str(events)}
            write(out / 'raw.json', raw)
        new_origin = raw.get('bindings', {}).get('product_origin')
        if new_origin:
            prepare += ['--existing-ca', '--task-tls-events', str(out / ('t2-tls-events.jsonl' if unit == 'task-write' else 't1-tls-events.jsonl'))]
        services_started = True
        with (out / 'log.txt').open('a') as target:
            subprocess.run(prepare, cwd=REPO, env=ENV, stdin=subprocess.DEVNULL,
                           stdout=target, stderr=subprocess.STDOUT, check=True, timeout=60)
        wait_services()
        assert ca_check(run, Path(packages['product']['path'])) == raw['bindings']['ca'], 'CA changed during service preparation'
        process, log = boot(out, log_path=out / 'log.txt')
        device = json.loads((out / 'emulator.json').read_text())
        assert type(device.get('pid')) is int and device['pid'] > 1 and device['pid'] == process.pid, 'Owned emulator PID differs from boot process'
        assert adb('shell', 'getprop', 'ro.build.version.sdk') == '36', 'Expected API36'
        raw['device'] = device
        write(out / 'raw.json', raw)
        (out / 'emulator.json').unlink()
        adb('install', '-r', packages['product']['path'])
        adb('install', '-r', packages['test']['path'])
        adb('reverse', 'tcp:29443', 'tcp:29443')
        if new_origin:
            try:
                new_origin_device_preconditions(SimpleNamespace(ENV=ENV, REPO=REPO, adb=adb, write=write, wait_for_webview=wait_for_webview), out, new_origin, unit)
            finally:
                precondition_file = out / 'origin-device-preconditions.json'
                if precondition_file.exists():
                    raw['new_origin_device_preconditions'] = json.loads(precondition_file.read_text())
                    write(out / 'raw.json', raw)
        if not new_origin:
            adb('shell', 'am', 'start', '-n', 'com.silverhand.android.stage1/com.silverhand.android.MainActivity')
            wait_for_webview(run)
        writer_exited = False  # Ownership remains with Node until explicitly confirmed.
        command = [ENV['NODE_BIN'], APP / 'scripts/acceptance.mjs', 'b3' if b3 else 'b2', out] + ([unit] + ([selection_name] if selection_name is not None else []) if b3 else [diagnostic] if diagnostic else [])
        entry = record_entry(command, out)
        writer_exited = entry['writer_exited']
        assert writer_exited, 'Action writer exit unconfirmed; raw merge deferred'
        raw = json.loads((out / 'raw.json').read_text())
        assert entry['raw_returncode'] == 0 and entry['collector_error'] is None, 'Acceptance entry failed'
        assert raw['status'] == 'passed' and all(row['status'] == 'passed' for row in raw['steps']), 'Actions did not all pass'
    except BaseException as error:
        primary = error
        result_file = out / ('raw.json' if writer_exited else 'entry-unmerged.json')
        raw = json.loads(result_file.read_text()) if result_file.exists() else {}
        raw.setdefault('first_error', {'type': type(error).__name__, 'message': str(error)})
        raw['status'] = 'failed'
        write(result_file, raw)
        raise
    finally:
        actions = []
        if process is not None:
            actions = [('clear-test-login', lambda: adb('shell', 'pm', 'clear', 'com.silverhand.android.stage1')),
                       ('remove-test-components', lambda: adb('uninstall', 'com.silverhand.android.stage1.test')),
                       ('remove-forward', lambda: adb('forward', '--remove', 'tcp:19322')),
                       ('remove-reverse', lambda: adb('reverse', '--remove', 'tcp:29443')),
                       ('stop-owned-emulator', lambda: stop_emulator(process, log))]
            if diagnostic == 'appearance-startup':
                actions.insert(-1, ('restore-normal-product', lambda: restore_normal_product(run)))
        try:
            finish_cleanup(run if services_started else out, actions, primary)
        finally:
            result_file = out / ('raw.json' if writer_exited else 'entry-unmerged.json')
            raw = json.loads(result_file.read_text()) if result_file.exists() else {}
            cleanup_file = (run if services_started else out) / 'cleanup.json'
            raw['cleanup'] = json.loads(cleanup_file.read_text())
            if raw['cleanup']['status'] != 'passed':
                raw['status'] = 'failed'
                raw.setdefault('first_error', {'type': 'CleanupError', 'message': 'Owned cleanup failed; see cleanup'})
            final_observer_error = None
            if b3 and unit == 'task-write' and writer_exited and raw.get('status') == 'passed':
                try:
                    raw['final_observer_validation'] = validate_t2_final_events(out)
                except Exception as error:
                    final_observer_error = error
                    raw['status'] = 'failed'
                    raw.setdefault('first_error', {'type': type(error).__name__, 'message': str(error)})
                    raw['final_observer_validation'] = {'status': 'failed', 'error': str(error)}
            write(result_file, raw)
            if cleanup_file.parent == out:
                cleanup_file.unlink()  # Its full result is now in raw, not a second result file.
            if writer_exited:
                if b3:
                    validate_b3_inner(run, attempt, unit, binding_file, out, raw, selection_name)
                if diagnostic in COVERAGE_DIAGNOSTICS:
                    validate_coverage_inner(run, attempt, diagnostic, out, raw)
                statuses = ['passed', 'failed', 'running', 'not_executed']
                counts = {'planned': len(raw['steps']), **{status: sum(row['status'] == status for row in raw['steps']) for status in statuses}}
                counts['groups'] = {group: {status: sum(row['status'] == status and (row['id'].split('.')[0] if '.' in row['id'] else 'original12') == group for row in raw['steps']) for status in statuses} for group in (['PRE', 'B3'] if b3 else ['original12', 'B1', 'B2'] + (['DIAG'] if diagnostic else []))}
                write(out / 'counts.json', counts)
                # One top-level checksum list; APKs are referenced at their build outputs.
                paths = sorted(p for p in out.rglob('*') if p.is_file() and p.name != 'SHA256SUMS')
                (out / 'SHA256SUMS').write_text(''.join(digest(p) + '  ' + str(p.relative_to(out)) + '\n' for p in paths))
                if final_observer_error is not None and primary is None:
                    raise final_observer_error
            else:
                raw['seal_deferred'] = 'Action writer may still be active; raw/counts/log are not finalized'
                write(result_file, raw)



def acceptance(run, suite="original12", attempt=None, diagnostic=None, unit=None, binding=None, selection_name=None):
    if suite == "b3":
        return acceptance_b2(run, attempt, unit=unit, binding=binding, selection_name=selection_name)
    assert unit is None and binding is None and selection_name is None, 'Unit/binding/selection are restricted to B3'
    if suite == "b2":
        return acceptance_b2(run, attempt, diagnostic)
    assert diagnostic is None, 'Diagnostics require --suite b2'
    configure(run)
    assert (run / 'build-complete.json').exists(), 'A3 must pass first'
    preflight()
    ca_check(run)
    process = log = None
    try:
        step(run, 'restart-services', ['python3', APP / 'scripts/prepare-acceptance.py'])
        wait_services()
        process, log = boot(run)
        adb('install', '-r', str(run / 'app-build/outputs/apk/acceptance/app-acceptance.apk'))
        adb('reverse', 'tcp:29443', 'tcp:29443')
        adb('shell', 'am', 'start', '-n', 'com.silverhand.android.stage1/com.silverhand.android.MainActivity')
        wait_for_webview(run)
        step(run, 'closed-loop', [ENV['NODE_BIN'], APP / 'scripts/acceptance.mjs'])
    finally:
        actions = []
        if process is not None:
            actions = [
                ('clear-test-profile', lambda: adb('shell', 'pm', 'clear', 'com.silverhand.android.stage1')),
                ('remove-forward', lambda: adb('forward', '--remove', 'tcp:19322')),
                ('remove-reverse', lambda: adb('reverse', '--remove', 'tcp:29443')),
                ('stop-emulator', lambda: stop_emulator(process, log)),
            ]
        finish_cleanup(run, actions, sys.exception())


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['preflight', 'emulator-check', 'build', 'resume-host', 'resume-android', 'resume-apk', 'acceptance'])
    parser.add_argument('name', nargs='?')
    parser.add_argument('--attempt')
    parser.add_argument('--suite', choices=['original12', 'b2', 'b3'], default='original12')
    parser.add_argument('--diagnostic', choices=DIAGNOSTICS)
    parser.add_argument('--unit', choices=['search-normal', 'search-isolation', 'task-read', 'task-write'])
    parser.add_argument('--selection', dest='selection_name', choices=['faults'])
    parser.add_argument('--binding', type=Path)
    parser.add_argument('--reviewed-inputs', type=Path)
    parser.add_argument('--resume-baseline', type=Path)
    args = parser.parse_args()
    if args.suite == 'b3' and (args.action != 'acceptance' or not args.unit or not args.binding):
        parser.error('B3 is acceptance-only and requires --unit/--binding')
    if (args.unit or args.binding) and (args.action != 'acceptance' or args.suite != 'b3'):
        parser.error('--unit/--binding are restricted to acceptance --suite b3')
    if args.selection_name is not None and (args.action != 'acceptance' or args.suite != 'b3' or args.unit != 'task-read'):
        parser.error('--selection faults requires acceptance --suite b3 --unit task-read')
    if args.diagnostic and (args.action != 'acceptance' or args.suite != 'b2'):
        parser.error('--diagnostic is restricted to acceptance --suite b2')
    if args.action == 'preflight':
        print(json.dumps(preflight(), indent=2))
    else:
        assert args.name and re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]*', args.name), 'supply a simple new run name'
        run = ENV_ROOT / 'runs' / args.name
        if args.action == 'acceptance':
            acceptance(run, args.suite, args.attempt, args.diagnostic, args.unit, args.binding, args.selection_name)
        elif args.action in {'resume-host', 'resume-android', 'resume-apk'}:
            assert args.resume_baseline, 'supply the reviewed checkpoint baseline'
            resume_build(run, args.attempt, args.resume_baseline, args.action.removeprefix('resume-'), args.suite, args.reviewed_inputs)
        else:
            run.mkdir(mode=0o700, parents=True, exist_ok=False)
            if args.action == 'build':
                if args.suite == 'b2':
                    assert shutil.disk_usage(ENV_ROOT).free >= 20 * 1024**3, 'Less than 20 GiB free'
                    assert args.reviewed_inputs, 'B2 build requires reviewed source/config baseline'
                    inputs = json.loads(args.reviewed_inputs.read_text())
                    assert apk_resume_inputs() == inputs, 'B2 reviewed inputs changed'
                    write(run / 'reviewed-inputs.json', {'path': str(args.reviewed_inputs), 'sha256': digest(args.reviewed_inputs)})
                build(run)
                if args.suite == 'b2':
                    finish_b2_packages(run, inputs)
            else:
                write(run / 'preflight.json', preflight())
                process, log = boot(run)
                stop_emulator(process, log)
                write(run / 'cleanup.json', {'emulator_stopped': process.poll() is not None})
