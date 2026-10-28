#!/usr/bin/env python3
"""Build the upstream allowlisted core and generated JNI; do not edit upstream files.
Required env: SWIFT_ANDROID_TOOLCHAIN, SWIFT_ANDROID_SDK_BUNDLE, ANDROID_NDK_HOME.
The selected Swift SDK and host toolchain must match. Logs/manifest stay in .generated.
"""
import os,subprocess,shutil,json,hashlib,argparse,time,datetime
from build_environment import build_environment
parser=argparse.ArgumentParser();parser.add_argument("--from-stage",choices=["all","host","android","package"],default="all");parser.add_argument("--configuration",choices=["debug","release"],default="debug");parser.add_argument('--log-dir');args=parser.parse_args()
from pathlib import Path
app=Path(__file__).resolve().parents[1];repo=app.parents[1];out=Path(os.environ.get('SILVERHAND_ANDROID_BUILD',str(app/'.generated/build'))).resolve();out.mkdir(parents=True,exist_ok=True)
core=out/'core';native=out/'native'
logs=Path(args.log_dir).resolve() if args.log_dir else out
if args.log_dir: logs.mkdir(parents=True,exist_ok=False)
source=repo/'apps/ios/native'
env=build_environment(os.environ);env.update(SKIP_BRIDGE_ANDROID_BUILD_DISABLED='1',SKIP_BRIDGE_ROBOLECTRIC_BUILD_DISABLED='1')
if args.from_stage == "all":
    # Regenerate from working-tree sources so an upstream sync cannot silently use old Swift.
    if core.exists(): shutil.rmtree(core)
    shutil.copytree(source,core,ignore=shutil.ignore_patterns('.build','.swiftpm'))
    r=subprocess.run(['patch','-p1','--batch','--fuzz=0','-i',str(app/'scripts/core-extraction.patch')],cwd=core,capture_output=True,text=True,env=env)
    (out/'core-extraction.log').write_text(r.stdout+r.stderr);r.check_returncode()
    subprocess.run(['node',str(app/'scripts/write-protocol.mjs'),str(core/'Sources/SilverhandNative/Resources/Protocol.json')],check=True,env=env)
    native.mkdir(exist_ok=True)
    for name in ['Package.swift','Package.resolved']: shutil.copy(app/'native'/name,native/name)
    if (native/'Sources').exists(): shutil.rmtree(native/'Sources')
    shutil.copytree(app/'native/Sources',native/'Sources')
