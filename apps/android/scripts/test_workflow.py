"""Targeted failure-path tests; no app build or real backend is used."""
import importlib.util
import io
import json
import os
import runpy
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile
from contextlib import contextmanager
from unittest.mock import patch
from build_environment import build_environment

os.environ.setdefault('SILVERHAND_ANDROID_HOME', str(Path.home() / 'Library/Developer/SilverhandAndroid'))
spec = importlib.util.spec_from_file_location('workflow', Path(__file__).with_name('workflow.py'))
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)


class WorkflowFailures(unittest.TestCase):
    def keep_evidence(self, name, data):
        destination = os.environ.get('SILVERHAND_ANDROID_TEST_EVIDENCE')
        if destination:
            path = Path(destination)
            path.mkdir(parents=True, exist_ok=True)
            (path / (name + '.json')).write_text(json.dumps(data, indent=2) + '\n')

    def test_cleanup_attempts_all_actions_and_preserves_primary(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'build-complete.json').write_text('{}')
            calls = []

            def adb(*args):
                calls.append(args)
                if args[0] == 'install':
                    raise RuntimeError('ORIGINAL_INSTALL_FAILURE')
                if args[:3] == ('shell', 'pm', 'clear'):
                    raise RuntimeError('PM_CLEAR_FAILURE')
                if args[:2] == ('forward', '--remove'):
                    raise RuntimeError('FORWARD_REMOVE_FAILURE')
                return ''

            with patch.object(w, 'preflight'), patch.object(w, 'ca_check'), \
                 patch.object(w, 'step'), patch.object(w, 'wait_services'), \
                 patch.object(w, 'boot', return_value=(object(), io.StringIO())), \
                 patch.object(w, 'adb', side_effect=adb), \
                 patch.object(w, 'stop_emulator', side_effect=RuntimeError('EMULATOR_STOP_FAILURE')) as stop, \
                 patch.object(w, 'cleanup_services', return_value={'status': 'passed', 'services': []}) as services:
                with self.assertRaisesRegex(RuntimeError, '^ORIGINAL_INSTALL_FAILURE$'):
                    w.acceptance(root)
                services.assert_called_once_with(root)
                stop.assert_called_once()
            self.assertIn(('reverse', '--remove', 'tcp:29443'), calls)
            report = json.loads((root / 'cleanup.json').read_text())
            self.assertIn('ORIGINAL_INSTALL_FAILURE', report['primary_error'])
            self.assertEqual(report['status'], 'failed')
            self.assertEqual(len([a for a in report['actions'] if a['status'] == 'failed']), 3)
            self.keep_evidence('primary-and-cleanup-errors', report)

    def spawn_probe(self, root, service, owned=True):
        marker = str(w.APP / 'scripts/acceptance-server.mjs') if service == 'proxy' else str(root / 'backend-build/debug/silverhand-backend')
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)',
                                  marker if owned else 'unrelated-test-process'],
                                 start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        directory = root / 'acceptance'
        directory.mkdir(exist_ok=True)
        (directory / (service + '.pid')).write_text(str(child.pid))
        return child

    def stop_probe(self, child):
        if child.poll() is None:
            child.terminate()
        child.wait(timeout=5)

    def test_owned_services_are_absent_and_pid_files_removed(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            children = [self.spawn_probe(root, name) for name in ['proxy', 'backend']]
            try:
                result = w.cleanup_services(root)
                self.assertEqual(result['status'], 'passed')
                self.assertFalse(list((root / 'acceptance').glob('*.pid')))
                for child in children:
                    with self.assertRaises(ProcessLookupError):
                        os.kill(child.pid, 0)
                self.keep_evidence('owned-service-exit', {
                    'cleanup': result, 'independently_observed_absent_pids': [p.pid for p in children],
                    'pid_files_remaining': 0, 'real_backend_used': False})
            finally:
                for child in children:
                    self.stop_probe(child)

    def test_wrong_owner_is_not_signalled_and_other_service_still_stops(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            foreign = self.spawn_probe(root, 'proxy', owned=False)
            managed = self.spawn_probe(root, 'backend')
            try:
                result = w.cleanup_services(root)
                self.assertEqual(result['status'], 'failed')
                self.assertIsNone(foreign.poll())
                self.assertTrue((root / 'acceptance/proxy.pid').exists())
                self.assertFalse((root / 'acceptance/backend.pid').exists())
                with self.assertRaises(ProcessLookupError):
                    os.kill(managed.pid, 0)
                self.keep_evidence('ownership-protection', {
                    'cleanup': result, 'foreign_process_alive': foreign.poll() is None,
                    'managed_process_absent': True})
            finally:
                self.stop_probe(foreign)
                self.stop_probe(managed)

    def test_signal_exit_race_is_verified_as_absent(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            child = self.spawn_probe(root, 'backend')
            original = os.killpg

            def exit_during_signal(pid, sig):
                original(pid, sig)
                raise ProcessLookupError('injected signal/exit race')

            try:
                with patch.object(w.os, 'killpg', side_effect=exit_during_signal):
                    self.assertEqual(w.cleanup_services(root)['status'], 'passed')
                self.assertFalse((root / 'acceptance/backend.pid').exists())
                with self.assertRaises(ProcessLookupError):
                    os.kill(child.pid, 0)
                self.keep_evidence('signal-exit-race', {'process_absent': True, 'pid_file_removed': True})
            finally:
                self.stop_probe(child)

    def test_cleanup_failure_cannot_report_a_successful_run(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with patch.object(w, 'cleanup_services', return_value={'status': 'failed', 'services': []}):
                with self.assertRaisesRegex(RuntimeError, 'Cleanup failed'):
                    w.finish_cleanup(root, [], None)
            self.assertEqual(json.loads((root / 'cleanup.json').read_text())['status'], 'failed')
            self.keep_evidence('cleanup-blocks-success', json.loads((root / 'cleanup.json').read_text()))

    def test_startup_timeout_is_unclassified_and_keeps_bounded_diagnostics(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            fake = subprocess.CompletedProcess([], 1, 'FATAL EXCEPTION fixture\nBearer secret-fixture', '')
            with patch.dict(w.ENV, ANDROID_HOME='/test-sdk', ANDROID_SERIAL='emulator-5584'), \
                 patch.object(w.time, 'monotonic', side_effect=[0, 61]), \
                 patch.object(w.subprocess, 'run', return_value=fake):
                with self.assertRaisesRegex(RuntimeError, '^Unclassified PID/WebView/CDP startup timeout'):
                    w.wait_for_webview(root)
            report = json.loads((root / 'startup-failure.json').read_text())
            self.assertEqual(report['classification'], 'unclassified')
            self.assertEqual(set(report['commands']), {'app_process', 'logcat_tail'})
            self.assertIn('FATAL EXCEPTION', report['commands']['logcat_tail']['output'])
            self.assertNotIn('secret-fixture', json.dumps(report))
            self.assertEqual(set(report['ports']), {'18480', '29443', '19322', '5584'})
            self.keep_evidence('unclassified-startup', report)

    def test_child_environment_sentinels_never_reach_any_plugin_state(self):
        sentinels = {'SILVERHAND_AUTH_TOKEN': 'fake-session-sentinel',
                     'WEREAD_API_KEY': 'fake-api-sentinel',
                     'UNRELATED_FUTURE_CREDENTIAL': 'fake-unknown-sentinel',
                     'CARGO_REGISTRIES_PRIVATE_TOKEN': 'fake-cargo-sentinel'}
        parent = {'PATH': os.environ['PATH'], 'HOME': str(Path.home()),
                  'ANDROID_HOME': '/selected-sdk', **sentinels}
        original = parent.copy()
        selected = build_environment(parent)
        self.assertEqual(parent, original)
        self.assertTrue(all(k not in selected for k in sentinels))
        self.assertEqual(selected['ANDROID_HOME'], '/selected-sdk')
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            probe = '''import os,json,sys
from pathlib import Path
root=Path(sys.argv[1])
for name in ['native/.build/plugins/cache/skipstone-state.json','cross/plugins/cache/skipbridge-state.json','nested/plugins/cache/other-state.json','native/.build/other-environment.json']:
 p=root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps({'environment':dict(os.environ)}))
'''
            subprocess.run([sys.executable, '-c', probe, str(root)], env=selected, check=True)
            states = sorted(root.glob('**/plugins/cache/*state.json'))
            artifacts = sorted(root.rglob('*.json'))
            self.assertEqual(len(states), 3)
            self.assertEqual(len(artifacts), 4)
            for path in artifacts:
                text = path.read_text()
                self.assertTrue(all(k not in text and v not in text for k, v in sentinels.items()))
            self.keep_evidence('child-environment-sentinels', {
                'all_plugin_states_checked': len(states), 'all_json_artifacts_checked': len(artifacts),
                'sensitive_names_found': 0, 'sentinel_values_found': 0,
                'tool_path_retained': True, 'parent_mapping_unchanged': parent == original,
                'actual_swift_build_run': False})
        with patch.dict(os.environ, sentinels):
            spec = importlib.util.spec_from_file_location('workflow_sentinel', Path(__file__).with_name('workflow.py'))
            isolated = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(isolated)
            self.assertTrue(all(k not in isolated.ENV for k in sentinels))
            self.assertTrue(all(os.environ[k] == v for k, v in sentinels.items()))


class HostResume(unittest.TestCase):
    def test_guard_rejects_changed_sources_plugin_and_first_evidence(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            repo, run = root / 'repo', root / 'run'
            app = repo / 'apps/android'
            (root / 'env.sh').write_text('original environment config')
            for path in [repo / 'apps/ios/native/Package.swift', app / 'native/Package.swift',
                         run / 'core-build/core/Package.swift', run / 'core-build/native/Package.swift',
                         app / 'toolchain-lock.json', app / 'scripts/core-extraction.patch',
                         app / 'scripts/write-protocol.mjs', repo / 'pnpm-lock.yaml',
                         repo / 'packages/shared/src/backend-admission.json', repo / 'packages/shared/src/api/paths.ts',
                         run / 'core-build/swift-host.log',
                         run / 'core-build/native/.build/plugins/cache/skipstone',
                         run / 'core-build/native/.build/plugins/cache/skipstone-state.json']:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('original')
            for name, code in [('dependencies', 0), ('core', 1)]:
                w.write(run / 'steps' / (name + '.json'), {'exit_code': code})
            with patch.object(w, 'REPO', repo), patch.object(w, 'APP', app), patch.object(w, 'ENV_ROOT', root):
                baseline = {'run': str(run), 'inputs': w.host_resume_inputs(run),
                            'first_evidence': {n: w.digest(run / n) for n in
                                ['steps/dependencies.json', 'steps/core.json', 'core-build/swift-host.log']},
                            'plugin_cache': {n: w.digest(run / n) for n in
                                ['core-build/native/.build/plugins/cache/skipstone',
                                 'core-build/native/.build/plugins/cache/skipstone-state.json']}}
                self.assertEqual(w.validate_host_resume(run, baseline)['status'], 'passed')
                for target in [run / 'core-build/core/Package.swift', app / 'toolchain-lock.json', root / 'env.sh',
                               run / 'core-build/native/.build/plugins/cache/skipstone', run / 'core-build/swift-host.log']:
                    with self.subTest(target=target):
                        original = target.read_bytes()
                        target.write_text('changed')
                        with self.assertRaises(RuntimeError):
                            w.validate_host_resume(run, baseline)
                        target.write_bytes(original)
                self.assertEqual(w.validate_host_resume(run, baseline)['status'], 'passed')

    def test_host_resume_does_not_regenerate_cache_or_overwrite_first_log(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            cache = root / 'native/.build/plugins/cache/skipstone'
            cache.parent.mkdir(parents=True)
            cache.write_text('allowed-first-binary')
            (root / 'core').mkdir()
            (root / 'core/source.swift').write_text('first-extracted-source')
            (root / 'swift-host.log').write_text('first-failure-log')
            before = {p: p.read_bytes() for p in [cache, root / 'core/source.swift', root / 'swift-host.log']}
            logs = root / 'attempt/core-logs'
            args = ['build-core.py', '--from-stage', 'host', '--configuration', 'release', '--log-dir', str(logs)]
            env = {'SILVERHAND_ANDROID_BUILD': str(root), 'SWIFT_ANDROID_TOOLCHAIN': '/pinned-toolchain',
                   'SWIFT_ANDROID_SDK_BUNDLE': '/existing-sdk', 'ANDROID_NDK_HOME': '/existing-ndk'}
            with patch.dict(os.environ, env), patch.object(sys, 'argv', args), \
                 patch('subprocess.run', return_value=subprocess.CompletedProcess([], 7)) as child, \
                 patch('shutil.copytree', side_effect=AssertionError('must not regenerate sources')), \
                 patch('shutil.rmtree', side_effect=AssertionError('must not remove existing trees')):
                with self.assertRaisesRegex(SystemExit, 'swift-host failed \\(7\\)'):
                    runpy.run_path(str(Path(__file__).with_name('build-core.py')), run_name='__main__')
            child.assert_called_once()
            self.assertEqual(child.call_args.args[0][0], '/pinned-toolchain/usr/bin/swift')
            self.assertFalse(child.call_args.kwargs['restore_signals'])
            raw = json.loads((logs / 'swift-host.exit.json').read_text())
            self.assertEqual(raw['raw_subprocess_returncode'], 7)
            self.assertIsNone(raw['signal_if_negative'])
            self.assertTrue(all(p.read_bytes() == b for p, b in before.items()))

    def test_resumed_pipeline_skips_install_and_keeps_remaining_A3_steps(self):
        for stage in ['host', 'android']:
            with self.subTest(checkpoint=stage), tempfile.TemporaryDirectory() as folder:
                self.check_resumed_pipeline(Path(folder), stage)

    def check_resumed_pipeline(self, run, stage):
        attempt = run / 'attempts/second'
        backend = run / 'backend-build/debug/silverhand-backend'
        backend.parent.mkdir(parents=True)
        backend.write_bytes(b'fixture-not-a-real-backend')
        with patch.dict(w.ENV, PNPM_BIN='/pnpm', SWIFT_ANDROID_TOOLCHAIN='/pinned',
                        NODE_BIN='/node', CARGO_BIN='/cargo', GRADLE_BIN='/gradle'), \
             patch.object(w, 'preflight', return_value={'fixture': True}), \
             patch.object(w, 'step') as step, patch.object(w, 'output', return_value='fixture-head'), \
             patch.object(w, 'wait_services'), patch.object(w, 'ca_check', return_value={}), \
             patch.object(w, 'finish_cleanup'):
            w.build(run, resume_attempt=attempt, resume_stage=stage)
        names = [call.args[1] for call in step.call_args_list]
        self.assertEqual(names, ['core', 'test-swift-version', 'host-tests', 'typecheck', 'platform-test',
                                 'ios-contracts', 'web', 'web-assets', 'backend-build', 'prepare-acceptance', 'apk'])
        self.assertTrue(all(call.args[0] == attempt for call in step.call_args_list))
        self.assertIn(stage, step.call_args_list[0].args[2])
        self.assertNotIn('host' if stage == 'android' else 'android', step.call_args_list[0].args[2])
        self.assertIn(attempt / 'core-logs', step.call_args_list[0].args[2])
        metadata = json.loads((run / 'build-complete.json').read_text())
        self.assertEqual(metadata['resumed_from_host'], stage == 'host')
        self.assertEqual(metadata['resumed_from_checkpoint'], stage)


class AndroidResume(unittest.TestCase):
    @contextmanager
    def fixture(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            repo, run = root / 'repo', root / 'runs/fixture-run'
            app = repo / 'apps/android'
            previous = run / 'attempts/002-host'
            paths = [repo / 'apps/ios/native/Package.swift', app / 'native/Package.swift',
                     run / 'core-build/core/Package.swift', run / 'core-build/native/Package.swift',
                     app / 'toolchain-lock.json', app / 'scripts/core-extraction.patch',
                     app / 'scripts/write-protocol.mjs', repo / 'pnpm-lock.yaml',
                     repo / 'packages/shared/src/backend-admission.json', repo / 'packages/shared/src/api/paths.ts',
                     root / 'env.sh', run / 'core-build/swift-host.log',
                     previous / 'core-logs/swift-host.log', previous / 'core-logs/swift-android-release.log',
                     previous / 'preflight.json',
                     run / 'core-build/native/.build/out/Products/Debug/libSilverhandCore.dylib',
                     run / 'core-build/native/.build/out/Products/Debug/SilverhandCore.o',
                     run / 'core-build/native/.build/plugins/outputs/native/generated.kt']
            for name in ['workflow.py', 'build-core.py', 'build_environment.py']:
                paths.append(app / 'scripts' / name)
            for scratch in ['native/.build', 'cross']:
                base = run / 'core-build' / scratch
                paths += [base / 'workspace-state.json', base / 'plugins/cache/skipstone',
                          base / 'plugins/cache/skipstone-state.json',
                          base / 'checkouts/skip/Plugins/SkipPlugin/SkipPlugin.swift']
                paths += [base / 'artifacts/skip/skip/skip.artifactbundle' / name
                          for name in ['info.json', 'bin/skip', 'macos/skip']]
            for path in paths:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('original fixture input')
            for path in [app / 'native/Package.resolved', run / 'core-build/native/Package.resolved']:
                w.write(path, {'pins': [{'identity': 'skip', 'state': {'revision': 'fixture-revision'}}]})
            for path, code in [(run / 'steps/dependencies.json', 0), (run / 'steps/core.json', 1),
                               (previous / 'steps/core.json', 1)]:
                w.write(path, {'exit_code': code})
            entry = root / 'evidence' / run.name / 'attempts/002-host/entry-exit.raw.json'
            w.write(entry, {'raw_subprocess_returncode': 1, 'stop_reason': None, 'stop_actions': []})
            host_command = list(map(str, [Path('/pinned/usr/bin/swift'), 'build', '--disable-sandbox',
                                         '--package-path', run / 'core-build/native', '--product', 'SilverhandCore']))
            android_command = host_command + list(map(str, ['-c', 'release', '--scratch-path', run / 'core-build/cross',
                '--swift-sdks-path', Path('/sdk'), '--swift-sdk', 'swift-6.4.1-RELEASE_android',
                '--triple', 'aarch64-unknown-linux-android28', '-Xswiftc', '-DSKIP_BRIDGE', '-Xswiftc', '-DTARGET_OS_ANDROID']))
            for name, code, command in [('swift-host', 0, host_command), ('swift-android-release', 1, android_command)]:
                w.write(previous / 'core-logs' / (name + '.exit.json'),
                        {'raw_subprocess_returncode': code, 'command': command, 'launch_error': None})
            with patch.object(w, 'REPO', repo), patch.object(w, 'APP', app), patch.object(w, 'ENV_ROOT', root), \
                 patch.dict(w.ENV, SWIFT_ANDROID_TOOLCHAIN='/pinned', SWIFT_ANDROID_SDK_BUNDLE='/sdk/bundle'), \
                 patch.object(w, 'output', side_effect=lambda cmd: 'fixture-revision' if 'rev-parse' in cmd else ''):
                inputs = w.host_resume_inputs(run)
                w.write(previous / 'resume-validation.json', {'baseline': {'inputs': inputs}})
                baseline = {'run': str(run), 'previous_attempt': '002-host', 'inputs': inputs,
                            'artifacts': w.android_resume_artifacts(run, '002-host'),
                            'checkout_revisions': w.android_resume_revisions(run)}
                yield root, run, previous, baseline

    def test_guard_binds_host_outputs_previous_results_cross_cache_and_inputs(self):
        with self.fixture() as (root, run, previous, baseline):
            self.assertEqual(w.validate_android_resume(run, baseline)['status'], 'passed')
            for target in [run / 'core-build/core/Package.swift', root / 'env.sh',
                           run / 'core-build/cross/plugins/cache/skipstone',
                           run / 'core-build/cross/plugins/cache/skipstone-state.json',
                           run / 'core-build/cross/workspace-state.json',
                           run / 'core-build/native/.build/out/Products/Debug/libSilverhandCore.dylib',
                           run / 'core-build/native/.build/plugins/outputs/native/generated.kt',
                           previous / 'core-logs/swift-host.exit.json', previous / 'core-logs/swift-android-release.log']:
                with self.subTest(target=target):
                    original = target.read_bytes()
                    target.write_bytes(original + b'changed')
                    with self.assertRaises(RuntimeError):
                        w.validate_android_resume(run, baseline)
                    target.write_bytes(original)
            # Even a refreshed hash list cannot make a failed host a valid Android checkpoint.
            host_path = previous / 'core-logs/swift-host.exit.json'
            host = json.loads(host_path.read_text())
            host['raw_subprocess_returncode'] = 1
            w.write(host_path, host)
            baseline['artifacts'] = w.android_resume_artifacts(run, '002-host')
            with self.assertRaisesRegex(RuntimeError, 'successful pinned host'):
                w.validate_android_resume(run, baseline)

    def test_dirty_checkout_and_existing_attempt_refused_before_build(self):
        with self.fixture() as (root, run, previous, baseline):
            path = root / 'baseline.json'
            w.write(path, baseline)
            with patch.object(w, 'build') as build:
                with self.assertRaisesRegex(RuntimeError, 'already exists'):
                    w.resume_build(run, '002-host', path, 'android')
                with patch.object(w, 'output', side_effect=lambda cmd: 'fixture-revision' if 'rev-parse' in cmd else ' M source.swift'):
                    with self.assertRaisesRegex(RuntimeError, 'checkout changed'):
                        w.resume_build(run, '003-android', path, 'android')
                self.assertFalse((run / 'attempts/003-android').exists())
                build.assert_not_called()
                w.resume_build(run, '003-android', path, 'android')
                build.assert_called_once_with(run, resume_attempt=run / 'attempts/003-android', resume_stage='android')

    def test_android_helper_skips_host_setup_and_preserves_evidence_on_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            files = [root / 'cross/plugins/cache/skipstone', root / 'native/.build/plugins/cache/skipstone',
                     root / 'previous/swift-host.log', root / 'previous/swift-android-release.log']
            for path in files:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b'original evidence')
            before = {path: path.read_bytes() for path in files}
            logs = root / 'new-attempt/core-logs'
            env = {'SILVERHAND_ANDROID_BUILD': str(root), 'SWIFT_ANDROID_TOOLCHAIN': '/pinned',
                   'SWIFT_ANDROID_SDK_BUNDLE': '/sdk/bundle', 'ANDROID_NDK_HOME': '/ndk'}
            args = ['build-core.py', '--from-stage', 'android', '--configuration', 'release', '--log-dir', str(logs)]
            with patch.dict(os.environ, env, clear=True), patch.object(sys, 'argv', args), \
                 patch('subprocess.run', return_value=subprocess.CompletedProcess([], 7)) as child, \
                 patch('shutil.copytree', side_effect=AssertionError('no source/setup regeneration')), \
                 patch('shutil.rmtree', side_effect=AssertionError('no cache/evidence removal')):
                with self.assertRaisesRegex(SystemExit, 'swift-android-release failed \\(7\\)'):
                    runpy.run_path(str(Path(__file__).with_name('build-core.py')), run_name='__main__')
            child.assert_called_once()
            command = child.call_args.args[0]
            self.assertEqual(command[0], '/pinned/usr/bin/swift')
            self.assertIn(str((root / 'cross').resolve()), command)
            self.assertEqual(child.call_args.kwargs['env']['SKIP_BRIDGE'], '1')
            self.assertFalse(child.call_args.kwargs['restore_signals'])
            self.assertFalse((logs / 'swift-host.log').exists())
            self.assertEqual(json.loads((logs / 'swift-android-release.exit.json').read_text())['raw_subprocess_returncode'], 7)
            self.assertTrue(all(path.read_bytes() == content for path, content in before.items()))


class ApkResume(unittest.TestCase):
    def test_openssl_selection_rejects_wrong_version_or_missing_capability(self):
        calls = []
        def selected(command):
            calls.append(command)
            return w.LOCK['tools']['openssl'] if command[1] == 'version' else '-CAfile -checkend -req -CA -CAkey -CAcreateserial -newkey -x509 -config'
        with patch.dict(w.ENV, OPENSSL_BIN='/usr/bin/openssl'), patch.object(w, 'output', side_effect=selected):
            with self.assertRaisesRegex(RuntimeError, 'capability missing'):
                w.openssl_preflight()
        self.assertTrue(all(command[0] == Path('/usr/bin/openssl') for command in calls))
        with patch.dict(w.ENV, OPENSSL_BIN='/usr/bin/openssl'), patch.object(w, 'output', return_value='LibreSSL 3.3.6'):
            with self.assertRaisesRegex(RuntimeError, 'version mismatch'):
                w.openssl_preflight()
        selected_env = build_environment({'OPENSSL_BIN': '/selected/openssl', 'UNRELATED_CREDENTIAL': 'sentinel'})
        self.assertEqual(selected_env, {'OPENSSL_BIN': '/selected/openssl'})

    def test_prepared_ca_keeps_chain_hostname_and_asset_mismatch_failures(self):
        with tempfile.TemporaryDirectory() as folder:
            run = Path(folder)
            for name in ['acceptance/certs/ca.pem', 'acceptance/certs/server.pem', 'app-build/acceptance-assets/acceptance-ca.pem']:
                path = run / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('public-fixture')
            with patch.dict(w.ENV, OPENSSL_BIN='/explicit/openssl'), patch.object(w, 'output', return_value='ok') as output:
                w.prepared_ca_check(run)
                self.assertEqual(output.call_count, 3)
                command = output.call_args.args[0]
                self.assertEqual(command[0], '/explicit/openssl')
                self.assertEqual(command[command.index('-verify_hostname') + 1], 'localhost')
                self.assertIn('-CAfile', command)
                (run / 'app-build/acceptance-assets/acceptance-ca.pem').write_text('different CA')
                with self.assertRaisesRegex(RuntimeError, 'CA mismatch'):
                    w.prepared_ca_check(run)
            with patch.dict(w.ENV, OPENSSL_BIN='/explicit/openssl'), \
                 patch.object(w, 'output', side_effect=subprocess.CalledProcessError(1, ['explicit-verify'], output='hostname mismatch')):
                with self.assertRaises(subprocess.CalledProcessError):
                    w.prepared_ca_check(run)

    def test_apk_checkpoint_runs_only_gradle_and_retains_old_cleanup_and_failure(self):
        for failed in [False, True]:
            with self.subTest(failed=failed), tempfile.TemporaryDirectory() as folder:
                run = Path(folder); attempt = run / 'attempts/fourth'
                (run / 'cleanup.json').write_text('original003-cleanup')
                with patch.dict(w.ENV, GRADLE_BIN='/explicit/gradle'), \
                     patch.object(w, 'step', side_effect=RuntimeError('APK fixture failure') if failed else None) as step, \
                     patch.object(w, 'apk_artifact_check', return_value={'fixture_only': True}) as check, \
                     patch.object(w, 'wait_services') as services, patch.object(w, 'cleanup_services') as cleanup:
                    if failed:
                        with self.assertRaisesRegex(RuntimeError, 'APK fixture failure'):
                            w.build_apk_checkpoint(run, attempt, 'third')
                        check.assert_not_called()
                        self.assertFalse((run / 'build-complete.json').exists())
                    else:
                        w.build_apk_checkpoint(run, attempt, 'third')
                        metadata = json.loads((run / 'build-complete.json').read_text())
                        self.assertEqual(metadata['resumed_from_checkpoint'], 'apk')
                        self.assertEqual(metadata['source_attempts']['upstream'], 'third')
                    step.assert_called_once_with(attempt, 'apk', ['/explicit/gradle', '-p', run / 'core-build/gradle', ':app:assembleAcceptance', '--no-daemon'])
                    services.assert_not_called(); cleanup.assert_not_called()
                    self.assertEqual((run / 'cleanup.json').read_text(), 'original003-cleanup')
                    self.assertFalse(json.loads((attempt / 'cleanup.json').read_text())['services_started'])

    def test_apk_guard_rejects_unapproved_source_and_failed_upstream_before_attempt(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); run = root / 'runs/fixture'; previous = run / 'attempts/third'
            names = ['core', 'test-swift-version', 'host-tests', 'typecheck', 'platform-test', 'ios-contracts',
                     'web', 'web-assets', 'backend-build', 'prepare-acceptance', 'apk']
            for name in names:
                w.write(previous / 'steps' / (name + '.json'), {'exit_code': 1 if name == 'apk' else 0})
            w.write(previous / 'core-logs/swift-android-release.exit.json', {'raw_subprocess_returncode': 0})
            w.write(previous / 'resume-validation.json', {'baseline': {'inputs': {'environment-config': 'old-env'}}})
            evidence = root / 'evidence' / run.name / 'attempts/third'
            w.write(evidence / 'entry-exit.raw.json', {'raw_subprocess_returncode': 1})
            w.write(evidence / 'source-inputs-before.json', {'business.swift': 'business', 'build.gradle': 'old'})
            inputs = {'repository': {'business.swift': 'business', 'build.gradle': 'approved'}, 'environment_config': 'new-env'}
            baseline = {'run': str(run), 'previous_attempt': 'third', 'inputs': inputs, 'artifacts': {'fixture': 'bound'},
                        'approved_source_changes': {'build.gradle': {'before': 'old', 'after': 'approved'}},
                        'environment_change': {'before': 'old-env', 'after': 'new-env'}}
            path = root / 'baseline.json'; w.write(path, baseline)
            with patch.object(w, 'ENV_ROOT', root), patch.object(w, 'apk_resume_artifacts', return_value={'fixture': 'bound'}), \
                 patch.object(w, 'apk_resume_inputs', return_value=inputs), patch.object(w, 'openssl_preflight', return_value={}), \
                 patch.object(w, 'prepared_ca_check', return_value={}), \
                 patch.dict(w.ENV, SKIP_BRIDGE_ANDROID_BUILD_DISABLED='1', SKIP_BRIDGE_ROBOLECTRIC_BUILD_DISABLED='1'), \
                 patch.object(w, 'build_apk_checkpoint') as build:
                self.assertEqual(w.validate_apk_resume(run, baseline)['status'], 'passed')
                with patch.object(w, 'apk_resume_inputs', return_value={'repository': {'business.swift': 'changed'}, 'environment_config': 'new-env'}):
                    with self.assertRaisesRegex(RuntimeError, 'reviewed repair list'):
                        w.resume_build(run, 'fourth', path, 'apk')
                w.write(previous / 'steps/host-tests.json', {'exit_code': 1})
                with self.assertRaisesRegex(RuntimeError, 'successful upstream'):
                    w.resume_build(run, 'fourth', path, 'apk')
                self.assertFalse((run / 'attempts/fourth').exists()); build.assert_not_called()

    def test_actual_apk_byte_mismatch_cannot_pass_provenance_check(self):
        with tempfile.TemporaryDirectory() as folder:
            run = Path(folder); apk = run / 'fixture.zip'
            lib = b'prepared-runtime'; web = b'prepared-web'
            import hashlib
            w.write(run / 'core-build/manifest.json', {'packagedLibraryHashes': {'libFixture.so': hashlib.sha256(lib).hexdigest()}})
            public = run / 'app-build/web-assets/public/index.html'; public.parent.mkdir(parents=True); public.write_bytes(web)
            for corrupted in [False, True]:
                with zipfile.ZipFile(apk, 'w') as bundle:
                    bundle.writestr('lib/arm64-v8a/libFixture.so', b'foreign-runtime' if corrupted else lib)
                    bundle.writestr('assets/public/index.html', web)
                with patch.object(w, 'ca_check', return_value={'apk': str(apk)}):
                    if corrupted:
                        with self.assertRaisesRegex(RuntimeError, 'Actual APK input mismatch'):
                            w.apk_artifact_check(run)
                    else:
                        self.assertTrue(w.apk_artifact_check(run)['actual_APK_inputs_match'])


if __name__ == '__main__':
    unittest.main()
