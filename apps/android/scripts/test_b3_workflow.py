"""B3 wiring in temporary IO only. No SDK, services, device, or product build."""
import copy
from contextlib import ExitStack
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from workflow_test_support import controlled_boot

os.environ.setdefault('SILVERHAND_ANDROID_HOME', str(Path.home() / 'Library/Developer/SilverhandAndroid'))
spec = importlib.util.spec_from_file_location('workflow', Path(__file__).with_name('workflow.py'))
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)

def setUpModule():
    global android_environment
    android_environment = patch.dict(w.ENV, ANDROID_HOME='/controlled-sdk', ANDROID_SERIAL='emulator-5584')
    android_environment.start()


def tearDownModule():
    android_environment.stop()


class B3Entry(unittest.TestCase):
    def setUp(self):
        self.env_patch = patch.dict(w.ENV, NODE_BIN='/controlled/node')
        self.env_patch.start(); self.addCleanup(self.env_patch.stop)
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.run = Path(self.directory.name).resolve()
        self.binding = self.run / 'reviewed-s1-binding.json'
        self.table = json.loads((w.APP / 'scripts/acceptance-scenarios.json').read_text())
        self.selection = w.b3_selection(self.table, 'search-normal')
        self.packages = {'product': {'path': '/unchanged0cd', 'sha256': '0cd'}, 'test': {'path': '/unchanged9fab', 'sha256': '9fab'}}
        self.baseline = {'kind': 'b3-unit', 'unit': 'search-normal', 'run': str(self.run), 'selection': self.selection, 'inputs': {'driver': 'new'}, 'packages': self.packages, 'ca': {'ca': 'same'}}
        w.write(self.binding, self.baseline)
        (self.run / 'b2-binding.json').write_bytes(b'unchanged B2 normal binding\n')
        self.before = (self.run / 'b2-binding.json').read_bytes()
        self.out = w.b3_attempt_paths(self.run, self.run, 'device-001', 'search-normal')[0]

    def invoke(self):
        w.acceptance(self.run, 'b3', 'device-001', unit=self.baseline['unit'], binding=self.binding, selection_name=self.baseline['selection'].get('selector'))

    def controlled(self, stack, *, failed=False, writer=True, cleanup_failed=False):
        def entry(command, out):
            self.assertEqual(list(map(str, command)), [w.ENV['NODE_BIN'], str(w.APP / 'scripts/acceptance.mjs'), 'b3', str(self.out), self.baseline['unit']] + ([self.baseline['selection']['selector']] if 'selector' in self.baseline['selection'] else []))
            result = {'launched': True, 'command': list(map(str, command)), 'writer_exited': writer, 'raw_returncode': 7 if failed else 0, 'collector_error': None}
            if not writer:
                self.writer_bytes = (out / 'raw.json').read_bytes()
                w.write(out / 'entry-unmerged.json', {'entry': result})
                return result
            raw = json.loads((out / 'raw.json').read_text())
            raw['entry'] = result
            if failed:
                raw['status'] = 'failed'
                raw['steps'][0]['status'] = 'passed'
                raw['steps'][1]['status'] = 'failed'
                raw['first_error'] = {'message': 'original controlled Search failure'}
            else:
                raw['status'] = 'passed'
                for row in raw['steps']:
                    row['status'] = 'passed'
            if self.baseline['unit'] == 'task-write' and not (out/'t2-events.jsonl').exists():
                (out/'t2-events.jsonl').write_text(json.dumps({'seq':1,'event':'observer_start'})+'\n')
            w.write(out / 'raw.json', raw)
            return result

        for name, kwargs in [
            ('configure', {}), ('apk_resume_inputs', {'return_value': self.baseline['inputs']}),
            ('b2_package_check', {'return_value': self.packages}), ('ca_check', {'return_value': self.baseline['ca']}),
            ('wait_services', {}), ('wait_for_webview', {}), ('boot', {'side_effect': controlled_boot}),
            ('adb', {'return_value': '36'}), ('stop_emulator', {}),
            ('cleanup_services', {'return_value': {'status': 'failed' if cleanup_failed else 'passed', 'services': []}}),
            ('record_entry', {'side_effect': entry}),
        ]:
            stack.enter_context(patch.object(w, name, **kwargs))
        stack.enter_context(patch.object(w.subprocess, 'run'))
        stack.enter_context(patch.object(w.socket.socket, 'connect_ex', return_value=1))
        stack.enter_context(patch.object(w.shutil, 'disk_usage', return_value=type('Usage', (), {'free': 100 * 1024**3})()))
        stack.enter_context(patch.dict(w.ENV, NODE_BIN='/controlled/node'))

    def test_happy_wiring_six_selected_only_and_independent_b2_binding(self):
        with ExitStack() as stack:
            self.controlled(stack)
            self.invoke()
        raw = json.loads((self.out / 'raw.json').read_text())
        counts = json.loads((self.out / 'counts.json').read_text())
        self.assertEqual(raw['selection']['planned_business'], 5)
        self.assertEqual(counts['groups']['PRE']['passed'], 1)
        self.assertEqual(counts['groups']['B3']['passed'], 5)
        self.assertFalse((self.run / 'acceptance/attempts/device-001').exists())
        self.assertEqual((self.run / 'b2-binding.json').read_bytes(), self.before)
        self.assertTrue((self.out / 'SHA256SUMS').exists())


    def test_s2_wires_explicit_control_only_to_independent_unit(self):
        self.baseline['unit'] = 'search-isolation'
        self.selection = w.b3_selection(self.table, self.baseline['unit'])
        self.baseline['selection'] = self.selection
        w.write(self.binding, self.baseline)
        self.out = w.b3_attempt_paths(self.run, self.run, 'device-001', self.baseline['unit'])[0]
        with ExitStack() as stack:
            self.controlled(stack)
            prepare = stack.enter_context(patch.object(w.subprocess, 'run'))
            self.invoke()
        command = list(map(str, prepare.call_args_list[0].args[0]))
        self.assertIn('--search-control', command)
        self.assertEqual(command[command.index('--search-control') + 1], str(self.out / 's2-control.json'))
        control = json.loads((self.out / 's2-control.json').read_text())
        self.assertFalse(control['active']); self.assertEqual(control['rules'], [])
        self.assertEqual(control['attempt'], 'device-001')
        raw = json.loads((self.out / 'raw.json').read_text())
        self.assertEqual(raw['selection']['business_ids'], self.table['B3']['search-isolation']['cases'])
        self.assertEqual(raw['controls']['events'], str(self.out / 's2-proxy-events.jsonl'))
        changed = copy.deepcopy(raw); changed['controls']['events'] = '/other/events'
        with self.assertRaisesRegex(AssertionError, 'control/output'):
            w.validate_b3_inner(self.run, 'device-001', self.baseline['unit'], self.binding, self.out, changed)
        self.assertEqual((self.run / 'b2-binding.json').read_bytes(), self.before)

    def test_s1_has_no_control_flags_or_files(self):
        with ExitStack() as stack:
            self.controlled(stack)
            prepare = stack.enter_context(patch.object(w.subprocess, 'run'))
            self.invoke()
        self.assertNotIn('--search-control', list(map(str, prepare.call_args_list[0].args[0])))
        self.assertFalse((self.out / 's2-control.json').exists())

    def test_changed_input_stops_before_packages_services_or_device(self):
        with patch.object(w, 'configure'), patch.object(w, 'apk_resume_inputs', return_value={'driver': 'changed'}), patch.object(w, 'b2_package_check') as packages, patch.object(w, 'boot') as boot:
            with self.assertRaisesRegex(AssertionError, 'source/config'):
                self.invoke()
        packages.assert_not_called(); boot.assert_not_called()
        raw = json.loads((self.out / 'raw.json').read_text())
        self.assertTrue(all(row['status'] == 'not_executed' for row in raw['steps']))
        self.assertEqual((self.run / 'b2-binding.json').read_bytes(), self.before)

    def test_wrong_binding_unit_run_or_selection_refused_before_services(self):
        for key, value in [('kind', 'b2'), ('unit', 'other'), ('run', '/other'), ('selection', {})]:
            with self.subTest(field=key):
                changed = {**self.baseline, key: value}
                w.write(self.binding, changed)
                with patch.object(w, 'configure'), patch.object(w, 'boot') as boot:
                    with self.assertRaisesRegex(AssertionError, 'binding|selection'):
                        self.invoke()
                boot.assert_not_called()
                import shutil
                shutil.rmtree(self.out)

    def test_changed_package_or_ca_refused_before_services(self):
        for field in ['packages', 'ca']:
            with self.subTest(field=field), ExitStack() as stack:
                self.controlled(stack)
                stack.enter_context(patch.object(w, 'b2_package_check' if field == 'packages' else 'ca_check', return_value={}))
                prepare = stack.enter_context(patch.object(w.subprocess, 'run'))
                with self.assertRaisesRegex(AssertionError, 'packages|CA'):
                    self.invoke()
                prepare.assert_not_called()
                import shutil
                shutil.rmtree(self.out)

    def test_functional_first_error_and_later_not_executed_survive_cleanup(self):
        with ExitStack() as stack:
            self.controlled(stack, failed=True)
            with self.assertRaisesRegex(AssertionError, 'entry failed'):
                self.invoke()
        raw = json.loads((self.out / 'raw.json').read_text())
        self.assertEqual(raw['first_error']['message'], 'original controlled Search failure')
        self.assertEqual(raw['entry']['raw_returncode'], 7)
        self.assertEqual(raw['cleanup']['status'], 'passed')
        self.assertTrue(all(row['status'] == 'not_executed' for row in raw['steps'][2:]))

    def test_cleanup_failure_does_not_become_unit_pass(self):
        with ExitStack() as stack:
            self.controlled(stack, cleanup_failed=True)
            with self.assertRaisesRegex(Exception, 'cleanup'):
                self.invoke()
        raw = json.loads((self.out / 'raw.json').read_text())
        self.assertEqual(raw['status'], 'failed')
        self.assertEqual(raw['cleanup']['status'], 'failed')

    def test_unconfirmed_writer_does_not_merge_or_seal_live_raw(self):
        with ExitStack() as stack:
            self.controlled(stack, writer=False)
            with self.assertRaisesRegex(AssertionError, 'writer exit unconfirmed'):
                self.invoke()
        self.assertEqual((self.out / 'raw.json').read_bytes(), self.writer_bytes)
        self.assertFalse((self.out / 'SHA256SUMS').exists())
        self.assertIn('seal_deferred', json.loads((self.out / 'entry-unmerged.json').read_text()))

    def test_occupied_attempt_is_not_overwritten(self):
        self.out.mkdir(parents=True)
        (self.out / 'raw.json').write_bytes(b'original evidence')
        with patch.object(w, 'configure'), patch.object(w, 'boot') as boot:
            with self.assertRaises(FileExistsError):
                self.invoke()
        boot.assert_not_called()
        self.assertEqual((self.out / 'raw.json').read_bytes(), b'original evidence')

    def test_path_and_unit_refusals(self):
        for attempt in ['../device-001', 'device-001/extra', '001']:
            with self.assertRaisesRegex(AssertionError, 'attempt'):
                w.b3_attempt_paths(self.run, self.run, attempt, 'search-normal')
        with self.assertRaisesRegex(AssertionError, 'unit'):
            w.b3_selection(self.table, 'search-errors')
        (self.run / 'acceptance').symlink_to(self.run / 'elsewhere')
        with self.assertRaisesRegex(AssertionError, 'identity'):
            w.b3_attempt_paths(self.run, self.run, 'device-001', 'search-normal')

    def test_postrun_identity_gate_refuses_wrong_case_or_command(self):
        with ExitStack() as stack:
            self.controlled(stack)
            self.invoke()
            raw = json.loads((self.out / 'raw.json').read_text())
            for mutation in [lambda v: v['steps'].append({'id': 'B2.old', 'status': 'passed'}), lambda v: v['entry']['command'].__setitem__(-1, 'coverage-short'), lambda v: v.__setitem__('unit', 'other')]:
                changed = copy.deepcopy(raw); mutation(changed)
                with self.assertRaisesRegex(AssertionError, 'case|command|selection'):
                    w.validate_b3_inner(self.run, 'device-001', 'search-normal', self.binding, self.out, changed)


    def test_t2_exact_selection_paths_and_no_selector(self):
        selected = w.b3_selection(self.table, 'task-write')
        self.assertEqual(selected['selected_ids'], ['PRE.T2.fixture-login', 'B3.T2.create', 'B3.T2.edit-cancel-save', 'B3.T2.status', 'B3.T2.restore'])
        self.assertNotIn('selector', selected)
        inner, outer = w.b3_attempt_paths(self.run, self.run, 'device-101', 'task-write')
        self.assertEqual(inner, self.run/'acceptance/b3/task-write/attempts/device-101')
        self.assertEqual(outer, self.run/'device-entry-101')
        for selector in ['faults', 'write', '']:
            with self.assertRaisesRegex(AssertionError, 'fixed selection'):
                w.b3_selection(self.table, 'task-write', selector)
        changed=copy.deepcopy(self.table);changed['B3']['task-write']['cases'].reverse()
        with self.assertRaises(AssertionError):w.b3_selection(changed, 'task-write')

    def test_t2_actual_prepare_owner_tls_and_inherited_env(self):
        import runpy
        import sys
        prepare = w.APP/'scripts/prepare-acceptance.py'
        out=self.run/'acceptance/b3/task-write/attempts/device-101';out.mkdir(parents=True)
        observer=out/'t2-observer-private.json';observer.write_text(json.dumps({'version':1,'unit':'task-write','active':False}));observer.chmod(0o600)
        cert=self.run/'acceptance/certs';cert.mkdir()
        for name in ['ca.pem','server.pem','server.key']:(cert/name).write_text('controlled certificate placeholder;never parsed by crypto')
        backend=self.run/'controlled-backend';backend.write_text('never executed')
        argv=[str(prepare),'--existing-ca','--task-write-observer',str(observer),'--task-write-events',str(out/'t2-events.jsonl'),'--task-tls-events',str(out/'t2-tls-events.jsonl')]
        with patch.dict(os.environ, SILVERHAND_ANDROID_RUN_ROOT=str(self.run), OPENSSL_BIN='/controlled/openssl', SILVERHAND_ACCEPTANCE_BACKEND=str(backend), SILVERHAND_T1_CONTROL='/inherited/rejected', SILVERHAND_T1_TLS_EVENTS='/inherited/rejected', SILVERHAND_T2_TLS_EVENTS='/inherited/replaced'),patch.object(sys,'argv',argv),patch.object(w.subprocess,'run') as command,patch.object(w.subprocess,'Popen') as popen,patch.object(w.socket.socket,'connect_ex',return_value=111):
            popen.return_value.pid=999991
            runpy.run_path(str(prepare),run_name='__main__')
        for child_call in popen.call_args_list: child_call.kwargs['stdout'].close()
        self.assertEqual(popen.call_count,2)
        env=popen.call_args_list[1].kwargs['env']
        self.assertEqual(env['SILVERHAND_T2_OBSERVER'],str(observer));self.assertEqual(env['SILVERHAND_T2_TLS_EVENTS'],str(out/'t2-tls-events.jsonl'))
        self.assertNotIn('SILVERHAND_T1_CONTROL',env);self.assertNotIn('SILVERHAND_T1_TLS_EVENTS',env)
        self.assertTrue(all(str(call.args[0][0])=='/controlled/openssl' for call in command.call_args_list))

    def test_t2_prepare_rejects_wrong_tls_and_private_owner_before_spawn(self):
        import runpy
        import sys
        prepare=w.APP/'scripts/prepare-acceptance.py';out=self.run/'acceptance/b3/task-write/attempts/device-102';out.mkdir(parents=True)
        observer=out/'t2-observer-private.json';observer.write_text(json.dumps({'version':1,'unit':'task-write','active':False}));observer.chmod(0o600)
        base=[str(prepare),'--task-write-observer',str(observer),'--task-write-events',str(out/'t2-events.jsonl')]
        cases=[base+['--task-tls-events',str(out/'t1-tls-events.jsonl')],base+['--task-tls-events',str(self.run/'t2-tls-events.jsonl')],[str(prepare),'--task-tls-events',str(out/'t2-tls-events.jsonl')]]
        for argv in cases:
            with self.subTest(argv=argv),patch.dict(os.environ,SILVERHAND_ANDROID_RUN_ROOT=str(self.run),OPENSSL_BIN='/controlled/openssl'),patch.object(sys,'argv',argv),patch.object(w.subprocess,'Popen') as popen,patch.object(w.subprocess,'run') as command:
                with self.assertRaises(AssertionError):runpy.run_path(str(prepare),run_name='__main__')
                popen.assert_not_called();command.assert_not_called()
        observer.chmod(0o644)
        with patch.dict(os.environ,SILVERHAND_ANDROID_RUN_ROOT=str(self.run),OPENSSL_BIN='/controlled/openssl'),patch.object(sys,'argv',base),patch.object(w.subprocess,'Popen') as popen:
            with self.assertRaisesRegex(AssertionError,'private permissions'):runpy.run_path(str(prepare),run_name='__main__')
            popen.assert_not_called()

    def t2_binding(self):
        self.baseline['unit']='task-write'
        self.baseline['selection']=w.b3_selection(self.table,'task-write')
        self.packages={'product':{'path':str(self.run/'synthetic-product.apk'),'sha256':'1'*64},'test':{'path':str(self.run/'synthetic-test.apk'),'sha256':'2'*64}}
        self.baseline['packages']=self.packages
        self.baseline['ca']={'ca_sha256':'3'*64}
        self.origin={'kind':'t2-renewed-ca-asset-origin-v1','frozen_product':self.packages['product'],'test':self.packages['test'],'ca_sha256':'3'*64,'server_certificate_der_sha256':'4'*64}
        self.baseline['product_origin']=self.origin
        self.out=w.b3_attempt_paths(self.run,self.run,'device-001','task-write')[0]
        w.write(self.binding,self.baseline)

    def test_t2_actual_entry_wires_origin_observer_tls_and_outer_consumer(self):
        self.t2_binding()
        def device(_w,out,origin,unit):
            self.assertEqual((out,origin,unit),(self.out,self.origin,'task-write'))
            w.write(out/'origin-device-preconditions.json',{'status':'passed','controlled':True})
        with ExitStack() as stack:
            self.controlled(stack)
            prepare=stack.enter_context(patch.object(w.subprocess,'run'))
            stack.enter_context(patch.object(w,'new_origin_device_preconditions',side_effect=device))
            consume=stack.enter_context(patch.object(w,'validate_new_origin_evidence'))
            self.invoke()
        raw=json.loads((self.out/'raw.json').read_text())
        consume.assert_called_once_with(self.out,self.origin,raw,'task-write')
        argv=list(map(str,prepare.call_args_list[0].args[0]))
        for flag,name in [('--task-write-observer','t2-observer-private.json'),('--task-write-events','t2-events.jsonl'),('--task-tls-events','t2-tls-events.jsonl')]:
            self.assertEqual(argv[argv.index(flag)+1],str(self.out/name))
        self.assertIn('--existing-ca',argv);self.assertNotIn('--task-control',argv)
        self.assertNotIn('controls',raw)
        self.assertEqual(json.loads((self.out/'t2-observer-private.json').read_text()),{'version':1,'unit':'task-write','active':False})
        self.assertEqual((self.out/'t2-observer-private.json').stat().st_mode & 0o777,0o600)
        counts=json.loads((self.out/'counts.json').read_text())
        self.assertEqual((counts['groups']['PRE']['passed'],counts['groups']['B3']['passed']),(1,4))
        changed=copy.deepcopy(raw);changed['bindings'].pop('product_origin')
        with self.assertRaisesRegex(AssertionError,'reviewed new product origin'):
            w.validate_b3_inner(self.run,'device-001','task-write',self.binding,self.out,changed)
        for field in ['manifest','events']:
            changed=copy.deepcopy(raw);changed['observer'][field]='/other/'+field
            with self.assertRaisesRegex(AssertionError,'observer/output'):
                w.validate_b3_inner(self.run,'device-001','task-write',self.binding,self.out,changed)

    def test_t2_final_observer_failure_after_valid_pre_refuses_success_and_preserves_first_error(self):
        self.t2_binding()
        evidence=T2OriginalEvidence();evidence.setUp();self.addCleanup(evidence.doCleanups)
        def rebase(value):
            if isinstance(value,str):return value.replace(str(evidence.out),str(self.out))
            if isinstance(value,list):return [rebase(item) for item in value]
            if isinstance(value,dict):return {key:rebase(item) for key,item in value.items()}
            return value
        def device(_w,out,origin,unit):
            for source in evidence.out.iterdir():
                (out/source.name).write_text(source.read_text().replace(str(evidence.out),str(out)))
        for failed in [False,True]:
            with self.subTest(existing_business_error=failed),ExitStack() as stack:
                self.controlled(stack,failed=failed)
                stack.enter_context(patch.object(w,'new_origin_device_preconditions',side_effect=device))
                original=w.record_entry.side_effect
                def entry(command,out):
                    result=original(command,out)
                    raw=json.loads((out/'raw.json').read_text())
                    raw['observations']=rebase(evidence.raw['observations'])
                    w.write(out/'raw.json',raw)
                    # Simulates a final TLS publish failure appended after the valid PRE row.
                    (out/'t2-events.jsonl').write_text(json.dumps({'seq':1,'event':'observer_start'})+'\n'+json.dumps({'seq':2,'event':'observation_failure','reason':'tls_publish'})+'\n')
                    return result
                stack.enter_context(patch.object(w,'record_entry',side_effect=entry))
                # Actual PRE original-file validator remains in use; no substitute completion marker.
                with self.assertRaisesRegex(AssertionError,'entry failed' if failed else 'observation_failure'):
                    self.invoke()
                raw=json.loads((self.out/'raw.json').read_text())
                self.assertEqual(raw['steps'][0]['status'],'passed')
                self.assertEqual(raw['cleanup']['status'],'passed')
                self.assertEqual(raw['status'],'failed')
                self.assertTrue((self.out/'counts.json').exists())
                self.assertTrue((self.out/'SHA256SUMS').exists())
                if failed:
                    self.assertEqual(raw['first_error']['message'],'original controlled Search failure')
                    self.assertNotIn('final_observer_validation',raw)
                else:
                    self.assertTrue(all(row['status']=='passed' for row in raw['steps']), 'controlled PRE and four business observations passed before final veto')
                    self.assertIn('observation_failure',raw['first_error']['message'])
                    self.assertEqual(raw['final_observer_validation']['status'],'failed')
                import shutil
                shutil.rmtree(self.out)

    def test_t2_missing_identity_or_historical_f7_refuses_before_services(self):
        import b3_origin as origin
        self.t2_binding()
        cases=[('wrong-kind',lambda b:b['product_origin'].__setitem__('kind','fixed-f7-ca-asset-origin-v1')),('missing-origin',lambda b:b.pop('product_origin')),('missing-test',lambda b:b['product_origin'].pop('test')),('short-product-hash',lambda b:b['product_origin']['frozen_product'].__setitem__('sha256','1')),('old-f7',lambda b:b['product_origin']['frozen_product'].__setitem__('sha256',origin.PRODUCT))]
        for name,mutate in cases:
            with self.subTest(name=name),ExitStack() as stack:
                changed=copy.deepcopy(self.baseline);mutate(changed);w.write(self.binding,changed)
                self.controlled(stack)
                prepare=stack.enter_context(patch.object(w.subprocess,'run'))
                boot=stack.enter_context(patch.object(w,'boot'))
                with self.assertRaises((AssertionError,KeyError)):self.invoke()
                prepare.assert_not_called();boot.assert_not_called()
                raw=json.loads((self.out/'raw.json').read_text())
                self.assertTrue(all(row['status']=='not_executed' for row in raw['steps']))
                import shutil
                shutil.rmtree(self.out)

    def test_t1_exact_seven_selection_and_explicit_control(self):
        self.baseline['unit'] = 'task-read'
        self.selection = w.b3_selection(self.table, 'task-read')
        self.baseline['selection'] = self.selection
        w.write(self.binding, self.baseline)
        self.out = w.b3_attempt_paths(self.run, self.run, 'device-001', 'task-read')[0]
        with ExitStack() as stack:
            self.controlled(stack)
            prepare = stack.enter_context(patch.object(w.subprocess, 'run'))
            self.invoke()
        command = list(map(str, prepare.call_args_list[0].args[0]))
        self.assertIn('--task-control', command)
        self.assertNotIn('--search-control', command)
        control = json.loads((self.out/'t1-control.json').read_text())
        self.assertFalse(control['active']); self.assertFalse(control['releaseAll'])
        self.assertEqual(control['rules'], []); self.assertEqual(control['routes'], [])
        raw = json.loads((self.out/'raw.json').read_text())
        self.assertEqual(len(raw['steps']),7)
        self.assertEqual(raw['selection']['planned_business'],6)
        changed = copy.deepcopy(raw); changed['controls']['manifest']='/other/control'
        with self.assertRaisesRegex(AssertionError,'control/output'):
            w.validate_b3_inner(self.run,'device-001','task-read',self.binding,self.out,changed)
        self.assertEqual((self.run/'b2-binding.json').read_bytes(),self.before)

    def test_t1_faults_selection_actual_entry_counts_and_original_control_path(self):
        self.baseline['unit']='task-read'
        self.baseline['selection']=w.b3_selection(self.table,'task-read','faults')
        w.write(self.binding,self.baseline)
        self.out=w.b3_attempt_paths(self.run,self.run,'device-001','task-read')[0]
        with ExitStack() as stack:
            self.controlled(stack)
            prepare=stack.enter_context(patch.object(w.subprocess,'run'))
            self.invoke()
        raw=json.loads((self.out/'raw.json').read_text());counts=json.loads((self.out/'counts.json').read_text())
        self.assertEqual(raw['selection']['selector'],'faults')
        self.assertEqual(raw['selection']['planned_business'],3)
        self.assertEqual(counts['groups']['PRE']['passed'],1);self.assertEqual(counts['groups']['B3']['passed'],3)
        self.assertIn('B3.T1.conversation-anchor',raw['selection']['not_selected'])
        self.assertEqual(raw['entry']['command'][-2:],['task-read','faults'])
        self.assertEqual(raw['controls']['manifest'],str(self.out/'t1-control.json'))
        self.assertIn('--task-control',list(map(str,prepare.call_args_list[0].args[0])))
        w.validate_b3_inner(self.run,'device-001','task-read',self.binding,self.out,raw,'faults')
        for mutate in [lambda r:r['selection'].__setitem__('selector','other'),lambda r:r['steps'].append({'id':'B3.T1.conversation-anchor','status':'passed'}),lambda r:r['entry']['command'].pop()]:
            changed=copy.deepcopy(raw);mutate(changed)
            with self.assertRaisesRegex(AssertionError,'selection|case|command'):
                w.validate_b3_inner(self.run,'device-001','task-read',self.binding,self.out,changed,'faults')
        with self.assertRaisesRegex(AssertionError,'selection'):
            w.validate_b3_inner(self.run,'device-001','task-read',self.binding,self.out,raw)
        self.assertEqual((self.run/'b2-binding.json').read_bytes(),self.before)

    def test_invalid_fixed_selection_refuses_before_attempt_or_any_external_action(self):
        for unit,selector in [('task-read','other'),('task-read',''),('search-normal','faults'),('search-isolation','faults')]:
            with self.subTest(unit=unit,selector=selector),patch.object(w,'configure') as configure,patch.object(w,'boot') as boot:
                with self.assertRaisesRegex(AssertionError,'fixed selection'):
                    w.acceptance(self.run,'b3','device-001',unit=unit,binding=self.binding,selection_name=selector)
                configure.assert_not_called();boot.assert_not_called();self.assertFalse((self.run/'acceptance').exists())

    def test_full_six_binding_cannot_be_reused_for_faults_selection(self):
        self.baseline['unit']='task-read';self.baseline['selection']=w.b3_selection(self.table,'task-read');w.write(self.binding,self.baseline)
        self.out=w.b3_attempt_paths(self.run,self.run,'device-001','task-read')[0]
        with patch.object(w,'configure'),patch.object(w,'boot') as boot,patch.object(w,'b2_package_check') as package:
            with self.assertRaisesRegex(AssertionError,'selection'):
                w.acceptance(self.run,'b3','device-001',unit='task-read',binding=self.binding,selection_name='faults')
            boot.assert_not_called();package.assert_not_called()


