# @silverhand/server

`@silverhand/server` is the runtime wrapper around `@silverhand/backend`. It
does not define a second backend; it prepares configuration and process-level
concerns, then starts the shared backend core.

The package exports two primary startup helpers from `src/index.ts`:

- `startEmbeddedSilverhandServer(...)` is used by the desktop main process. It
  maps the desktop data directory to `silverhand.db`, passes desktop
  server-config and CLI-launcher dependencies, chooses an ephemeral local listen
  port by default, and starts `@silverhand/backend` with `mode: 'embedded'`.
- `startStandaloneSilverhandServer(...)` is used by the `silverhand-server`
  process. It reads standalone environment variables, prepares the data/log
  directories, configures auth/signup/migration/logging, and starts
  `@silverhand/backend` with `mode: 'standalone'`.

The package also owns the standalone command-line surface:

- `src/main.ts` is the `silverhand-server` binary entry point.
- `src/config.ts` parses standalone env such as `SILVERHAND_LISTEN`,
  `SILVERHAND_DATA_DIR`, `SILVERHAND_MIGRATE`, `SILVERHAND_DISABLE_SIGNUP`, and
  `SILVERHAND_LOG_LEVEL`.
- `src/admin.ts` implements `silverhand-server admin ...` commands.

## Relationship to `@silverhand/backend`

`@silverhand/backend` owns backend behavior: routes, services, repos, auth,
database access, websocket/runtime coordination, and `startBackend(...)`.

`@silverhand/server` owns boot policy and packaging:

- how a desktop embedded backend is started;
- how a standalone server process is configured and launched;
- how standalone admin CLI commands are parsed and audited;
- how the `silverhand-server` bundle is produced.

Keep reusable backend logic in `@silverhand/backend`. Keep process entry points,
standalone env parsing, and admin CLI behavior in `@silverhand/server`.
