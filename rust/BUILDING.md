# Building the Rust backend

## Linux x86_64 server from macOS / OrbStack

Run `./scripts/build-rust-linux.sh` from the repository. Docker must be running;
the current Docker context is used (OrbStack works). No macOS Rust target
installation, Node build, Desktop packaging or ECS deployment is performed.

This builds only `silverhand-backend` for `x86_64-unknown-linux-gnu` inside a
`linux/amd64` container. On Apple Silicon this uses OrbStack's architecture
emulation, not a macOS linker. The Rust 1.94.0 Debian bullseye image is pinned by
digest; Cargo uses `--locked`. Registry and Linux target caches use separate named
Docker volumes and never overwrite the macOS target cache. The source mount is
read-only. `CARGO_BUILD_JOBS=2 ./scripts/build-rust-linux.sh` reduces build load.

Each run writes a new `.cache/linux-server/<UTC timestamp>-<commit>/` directory
with the executable, `SHA256SUMS`, `build.json`, ELF dependency/version reports
and isolated smoke results. Old output directories are not cleared. The manifest
records the source commit and tracked-dirty flag: use a clean source tree for
release delivery, and do not edit sources while building.

The verified ECS host is x86_64 Cloud Linux 3 with glibc 2.32.
Bullseye's glibc 2.31 provides a compatible build floor; bookworm's newer libc is
not an interchangeable choice. The script checks the ELF architecture, required
glibc symbols (at most 2.32), dependency resolution and actual startup on the
older container runtime. It initializes an isolated empty database without
Node/Cargo on the child's PATH, probes `/readyz` and `/api/server/info`, then
requires SIGTERM exit 0. This is build/runtime compatibility evidence, not a
production ECS deployment or real-data acceptance test.

The produced executable still requires explicit database/blobs/log-directory,
listen/origin and `remote-only` deployment configuration; see database startup
ownership below and `../docs/rust-server-logging.md`. Do not point build tests at
production data or copy a new binary over a running ECS process.

## Bundled SQLite build policy

Run Cargo from the repository root (`cargo build --manifest-path rust/Cargo.toml`)
or from `rust/`. The checked-in root `.cargo/config.toml` is inherited by both,
including `scripts/dev.sh` and `scripts/package.sh` host-sidecar builds. Cargo
does not discover a manifest's ancestor configuration when invoked from an
unrelated working directory: change directory first. Do not bypass this policy
with an external Cargo configuration when producing release artifacts.

The pinned bundled `libsqlite3-sys` build adds
`SQLITE_ENABLE_MEMORY_MANAGEMENT`, then applies `LIBSQLITE3_FLAGS`. We explicitly
undefine that one option. `force = true` prevents a shell's diagnostic value from
silently replacing the product policy. No SQLx fork or runtime switch is needed.

This disables **global page-cache reclamation**, not ordinary page caching.
`sqlite3_release_memory` and the related soft-heap-limit global reclaim path no
longer reclaim pages. Current application/SQLx consumers do not use these paths;
future consumers must not assume they work. Normal cache eviction, connection
close and connection-local release (`sqlite3_db_release_memory` / `PRAGMA
shrink_memory`) remain. There is no new reclaim timer, cache enlargement or pool
change. Memory-status accounting, thread safety and adapter `synchronous=FULL`
remain enabled. Reduced contention is not a promise of lower long-term RSS.

The messaging pool configuration test checks the actual linked SQLite compile
options and every pool connection's durability settings. The auth pool test
checks the session-touch connections too. Run these on dependency upgrades:

```sh
cd rust
cargo test -p silverhand-backend-sqlite --lib every_pool_connection_carries_the_durability_configuration
cargo test -p silverhand-backend-sqlite --lib session_pool_retains_full_durability
```

Tests must use the project's workspace-local isolated test directories. Release
acceptance additionally checks the produced binary's compile options and real
authenticated HTTP results; a successful build alone is not performance proof.

# Database startup ownership

The Rust executable prepares its configured database before opening application
pools or publishing readiness. It initializes empty stores, admits the shared
ledger, backs up existing stores before an upgrade, executes each step atomically,
and audits persisted conversation-title/workspace-name keys. Its migration
connection is closed before application adapters open. There is no runtime Node,
TS migration subprocess, Cargo invocation or fallback in that path.

`SILVERHAND_MIGRATE` accepts `0` or `1` (trimmed); unset/empty defaults to `1` for
the embedded profile and `0` for remote-only. Empty initialization does not require
upgrade permission. Existing unsupported, newer, gapped or malformed ledgers fail
visibly; the executable never discards them to recreate an empty store. Migration
step and reported schema epoch remain separate: step88 completes the current
epoch69 plan; the deployed step87 plan previously reported epoch69 with its own
shorter manifest.

Desktop remains the path authority (`resolveDesktopAppPaths`). Starting a newly
built Desktop with `SILVERHAND_DIR` set to an existing app root upgrades that root
in place without a TS initialization command. Stop the old instance first. For
standalone use, supply the explicit database/blob/log/listen/origin/profile
environment inputs listed in `backend-app/src/lib.rs`; Rust does not infer an
alternative `~/.silverhand` layout.

The preparation connection retains SQLite EXCLUSIVE locking mode across backup
and step commits, and closes before ordinary runtime connections open. Process
death releases the OS lock; no persistent lock directory is created or stolen.
Both current runners share this exclusion. Deployed older TS bundles do not:
the old instance must still exit before upgrading. Unknown legacy lock directories
are never deleted by the new runner.

Before an existing-store upgrade, SQLite creates a consistent standalone database
with `VACUUM INTO`; other regular files and symlinks are copied alongside it,
excluding the source database, WAL/SHM/journal and runtime sockets/devices. A
`.partial` directory is renamed to `<data-directory>-backup-<UTC>` only on success.
Restore only with every instance stopped. Backup preserves logical data; it is
not a byte-identical copy of the database's original page layout.

Desktop startup protocol v2 is `preparing → prepared → bound`. Spawn-to-preparing
is bounded; confirmed backup/migration is cancelable without a fixed deadline.
Only preparation success and connection close permit `prepared`, which starts
one bounded service/ready/epoch budget. `bound` never resets that deadline and
does not itself publish an available endpoint.

## Shared migration source and transition consumers

`packages/shared/src/db/migrations.ts` and `schema-epochs.ts` remain the source of
step history. Run `node scripts/generate-rust-migrations.mjs` when changing them;
`--check` is the package gate. This build-time generator uses esbuild from the
existing server development dependencies. Its checked-in JSON projection embeds
SQL in Rust; Cargo checks input hashes and the native precondition inventory
without running Node. Procedural preconditions reuse Rust's pinned total stored-
name canonicalization, not the stricter new-write validator.

The old TS runner still serves TS standalone, admin and their tests while those
consumers exist. It is not reachable from Rust or Desktop startup. Retire it after
Rust replaces ECS and admin consumers have replacements, not by removing their
current initialization authority prematurely. No new migration step was added.

Desktop bundles the shared `node-file-logger` subpath rather than a server barrel.
Neither package profile includes a TS server/backend or native SQLite/argon2
runtime. Development and packaging no longer swap the workspace SQLite ABI.
`scripts/package.sh` accepts Cargo's `CARGO_TARGET_DIR` and an optional absolute
`SILVERHAND_BACKEND_STAGE` for isolated build artifacts; its normal defaults stay
under `rust/target`. Existing app packages need not be overwritten to validate a
new build (`--output-dir <name>`).
