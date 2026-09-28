# Client packages and application hosts

`packages/client` owns application-facing connection, session, HTTP/event transport
and platform contracts. It has no React, Electron or Node runtime dependency.
Server DTOs and API epochs remain in `packages/shared`. Session validation and
asynchronous session-generation invalidation live in `client/session`; neither
claims a local computer.

`packages/app-ui` owns the React application, feature/query caches, event ingestion,
components and styles. It takes a `ClientPlatform` through `configurePlatform`
before `mountApp`. It never reads a preload global. An application supplies:

- `client`: authentication, connection settings, HTTP/upload, authenticated event
  socket construction and client API compatibility promotion. Credentials stay in
  the adapter; the UI receives user DTOs and response bytes, never bearer tokens.
- `files`: external links, attachment open/save and image export/clipboard actions.
  A successful save need not return a desktop filesystem path.
- Optional `localHost`, `shell` and `notifications` capabilities. Their absence is
  an actual lack of capability. Local-host actions fail explicitly if invoked
  without that capability, and shared connection reads do not invent a host ID,
  status, attachment or daemon compatibility verdict.

The shared UI continues to manage remote computers through server APIs even when
there is no local host. Revoking an app-managed computer uses the shared HTTP
client; Desktop reconciles its binding only when the successful response belongs
to the current session and names that local computer. Optional native notifications have no relationship to
server unread authority. No APNs implementation is included.

## Desktop composition

`apps/desktop/src/renderer` contains only the HTML and application/platform entry.
`src/preload` implements the Desktop IPC contract using the shared types; the
preload declaration no longer maintains a separate copy of client DTOs.

The main process is organized by responsibility:

- `client/`: Electron transport, session storage, API compatibility and profile
  connections. Desktop authentication orchestration owns the local-host claim
  after successful session restoration.
- `local-host/`: daemon launch, claim, attachment, reload and binding management.
- `embedded/`: Rust sidecar construction, ownership, publication and shutdown.
- `shell/`: app configuration, build policy, window/startup/close integration.
- `ipc/`: guarded native surface operations. `main/index.ts` composes these owners.

Both embedded and remote-only builds still provide a local host. Remote-only
excludes embedded construction at build time; it is not a second UI application.
Electron keeps the existing HTTP authorization and WS cookie/Origin/epoch policy.

Changing the active remote server to another origin starts a new session: clear
the old persisted client credentials and computer binding before committing the
new profile, detach the old daemon connection, then retarget. The old host token
is never reloaded against the new server. Late login/host-claim results cannot
restore the previous session. Rotation, proxy configuration and HTTP/upload
responses also check session ownership after reading the response body, before
writing credentials or clearing a session on 401. Rotation persists against the
captured server and cannot restore a binding removed while the request was in flight.
Credential deletion errors abort the switch before a new profile is committed;
only a missing file counts as already cleared. The Desktop adapter restarts the renderer on the
new connection so query caches, drafts, live sockets and resume positions cannot
cross server identities. Same-origin profile saves preserve host apply behavior.
A failed profile write may therefore leave the old server signed out; this is a
fail-closed transition, and the user can sign in again.

## Next application host

An iOS application can implement `client` and `files` and omit `localHost` and
Desktop shell entirely. Its native container, secure credential storage, network
bridge and foreground lifecycle are not selected by this package extraction.
A real-device HTTPS/WS/upload/background-return proof and mobile navigation are
still needed before there is an iOS product. The handset will never host a local
daemon, runtime or working directory.

## Boundaries and checks

`client/tests/boundaries.test.ts` checks shared source imports and manifests against
Electron, Node, Desktop and host dependencies. The Desktop renderer build checks
the resolved browser graph as well. The existing embedded/remote-only main graph
fence remains active. `scripts/test.sh` includes both new packages.

Run `typecheck` and `test` with `pnpm --filter @silverhand/client`,
`pnpm --filter @silverhand/app-ui`, and `pnpm --filter @silverhand/desktop`. Desktop tests require an isolated
`SILVERHAND_DIR`. Build Desktop normally and again with
`SILVERHAND_DESKTOP_REMOTE_ONLY=1` to check both construction graphs.
