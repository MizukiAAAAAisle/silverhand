# Silverhand iOS preview

Capacitor 8 hosts the bundled `@silverhand/app-ui`. Swift implements the
`ClientPlatform` adapter; the phone never claims a computer or starts a daemon.
The server is an HTTPS API origin, never a WebView navigation target. No Ionic UI,
React Native, APNs, background execution mode or relaxed TLS policy is included.

## Build

Requirements: Node/pnpm from the repository, Xcode 26 or newer with its license
and first-launch setup complete, and an installed iOS simulator runtime.

```sh
pnpm install
pnpm --filter @silverhand/ios sync
pnpm --filter @silverhand/ios open
```

Choose the App scheme and a simulator. Simulator builds need normal ad-hoc
signing (`CODE_SIGN_IDENTITY=-`), not `CODE_SIGNING_ALLOWED=NO`: Keychain access
requires a signed process. A physical device requires the user's Development
Team and provisioning choice; no team or signing identity is committed.

```sh
xcodebuild -project apps/ios/ios/App/App.xcodeproj -scheme App \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath .cache/ios-derived CODE_SIGN_IDENTITY=- build
```

Swift Package Manager owns the Capacitor dependency. `cap sync ios` regenerates
CapApp-SPM; the application separately references the local `native` package, so
sync never overwrites the session implementation. Commit Package.resolved.
`vite build` generates the native wire contract from the shared API/epoch authority.

## Session and network behavior

- One Keychain item binds server origin and user token atomically. It is available
  after first unlock and restricted to this device; it is never copied into
  JavaScript, cookies in WKWebView, localStorage or the app's ordinary files.
- URLSession uses ephemeral storage, no automatic cookies, no credential cache,
  standard system TLS validation, and refuses redirects. Generic requests can
  address only `/api/` under the active server, with native-owned bearer/epoch
  headers. WS uses the server's existing Origin/session-cookie/epoch admission.
- Generation checks reject late HTTP and login results. Socket identity and
  generation checks suppress frames from retired connections. Native state
  changes commit before retargeting; Keychain errors do not commit a new server.
- Server changes, logout and session invalidation clear the preview's browser
  storage and reload the app, dropping all module/query/socket state. Background
  entry closes sockets; foreground entry revalidates the session, reconnects WS
  and refreshes snapshots in the existing React tree, preserving composer drafts
  and pending send identities. Transient network failures retain the mounted
  conversation. Background delivery is not promised.
- Attachments/upload/export/clipboard return explicit unsupported errors in this
  phase. Desktop capabilities are absent, never replaced with successful stubs.

## Tests

```sh
pnpm --filter @silverhand/ios typecheck
pnpm --filter @silverhand/ios test
swift test --package-path apps/ios/native
```

The macOS Swift run exercises session races/storage failures and skips the iOS
network acceptance test. For native HTTPS/WSS against the real server:

1. Build `cargo build --manifest-path rust/Cargo.toml -p silverhand-backend-app --bin silverhand-backend`.
2. Create and boot a **dedicated disposable simulator**; never use a personal
   device for the fixture. Run `node apps/ios/scripts/ios-acceptance-server.mjs <simulator-uuid>`.
   It creates a two-day CA and isolated backend under `.cache`, and trusts that
   CA only in the named simulator. TLS validation stays enabled.
3. Run `xcodebuild -project apps/ios/ios/App/App.xcodeproj -scheme App -destination
   'platform=iOS Simulator,id=<uuid>' -parallel-testing-enabled NO CODE_SIGN_IDENTITY=- test`.
   Use the hosted AppTests target: hostless iOS SwiftPM tests cannot access Keychain.
4. Stop the fixture with Ctrl-C; delete the dedicated simulator when finished.

The network test covers Keychain cold restore, signup/login, authenticated WS,
channel creation and message exchange, real WKWebView plugin → shared React composer
→ HTTP send → native WS event → React message-list reception, background refusal and foreground snapshot
catch-up, password invalidation and logout. The hosted WebView test also posts
UIKit lifecycle notifications through the real plugin and verifies that the same
composer DOM node, draft and missed messages survive resume. This exercises the
notification-to-page chain, not OS process suspension or termination. It is transport acceptance, not a
claim that a physical iPhone or the entire mobile interface was exercised.

## Remaining acceptance

Connect a development-enabled iPhone, select the user's signing Team, and repeat
login/WS/message/suspend/resume/switch-server checks with an isolated, reachable
HTTPS server. Verify keyboard and message composer behavior on-device. The iPhone chat sidebar is an overlay toggled by the existing sidebar button;
full mobile layout, attachment capabilities, TestFlight and APNs are outside this first phase.

References: [Capacitor local Swift plugins](https://capacitorjs.com/docs/ios/custom-code),
[iOS setup](https://capacitorjs.com/docs/ios),
[configuration](https://capacitorjs.com/docs/config).
