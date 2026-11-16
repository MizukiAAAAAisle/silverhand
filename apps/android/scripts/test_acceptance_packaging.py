"""Run the production Gradle gate in an isolated packaging graph, without AGP/APK/device.

Android source sets and merge/package actions are fixtures. The applied gate, Python
validator, OpenSSL, Gradle and build-app.sh dispatch are real. Web commands are no-ops.
"""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from trust_test_fixtures import pki

APP = Path(__file__).resolve().parents[1]


class AcceptancePackaging(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temporary.name)
        cls.fixtures = cls.root / 'pki'; cls.fixtures.mkdir(); pki(cls.fixtures)
        cls.project = cls.root / 'apps/android/app'; cls.project.mkdir(parents=True)
        scripts = cls.project.parent / 'scripts'; scripts.mkdir()
        shutil.copy(APP / 'scripts/acceptance_certificates.py', scripts)
        cls.gradle = cls.root / 'core/gradle'; cls.gradle.mkdir(parents=True)
        (cls.gradle / 'settings.gradle').write_text("rootProject.name='certificate-gate-fixture'\ninclude(':app')\nproject(':app').projectDir=file('../../apps/android/app')\n")
        (cls.project / 'build.gradle').write_text('''
class FixtureSourceSets {
    Map entries
    def getByName(String name) { entries[name] }
}
extensions.add('android', new Expando(sourceSets: new FixtureSourceSets(entries: [
    main: [assets: [srcDirs: [file('src/main/assets')] as Set]],
    acceptance: [assets: [srcDirs: [file('build/acceptance-assets')] as Set]]
])))
tasks.register('mergeAcceptanceAssets') {
    inputs.dir('build/acceptance-assets')
    outputs.file('build/merged-marker')
    doLast { file('build/merged-marker').text='fixture merge' }
}
tasks.register('assembleAcceptance') {
    dependsOn('mergeAcceptanceAssets')
    doLast { file('build/packaged-marker').text='fixture package' }
}
tasks.register('assembleDebug')
tasks.register('assembleRelease')
'''+"apply from: '"+str(APP/'acceptance-certificates.gradle')+"'\n")
        cls.bin = cls.root / 'bin'; cls.bin.mkdir()
        for name in ['node', 'pnpm']:
            path = cls.bin / name; path.write_text('#!/bin/sh\nexit 0\n'); path.chmod(0o755)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def setUp(self):
        self.run = self.root / 'run'
        self.cert = self.run / 'acceptance/certs'; self.cert.mkdir(parents=True, exist_ok=True)
        for source, target in [('valid.pem','ca.pem'),('valid-server.pem','server.pem'),('valid-server.key','server.key')]:
            shutil.copy(self.fixtures/source,self.cert/target)
        self.assets = self.project/'build/acceptance-assets'; self.assets.mkdir(parents=True, exist_ok=True)
        shutil.copy(self.cert/'ca.pem',self.assets/'acceptance-ca.pem')
        main = self.project/'src/main/assets'; main.mkdir(parents=True, exist_ok=True)
        (main/'acceptance-ca.pem').unlink(missing_ok=True)
        self.marker=self.project/'build/packaged-marker'; self.marker.unlink(missing_ok=True)
        self.env={**os.environ,'SILVERHAND_ANDROID_RUN_ROOT':str(self.run),
                  'SILVERHAND_ANDROID_BUILD':str(self.root/'core'),
                  'PNPM_BIN':str(self.bin/'pnpm'),'PATH':str(self.bin)+os.pathsep+os.environ['PATH']}

    def invoke(self, *tasks, shell=False):
        command = ['bash',str(APP/'scripts/build-app.sh'),'Acceptance'] if shell else [
            os.environ['GRADLE_BIN'],'-p',str(self.gradle),'--offline','--no-daemon','--console=plain',*tasks]
        result=subprocess.run(command,env=self.env,capture_output=True,text=True,timeout=90)
        print('PACKAGING CONTROL',result.returncode,result.stdout,result.stderr,flush=True)
        return result

    def test_direct_entry_rejects_actual_expired_asset_before_packaging(self):
        shutil.copy(self.fixtures/'expired.pem',self.assets/'acceptance-ca.pem')
        result=self.invoke(shell=True)
        self.assertNotEqual(result.returncode,0)
        self.assertIn('not currently valid',result.stdout+result.stderr)
        self.assertFalse(self.marker.exists())

    def test_direct_entry_rejects_two_day_asset_even_with_valid_prepared_chain(self):
        subprocess.run([os.environ['OPENSSL_BIN'], 'x509', '-req', '-in', 'valid.csr',
                        '-signkey', 'valid.key', '-days', '2', '-extfile', 'ca.ext',
                        '-out', str(self.assets/'acceptance-ca.pem')], cwd=self.fixtures,
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        result=self.invoke(shell=True)
        self.assertNotEqual(result.returncode,0)
        self.assertIn('604800',result.stdout+result.stderr)
        self.assertFalse(self.marker.exists())

    def test_direct_entry_valid_and_reused_up_to_date_assets_recheck(self):
        first=self.invoke(shell=True)
        self.assertEqual(first.returncode,0,first.stdout+first.stderr)
        self.assertTrue(self.marker.exists())
        second=self.invoke(':app:assembleAcceptance')
        self.assertEqual(second.returncode,0,second.stdout+second.stderr)
        self.assertIn(':app:mergeAcceptanceAssets UP-TO-DATE',second.stdout)
        self.assertIn('packaged_asset_validity',second.stdout)
        self.assertNotIn(':app:validateAcceptanceCertificates UP-TO-DATE',second.stdout)

    def test_mismatch_and_shadow_asset_refuse(self):
        shutil.copy(self.fixtures/'system.pem',self.assets/'acceptance-ca.pem')
        result=self.invoke(':app:assembleAcceptance')
        self.assertNotEqual(result.returncode,0)
        self.assertIn('differs from prepared CA',result.stdout+result.stderr)
        self.assertFalse(self.marker.exists())
        shutil.copy(self.cert/'ca.pem',self.assets/'acceptance-ca.pem')
        shutil.copy(self.cert/'ca.pem',self.project/'src/main/assets/acceptance-ca.pem')
        result=self.invoke(':app:assembleAcceptance')
        self.assertNotEqual(result.returncode,0)
        self.assertIn('Expected exactly one packaged',result.stdout+result.stderr)
        self.assertFalse(self.marker.exists())

    def test_normal_and_core_only_do_not_require_acceptance_materials(self):
        shutil.rmtree(self.cert); shutil.rmtree(self.assets)
        self.env.pop('OPENSSL_BIN',None)
        result=self.invoke(':app:assembleDebug',':app:assembleRelease','help')
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertNotIn(':app:validateAcceptanceCertificates',result.stdout)


if __name__ == '__main__':
    unittest.main()
