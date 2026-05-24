# Daemon wire contract fixtures

Source of truth for the **bytes** that travel on the daemon ↔ HostClient
NDJSON socket. Each fixture is one literal frame line. Together they
cover every distinct schema arm that a cross-language daemon /
client implementation must recognize.

## What this is — and is NOT

These are **wire fixtures**, not schema artifacts. The relationship
between the three layers we maintain:

1. **`packages/host/src/protocol.ts`** — zod schemas. Authoritative
   source for what *shape* a frame may have. TypeScript daemon and
   TypeScript clients import these directly.
2. **`packages/host/tests/fixtures/wire/wire-fixtures.ts`** — wire
   fixtures. Authoritative source for what *bytes* a valid frame
   looks like on the socket. Locks the contract at the byte level so
   future re-implementations (Rust daemon, remote host agent, etc.)
   have an acceptance gate independent of zod.
3. **A future JSON Schema / serde artifact** — only generated when a
   non-TypeScript consumer actually needs it. Fixture-first is
   deliberate: we don't want a schema-authority migration churn
   without a real consumer paying for it.

If someone asks "is this frame on the wire?" the answer comes from
this directory, not from zod. Zod tells you whether *some* shape is
permitted; fixtures tell you whether *this* shape is canonical.

## Layout

- `wire-fixtures.ts` — registry of every fixture. Each entry carries:
  - `name` — path-style identifier (`request/runtime_wake`, `event/runtime_init_timeout-silence-retrying`, etc.).
  - `description` — why this variant exists; what it locks.
  - `frame` — the literal NDJSON line bytes (no trailing newline).
  - `kind` — discriminator (`request` / `response_success` /
    `response_error` / `event`) plus which intent / arm the frame
    belongs to. Drives schema selection at test time.

- `README.md` — this file.

`wire-contract-fixtures.test.ts` (in the parent tests/ dir) is the
acceptance test. It iterates every fixture and asserts:

1. The frame parses as valid JSON.
2. The frame validates against `RequestFrameSchema` / `ResponseFrameSchema` /
   `EventFrameSchema` as appropriate.
3. For request and response_success fixtures, the inner `params` /
   `result` validates against the matching `intentSchemas[intent]`
   sub-schema.
4. `encodeFrame(parsed) → JSON.parse → deepEqual(parsed)` round-trips
   structurally lossless (i.e. the wire bytes can be re-emitted by the
   TS daemon without information loss).
5. Per-frame size stays under `MAX_FRAME_BYTES`.

## Authority order

When wire bytes and zod disagree:

- If a fixture parses but the corresponding zod schema rejects it →
  **zod is wrong** (or the fixture was authored against a stale
  schema). Bug.
- If zod accepts it but no fixture covers the variant → **fixture set
  is incomplete**. Add a fixture to lock the variant on the wire
  before downstream consumers depend on it.
- If a future Rust daemon serializes a frame and a TS client rejects
  it → the **fixture catalogue is the arbiter**. Either the Rust
  daemon emitted a frame we never sanctioned (Rust bug), or the
  fixture catalogue silently grew a variant that wasn't ratified by
  the zod schema (drift bug — both sides need a same-PR update).

## Adding a fixture

1. Find the smallest meaningful variant the catalogue does not
   already cover (a new arm of a discriminated union, a new enum
   slot, a previously-untested combination of optional fields).
2. Append a `WireFixture` entry to `wire-fixtures.ts`. Keep the
   `frame` line minimal — a fixture is a contract example, not a
   stress test. Stress tests live in unit tests against the schemas.
3. Run `pnpm --filter @silverhand/host test wire-contract-fixtures`.
4. If a new schema field was introduced, update the corresponding
   zod schema in `protocol.ts` in the same change. Drift between the
   two layers is a review blocker.

## Consumer recipe (for future cross-language daemons)

A non-TypeScript implementation that wants to verify it is
wire-compatible should:

1. Import the registry's `frame` strings into its own test fixtures
   (one option: emit `*.ndjson` files from the TS registry as a
   build step, then check those files into the consumer's repo).
2. For each `request` / `event` fixture, parse the line as the
   consumer's frame type and assert success.
3. For each `request` fixture, encode an equivalent struct in the
   consumer's language and assert byte-equality (after canonical key
   ordering) with the fixture line.
4. For each `response_success` / `response_error` fixture, treat it
   as a wire example the consumer's daemon must be willing to emit.

The TypeScript `wire-contract-fixtures.test.ts` is the executable
spec. If a consumer cannot reproduce the fixture catalogue under its
own parser, the consumer is non-compliant — independent of whether
it can satisfy the zod schemas.