class S2PrepareScope(unittest.TestCase):
    """Execute only argument validation prefix; never start a service/OpenSSL."""
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(); self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.parent = self.root / 'acceptance/b3/search-isolation/attempts/device-003'
        self.parent.mkdir(parents=True)
        self.control = self.parent / 's2-control.json'; self.events = self.parent / 's2-proxy-events.jsonl'
        self.control.write_text(json.dumps({'version': 1, 'unit': 'search-isolation', 'attempt': 'device-003', 'active': False, 'users': [], 'rules': []}))
        self.source = w.APP / 'scripts/prepare-acceptance.py'
        self.prefix = self.source.read_text().split("for name in ['backend','proxy']:", 1)[0]

    def run_prefix(self, args):
        env = {'OPENSSL_BIN': '/unused/openssl', 'SILVERHAND_ANDROID_RUN_ROOT': str(self.root),
               'SILVERHAND_S2_CONTROL': '/unreviewed', 'SILVERHAND_S2_EVENTS': '/unreviewed'}
        with patch.dict(os.environ, env), patch('sys.argv', [str(self.source), *args]):
            values = {'__file__': str(self.source)}
            exec(compile(self.prefix, str(self.source), 'exec'), values)
        return values

    def test_default_strips_ambient_controls(self):
        value = self.run_prefix([])
        self.assertNotIn('SILVERHAND_S2_CONTROL', value['proxy_env'])
        self.assertNotIn('SILVERHAND_S2_EVENTS', value['proxy_env'])

    def test_only_exact_inactive_unoccupied_unit_paths_are_enabled(self):
        value = self.run_prefix(['--search-control', str(self.control), '--search-events', str(self.events)])
        self.assertEqual(value['proxy_env']['SILVERHAND_S2_CONTROL'], str(self.control))
        self.assertEqual(value['proxy_env']['SILVERHAND_S2_EVENTS'], str(self.events))

    def test_unpaired_refused(self):
        with self.assertRaisesRegex(AssertionError, 'paired'): self.run_prefix(['--search-control', str(self.control)])

    def test_occupied_events_refused(self):
        self.events.write_bytes(b'original')
        with self.assertRaisesRegex(AssertionError, 'occupied'): self.run_prefix(['--search-control', str(self.control), '--search-events', str(self.events)])
        self.assertEqual(self.events.read_bytes(), b'original')

    def test_active_control_refused(self):
        value = json.loads(self.control.read_text()); value['active'] = True; self.control.write_text(json.dumps(value))
        with self.assertRaisesRegex(AssertionError, 'transparent'): self.run_prefix(['--search-control', str(self.control), '--search-events', str(self.events)])

    def test_wrong_unit_or_symlink_path_refused(self):
        other = self.root / 'other'; other.mkdir(); linked = other / 's2-control.json'; linked.symlink_to(self.control)
        for control, events in [(linked, other / 's2-proxy-events.jsonl'), (self.control, other / 's2-proxy-events.jsonl')]:
            with self.subTest(control=control), self.assertRaisesRegex(AssertionError, 'identity|mismatch'):
                self.run_prefix(['--search-control', str(control), '--search-events', str(events)])


