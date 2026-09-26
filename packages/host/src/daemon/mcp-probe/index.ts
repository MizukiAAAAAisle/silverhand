import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  MCP_CONFIG_FILENAME,
  parseMcpConfig,
  type McpProbeResult,
  type McpServerConfig,
} from '@silverhand/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { type McpProbeParams, type McpProbeErrorCode } from '../../protocol.js';
import { DaemonTypedError } from '../typed-error.js';
import { resolveAgentDir } from '../agent-materialize/index.js';

/**
 * Daemon handler for `mcp_probe` (#task:1137) — the LIVE counterpart to the
 * static `parseMcpConfig` check behind `silverhand profile mcp validate`.
 *
 * A probe opens ONE short-lived MCP connection to a single declared server,
 * runs the `initialize` handshake, optionally `tools/list`, and closes it in a
 * `finally` — the connection NEVER outlives the call (stdio → child killed,
 * remote → HTTP/SSE session closed). It is a user-triggered diagnostic
 * snapshot, not runtime MCP health state, never pooled, never reused at spawn.
 *
 * Failure modes that are part of the probe's own outcome (bad config, missing
 * server, unreachable endpoint, handshake/tools error) are returned as a
 * `McpProbeResult` with `ok:false` + the failing `phase` and a REDACTED
 * message — they render inline next to the server, they are NOT IPC errors.
 * Only a host-local fault that prevents probing at all (the agent dir itself is
 * unreadable for a non-ENOENT reason) throws a typed `McpProbeError`.
 *
 * Scope-blind by construction: the server config is resolved from the source
 * (v1: `profile` → the agent's L1 `mcp.json`), then the connect/initialize/
 * tools logic is identical for any scope. A future `workspace` source adds a
 * resolver branch and nothing else. The probe connects to the RAW server (the
 * user's url/command), never the `silverhand_<scope>__` runtime name — that
 * prefix only exists when handing servers to a runtime at spawn.
 */
export class McpProbeError extends DaemonTypedError {
  constructor(
    readonly code: McpProbeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'McpProbeError';
  }
}

export interface McpProbeDeps {
  /**
   * The EXACT agents root agent-home resolution joins onto, from the
   * composition root. Required — no implicit default (#task:1813).
   */
  agentHomeRootDir: string;
}

/** Connect (transport open + MCP `initialize`) budget. Short — probe is a
 *  diagnostic, not a long-poll. */
const CONNECT_TIMEOUT_MS = 10_000;
/** `tools/list` budget once connected. */
const TOOLS_TIMEOUT_MS = 10_000;

export async function probeMcpServer(
  params: McpProbeParams,
  deps: McpProbeDeps,
): Promise<McpProbeResult> {
  // 1. Resolve + parse the raw config for the source, then find the server.
  const raw = await readSourceConfig(params, deps);
  if (raw === null) {
    return {
      ok: false,
      phase: 'not_found',
      message: `no MCP config; server "${params.server_name}" not found`,
    };
  }
  const parsed = parseMcpConfig(raw);
  if (!parsed.ok) {
    return { ok: false, phase: 'parse', message: parsed.error };
  }
  const server = parsed.config.mcpServers[params.server_name];
  if (!server) {
    return {
      ok: false,
      phase: 'not_found',
      message: `server "${params.server_name}" not found in config`,
    };
  }

  // 2. One-shot connect → initialize → (optional) tools/list → always close.
  const transport = buildTransport(server);
  const client = new Client({ name: 'silverhand-probe', version: '1' }, { capabilities: {} });

  try {
    await withTimeout(
      client.connect(transport, { timeout: CONNECT_TIMEOUT_MS }),
      CONNECT_TIMEOUT_MS,
      'connect',
    );
  } catch (err) {
    // connect() bundles transport.start() + the initialize handshake; clean up
    // anything it opened (a stdio child may already be spawned).
    await safeClose(client);
    return { ok: false, phase: classifyConnectError(err), message: redact(err) };
  }

  try {
    const info = client.getServerVersion();
    const server_info = info ? { name: info.name, version: info.version } : undefined;

    if (!params.include_tools) {
      return { ok: true, phase: 'initialize', server_info };
    }

    try {
      const listed = await withTimeout(
        client.listTools(undefined, { timeout: TOOLS_TIMEOUT_MS }),
        TOOLS_TIMEOUT_MS,
        'tools/list',
      );
      const tools = listed.tools.map((t) => ({
        name: t.name,
        description: t.description,
      }));
      return { ok: true, phase: 'tools', server_info, tools };
    } catch (err) {
      return { ok: false, phase: 'tools', server_info, message: redact(err) };
    }
  } finally {
    // Always tear down: stdio → SIGTERM the child, remote → close the session.
    await safeClose(client);
  }
}

