#!/usr/bin/env python3
"""Run upstream NativeTransport on Android with platform-default CA trust.
Only a fixed non-secret marker is sent to Postman's public HTTPS/WSS echo service.
This is a transport probe, not the full production APK acceptance.
"""
import os, subprocess, shutil, json
from pathlib import Path
app = Path(__file__).resolve().parents[1]
build = Path(os.environ['SILVERHAND_ANDROID_BUILD']).resolve()
swift = Path(os.environ['SWIFT_ANDROID_TOOLCHAIN']) / 'usr/bin/swift'
sdk = Path(os.environ['SWIFT_ANDROID_SDK_BUNDLE'])
serial = os.environ.get('ANDROID_SERIAL', 'emulator-5584')
assert serial.startswith('emulator-'), 'Use the disposable emulator'
probe = build / 'public-network'
source = probe / 'Sources/NetworkCheck'
source.mkdir(parents=True, exist_ok=True)
shutil.copy(app / 'validation/PublicNetwork.swift', source / 'main.swift')
(probe / 'Package.swift').write_text('''// swift-tools-version: 6.1
import PackageDescription
let package = Package(name: "NetworkCheck", dependencies:[.package(path: %s)], targets:[.executableTarget(name:"NetworkCheck", dependencies:[.product(name:"SilverhandNative",package:"core")])], swiftLanguageModes:[.v5])
''' % json.dumps(str(build / 'core')))
with (probe / 'build.log').open('w') as log:
    subprocess.run([str(swift), 'build', '--disable-sandbox', '--package-path', str(probe), '--swift-sdks-path', str(sdk.parent), '--swift-sdk', 'swift-6.4.1-RELEASE_android', '--triple', 'aarch64-unknown-linux-android28', '-c', 'release'], stdout=log, stderr=subprocess.STDOUT, restore_signals=False, check=True)
def adb(*args, **kwargs):
    return subprocess.run(['adb', '-s', serial, *args], check=True, **kwargs)
remote = '/data/local/tmp/silverhand-public-check'
adb('shell', 'mkdir', '-p', remote)
adb('push', str(probe / '.build/out/Products/Release-android-aarch64/NetworkCheck'), remote + '/NetworkCheck')
adb('push', str(build / 'gradle/SilverhandCore/build/jni-libs/arm64-v8a') + '/.', remote + '/')
# No test CA override, bearer, app credential or insecure TLS setting is supplied.
result = adb('shell', f'cd {remote} && chmod 755 NetworkCheck && LD_LIBRARY_PATH=. ./NetworkCheck', capture_output=True, text=True, timeout=60)
(probe / 'result.log').write_text(result.stdout + result.stderr)
print(result.stdout)
