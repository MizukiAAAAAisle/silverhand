# ECS Console Dashboard

The ECS Console is a small operator-facing product analytics surface served by
the Rust backend. It does not connect to SQLite from another process and it does
not expose a SQL console. All counts are produced by a fixed, bounded read model
inside the server process.

## Enable and access

The console is available only in the `remote-only` deployment profile. Set
`SILVERHAND_CONSOLE_TOKEN` to a random 32–256-character visible ASCII secret to
enable it on the **product listener** (`SILVERHAND_LISTEN_ADDR`). An unset token
leaves both the shell and APIs unregistered. Metrics need not be enabled.

Generate the token locally once (for example, `openssl rand -hex 32`), save it in
your password manager, and provide the same value as `SILVERHAND_CONSOLE_TOKEN`
in the server's protected environment file (0600). Ordinary redeployments reuse
that value. To rotate it, replace the environment value and restart the server;
the old token then stops working. Do not commit the environment file or paste
its contents into logs or command arguments.

After deploying this version and configuring the HTTPS ingress, open `/console`
on the deployment's configured HTTPS origin in your local browser and enter the
token. Use the current deployment configuration to determine the domain.
The server serves HTML; it does not need a browser installed.

The browser keeps the token only in page memory. Reloading, leaving or reopening
the page requires entering it again. Disconnect clears it and cancels outstanding
requests; page exit also clears it before back/forward caching. The input is
cleared on submission. No credential is written to browser storage or a cookie;
startup only removes the legacy sessionStorage key from older versions.
The browser sends the token only as an `Authorization: Bearer …` header to the
same-origin Console API. The public HTML contains no token or product data; the
API does not accept URL tokens. Console responses use `Cache-Control: no-store,
private`. All three data routes authenticate before processing user input and
return the same empty 401 response for missing or incorrect credentials.

### HTTPS ingress contract

Terminate HTTPS at the existing domain ingress and forward `/console` and
`/console/api/*` to the existing product upstream (currently documented as port
8080), preserving the path, query and Authorization header. Keep the existing
product API and WebSocket routing intact. Redirect plain HTTP to HTTPS and do
not expose a separate plaintext product port to operators. Disable caching for
Console responses and omit credentials, query strings and request headers from
access logs. Do not enable request/header debug logging on this route.

