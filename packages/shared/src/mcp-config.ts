/**
 * Profile MCP — canonical config model + runtime-agnostic translation.
 *
 * Source of truth: `docs/agent-mcp-config-v1.md`. This module owns the
 * **canonical raw shape** a subject declares (the standard MCP `mcpServers`
 * map), how it parses/validates (fail-loud), the domain-scoped runtime name
 * prefix, and the pure per-runtime translations (canonical → Claude
 * `--mcp-config` JSON; canonical → Codex `-c mcp_servers.*` overrides). It is
 * host-agnostic and node-free: writing temp files / pushing argv lives in the
 * host drivers; this module only produces the values.
 *
 * Locked invariants (do not relax without updating the doc):
 *  - Additive only. We never emit `--strict-mcp-config`, never replace the
 *    user's own MCP, never touch the user's runtime config files.
 *  - The raw server name is the user-visible truth; the name handed to a
 *    runtime is private and ALWAYS domain-prefixed (`silverhand_<scope>__`)
 *    from v1 so a future workspace layer can't shadow it or force a rename
 *    (which a runtime would read as a brand-new server, resetting OAuth/cache).
 */
import { z } from 'zod';

/**
 * MCP config scope domain. `profile` = the executing subject's global/L1
 * config (v1). `workspace` is reserved for the future workspace layer; it is
 * part of the name-prefix contract now so both layers can coexist without a
 * later rename.
 */
export type McpScope = 'profile' | 'workspace';

/**
 * Canonical filename of the raw profile MCP config under a subject's L1 home
 * (`~/.silverhand/agents/<id>/mcp.json`). One constant so the daemon
 * read/write handler, the spawn loader, and the UI all agree.
 */
export const MCP_CONFIG_FILENAME = 'mcp.json';

/**
 * Server name charset. The raw name is embedded into a runtime server name
 * AND, for codex, into a TOML bare key (`mcp_servers.<prefixed>`), so it must
 * be bare-key safe. Restricting it up front (fail-loud) is cheaper than
 * quoting dotted TOML keys and keeps Claude/Codex names identical.
 */
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

const StdioServerSchema = z
  .object({
    type: z.literal('stdio').optional(),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
  })
  .strict();

const HttpServerSchema = z
  .object({
    type: z.enum(['http', 'sse']),
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
  })
  .strict();

/**
 * One MCP server. Either a stdio launcher (`command` [+ `args`/`env`], the
 * default when `type` is omitted) or a remote endpoint (`type: http|sse` +
 * `url` [+ `headers`]). `.strict()` on both arms rejects unknown keys so a
 * typo or unsupported field fails loud at write/validate time.
 */
export const McpServerConfigSchema = z.union([
  StdioServerSchema,
  HttpServerSchema,
]);
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/**
 * The canonical raw file: the standard `{ "mcpServers": { <name>: {...} } }`
 * map, so it is copy-paste compatible with the ecosystem `.mcp.json` /
 * Claude's `--mcp-config`. Server names are validated against
 * {@link SERVER_NAME_RE}; `mcpServers` defaults to empty.
 */
export const McpConfigSchema = z
  .object({
    mcpServers: z
      .record(McpServerConfigSchema)
      .default({})
      .superRefine((servers, ctx) => {
        for (const name of Object.keys(servers)) {
          if (!SERVER_NAME_RE.test(name)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `invalid MCP server name "${name}": use 1-64 chars of [A-Za-z0-9_-]`,
              path: ['mcpServers', name],
            });
          }
        }
      }),
  })
  .strict();
export type McpConfig = z.infer<typeof McpConfigSchema>;

export const EMPTY_MCP_CONFIG: McpConfig = { mcpServers: {} };

export type ParseMcpResult =
  | { ok: true; config: McpConfig }
  | { ok: false; error: string };