swift=Path(env['SWIFT_ANDROID_TOOLCHAIN'])/'usr/bin/swift';sdk=Path(env['SWIFT_ANDROID_SDK_BUNDLE'])
def run(name,cmd,extra={}):
 started=time.monotonic();started_at=datetime.datetime.now(datetime.timezone.utc).isoformat()
 with (logs/(name+'.log')).open('x' if args.log_dir else 'w') as log:
  # Keep Python's ignored SIGPIPE disposition for SwiftPM/Skip IPC. A cold Swift 6.4.1
  # launch with restored defaults has terminated with -13 before compilation.
  # Do not retry or suppress return codes; compiler failures still fail this build.
  result=None;launch_error=None
  try:
   result=subprocess.run(list(map(str,cmd)),env=env|extra,stdout=log,stderr=subprocess.STDOUT,restore_signals=False)
  except OSError as error:
   launch_error=str(error)
   raise
  finally:
   if args.log_dir:
    code=result.returncode if result is not None else None
    with (logs/(name+'.exit.json')).open('x') as raw:
     json.dump({'command':list(map(str,cmd)),'raw_subprocess_returncode':code,'signal_if_negative':-code if code is not None and code<0 else None,'launch_error':launch_error,'seconds':round(time.monotonic()-started,6),'started_at_utc':started_at,'wait_finished_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'restore_signals':False},raw,indent=2);raw.write('\n');raw.flush();os.fsync(raw.fileno())
 if result.returncode: raise SystemExit(f'{name} failed ({result.returncode}); see {logs/name}.log')
 print(name+' passed',flush=True)
if args.from_stage == 'all':
 clang=sdk/'swift-android/swift-resources/usr/lib/swift/clang'
 if clang.is_symlink(): clang.unlink()
 run('sdk-setup',['bash',sdk/'swift-android/scripts/setup-android-sdk.sh'])
base=[swift,'build','--disable-sandbox','--package-path',native,'--product','SilverhandCore']
if args.from_stage in ('all','host'): run('swift-host',base,{'SKIP_DYNAMIC_LIBRARIES':'1'})
if args.from_stage != 'package': run('swift-android-'+args.configuration,base+['-c',args.configuration]+['--scratch-path',out/'cross','--swift-sdks-path',sdk.parent,'--swift-sdk','swift-6.4.1-RELEASE_android','--triple','aarch64-unknown-linux-android28','-Xswiftc','-DSKIP_BRIDGE','-Xswiftc','-DTARGET_OS_ANDROID'],{'SKIP_BRIDGE':'1'})
expected=json.loads((app/'native/Package.resolved').read_text())['pins'];actual=json.loads((native/'Package.resolved').read_text())['pins']
assert {p['identity']:p['state']['revision'] for p in expected}=={p['identity']:p['state']['revision'] for p in actual},'Swift pins drifted'
generated=native/'.build/plugins/outputs/native/SilverhandCore/destination/skipstone';dest=out/'gradle'
if dest.exists():shutil.rmtree(dest)
shutil.copytree(generated,dest,ignore=shutil.ignore_patterns('swift','build','.gradle'),symlinks=False)
for f in dest.rglob('*'):
 if f.is_file():f.chmod(0o644)
shutil.copy(app/'gradle-root.gradle.kts',dest/'build.gradle.kts')
# The generated settings remain intact; our settings apply this owned extension.
with (dest/'settings.gradle.kts').open('a') as f:
 f.write('\ninclude(":app", ":capacitor-android")\nproject(":app").projectDir = file('+json.dumps(str(app/'app'))+')\nproject(":capacitor-android").projectDir = file('+json.dumps(str(app/'node_modules/@capacitor/android/capacitor'))+')\n')
product=out/('cross/out/Products/'+args.configuration.capitalize()+'-android-aarch64');runtime=sdk/'swift-android/swift-resources/usr/lib/swift-aarch64/android'
libs=dest/'SilverhandCore/build/jni-libs/arm64-v8a';libs.mkdir(parents=True)
# Only the runtime dependency closure is packaged, never XCTest libraries.
ndk=Path(env['ANDROID_NDK_HOME'])/'toolchains/llvm/prebuilt/darwin-x86_64'
import re
available={f.name:f for folder in [product,runtime,ndk/'sysroot/usr/lib/aarch64-linux-android'] for f in folder.glob('*.so')}
platform={'libc.so','libm.so','libdl.so','liblog.so','libandroid.so','libz.so'};pending=['libSilverhandCore.so'];closure={}
while pending:
 name=pending.pop()
 if name in closure or name in platform:continue
 src=available[name];deps=re.findall(r'NEEDED.*\[(.*?)\]',subprocess.check_output([str(ndk/'bin/llvm-readelf'),'-d',str(src)],text=True,env=env));closure[name]=deps;pending+=deps
 shutil.copy(src,libs/name)
 if args.configuration == 'release': subprocess.run([str(ndk/'bin/llvm-strip'),'--strip-unneeded',str(libs/name)],check=True,env=env)
assets=(Path(env['SILVERHAND_ANDROID_RUN_ROOT'])/'app-build' if env.get('SILVERHAND_ANDROID_RUN_ROOT') else app/'app/build')/'core-assets/SilverhandNative_SilverhandNative.resources';assets.mkdir(parents=True,exist_ok=True)
shutil.copy(core/'Sources/SilverhandNative/Resources/Protocol.json',assets/'Protocol.json')
(out/'manifest.json').write_text(json.dumps({'configuration':args.configuration,'launcherRestoreSignals':False,'buildSystem':'swiftbuild (toolchain default)','swift':subprocess.check_output([str(swift),'--version'],text=True,env=env).strip(),'upstream':subprocess.check_output(['git','-C',str(repo),'rev-parse','HEAD'],text=True,env=env).strip(),'sourceHashes':{str(f.relative_to(source)):hashlib.sha256(f.read_bytes()).hexdigest() for f in source.rglob('*.swift') if '.build' not in f.parts},'runtimeClosure':closure},indent=2)+'\n')
# Provenance includes both source inputs and the actual stripped libraries being packaged.
manifest_path=out/'manifest.json';manifest=json.loads(manifest_path.read_text())
manifest['extractedSourceHashes']={str(f.relative_to(core)):hashlib.sha256(f.read_bytes()).hexdigest() for f in (core/'Sources').rglob('*') if f.is_file()}
manifest['packagedLibraryHashes']={f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in libs.glob('*.so')}
manifest['generatedBridgeHashes']={str(f.relative_to(dest)):hashlib.sha256(f.read_bytes()).hexdigest() for f in dest.rglob('ClientBridge.kt')}
inputs=[app/'scripts/core-extraction.patch',app/'scripts/build-core.py',app/'scripts/write-protocol.mjs',app/'native/Package.swift',app/'native/Package.resolved',repo/'pnpm-lock.yaml',repo/'apps/ios/native-protocol.ts',repo/'packages/shared/src/backend-admission.json',repo/'packages/shared/src/api/paths.ts']
manifest['inputHashes']={str(f.relative_to(repo)):hashlib.sha256(f.read_bytes()).hexdigest() for f in inputs}
manifest_path.write_text(json.dumps(manifest,indent=2)+'\n')
print(dest)