class T1PrepareScope(unittest.TestCase):
    run_prefix = S2PrepareScope.run_prefix
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory(); self.addCleanup(self.directory.cleanup)
        self.root=Path(self.directory.name).resolve()
        self.parent=self.root/'acceptance/b3/task-read/attempts/device-007';self.parent.mkdir(parents=True)
        self.control=self.parent/'t1-control.json';self.events=self.parent/'t1-proxy-events.jsonl'
        self.spec={'version':1,'unit':'task-read','attempt':'device-007','active':False,'users':[],'taskIds':[],'channelIds':[],'routes':[],'rules':[],'releaseAll':False}
        self.control.write_text(json.dumps(self.spec))
        self.source=w.APP/'scripts/prepare-acceptance.py'
        self.prefix=self.source.read_text().split("for name in ['backend','proxy']:",1)[0]
    def test_t1_prefix_enables_only_explicit_inactive_unit(self):
        values=self.run_prefix(['--task-control',str(self.control),'--task-events',str(self.events)])
        self.assertEqual(values['proxy_env']['SILVERHAND_T1_CONTROL'],str(self.control))
        self.assertNotIn('SILVERHAND_S2_CONTROL',values['proxy_env'])
    def test_t1_prefix_refuses_unpaired_occupied_or_active(self):
        with self.assertRaisesRegex(AssertionError,'paired'):self.run_prefix(['--task-control',str(self.control)])
        self.events.write_bytes(b'original')
        with self.assertRaisesRegex(AssertionError,'occupied'):self.run_prefix(['--task-control',str(self.control),'--task-events',str(self.events)])
        self.assertEqual(self.events.read_bytes(),b'original');self.events.unlink()
        self.control.write_text(json.dumps({**self.spec,'active':True}))
        with self.assertRaisesRegex(AssertionError,'transparent'):self.run_prefix(['--task-control',str(self.control),'--task-events',str(self.events)])
    def test_t1_prefix_rejects_wrong_unit_path_and_symlink(self):
        other=self.root/'other';other.mkdir();linked=other/'t1-control.json';linked.symlink_to(self.control)
        with self.assertRaisesRegex(AssertionError,'identity'):self.run_prefix(['--task-control',str(linked),'--task-events',str(other/'t1-proxy-events.jsonl')])
        self.control.write_text(json.dumps({**self.spec,'unit':'search-isolation'}))
        with self.assertRaisesRegex(AssertionError,'transparent'):self.run_prefix(['--task-control',str(self.control),'--task-events',str(self.events)])