/** Resolve the raw config text for the probe source. v1 implements `profile`
 *  only (the discriminated union has a single arm today); a future `workspace`
 *  source adds its own branch. ENOENT → `null` (no config = server not_found,
 *  a normal outcome); any other fs fault is a hard host fault. */
async function readSourceConfig(
  params: McpProbeParams,
  deps: McpProbeDeps,
): Promise<string | null> {
  const { source } = params;
  const filePath = join(resolveAgentDir(source.agent_id, deps), MCP_CONFIG_FILENAME);
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw new McpProbeError('fs_unavailable', err instanceof Error ? err.message : String(err));
  }
}

/** Build the real SDK transport for a server, honoring its declared type.
 * The prefix is never applied here — a probe talks to the raw endpoint. */
function buildTransport(server: McpServerConfig): Transport {
  if ('url' in server) {
    const url = new URL(server.url);
    const headers = server.headers;
    if (server.type === 'sse') {
      // The SDK's SSE GET builds its request headers from `_commonHeaders()`,
      // which already folds in `requestInit.headers` alongside the protocol's
      // own `Accept: text/event-stream` / `mcp-protocol-version`. So passing
      // the user headers via `requestInit` is sufficient — do NOT override
      // `eventSourceInit.fetch` to re-inject them: the SDK hands that fetch a
      // fully-built `Headers` object, and spreading it would drop the
      // protocol headers (Headers has no enumerable own props).
      return new SSEClientTransport(url, {
        requestInit: headers ? { headers } : undefined,
      });
    }
    return new StreamableHTTPClientTransport(url, {
      requestInit: headers ? { headers } : undefined,
    });
  }
  // stdio: merge the safe default env (PATH etc.) with the server's own env so
  // the launcher is actually resolvable; passing only server.env would drop PATH.
  return new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: server.env ? { ...getDefaultEnvironment(), ...server.env } : undefined,
  });
}

/** Best-effort teardown — close() propagates to the transport (stdio kills the
 *  child, remote closes the session). Never throws. */
async function safeClose(client: Client): Promise<void> {
  try {
    await client.close();
  } catch {
    // teardown is best-effort; a probe must never leave a failure unreported
    // because cleanup threw.
  }
}

/** Split a connect()-stage failure into `connect` (transport/network/spawn,
 *  before the MCP protocol speaks) vs `initialize` (the handshake itself
 *  failed). Heuristic — connect() bundles both — but the redacted message
 *  carries the detail either way. */
function classifyConnectError(err: unknown): 'connect' | 'initialize' {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (
    /econn|enotfound|etimedout|ehostunreach|eai_again|fetch failed|socket hang|getaddrinfo|spawn|enoent|certificate|self-signed|tls|http \d{3}|timed out/.test(
      msg,
    )
  ) {
    return 'connect';
  }
  return 'initialize';
}

/** Strip anything secret-bearing from an error message before it leaves the
 *  host: URL query strings / fragments (may carry `?token=…`) and bearer
 *  tokens. Caps length so a chatty transport can't dump a huge payload. */
function redact(err: unknown): string {
  let msg = err instanceof Error ? err.message : String(err);
  msg = msg.replace(/(https?:\/\/[^\s?#]+)[^\s]*/gi, '$1');
  msg = msg.replace(/bearer\s+[\w.\-+/=]+/gi, 'Bearer <redacted>');
  return msg.slice(0, 500);
}

/** Race a promise against a timeout, clearing the timer either way. The
 *  underlying op is abandoned on timeout; `safeClose` then tears down the
 *  transport so nothing leaks. */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
