# Bundled SQLite build policy

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