class T2OriginalEvidence(unittest.TestCase):
    def setUp(self):
        import b3_origin
        self.origin_module=b3_origin
        self.directory=tempfile.TemporaryDirectory();self.addCleanup(self.directory.cleanup)
        self.out=Path(self.directory.name).resolve()
        self.origin={'kind':'t2-renewed-ca-asset-origin-v1','frozen_product':{'path':str(self.out/'synthetic-product.apk'),'sha256':'1'*64},'test':{'path':str(self.out/'synthetic-test.apk'),'sha256':'2'*64},'ca_sha256':'3'*64,'server_certificate_der_sha256':'4'*64}
        self.log='B1_DEVICE_CONTROL_COMPLETED\nINSTRUMENTATION_CODE: -1\n'
        (self.out/'origin-controller.log').write_text(self.log)
        exited={'pid':321,'command':['controlled-controller'],'wait_finished':True,'final_returncode':0,'term_sent':False,'kill_sent':False,'cleanup_errors':[],'natural_returncode':0,'natural_exit':True}
        w.write(self.out/'origin-controller-exit.json',exited)
        control={'status':'passed','ready':True,'wait_finished':True,'raw_returncode':0,'first_error':None,'cleanup_errors':[],'pid':321,'command':exited['command'],'identity':{'pid':42,'activity':43,'webViewIdentity':44},'log':str(self.out/'origin-controller.log'),'log_sha256':w.digest(self.out/'origin-controller.log'),'exit_record':{'path':str(self.out/'origin-controller-exit.json'),'sha256':w.digest(self.out/'origin-controller-exit.json')},'terminal':b3_origin.instrumentation_terminal(self.log,0,True)}
        control['requests']=[{'request':{'id':'identity','operation':'identity'},'response':{'ok':True,'id':'identity','result':control['identity']}},{'request':{'id':'stop','operation':'stop'},'write_exit':0,'response':None,'response_read':False}]
        w.write(self.out/'origin-controller.json',control)
        device={'status':'passed','controller':control,'public_CA':{'expected_sha256':'3'*64,'sha256sum_output':'3'*64+' files/acceptance-ca.pem'}}
        for key,sha in [('product','1'*64),('test','2'*64)]:
            path='/data/app/controlled-'+key+'/base.apk'
            device[key]={'status':'passed','expected_sha256':sha,'installed_path':path,'sha256sum_output':sha+' '+path}
        w.write(self.out/'origin-device-preconditions.json',device)
        w.write(self.out/'fixture-private.json',{'userId':'A'})
        self.response={'id':'trace-original','attempt':str(self.out),'event':'fixture_me_tls_response','fixtureUserId':'A','method':'GET','pathname':'/api/me','host':'localhost:29443','upstream':{'host':'127.0.0.1','port':18480,'status':200},'bodySha256':'5'*64,'bodyBytes':10,'tls':{'encrypted':True,'protocol':'TLSv1.3','localPort':29443,'serverCertificateSha256':'4'*64}}
        marker={'status':'passed','nativeServerUrl':'https://localhost:29443','fixtureUserId':'A','infoStatus':200,'meStatus':200,'nativeTraceId':'trace-original','nativeBodySha256':'5'*64,'nativeBodyBytes':10,'response':copy.deepcopy(self.response)}
        self.raw={'new_origin_device_preconditions':device,'observations':[{'name':'t2-new-origin-native-tls-complete','value':marker}]}
        self.write_row(self.response)

    def write_row(self,row):
        (self.out/'t2-tls-events.jsonl').write_text(json.dumps(row)+'\n')

    def consume(self,raw=None):
        self.origin_module.validate_evidence(self.out,self.origin,self.raw if raw is None else raw,'task-write')

    def test_exact_t2_kind_and_unchanged_t1_kind(self):
        origin=self.origin_module
        self.assertEqual(origin.expected_packages(self.origin,'task-write'),('1'*64,'2'*64))
        for kind in [None,'fixed-f7-ca-asset-origin-v1','t2-renewed-ca-asset-origin-v2','synthetic-control-only']:
            changed=copy.deepcopy(self.origin)
            if kind is None:changed.pop('kind')
            else:changed['kind']=kind
            with self.subTest(kind=kind),self.assertRaisesRegex(AssertionError,'T2 origin kind differs'):
                origin.expected_packages(changed,'task-write')
        self.assertEqual(origin.expected_packages({'kind':'fixed-f7-ca-asset-origin-v1'},'task-read'),(origin.PRODUCT,origin.TEST))
        with self.assertRaisesRegex(AssertionError,'T1 origin kind differs'):
            origin.expected_packages(self.origin,'task-read')

    def test_same_attempt_original_files_native_trace_hash_certificate_accepted(self):
        self.consume()

    def test_original_row_present_but_attempt_identity_trace_body_certificate_rejected(self):
        cases=[('attempt',lambda r:r.__setitem__('attempt',str(self.out)+'-other'),'attempt'),('identity',lambda r:r.__setitem__('fixtureUserId','B'),'source'),('trace',lambda r:r.__setitem__('id','trace-other'),'correlation'),('body',lambda r:r.__setitem__('bodySha256','6'*64),'digest'),('certificate',lambda r:r['tls'].__setitem__('serverCertificateSha256','7'*64),'connection')]
        for name,mutate,message in cases:
            with self.subTest(name=name):
                row=copy.deepcopy(self.response);mutate(row);self.write_row(row)
                raw=copy.deepcopy(self.raw);raw['observations'][0]['value']['response']=copy.deepcopy(row)
                with self.assertRaisesRegex(AssertionError,message):self.consume(raw)
        self.write_row(self.response);self.consume()

    def test_final_journal_existing_bounds_sequence_and_failure_rules(self):
        path=self.out/'t2-events.jsonl'
        valid=json.dumps({'seq':1,'event':'observer_start'})+'\n'
        path.write_text(valid)
        answer=self.origin_module.validate_t2_final_events(self.out)
        self.assertEqual((answer['status'],answer['events']),('passed',1))
        invalid=[valid+json.dumps({'seq':2,'event':'observation_failure'})+'\n',valid+json.dumps({'seq':3,'event':'terminal'})+'\n',valid.rstrip(),json.dumps({'seq':1,'event':'terminal'})+'\n',''.join(json.dumps({'seq':i+1,'event':'observer_start' if i==0 else 'terminal'})+'\n' for i in range(513)),'x'*(4*1024*1024+1)]
        for text in invalid:
            path.write_text(text)
            with self.assertRaises(AssertionError):self.origin_module.validate_t2_final_events(self.out)

    def test_original_row_duplicate_or_partial_or_marker_only_rejected(self):
        path=self.out/'t2-tls-events.jsonl';text=path.read_text()
        for malformed,expected in [(text+text,'correlation'),(text.rstrip(),'bytes')]:
            path.write_text(malformed)
            with self.assertRaisesRegex(AssertionError,expected):self.consume()
        path.unlink()
        with self.assertRaises(FileNotFoundError):self.consume()

if __name__ == '__main__':
    unittest.main()
