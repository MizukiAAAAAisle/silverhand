/**
 * `spawn-env` — pure helpers that compose the env passed to a spawned
 * agent CLI. The daemon-path `RuntimeBridge` caller is the only
 * consumer post-cleanup (Commit B removed the in-process
 * ConversationManager spawn path; Commit C removed the runtime-host
 * env switch — there is no other branch).
 *
 * ## Why this lives here as a separate module
 *
 * The env composition was lifted out of the original
 * `ConversationManager` runtime so the daemon path could land
 * byte-identical bytes in `runtime_start.options.env`; the daemon
 * then re-applies `driver.applyEnv` on top of
 * `{ ...daemon.process.env, ...wire.env }`. The lift survives as the
 * single source of spawn env composition; the module-level cap on
 * what's allowed in `SILVERHAND_*` vars / driver env / proxy overlay
 * lives here.
 *
 * Cindy's commit-5 hard line (msgs `gePj5qOffE7rDlGw` +
 * `KMJFmcS4hf_tJ5hj`): spawn env MUST stay byte-equivalent to what
 * the original CM produced — PATH shim, `SILVERHAND_*` vars, driver
 * env, proxy overlay. The `proxy-env.test.ts` suite pins each layer.
 *
 * ## Layer model
 *
 * `buildAgentSpawnEnv` — the END env passed to spawn-prep / the
 * daemon's `runtime_start`. Four layers applied in order:
 *
 *   1. `driver.applyEnv(baseProcessEnv)`   ← innermost (driver vars)
 *   2. `applyProxyEnv(...)`               ← proxy overlay (allowlist gated)
 *   3. `withSilverhandCliEnv(...)`        ← outermost (PATH shim + SILVERHAND_*)
 *
 * `buildBridgeStartEnv` — what to put into `runtime_start.options.env`.
 * Layers 2 + 3 are caller-owned (backend reads SettingsRepo); layer 1
 * is re-applied daemon-side from `{ ...daemon.process.env, ...wire.env }`.
 * The resulting daemon-spawn env is identical to `buildAgentSpawnEnv`
 * when daemon and backend share the same `process.env` (single-host
 * deployment — the only one supported in v1).
 */
import { delimiter } from 'node:path';
import {
  SILVERHAND_AGENT_ID_ENV,
  SILVERHAND_AUTH_TOKEN_ENV,
  SILVERHAND_CONVERSATION_ID_ENV,
  SILVERHAND_SERVER_URL_ENV,
} from '@silverhand/shared';
import type { Driver } from '../drivers/index.js';
import {
  applyProxyEnv,
  parseProxyRuntimes,
} from './proxy-env.js';
import type { ProxySettingsSource } from './bridge.js';

/** Inputs required to build the final spawn env, regardless of path. */
export interface SpawnEnvInput {
  driver: Driver;
  /** The agent's runtime kind (`'claude' | 'codex' | ...`) — proxy
   *  allowlist matches on this. */
  runtime: string;
  conversationId: string;
  agentId: string;
  serverUrl: string;
  /** Per-spawn agent token, minted at spawn time and revoked on
   *  process exit. */
  token: string;
  /** Absolute path to the per-spawn directory containing the
   *  `bin/silverhand` shim. Prepended to PATH so the spawned CLI
   *  finds the shim first. */
  binDir: string;
  /** Snapshot of `process.env` used as the seed for `driver.applyEnv`.
   *  Passed in (not read from `process.env` directly) so tests can
   *  feed a deterministic baseline. */
  baseProcessEnv: NodeJS.ProcessEnv;
  /** Settings reader for proxy URL + allowlist. */
  proxySettings: ProxySettingsSource;
}

/**
 * Append the `SILVERHAND_*` CLI env vars and prepend the per-spawn
 * bin shim to PATH. Pure — no fs, no settings reads.
 *
 * Lifted verbatim from CM's prior `withSilverhandCliEnv` private
 * method. Behavior preserved byte-for-byte: PATH fallback chain is
 * `env.PATH ?? process.env.PATH ?? ''`, and the order matters because
 * tests pin the chain.
 */
export function withSilverhandCliEnv(
  env: NodeJS.ProcessEnv,
  input: {
    conversationId: string;
    agentId: string;
    serverUrl: string;
    token: string;
    binDir: string;
  },
): NodeJS.ProcessEnv {
  const currentPath = env.PATH ?? process.env.PATH ?? '';
  return {
    ...env,
    [SILVERHAND_CONVERSATION_ID_ENV]: input.conversationId,
    [SILVERHAND_AGENT_ID_ENV]: input.agentId,
    [SILVERHAND_SERVER_URL_ENV]: input.serverUrl,
    [SILVERHAND_AUTH_TOKEN_ENV]: input.token,
    PATH: currentPath
      ? `${input.binDir}${delimiter}${currentPath}`
      : input.binDir,
  };
}

/**
 * The full env CM passes to `spawn()` today. Replicates CM's exact
 * composition chain so the daemon-path can be parity-tested against
 * a single source of truth.
 */
export function buildAgentSpawnEnv(input: SpawnEnvInput): NodeJS.ProcessEnv {
  return withSilverhandCliEnv(
    applyProxyEnv(input.driver.applyEnv(input.baseProcessEnv), input.runtime, {
      proxyUrl: input.proxySettings.get('proxy_url'),
      allowlist: parseProxyRuntimes(input.proxySettings.get('proxy_runtimes')),
    }),
    {
      conversationId: input.conversationId,
      agentId: input.agentId,
      serverUrl: input.serverUrl,
      token: input.token,
      binDir: input.binDir,
    },
  );
}

/**
 * The env caller (CM post-flip, or AgentService directly) should put
 * into `RuntimeBridge.runtimeStart`'s `baseEnv` slot. The bridge
 * layers the proxy on top per allowlist; daemon then re-applies
 * `driver.applyEnv` from `{ ...daemon.process.env, ...wire.env }`.
 *
 * On a single-host deployment (daemon and backend share parent env),
 * the daemon-spawned env equals `buildAgentSpawnEnv(input)` — that
 * invariant is asserted by the spawn-env-parity test.
 *
 * IMPORTANT: this returns the env WITHOUT the proxy overlay. The
 * bridge owns the proxy layering so it can read SettingsRepo at the
 * moment of spawn (proxy URL changes take effect on next spawn
 * without restart). Callers MUST NOT add proxy keys here.
 */
export function buildBridgeBaseEnv(
  input: Omit<SpawnEnvInput, 'proxySettings'>,
): NodeJS.ProcessEnv {
  // Daemon will re-apply driver.applyEnv on its side. To preserve
  // parity we apply it here too, then ship the result via wire.env.
  // (Without this, daemon's driver vars would be the only source; if
  // backend's process.env differs from daemon's process.env for any
  // env the driver doesn't manage, daemon-side wouldn't see it.)
  const seeded = input.driver.applyEnv(input.baseProcessEnv);
  return withSilverhandCliEnv(seeded, {
    conversationId: input.conversationId,
    agentId: input.agentId,
    serverUrl: input.serverUrl,
    token: input.token,
    binDir: input.binDir,
  });
}