The checked-in [ingress snippets and verification instructions](../ops/deployment/README.md#console-https-ingress)
provide an Nginx reference for this contract. The deployment inventory establishes
the domain and product upstream, but not the current ingress implementation;
apply the contract to that actual ingress at deployment time.

`SILVERHAND_METRICS_LISTEN=127.0.0.1:9464` remains optional and loopback-only.
`/metrics` is denied on the product listener and public ingress. The metrics
listener no longer serves Console routes. Never proxy port 9464 for the Console.
For local diagnosis, the same Console can be reached through a tunnel to the
product port; this is optional, not the normal operator workflow.

Rejected API authentication emits a fixed `operator_console_access` warning
with `authorized=false`, including at the default ERROR logging floor. It contains
no token, URI, user ID or supplied headers. The private metric
`silverhand_console_auth_requests_total{result="accepted|rejected"}` counts
requests using two bounded result labels. A shared preset token identifies
permission, not an individual operator, so these events do not attribute actions
to a person.

## Dashboard controls

The sidebar opens four separate views: Overview (`#/overview`) for resource
counts, Activity (`#/activity`) for activity windows and the message chart,
Agent runtimes (`#/runtimes`) for the runtime table, and Server contract
(`#/contract`) for protocol compatibility. Only the selected view is displayed;
its title, breadcrumb and active navigation item stay in sync. Links support
reload, direct access and browser back/forward. Activity loads its user read model
on first entry; revisiting a loaded view does not repeat the query.
Unknown routes fall back to Overview. The selected view is preserved through
connection, refresh and reconnect.
The 7/30-day switch affects the activity summary, user ranking, directory and
selected user detail. The all-user message chart always shows 30 days. Chart values are available on hover and keyboard focus. Snapshot times
use the response's `Asia/Shanghai` timezone.

Connect through the token dialog, then use Refresh to request another snapshot.
Refresh failures label the retained snapshot as stale; authentication failures
hide it and clear the in-memory token. Disconnect clears the in-memory token and
returns to the connection screen. No automatic polling or external assets are
introduced.

## User activity

Activity includes a global Top 10, a searchable user directory and a selected
user's statistics and daily trend. Click a name in either list to inspect that
user. Search by name/display name substring or exact user ID; ASCII matching is
case-insensitive. Clear the search to browse all users, including users with no
messages. The global Top 10 is independent of search and excludes zero-message
users. Directory pages contain 25 users.

Ranking uses original **human-authored** message count in the selected 7/30-day
Shanghai calendar window, descending, with user ID as the deterministic tie
breaker. Messages from system/agents, CC delivery copies and future timestamps
are excluded. Messages in all conversation placements are counted, including
DirectPairs. Agent messages are not attributed to their owner or creator.

Per-user detail exposes human message count, distinct speaking calendar days,
distinct conversations spoken in (counts only), last message time, last durable
session authentication time within the window, and exactly 7 or 30 daily buckets.
Missing timestamps show a dash. Authentication is the durable session's current
`last_used_at` fact, not a historical login-event count or a live online indicator.

- `GET /console/api/users?days=7&page=1&q=` returns `users`, global `top_users`,
  `total_matching`, fixed `page_size=25`, days, page, generated time and timezone.
- `GET /console/api/users/{user_id}?days=7` returns the user's identity/statistics
  and daily buckets; a nonexistent user returns 404.
- Days accepts only 7 or 30; page accepts 1–10000; trimmed search accepts at most
  128 characters without control characters. Unknown/invalid parameters return 400. No arbitrary filters, sort fields or SQL are accepted.
- Both routes require the same console Bearer token and use `no-store, private`.
  They expose only user ID, handle and display name as identity: no email,
  credentials, message body, conversation IDs or source content.
- One user query can execute at a time; concurrent requests receive 503, and
  each query has a five-second timeout. No cache grows with user/search keys.
  SQLite queries bind all inputs, run in a read transaction, reuse the time
  indexes and the existing `(from_user_id, created_at)` profile index, and return
  at most 35 distinct user rows or 30 daily rows. No migration is added.
- The UI hides obsolete user results while changing filters, ignores superseded
  responses, and provides explicit loading, empty, error and retry states.
  User snapshots have their own timestamp; they need not equal the cached
  all-user overview timestamp.

## Overview metric contract

All calendar boundaries use `Asia/Shanghai`.

- Authenticated users: distinct users whose durable session `last_used_at` is
  inside the 7- or 30-day calendar window. A later session revocation does not
  erase historical use.
- Speaking users: distinct human authors with an original message inside the
  window.
- Human and agent messages: original authored rows. System rows and mention-CC
  delivery copies are excluded.
- Workspaces: regular workspaces only; agent-home workspaces are excluded.
- Channels: workspace-placed conversations, split by archived state. Direct
  pairs are excluded.
- Active computers: non-revoked host rows.
- Daily activity: exactly 30 bounded calendar buckets, containing only counts.
- Agent runtimes: counts grouped by the closed runtime name.

The overview endpoint returns no message body, actor identifier, source workspace,
source conversation, installation identity, or raw log field. It has no query
parameters and cannot widen its 30-day trend window.

## Query and cache boundary

The read model uses migration-owned indexes for the two time axes it scans:
`auth_sessions(last_used_at, user_id)` and the partial original-authored-message
index on `messages(created_at)`. Aggregation happens in SQLite and returns at
most 30 daily rows plus bounded category counts. The server serializes requests
through one cache fill, times a fill out after five seconds, and reuses a
snapshot for 30 seconds.

Operational Prometheus metrics remain at `/metrics` and continue to belong to
Grafana/alerting. The Console is not a replacement for health alerts or log
investigation.

Release distribution remains a structured-log and SLS concern, not part of
this SQLite read model. The Console displays only the running server's Desktop
API epoch and outbound protocol version.
