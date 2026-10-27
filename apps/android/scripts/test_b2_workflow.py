"""B2 entry failure collection; no SDK process, services, emulator or APK build."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from contextlib import contextmanager
import copy

os.environ.setdefault('SILVERHAND_ANDROID_HOME', str(Path.home() / 'Library/Developer/SilverhandAndroid'))
spec = importlib.util.spec_from_file_location('workflow', Path(__file__).with_name('workflow.py'))
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)

class FileProviderResource(unittest.TestCase):
    # Exact final resource block observed from this APK's aapt2 output.
    block = 'resource 0x7f0f0000 xml/shared_image_paths\n      () (file) res/xml/shared_image_paths.xml type=XML\n'

    def test_last_resource_accepts_raw_or_stripped_output(self):
        for text in [self.block, self.block.rstrip()]:
            with self.subTest(terminal_newline=text.endswith('\n')):
                self.assertEqual(w.file_provider_resource_file(text), 'res/xml/shared_image_paths.xml')

    def test_missing_or_ambiguous_resource_and_file_are_rejected(self):
        for text in ['', 'resource 0x7f0f0000 xml/shared_image_paths', self.block + self.block,
                     self.block + '      () (file) res/xml/another.xml type=XML\n']:
            with self.subTest(text=text), self.assertRaisesRegex(AssertionError, 'missing or ambiguous'):
                w.file_provider_resource_file(text)


class Entry(unittest.TestCase):
    def test_child_failure_keeps_steps_and_original_code_before_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            w.write(out / 'raw.json', {'steps': []})
            code = "import json,sys;from pathlib import Path;p=Path(sys.argv[1]);p.write_text(json.dumps({'steps':[{'id':'a','status':'failed'},{'id':'b','status':'not_executed'}],'first_error':{'message':'action failed'}}));sys.exit(7)"
            entry = w.record_entry([sys.executable, '-c', code, out / 'raw.json'], out)
            raw = json.loads((out / 'raw.json').read_text())
            self.assertEqual(entry['raw_returncode'], 7)
            self.assertIsNone(entry['collector_error'])
            self.assertEqual(raw['steps'][1]['status'], 'not_executed')
            self.assertEqual(raw['first_error']['message'], 'action failed')
            self.assertEqual(raw['entry']['raw_returncode'], 7)

    def test_timeout_escalates_only_owned_group_and_records_real_signal(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            entry = w.record_entry([sys.executable, '-c', 'import signal,time;signal.signal(signal.SIGINT,signal.SIG_IGN);print("ready",flush=True);time.sleep(30)'], out, timeout=.3, grace=(.2, .5, .5))
            self.assertEqual(entry['collector_error']['type'], 'TimeoutExpired')
            self.assertEqual(entry['raw_returncode'], -signal.SIGTERM)
            self.assertEqual([row['signal'] for row in entry['stop_actions']], ['SIGINT', 'SIGTERM'])
            self.assertTrue(all(row['group'] == entry['pid'] for row in entry['stop_actions']))
            with self.assertRaises(ProcessLookupError):
                os.kill(entry['pid'], 0)

    def test_ps_failure_still_stops_and_waits_for_the_known_writer(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            entry = None
            try:
                with patch.object(w, 'group_members', side_effect=PermissionError('controlled ps denied')):
                    entry = w.record_entry([sys.executable, '-c', 'import signal,time;signal.signal(signal.SIGINT,signal.SIG_IGN);time.sleep(30)'], out, timeout=.2, grace=(.1, .3, .3))
                self.assertTrue(entry.get('writer_exited'))
                self.assertIsNotNone(entry['raw_returncode'])
                self.assertEqual(entry['group_observation'], 'unknown')
                self.assertIsNone(entry['group_remaining_after_stop'])
                self.assertTrue(entry['stop_actions'])
            finally:
                if entry is not None and entry['raw_returncode'] is None:
                    try: os.killpg(entry['pid'], signal.SIGKILL)
                    except ProcessLookupError: pass
                    try: os.waitpid(entry['pid'], 0)
                    except ChildProcessError: pass

    def test_unconfirmed_writer_and_parent_finally_do_not_modify_raw(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            packages = {'product': {'path': 'product'}, 'test': {'path': 'test'}}
            w.write(run / 'b2-binding.json', {'inputs': {}, 'packages': packages})
            fake = __import__('unittest.mock', fromlist=['Mock']).Mock()
            fake.pid = 123456789
            fake.returncode = None
            fake.poll.return_value = None
            fake.wait.side_effect = subprocess.TimeoutExpired('controlled writer', 0)
            original = []
            def popen(*args, **kwargs):
                original.append((run / 'acceptance/attempts/001/raw.json').read_bytes())
                return fake
            def boot(out, **kwargs):
                w.write(out / 'emulator.json', {'fixture': True})
                return object(), None
            with patch.object(w, 'configure'), patch.object(w, 'apk_resume_inputs', return_value={}), patch.object(w, 'b2_package_check', return_value=packages), patch.object(w, 'ca_check', return_value={}), patch.object(w, 'wait_services'), patch.object(w, 'wait_for_webview'), patch.object(w, 'boot', side_effect=boot), patch.object(w, 'adb', return_value='36'), patch.object(w, 'stop_emulator'), patch.object(w, 'cleanup_services', return_value={'status': 'passed', 'services': []}), patch.object(w.subprocess, 'run'), patch.object(w.subprocess, 'Popen', side_effect=popen), patch.object(w, 'group_members', side_effect=PermissionError('controlled query unavailable')), patch.object(w.os, 'killpg'), patch.object(w.socket.socket, 'connect_ex', return_value=1), patch.dict(w.ENV, NODE_BIN='/node'):
                with self.assertRaisesRegex(AssertionError, 'writer exit unconfirmed'):
                    w.acceptance_b2(run, '001')
            out = run / 'acceptance/attempts/001'
            self.assertEqual((out / 'raw.json').read_bytes(), original[0])
            pending = json.loads((out / 'entry-unmerged.json').read_text())
            self.assertFalse(pending['raw_merged'])
            self.assertFalse(pending['entry']['writer_exited'])
            self.assertIsNone(pending['entry']['raw_returncode'])
            self.assertEqual(pending['entry']['group_observation'], 'unknown')
            self.assertEqual(pending['cleanup']['status'], 'passed')
            self.assertIn('seal_deferred', pending)
            self.assertFalse((out / 'SHA256SUMS').exists())

    def test_input_guard_stops_before_services_and_leaves_cases_unexecuted(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            w.write(run / 'b2-binding.json', {'inputs': {'old': True}, 'packages': {}})
            with patch.object(w, 'configure'), patch.object(w, 'apk_resume_inputs', return_value={'new': True}), patch.object(w, 'b2_package_check') as packages, patch.object(w, 'boot') as boot:
                with self.assertRaisesRegex(AssertionError, 'inputs|source/config'):
                    w.acceptance_b2(run, '001')
            packages.assert_not_called();boot.assert_not_called()
            out = run / 'acceptance/attempts/001'
            raw = json.loads((out / 'raw.json').read_text())
            self.assertTrue(all(row['status'] == 'not_executed' for row in raw['steps']))
            self.assertEqual(len(raw['steps']), 33)
            self.assertFalse(any(row['id'].startswith('DIAG.') for row in raw['steps']))
            self.assertEqual(raw['cleanup']['status'], 'passed')
            self.assertEqual(json.loads((out / 'counts.json').read_text())['passed'], 0)
            with self.assertRaises(FileExistsError):
                w.acceptance_b2(run, '001')
            self.assertEqual(json.loads((out / 'raw.json').read_text()), raw)

    def test_zero_entry_exit_does_not_override_action_failure_or_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            w.write(run / 'b2-binding.json', {'inputs': {}, 'packages': {}})
            def boot(out, **kwargs):
                w.write(out / 'emulator.json', {'fixture': True})
                return object(), None
            def entry(command, out):
                raw = json.loads((out / 'raw.json').read_text())
                raw['steps'][0]['status'] = 'failed'
                raw['status'] = 'failed'
                raw['first_error'] = {'message': 'controlled action failure'}
                raw['entry'] = {'raw_returncode': 0, 'collector_error': None, 'writer_exited': True}
                w.write(out / 'raw.json', raw)
                return raw['entry']
            with patch.object(w, 'configure'), patch.object(w, 'apk_resume_inputs', return_value={}), patch.object(w, 'b2_package_check', return_value={'product': {'path': 'product'}, 'test': {'path': 'test'}}), patch.object(w, 'ca_check', return_value={}), patch.object(w, 'wait_services'), patch.object(w, 'wait_for_webview'), patch.object(w, 'boot', side_effect=boot), patch.object(w, 'adb', return_value='36'), patch.object(w, 'stop_emulator'), patch.object(w, 'cleanup_services', return_value={'status': 'passed', 'services': []}), patch.object(w, 'record_entry', side_effect=entry), patch.object(w.subprocess, 'run'), patch.object(w.socket.socket, 'connect_ex', return_value=1), patch.dict(w.ENV, NODE_BIN='/node'):
                # Match the declared package paths; no actual packages or SDK are read.
                w.write(run / 'b2-binding.json', {'inputs': {}, 'packages': {'product': {'path': 'product'}, 'test': {'path': 'test'}}})
                with self.assertRaisesRegex(AssertionError, 'Actions did not all pass'):
                    w.acceptance_b2(run, '001')
            raw = json.loads((run / 'acceptance/attempts/001/raw.json').read_text())
            self.assertEqual(raw['entry']['raw_returncode'], 0)
            self.assertEqual(raw['first_error']['message'], 'controlled action failure')
            self.assertEqual(raw['cleanup']['status'], 'passed')
            self.assertTrue(all(row['status'] == 'not_executed' for row in raw['steps'][1:]))


class B2AndroidCheckpoint(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.run = self.root / 'current-b2'
        self.original = {'repository': {'product.ts': 'product', 'apps/android/scripts/workflow.py': 'old',
                                      'apps/android/scripts/test_b2_workflow.py': 'old'}, 'environment_config': 'config'}
        self.reviewed = copy.deepcopy(self.original)
        self.reviewed['repository']['apps/android/scripts/workflow.py'] = 'reviewed-entry'
        self.original_path = self.root / 'original-inputs.json'
        self.reviewed_path = self.root / 'reviewed-inputs.json'
        w.write(self.original_path, self.original)
        w.write(self.reviewed_path, self.reviewed)
        w.write(self.run / 'reviewed-inputs.json', {'path': str(self.original_path), 'sha256': w.digest(self.original_path)})
        w.write(self.run / 'preflight.json', {'status': 'passed'})
        w.write(self.run / 'steps/dependencies.json', {'exit_code': 0})
        w.write(self.run / 'steps/core.json', {'exit_code': 1, 'command': ['python3', str(w.APP / 'scripts/build-core.py'), '--configuration', 'release']})
        self.core_log = self.run / 'logs/core.log'
        self.core_log.parent.mkdir(parents=True)
        self.core_log.write_text('sdk-setup passed\nswift-host passed\nswift-android-release failed (1); see android log\n')
        (self.run / 'core-build').mkdir(exist_ok=True)
        (self.run / 'core-build/swift-host.log').write_text('Build complete! (1s)\n')
        (self.run / 'core-build/swift-android-release.log').write_text('error: build planning stopped due to build-tool plugin failures\n')
        cache_names = ['workspace-state.json', 'plugins/cache/skipstone', 'plugins/cache/skipstone-state.json',
                       'checkouts/skip/Plugins/SkipPlugin/SkipPlugin.swift',
                       *['artifacts/skip/skip/skip.artifactbundle/' + name for name in ['info.json', 'bin/skip', 'macos/skip']]]
        paths = ['native/.build/out/Products/Debug/libSilverhandCore.dylib', 'native/.build/out/Products/Debug/SilverhandCore.o',
                 'native/.build/plugins/outputs/native/SilverhandCore/destination/skipstone/settings.gradle.kts']
        paths += [scratch + '/' + name for scratch in ['native/.build', 'cross'] for name in cache_names]
        for name in paths:
            path = self.run / 'core-build' / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('fixture ' + name)
        self.entry_path = self.root / 'entry-raw.json'
        w.write(self.entry_path, {'entry': {'command': ['bash', str(w.APP / 'scripts/android.sh'), 'build', self.run.name,
                                                      '--suite', 'b2', '--reviewed-inputs', str(self.original_path)],
                                         'raw_returncode': 1, 'writer_exited': True, 'collector_error': None, 'stop_actions': []}})
        self.baseline = {'kind': 'b2-initial-android', 'run': str(self.run), 'inputs': {'source': 'same'},
                         'checkout_revisions': {'native/skip': 'pin', 'cross/skip': 'pin'},
                         'entry_result': {'path': str(self.entry_path), 'sha256': w.digest(self.entry_path)},
                         'artifacts': w.android_resume_artifacts(self.run)}
        self.baseline_path = self.root / 'baseline.json'
        w.write(self.baseline_path, self.baseline)

    @contextmanager
    def local_validation(self):
        with patch.object(w, 'apk_resume_inputs', return_value=self.reviewed), \
             patch.object(w, 'host_resume_inputs', return_value={'source': 'same'}), \
             patch.object(w, 'android_resume_revisions', return_value=self.baseline['checkout_revisions']):
            yield

    def test_b2_checkpoint_accepts_bound_success_evidence_and_rejects_wrong_kind(self):
        with self.local_validation():
            result = w.validate_android_resume(self.run, self.baseline, 'b2', self.reviewed)
            self.assertEqual(result['engineering_changes'], ['apps/android/scripts/workflow.py'])
            with self.assertRaisesRegex(RuntimeError, 'suite b2'):
                w.validate_android_resume(self.run, self.baseline)
            wrong = dict(self.baseline, kind='legacy-android')
            with self.assertRaisesRegex(RuntimeError, 'initial Android'):
                w.validate_android_resume(self.run, wrong, 'b2', self.reviewed)
            with self.assertRaisesRegex(RuntimeError, 'another run'):
                w.validate_android_resume(self.run, dict(self.baseline, run=str(self.root / 'other')), 'b2', self.reviewed)

    def test_host_files_alone_do_not_prove_success_even_with_rebound_hashes(self):
        self.core_log.write_text('sdk-setup passed\nswift-android-release failed (1); see android log\n')
        self.baseline['artifacts'] = w.android_resume_artifacts(self.run)
        with self.local_validation(), self.assertRaisesRegex(RuntimeError, 'host success'):
            w.validate_android_resume(self.run, self.baseline, 'b2', self.reviewed)
        self.assertTrue((self.run / 'core-build/native/.build/out/Products/Debug/libSilverhandCore.dylib').exists())

    def test_rejects_cache_source_revision_or_entry_mismatch_before_build(self):
        with self.local_validation():
            plugin = self.run / 'core-build/cross/plugins/cache/skipstone'
            before = plugin.read_bytes()
            plugin.write_bytes(before + b'changed')
            w.write(self.baseline_path, self.baseline)
            with patch.object(w, 'build') as build, self.assertRaisesRegex(RuntimeError, 'checkpoint artifacts'):
                w.resume_build(self.run, 'retry', self.baseline_path, 'android', 'b2', self.reviewed_path)
            build.assert_not_called()
            self.assertFalse((self.run / 'attempts/retry').exists())
            plugin.write_bytes(before)
            for field in ['product', 'environment', 'revision', 'entry']:
                with self.subTest(field=field):
                    reviewed = copy.deepcopy(self.reviewed)
                    baseline = copy.deepcopy(self.baseline)
                    if field == 'product': reviewed['repository']['product.ts'] = 'unexpected'
                    if field == 'environment': reviewed['environment_config'] = 'unexpected'
                    if field == 'entry': baseline['entry_result']['sha256'] = 'changed'
                    if field == 'revision': baseline['checkout_revisions'] = {'cross/skip': 'changed'}
                    with self.assertRaises(RuntimeError):
                        w.validate_android_resume(self.run, baseline, 'b2', reviewed)

    def test_b2_resume_skips_successful_host_setup_and_reaches_shared_package_tail(self):
        old_log = self.core_log.read_bytes()
        calls = []
        product = self.run / 'app-build/outputs/apk/acceptance/app-acceptance.apk'
        def step(evidence, name, command):
            calls.append((evidence, name, list(map(str, command))))
            if name == 'backend-build':
                backend = self.run / 'backend-build/debug/silverhand-backend'
                backend.parent.mkdir(parents=True);backend.write_text('backend fixture')
            if name == 'apk':
                product.parent.mkdir(parents=True);product.write_bytes(b'product fixture')
        with self.local_validation(), patch.dict(w.ENV, PNPM_BIN='/pnpm', SWIFT_ANDROID_TOOLCHAIN='/swift',
                NODE_BIN='/node', CARGO_BIN='/cargo', GRADLE_BIN='/gradle'), \
             patch.object(w, 'preflight', return_value={'status': 'passed'}), patch.object(w, 'step', side_effect=step), \
             patch.object(w, 'output', return_value='head'), patch.object(w, 'wait_services'), \
             patch.object(w, 'finish_cleanup'), patch.object(w, 'ca_check', return_value={'ca': 'same'}), \
             patch.object(w, 'b2_package_check', return_value={'checked': True}), \
             patch.object(w, 'apk_artifact_check', return_value={'contents': 'checked'}):
            w.resume_build(self.run, 'retry', self.baseline_path, 'android', 'b2', self.reviewed_path)
            with self.assertRaisesRegex(RuntimeError, 'already exists'):
                w.resume_build(self.run, 'retry', self.baseline_path, 'android', 'b2', self.reviewed_path)
        names = [name for _, name, _ in calls]
        self.assertNotIn('dependencies', names)
        core = next(command for _, name, command in calls if name == 'core')
        self.assertEqual(core[core.index('--from-stage') + 1], 'android')
        self.assertEqual(core[core.index('--log-dir') + 1], str(self.run / 'attempts/retry/core-logs'))
        self.assertIn('host-tests', names)  # This stage was never run before the Android failure.
        self.assertLess(names.index('host-tests'), names.index('web'))
        self.assertEqual(names.count('test-apk'), 1)
        self.assertTrue(all(evidence == self.run / 'attempts/retry' for evidence, _, _ in calls))
        self.assertEqual(self.core_log.read_bytes(), old_log)
        binding = json.loads((self.run / 'b2-binding.json').read_text())
        self.assertEqual(binding, {'inputs': self.reviewed, 'packages': {'checked': True}, 'actual_apk': {'contents': 'checked'}})

    def test_legacy_android_resume_stays_on_original_branch_and_b2_rejects_host(self):
        with patch.object(w, 'validate_android_resume', return_value={'status': 'passed'}) as validator, \
             patch.object(w, 'build') as build, patch.object(w, 'finish_b2_packages') as finish:
            w.resume_build(self.run, 'legacy', self.baseline_path, 'android')
            validator.assert_called_once_with(self.run, self.baseline)
            build.assert_called_once_with(self.run, resume_attempt=self.run / 'attempts/legacy', resume_stage='android')
            finish.assert_not_called()
            with self.assertRaisesRegex(RuntimeError, 'only.*Android'):
                w.resume_build(self.run, 'wrong', self.baseline_path, 'host', 'b2', self.reviewed_path)

    def test_shared_tail_rejects_product_mutation_and_never_binds_failed_packages(self):
        product = self.run / 'app-build/outputs/apk/acceptance/app-acceptance.apk'
        product.parent.mkdir(parents=True);product.write_bytes(b'product fixture')
        def changed(*args): product.write_bytes(b'changed')
        with patch.dict(w.ENV, GRADLE_BIN='/gradle'), patch.object(w, 'step', side_effect=changed), \
             self.assertRaisesRegex(AssertionError, 'Product APK changed'):
            w.finish_b2_packages(self.run, self.reviewed)
        with patch.dict(w.ENV, GRADLE_BIN='/gradle'), patch.object(w, 'step'), \
             patch.object(w, 'apk_resume_inputs', return_value=self.reviewed), \
             patch.object(w, 'b2_package_check', side_effect=RuntimeError('real package check failed')), \
             self.assertRaisesRegex(RuntimeError, 'real package check failed'):
            w.finish_b2_packages(self.run, self.reviewed)
        self.assertFalse((self.run / 'b2-binding.json').exists())


class B2ApkCheckpoint(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name);self.run = self.root / 'b2-apk';self.previous = '002-android-after-user-report'
        prior = self.run / 'attempts' / self.previous
        self.original = {'repository': {'product.ts': 'same', 'apps/android/app/src/main/java/com/silverhand/android/SilverhandClientPlugin.kt': 'old'}, 'environment_config': 'config'}
        self.reviewed = copy.deepcopy(self.original)
        self.reviewed['repository']['apps/android/app/src/main/java/com/silverhand/android/SilverhandClientPlugin.kt'] = 'fixed'
        self.original_path = self.root / 'executed-inputs.json';self.reviewed_path = self.root / 'new-inputs.json'
        w.write(self.original_path, self.original);w.write(self.reviewed_path, self.reviewed)
        for name in ['preflight.json', 'resume-validation.json']:w.write(prior / name, {'fixture': True})
        w.write(prior / 'core-logs/swift-android-release.exit.json', {'raw_subprocess_returncode': 0})
        (prior / 'core-logs/swift-android-release.log').write_text('Build complete!\n')
        for name in ['core', 'test-swift-version', 'host-tests', 'typecheck', 'platform-test', 'ios-contracts', 'web', 'web-assets', 'backend-build', 'prepare-acceptance', 'apk']:
            w.write(prior / 'steps' / (name + '.json'), {'exit_code': 1 if name == 'apk' else 0})
            path = prior / 'logs' / (name + '.log');path.parent.mkdir(parents=True, exist_ok=True);path.write_text(name)
        for name in ['steps/dependencies.json', 'cleanup.json']:w.write(self.run / name, {'exit_code': 0, 'status': 'passed'})
        for name in ['logs/core.log', 'core-build/swift-host.log', 'acceptance/certs/ca.pem', 'acceptance/certs/server.pem']:
            path = self.run / name;path.parent.mkdir(parents=True, exist_ok=True);path.write_text('fixture ' + name)
        for name in ['core-build/gradle', 'web', 'app-build/web-assets', 'app-build/core-assets', 'app-build/acceptance-assets']:
            folder = self.run / name;folder.mkdir(parents=True, exist_ok=True);(folder / 'fixture').write_text(name)
        library = self.run / 'core-build/gradle/SilverhandCore/build/jni-libs/arm64-v8a/libSilverhandCore.so'
        library.parent.mkdir(parents=True);library.write_bytes(b'library')
        w.write(self.run / 'core-build/manifest.json', {'packagedLibraryHashes': {library.name: w.digest(library)}})
        backend = self.run / 'backend-build/debug/silverhand-backend';backend.parent.mkdir(parents=True);backend.write_bytes(b'backend')
        w.write(self.run / 'backend.json', {'path': str(backend), 'sha256': w.digest(backend), 'cargo_lock_sha256': w.digest(w.REPO / 'rust/Cargo.lock')})
        self.entry_path = self.root / 'entry.json'
        w.write(self.entry_path, {'entry': {'command': ['bash', str(w.APP / 'scripts/android.sh'), 'resume-android', self.run.name,
                                                      '--suite', 'b2', '--attempt', self.previous, '--resume-baseline', '/original-baseline', '--reviewed-inputs', str(self.original_path)],
                                         'raw_returncode': 1, 'writer_exited': True, 'collector_error': None, 'stop_actions': []}})
        source = 'apps/android/app/src/main/java/com/silverhand/android/SilverhandClientPlugin.kt'
        self.baseline = {'run': str(self.run), 'kind': 'b2-apk-compile-fix', 'previous_attempt': self.previous,
                         'entry_result': {'path': str(self.entry_path), 'sha256': w.digest(self.entry_path)},
                         'original_inputs': {'path': str(self.original_path), 'sha256': w.digest(self.original_path)},
                         'inputs': self.reviewed, 'approved_source_changes': {source: {'before': 'old', 'after': 'fixed'}},
                         'environment_change': {'before': 'config', 'after': 'config'},
                         'artifacts': w.apk_resume_artifacts(self.run, self.previous, b2=True)}
        self.baseline_path = self.root / 'baseline.json';w.write(self.baseline_path, self.baseline)

    @contextmanager
    def local_validation(self):
        with patch.object(w, 'apk_resume_inputs', return_value=self.reviewed), \
             patch.dict(w.ENV, SKIP_BRIDGE_ANDROID_BUILD_DISABLED='1', SKIP_BRIDGE_ROBOLECTRIC_BUILD_DISABLED='1', GRADLE_BIN='/gradle'), \
             patch.object(w, 'openssl_preflight', return_value={'tool': 'controlled'}), \
             patch.object(w, 'prepared_ca_check', return_value={'ca': 'same'}):
            yield

    def test_accepts_exact_completed_upstream_and_rejects_wrong_suite(self):
        with self.local_validation():
            self.assertEqual(w.validate_apk_resume(self.run, self.baseline, 'b2', self.reviewed)['status'], 'passed')
            with self.assertRaisesRegex(RuntimeError, 'suite b2'):
                w.validate_apk_resume(self.run, self.baseline)
            with self.assertRaisesRegex(RuntimeError, 'compile-fix'):
                w.validate_apk_resume(self.run, dict(self.baseline, kind='b2-initial-android'), 'b2', self.reviewed)

    def test_missing_success_is_rejected_even_if_artifact_hashes_are_rebound(self):
        w.write(self.run / 'attempts' / self.previous / 'steps/host-tests.json', {'exit_code': 1})
        self.baseline['artifacts'] = w.apk_resume_artifacts(self.run, self.previous, b2=True)
        with self.local_validation(), self.assertRaisesRegex(RuntimeError, 'successful upstream'):
            w.validate_apk_resume(self.run, self.baseline, 'b2', self.reviewed)

    def test_changed_prepared_resources_refuse_launch_and_preserve_prior_logs(self):
        prior_log = self.run / 'attempts' / self.previous / 'logs/apk.log';before = prior_log.read_bytes()
        (self.run / 'app-build/web-assets/fixture').write_text('changed after approval')
        with self.local_validation(), patch.object(w, 'build_apk_checkpoint') as build, \
             self.assertRaisesRegex(RuntimeError, 'prepared artifacts changed'):
            w.resume_build(self.run, 'next', self.baseline_path, 'apk', 'b2', self.reviewed_path)
        build.assert_not_called();self.assertEqual(prior_log.read_bytes(), before)
        self.assertFalse((self.run / 'attempts/next').exists())

    def test_unapproved_source_environment_or_invalid_ca_stops_before_gradle(self):
        with self.local_validation():
            for field in ['product', 'environment']:
                with self.subTest(field=field):
                    reviewed = copy.deepcopy(self.reviewed)
                    if field == 'product':reviewed['repository']['product.ts'] = 'unapproved'
                    else:reviewed['environment_config'] = 'other'
                    with self.assertRaises(RuntimeError):w.validate_apk_resume(self.run, self.baseline, 'b2', reviewed)
            with patch.object(w, 'prepared_ca_check', side_effect=RuntimeError('expired or mismatched CA')), \
                 self.assertRaisesRegex(RuntimeError, 'expired or mismatched'):
                w.validate_apk_resume(self.run, self.baseline, 'b2', self.reviewed)

    def test_apk_resume_only_runs_gradle_and_shared_tail_without_services_or_renewal(self):
        prior_log = self.run / 'attempts' / self.previous / 'logs/apk.log';before = prior_log.read_bytes();calls=[]
        product = self.run / 'app-build/outputs/apk/acceptance/app-acceptance.apk'
        def step(evidence, name, command):
            calls.append((evidence, name, list(map(str, command))))
            if name == 'apk':product.parent.mkdir(parents=True);product.write_bytes(b'product')
        with self.local_validation(), patch.object(w, 'step', side_effect=step), \
             patch.object(w, 'apk_artifact_check', return_value={'contents': 'verified'}), \
             patch.object(w, 'b2_package_check', return_value={'packages': 'verified'}), \
             patch.object(w, 'build') as upstream, patch.object(w, 'cleanup_services') as services:
            w.resume_build(self.run, 'next', self.baseline_path, 'apk', 'b2', self.reviewed_path)
        upstream.assert_not_called();services.assert_not_called()
        self.assertEqual([name for _, name, _ in calls], ['apk', 'test-apk'])
        self.assertTrue(all(evidence == self.run / 'attempts/next' for evidence, _, _ in calls))
        self.assertEqual(prior_log.read_bytes(), before)
        self.assertEqual(json.loads((self.run / 'build-complete.json').read_text())['source_attempts']['host'], 'initial-build')
        self.assertEqual(json.loads((self.run / 'b2-binding.json').read_text())['inputs'], self.reviewed)
        self.assertFalse(json.loads((self.run / 'attempts/next/cleanup.json').read_text())['services_started'])

class StartupDiagnostic(unittest.TestCase):
    def test_injection_is_blocking_before_the_unique_main_and_keeps_CSP(self):
        index='<meta http-equiv="Content-Security-Policy" content="script-src self"><script type="module" crossorigin src="/assets/main.js"></script>'
        actual=w.inject_startup_diagnostic(index, 'nonce')
        tag='<script src="/b2-appearance-startup.js" data-b2-startup-diagnostic="nonce"></script>\n'
        self.assertEqual(actual.replace(tag, '', 1), index)
        self.assertLess(actual.index(tag), actual.index('type="module"'))
        for bad in [index+index, '', actual]:
            with self.assertRaises(AssertionError):w.inject_startup_diagnostic(bad, 'nonce')
        with self.assertRaises(AssertionError):w.inject_startup_diagnostic(index, 'bad"nonce')

    def test_isolated_binding_rejects_changed_assets_native_payload_and_unrestored_product(self):
        import zipfile
        with tempfile.TemporaryDirectory() as directory:
            run=Path(directory);product=run/'normal.apk';diagnostic=run/'diagnostics/nonce/app-acceptance.apk'
            original={'assets/public/index.html':b'<script type="module" src="/main.js"></script>', 'assets/public/main.js':b'unchanged main', 'classes.dex':b'unchanged dex', 'lib/arm64-v8a/libtest.so':b'unchanged native', 'assets/acceptance-ca.pem':b'CA', 'assets/capacitor.config.json':b'config'}
            def pack(path, entries):
                path.parent.mkdir(parents=True,exist_ok=True)
                with zipfile.ZipFile(path,'w') as z:
                    for name,value in entries.items():z.writestr(name,value)
            pack(product,original)
            w.write(run/'b2-binding.json', {'packages':{'product':{'path':str(product),'sha256':w.digest(product)}}})
            script=(w.APP/'scripts/appearance-startup-diagnostic.js').read_bytes()
            derived=dict(original);derived['assets/public/index.html']=w.inject_startup_diagnostic(original['assets/public/index.html'].decode(),'nonce').encode();derived['assets/public/b2-appearance-startup.js']=script
            pack(diagnostic,derived)
            baseline={'kind':'appearance-startup','diagnostic_only':True,'nonce':'nonce','normal_binding_sha256':w.digest(run/'b2-binding.json'),'base_product_sha256':w.digest(product),'startup_script_sha256':__import__('hashlib').sha256(script).hexdigest(),'packages':{'product':{'path':str(diagnostic),'sha256':w.digest(diagnostic)}}}
            self.assertEqual(w.validate_startup_diagnostic(run,baseline)['nonce'],'nonce')
            for key in ['assets/public/main.js','classes.dex','assets/acceptance-ca.pem']:
                bad=dict(derived);bad[key]+=b'changed';pack(diagnostic,bad);baseline['packages']['product']['sha256']=w.digest(diagnostic)
                with self.assertRaises(AssertionError):w.validate_startup_diagnostic(run,baseline)
            pack(diagnostic,derived);baseline['packages']['product']['sha256']=w.digest(diagnostic)
            product.write_bytes(b'unrestored')
            with self.assertRaisesRegex(AssertionError,'not restored'):w.validate_startup_diagnostic(run,baseline)

    def test_device_restore_checks_actual_installed_digest_and_rejects_unknown_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            run=Path(directory);apk=run/'normal.apk';apk.write_bytes(b'current product');sha=w.digest(apk)
            w.write(run/'b2-binding.json',{'packages':{'product':{'path':str(apk),'sha256':sha}}})
            with patch.object(w,'adb',side_effect=['Success','package:/data/app/base.apk',sha+' /data/app/base.apk']) as adb:
                w.restore_normal_product(run)
                self.assertEqual(adb.call_args_list[0].args,('install','-r',str(apk)))
                self.assertEqual(adb.call_args_list[-1].args,('shell','sha256sum','/data/app/base.apk'))
            for replies in [['Success',''],['Success','package:/data/app/base.apk','wrong /data/app/base.apk']]:
                with patch.object(w,'adb',side_effect=replies),self.assertRaises(AssertionError):w.restore_normal_product(run)

    def test_diagnostic_transport_and_finally_restore_keep_outcomes_separate(self):
        for code,restore_fails in [(0,False),(0,True),(7,True)]:
            with self.subTest(code=code,restore_fails=restore_fails),tempfile.TemporaryDirectory() as directory:
                run=Path(directory);events=[]
                packages={'product':{'path':str(run/'diag.apk')},'test':{'path':str(run/'test.apk')}}
                w.write(run/'b2-startup-diagnostic-binding.json',{'inputs':{},'packages':packages})
                def boot(out,**kwargs):w.write(out/'emulator.json',{});return object(),None
                def entry(command,out):
                    self.assertEqual(command[-1],'appearance-startup');events.append('node')
                    raw=json.loads((out/'raw.json').read_text());raw['status']='passed'
                    for row in raw['steps']:row['status']='passed';row['detail']={'diagnosticOnly':True,'persistenceAssertion':'failed'}
                    raw['entry']={'raw_returncode':code,'writer_exited':True,'collector_error':None}
                    if code:raw['first_error']={'message':'original controlled node failure'}
                    w.write(out/'raw.json',raw);return raw['entry']
                def restore(_):
                    events.append('restore')
                    if restore_fails:raise RuntimeError('installed restore failed')
                with patch.object(w,'configure'),patch.object(w,'apk_resume_inputs',return_value={}),patch.object(w,'validate_startup_diagnostic',return_value={'kind':'appearance-startup','nonce':'nonce'}),patch.object(w,'b2_package_check',return_value=packages),patch.object(w,'ca_check',return_value={}),patch.object(w,'wait_services'),patch.object(w,'wait_for_webview'),patch.object(w,'boot',side_effect=boot),patch.object(w,'adb',return_value='36'),patch.object(w,'restore_normal_product',side_effect=restore),patch.object(w,'stop_emulator',side_effect=lambda *_:events.append('stop')),patch.object(w,'cleanup_services',return_value={'status':'passed','services':[]}),patch.object(w,'record_entry',side_effect=entry),patch.object(w.subprocess,'run'),patch.object(w.socket.socket,'connect_ex',return_value=1),patch.dict(w.ENV,NODE_BIN='/node'):
                    if code or restore_fails:
                        with self.assertRaises((AssertionError,RuntimeError)):w.acceptance_b2(run,'once','appearance-startup')
                    else:w.acceptance_b2(run,'once','appearance-startup')
                raw=json.loads((run/'acceptance/attempts/once/raw.json').read_text());counts=json.loads((run/'acceptance/attempts/once/counts.json').read_text())
                self.assertEqual(events,['node','restore','stop']);self.assertEqual(counts['groups']['B2']['passed'],0)
                self.assertEqual(counts['groups']['DIAG']['passed'],2)
                self.assertEqual(raw['cleanup']['status'],'failed' if restore_fails else 'passed')
                if code:self.assertEqual(raw['first_error']['message'],'original controlled node failure')
                if restore_fails:self.assertEqual(raw['status'],'failed')

    def test_diagnostic_preflight_failure_leaves_only_DIAG_steps_unexecuted(self):
        with tempfile.TemporaryDirectory() as directory:
            run=Path(directory);w.write(run/'b2-startup-diagnostic-binding.json',{'inputs':{}})
            with patch.object(w,'configure'),patch.object(w,'apk_resume_inputs',return_value={}),patch.object(w,'validate_startup_diagnostic',side_effect=AssertionError('not restored')),patch.object(w,'boot') as boot:
                with self.assertRaisesRegex(AssertionError,'not restored'):w.acceptance_b2(run,'diagnostic','appearance-startup')
            boot.assert_not_called();raw=json.loads((run/'acceptance/attempts/diagnostic/raw.json').read_text())
            self.assertEqual([r['id'] for r in raw['steps']],['DIAG.real-page-login','DIAG.theme-startup'])
            self.assertTrue(all(r['status']=='not_executed' for r in raw['steps']))
            self.assertEqual(raw['suite'],'b2-diagnostic')


class AppearanceShort(unittest.TestCase):
    def test_normal_binding_dispatch_and_persistence_failure_remain_fatal(self):
        for diagnostic, code, failed in [(d, c, f) for d in ['appearance-short', 'photo-picker-menu'] for c, f in [(0, False), (0, True), (7, True)]]:
            with self.subTest(diagnostic=diagnostic, code=code, failed=failed), tempfile.TemporaryDirectory() as directory:
                run = Path(directory)
                packages = {'product': {'path': str(run/'normal.apk')}, 'test': {'path': str(run/'test.apk')}}
                w.write(run/'b2-binding.json', {'inputs': {}, 'packages': packages})
                # A stale isolated binding must never be selected for this branch.
                (run/'b2-startup-diagnostic-binding.json').write_text('not JSON')
                def boot(out, **kwargs):
                    w.write(out/'emulator.json', {}); return object(), None
                def entry(command, out):
                    self.assertEqual(command[-1], diagnostic)
                    raw = json.loads((out/'raw.json').read_text())
                    self.assertNotIn('startup_diagnostic', raw['bindings'])
                    raw['steps'][0]['status'] = 'passed'
                    raw['steps'][1]['status'] = 'failed' if failed else 'passed'
                    raw['status'] = 'failed' if failed else 'passed'
                    raw['entry'] = {'raw_returncode': code, 'writer_exited': True, 'collector_error': None}
                    if failed: raw['first_error'] = {'message': 'original persistence timeout'}
                    w.write(out/'raw.json', raw); return raw['entry']
                with patch.object(w, 'configure'), patch.object(w, 'apk_resume_inputs', return_value={}), patch.object(w, 'validate_startup_diagnostic') as startup, patch.object(w, 'b2_package_check', return_value=packages) as package_check, patch.object(w, 'ca_check', return_value={}), patch.object(w, 'wait_services'), patch.object(w, 'wait_for_webview'), patch.object(w, 'boot', side_effect=boot), patch.object(w, 'adb', return_value='36'), patch.object(w, 'restore_normal_product') as restore, patch.object(w, 'stop_emulator') as stop, patch.object(w, 'cleanup_services', return_value={'status': 'passed', 'services': []}), patch.object(w, 'record_entry', side_effect=entry), patch.object(w.subprocess, 'run'), patch.object(w.socket.socket, 'connect_ex', return_value=1), patch.dict(w.ENV, NODE_BIN='/node'):
                    if failed:
                        with self.assertRaisesRegex(AssertionError, 'Acceptance entry failed|Actions did not all pass'):
                            w.acceptance_b2(run, 'short', diagnostic)
                    else: w.acceptance_b2(run, 'short', diagnostic)
                startup.assert_not_called(); restore.assert_not_called()
                package_check.assert_called_once_with(run); stop.assert_called_once()
                raw = json.loads((run/'acceptance/attempts/short/raw.json').read_text())
                counts = json.loads((run/'acceptance/attempts/short/counts.json').read_text())
                self.assertEqual(raw['status'], 'failed' if failed else 'passed')
                self.assertEqual(raw['cleanup']['status'], 'passed')
                self.assertEqual(counts['groups']['DIAG']['failed'], int(failed))
                self.assertEqual(counts['groups']['B2']['passed'], 0)
                self.assertEqual([row['id'] for row in raw['steps']], json.loads((w.APP/'scripts/acceptance-scenarios.json').read_text())['diagnostics'][diagnostic])
                if failed: self.assertEqual(raw['first_error']['message'], 'original persistence timeout')

    def test_missing_normal_binding_does_not_fall_back_to_startup_diagnostic(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            w.write(run/'b2-startup-diagnostic-binding.json', {'inputs': {}, 'packages': {}})
            with patch.object(w, 'configure'), patch.object(w, 'boot') as boot:
                with self.assertRaises(FileNotFoundError):
                    w.acceptance_b2(run, 'short', 'appearance-short')
            boot.assert_not_called()
            raw = json.loads((run/'acceptance/attempts/short/raw.json').read_text())
            self.assertEqual([row['id'] for row in raw['steps']], ['DIAG.real-page-login', 'DIAG.theme-short-path'])
            self.assertTrue(all(row['status'] == 'not_executed' for row in raw['steps']))
            self.assertEqual(raw['suite'], 'b2-diagnostic')

if __name__ == '__main__':
    unittest.main()
