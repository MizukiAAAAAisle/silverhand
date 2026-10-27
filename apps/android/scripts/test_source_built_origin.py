"""Source-built T2 origin through actual workflow consumers; temporary IO only."""
import copy
from contextlib import ExitStack
import hashlib
import json
import shutil
import ssl
import unittest
from unittest.mock import patch
import test_b3_workflow as existing
import b3_origin as origin

w=existing.w

def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()

class SourceBuiltOrigin(unittest.TestCase):
    def setUp(self):
        self.f=existing.B3Entry();self.f.setUp();self.addCleanup(self.f.doCleanups)
        f=self.f;f.t2_binding()
        for name in ['product','test']:
            path=f.run/('synthetic-'+name+'.apk');path.write_bytes(('controlled '+name).encode())
            f.packages[name]['sha256']=digest(path)
        self.build_root=f.run/'original-source-build';certs=self.build_root/'acceptance/certs';certs.mkdir(parents=True)
        (certs/'ca.pem').write_text('controlled public CA bytes')
        (certs/'server.pem').write_text(ssl.DER_cert_to_PEM_cert(b'controlled server DER'))
        core=self.build_root/'core-build/manifest.json';core.parent.mkdir();core.write_text('{"controlled":true}\n')
        f.origin.update(kind='source-built-acceptance-origin-v1',CA_asset_only_derivation=False,ca_sha256=digest(certs/'ca.pem'),server_certificate_der_sha256=hashlib.sha256(b'controlled server DER').hexdigest())
        f.baseline['ca']={'ca_sha256':f.origin['ca_sha256']}
        self.build={'inputs':{'repository':{'controlled-original-build-source':'a'*64},'environment_config':'b'*64},'packages':copy.deepcopy(f.packages),'actual_apk':{'apk':f.packages['product']['path'],'apk_sha256':f.packages['product']['sha256'],'actual_APK_inputs_match':True,'packaged_input_hashes':{'assets/controlled':'c'*64},'ca_sha256':f.origin['ca_sha256'],'core_manifest_sha256':digest(core)}}
        self.path=self.build_root/'b2-binding.json';self.seal()
        f.baseline['product_origin']=f.origin;w.write(f.binding,f.baseline)
        self.original_build=self.path.read_bytes()

    def seal(self):
        self.path.write_text(json.dumps(self.build))
        self.f.origin['source_build_binding']={'path':str(self.path),'sha256':digest(self.path)}

    def invoke(self,expect_failure=False):
        f=self.f
        with ExitStack() as stack:
            f.controlled(stack)
            prepare=stack.enter_context(patch.object(w.subprocess,'run'))
            boot=stack.enter_context(patch.object(w,'boot')) if expect_failure else None
            if expect_failure:
                with self.assertRaises((AssertionError,KeyError,FileNotFoundError)):f.invoke()
                prepare.assert_not_called();boot.assert_not_called()
                raw=json.loads((f.out/'raw.json').read_text());self.assertTrue(all(x['status']=='not_executed' for x in raw['steps']))
                shutil.rmtree(f.out)
            else:
                def device(_w,out,material,unit):
                    self.assertEqual((material,unit),(f.origin,'task-write'));w.write(out/'origin-device-preconditions.json',{'status':'passed','controlled':True})
                stack.enter_context(patch.object(w,'new_origin_device_preconditions',side_effect=device))
                consumer=stack.enter_context(patch.object(w,'validate_new_origin_evidence'))
                f.invoke()
                raw=json.loads((f.out/'raw.json').read_text())
                consumer.assert_called_once_with(f.out,f.origin,raw,'task-write')
                self.assertEqual(raw['bindings']['product_origin'],f.origin)
                # Exercise the real outer consumer again, not a hand-built package verdict.
                w.validate_b3_inner(f.run,'device-001','task-write',f.binding,f.out,raw)
                self.assertEqual(consumer.call_count,2)
                self.assertEqual(self.path.read_bytes(),self.original_build)
                self.assertNotEqual(self.build['inputs'],f.baseline['inputs'],'original build and later driver inputs must stay distinct')
                return raw

    def test_actual_workflow_and_outer_consume_source_build_binding(self):
        raw=self.invoke()
        self.assertEqual(raw['status'],'passed')

    def test_missing_or_tampered_source_build_ref_refuses_before_services(self):
        f=self.f;original=copy.deepcopy(f.origin)
        for case in ['missing','missing-file','digest-mismatch']:
            with self.subTest(case=case):
                f.origin=copy.deepcopy(original)
                if case=='missing':f.origin.pop('source_build_binding')
                elif case=='missing-file':f.origin['source_build_binding']['path']=str(self.build_root/'absent.json')
                else:f.origin['source_build_binding']['sha256']='f'*64
                f.baseline['product_origin']=f.origin;w.write(f.binding,f.baseline);self.invoke(expect_failure=True)

    def test_rehashed_incomplete_or_different_build_refuses_before_services(self):
        original=copy.deepcopy(self.build)
        for case in ['inputs','product','test','payload','CA','core']:
            with self.subTest(case=case):
                self.build=copy.deepcopy(original)
                if case=='inputs':self.build['inputs']['repository']={}
                elif case in ['product','test']:self.build['packages'][case]['sha256']='d'*64
                elif case=='payload':self.build['actual_apk']['actual_APK_inputs_match']=False
                elif case=='CA':self.build['actual_apk']['ca_sha256']='d'*64
                else:self.build['actual_apk']['core_manifest_sha256']='d'*64
                self.seal();w.write(self.f.binding,self.f.baseline);self.invoke(expect_failure=True)

    def test_CA_only_or_server_DER_mismatch_refuses_before_services(self):
        f=self.f;original=copy.deepcopy(f.origin)
        for case in ['CA-only','server-DER']:
            with self.subTest(case=case):
                f.origin=copy.deepcopy(original)
                if case=='CA-only':f.origin['CA_asset_only_derivation']=True
                else:f.origin['server_certificate_der_sha256']='d'*64
                f.baseline['product_origin']=f.origin;w.write(f.binding,f.baseline);self.invoke(expect_failure=True)

    def test_legacy_T1_and_CA_only_mapping_remains_closed(self):
        f=self.f
        legacy={**f.origin,'kind':'t2-renewed-ca-asset-origin-v1'};legacy.pop('source_build_binding');legacy.pop('CA_asset_only_derivation')
        self.assertEqual(origin.expected_packages(legacy,'task-write'),(f.packages['product']['sha256'],f.packages['test']['sha256']))
        self.assertEqual(origin.expected_packages({'kind':'fixed-f7-ca-asset-origin-v1'},'task-read'),(origin.PRODUCT,origin.TEST))
        for material,unit in [(f.origin,'task-read'),({**f.origin,'kind':'source-built-acceptance-origin-v2'},'task-write')]:
            with self.subTest(unit=unit),self.assertRaisesRegex(AssertionError,'origin kind differs'):origin.expected_packages(material,unit)

if __name__=='__main__':unittest.main()
