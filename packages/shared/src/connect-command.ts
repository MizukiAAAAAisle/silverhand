// Single source of truth for the `silverhand-daemon connect` command shape.
//
// The connect command is assembled at the EDGE (the desktop that knows which
// server URL it is actually connected to), never minted by the server from its
// own bind address — see `docs/orchestration-boundary-v1.md §4.3` ("server
// ships identity, host/edge owns topology"). The server returns only the
// identity payload (connect token + daemon npm-spec recipe); the desktop joins
// it into a command locally using its own connected server URL.
//
// The arg-name contract lives here (not on the per-request wire) because it is
// a STATIC property of the daemon CLI surface — it does not vary per invite.
// Both sides consume these constants:
//   - `assembleConnectCommand` / `buildConnectArgv` (edge, this file), and
//   - `parseConnectArgv` (daemon, `@silverhand/host`),
// so the produce/parse pair can never drift. A round-trip test
// (`parseConnectArgv(buildConnectArgv(x)) === x`) lives in `@silverhand/host`
// (the only package that can import both) and locks that symmetry.

/** Canonical flag names for the daemon `connect` subcommand. */
export const CONNECT_ARG_SERVER_URL = '--server-url';
export const CONNECT_ARG_CONNECT_TOKEN = '--connect-token';
export const CONNECT_ARG_CONNECT_TOKEN_ENV = '--connect-token-env';
export const CONNECT_ARG_DATA_ROOT = '--data-root';
/** #task:1608 — INTERNAL flag: the detached child inherits the parent's
 *  default/explicit data-root origin FACT instead of re-deriving it from
 *  the path shape. Never part of the human-assembled connect command. */
export const CONNECT_ARG_DATA_ROOT_ORIGIN = '--data-root-origin';
export const CONNECT_ARG_FOREGROUND = '--foreground';
export const CONNECT_ARG_NO_DAEMON = '--no-daemon';
export const CONNECT_ARG_QUIET = '--quiet';
export const CONNECT_ARG_STDERR = '--stderr';
/** The daemon subcommand the assembled command invokes. */
export const CONNECT_SUBCOMMAND = 'connect';
export const STOP_SUBCOMMAND = 'stop';

export interface ConnectCommandParams {
  /** The npm spec the operator wants the daemon launched from (e.g.
   *  `@silverhand-ai/daemon@latest`). Server-owned recipe — travels on the
   *  bootstrap payload because it is per-deploy configurable. */
  daemonNpmSpec: string;
  /** The URL the daemon must dial back to reach this server. Supplied by the
   *  EDGE — the desktop's own connected server URL — never the server's own
   *  bind address (the server no longer advertises any reach origin). */
  serverUrl: string;
  /** The reveal-once connect credential minted by the server. */
  connectToken: string;
}

/**
 * The argv that follows the `connect` subcommand — the exact inverse of the
 * daemon's `parseConnectArgv`. Kept free of shell quoting so
 * `parseConnectArgv(buildConnectArgv(x))` recovers `x` verbatim; shell-string
 * rendering is layered on top by {@link assembleConnectCommand}.
 */
export function buildConnectArgv(params: {
  serverUrl: string;
  connectToken: string;
}): string[] {
  return [
    CONNECT_ARG_SERVER_URL,
    params.serverUrl,
    CONNECT_ARG_CONNECT_TOKEN,
    params.connectToken,
  ];
}

/**
 * Assemble the copy-pasteable connect command string. This is the ONLY place a
 * connect command is produced; the server never returns one. The result embeds
 * the reveal-once `connectToken`, so callers must treat it with the same
 * ephemeral discipline as the token itself (display once, copy, never persist).
 */
export function assembleConnectCommand(params: ConnectCommandParams): string {
  return [
    'npx',
    params.daemonNpmSpec,
    CONNECT_SUBCOMMAND,
    ...buildConnectArgv({
      serverUrl: params.serverUrl,
      connectToken: params.connectToken,
    }).map(shellQuoteConnectArg),
  ].join(' ');
}

/**
 * Minimal POSIX shell quoting for a single connect-command argument. Values
 * made purely of shell-safe characters are emitted bare; anything else is
 * wrapped in single quotes with embedded single quotes escaped.
 */
export function shellQuoteConnectArg(value: string): string {
  if (/^[A-Za-z0-9_/:.@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