/**
 * Parse + validate raw JSON text into a {@link McpConfig}. Fail-loud: returns
 * a readable single-line error for bad JSON or schema violations and NEVER
 * throws. The write path (`profile mcp set` / `validate`) rejects on
 * `ok: false`; the spawn path drops the whole layer (loud, non-blocking) on
 * `ok: false`. An empty / whitespace-only body parses to the empty config.
 */
export function parseMcpConfig(raw: string): ParseMcpResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, config: EMPTY_MCP_CONFIG };

  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch (err) {
    return {
      ok: false,
      error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const parsed = McpConfigSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? ` at ${first.path.join('.')}` : '';
    return { ok: false, error: `invalid MCP config${where}: ${first?.message ?? 'schema mismatch'}` };
  }
  return { ok: true, config: parsed.data };
}

/**
 * The private, domain-scoped runtime server name. ALWAYS prefixed so profile
 * and (future) workspace layers never collide at the runtime and a later
 * rename is never forced. Example: `silverhand_profile__github`.
 */
export function runtimeMcpServerName(scope: McpScope, rawName: string): string {
  return `silverhand_${scope}__${rawName}`;
}

/**
 * Canonical → Claude `--mcp-config` JSON object. Returns the `{ mcpServers }`
 * map with every server key rewritten to its domain-prefixed runtime name;
 * the per-server body is passed through unchanged (Claude reads the same
 * stdio / http shape). Returns `null` when there are no servers (the driver
 * then omits `--mcp-config` entirely).
 */
export function toClaudeMcpConfig(
  config: McpConfig,
  scope: McpScope = 'profile',
): { mcpServers: Record<string, McpServerConfig> } | null {
  const names = Object.keys(config.mcpServers);
  if (names.length === 0) return null;
  const mcpServers: Record<string, McpServerConfig> = {};
  for (const name of names) {
    mcpServers[runtimeMcpServerName(scope, name)] = config.mcpServers[name]!;
  }
  return { mcpServers };
}

/**
 * Canonical → Codex `-c` override VALUES (the `key=value` strings; the driver
 * supplies the `-c` argv token before each). ONE override per server
 * (`mcp_servers.<prefixed>=<inline-toml-table>`) so it MERGES with the user's
 * existing `[mcp_servers.*]` instead of replacing the whole table. The value
 * is a serialized TOML inline table (quoting handled by {@link serializeTomlValue}),
 * never a hand-built string. Returns `[]` when there are no servers.
 *
 * The mapping mirrors the canonical shape: stdio → `command`/`args`/`env`;
 * http/sse → `url`/`headers` (+ `type`). Codex's exact http MCP keys are part
 * of the codex runtime-verification follow-up (the canonical raw + this
 * structure are unchanged regardless).
 */
export function toCodexMcpOverrides(
  config: McpConfig,
  scope: McpScope = 'profile',
): string[] {
  const overrides: string[] = [];
  for (const [name, server] of Object.entries(config.mcpServers)) {
    const key = `mcp_servers.${runtimeMcpServerName(scope, name)}`;
    overrides.push(`${key}=${serializeTomlValue(server)}`);
  }
  return overrides;
}

/**
 * Serialize a JSON-ish value to a TOML value literal (inline table / array /
 * string / number / boolean). Used to build codex `-c` override values
 * safely. Strings use TOML basic-string escaping; objects become inline
 * tables; arrays become inline arrays. `undefined` keys are skipped. Throws
 * on non-finite numbers / unsupported types so a bad mapping fails loud
 * rather than emitting malformed TOML.
 */
export function serializeTomlValue(value: unknown): string {
  if (typeof value === 'string') return serializeTomlString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`cannot serialize non-finite number to TOML: ${value}`);
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serializeTomlValue).join(', ')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      parts.push(`${serializeTomlKey(k)} = ${serializeTomlValue(v)}`);
    }
    return `{${parts.join(', ')}}`;
  }
  throw new Error(`cannot serialize value to TOML: ${String(value)}`);
}

/** TOML bare key if safe, else a quoted key. */
function serializeTomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : serializeTomlString(key);
}

/** TOML basic string with the standard escape set. */
function serializeTomlString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}
