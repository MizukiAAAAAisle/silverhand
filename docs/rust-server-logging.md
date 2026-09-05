# Rust server diagnostic logs

The `silverhand-backend` executable uses the same file logger in `embedded` and
`remote-only` profiles. Set `SILVERHAND_LOG_DIR` before starting it. Desktop passes
the resolved application `logs` directory (normally `~/.silverhand/logs`, or
`$SILVERHAND_DIR/logs`). A directly launched binary requires the explicit path;
it does not infer a user-data root.

Diagnostic JSON is written to `rust-backend.YYYY-MM-DD.log` (UTC day) and stderr
through the same existing sanitized formatter. Stdout remains reserved for the
startup protocol. `RUST_LOG` and conversation debug controls retain their existing
filter semantics; with no `RUST_LOG`, the global default is ERROR. These files
are separate from the categorized CLI/agent audit files.

Files rotate daily and retain at most 14 matching log files. This is a file-count
retention policy, not a byte quota. Logging uses a bounded 4096-record worker
queue with backpressure rather than silently dropping records on saturation.
The process owns its drain guard through startup failure and graceful shutdown.
SIGKILL/power loss cannot guarantee pending records are flushed. An unusable log
directory refuses startup and reports the initialization error on stderr.
