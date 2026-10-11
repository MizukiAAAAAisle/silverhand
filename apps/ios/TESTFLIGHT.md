# TestFlight release checklist

## Identity and build inputs

- App and Capacitor identifier: `com.silverhand.ios`.
- Supported devices: iPhone and iPad; retain the shared responsive UI and iPad
  portrait/landscape orientations. System share sheets must have a popover anchor.
- Select the paid Apple Developer team in Xcode after enrollment completes.
  Do not rename the Keychain service: it is a storage key, not the app identifier.
- Keep the marketing version for a beta series; choose a new build number for
  every upload. The archive command overrides these settings in the build only,
  without modifying the Xcode project.

From the repository root:

```sh
SILVERHAND_DEFAULT_SERVER_URL=https://silverhand.build \
  pnpm --filter @silverhand/ios archive --build 2 --version 1.0
```

Replace `2` with an unused build number. This builds and syncs Web resources, then
creates a Release archive for `generic/platform=iOS` in a new directory under
`.cache/ios-release/`. The server must be passed explicitly; it is not hardcoded
as an application fallback. Saved user connections still take priority.

The command does **not** upload, export an IPA, register devices, purchase a
membership, or automatically create/update signing assets. It uses the locally
configured Team and signing credentials. Missing provisioning fails normally;
finish account/signing setup in Xcode and retry.

For local engineering validation before signing is ready:

```sh
SILVERHAND_DEFAULT_SERVER_URL=https://silverhand.build \
  pnpm --filter @silverhand/ios archive --build 2 --version 1.0 --unsigned
```

An unsigned archive is **not** an installable or uploadable release. A successful
unsigned build proves compilation/packaging only, not distribution signing or
App Store Connect acceptance. Use an Xcode/SDK version Apple accepts for upload.

## Archive inspection

Inspect the final archive, not only source files:

- `Products/Applications/App.app/Info.plist`: correct bundle ID, version/build,
  `UIDeviceFamily` containing 1 and 2, camera/microphone/photo-save purpose strings,
  and no ATS insecure-network exception.
- `capacitor.config.json`: expected default server; no remote WebView `server.url`.
  `public/index.html` and its bundled assets must be present.
- `Frameworks/Capacitor.framework/PrivacyInfo.xcprivacy` and
  `Frameworks/Cordova.framework/PrivacyInfo.xcprivacy` must be included. Both SDKs
  are supplied by the pinned SwiftPM dependency; do not edit vendored manifests.
- App icons must include an opaque 1024px source. Archive the dSYMs with the build.
- Inspect the signed archive in Xcode Organizer, use Validate App, then upload
  only after approval. Re-run the signed path even if unsigned validation passed.

## Permissions, privacy and encryption

Camera and microphone descriptions cover WebKit's existing “take photo/video”
attachment path; this does not add background recording or request permissions
on startup. Photo-add permission covers saving an exported image via the system
share sheet. Photo selection uses the system picker, not unrestricted library
access. Denied permissions and cancellation still need physical-device checks.

`ITSAppUsesNonExemptEncryption = NO` reflects the current client: HTTPS/WSS through
Apple URLSession, Keychain credential storage, WebKit networking and OS-provided
random IDs, without bundled proprietary or third-party encryption algorithms.
Reassess this declaration when adding crypto/auth/network SDKs. This is a technical
inventory, not a blanket determination of every jurisdiction's export obligations.
[Apple encryption guidance](https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations)

The application's current Swift code does not use the required-reason API
categories (file timestamps, disk capacity, boot time, UserDefaults, active
keyboards). SDK manifests describe SDK behavior, **not** the app's server data
collection. Do not submit “no data collected” merely because those SDK arrays
are empty. Before external review, the owner must confirm privacy disclosures
for accounts, message content, uploaded media/files, operational logs and any
connected agents/services, including retention/deletion behavior and a policy URL.
[Apple SDK requirements](https://developer.apple.com/support/third-party-SDK-requirements/)

## Distribution and device checks

1. Complete membership and create the App Store Connect record using the bundle
   ID above. Accept required agreements and finish signing setup.
2. Validate/upload a signed archive in Organizer; resolve processing diagnostics
   and export-compliance questions in App Store Connect.
3. Start with internal TestFlight. Uploading/internal testing does not itself
   require giving Apple a demo login.
4. Before external review, provide beta description, feedback/contact information,
   test instructions and a restricted working demo account/server. Never share
   an administrator account or private production conversations.
5. On iPhone and iPad, test clean login, saved-session upgrade, server switching,
   message send/history, keyboard, rotation/resizing, image preview/share/cancel,
   attachment picker and permission denial. Test iPad narrow multitasking as well
   as full width; responsive layout is not evidence of native presentation safety.

Creating review accounts, changing server access, uploading, inviting testers and
submitting review are separate authorized release actions, not side effects of
the local archive command.
