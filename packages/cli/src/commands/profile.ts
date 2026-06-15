/**
 * `silverhand profile` — the executing subject's GLOBAL (L1) config, the
 * config that travels with the agent across every workspace. Subject-agnostic
 * (Human/Agent isomorphism): it always targets whoever is running the CLI.
 *
 * Three-level grammar: `silverhand profile <facet> <verb>`. The only facet in
 * v1 is `mcp` (custom MCP servers); future facets (avatar, display-name) slot
 * in alongside it, and future workspace-scoped config gets its own
 * `silverhand workspace <facet> <verb>` noun rather than a `--scope` flag.
 *
 * MCP config is stored as raw JSON at the agent's L1 `mcp.json` (the host is
 * the single source of truth — no DB copy). It is loaded ADDITIVELY at the
 * NEXT spawn (no hot reload): claude via `--mcp-config`, codex via per-server
 * `-c mcp_servers.*` overrides. Server names are namespaced to
 * `silverhand_profile__<name>` at spawn so they never collide with the user's
 * own MCP servers.
 */
import { parseMcpConfig, type McpServerConfig } from '@silverhand/shared';
import type { Command, FacetGroup } from './index.js';
import { CliError } from '../errors.js';

const getCommand: Command = {
  verb: 'get',
  summary: "Print the executing agent's profile MCP config (raw mcp.json).",
  help: `silverhand profile mcp get

Print the executing agent's profile MCP config — the raw \`mcp.json\`
that lives in the agent's global (L1) home and is loaded into every
spawn additively.

stdout: { "raw": <string|null> }. \`raw\` is the file's verbatim text,
or null when the agent has no profile MCP config yet.`,
  flags: [] as const,
  async run({ client }) {
    return client.getProfileMcp();
  },
};

const setCommand: Command = {
  verb: 'set',
  summary: "Replace the executing agent's profile MCP config (raw JSON on stdin).",
  help: `silverhand profile mcp set

Replace the executing agent's profile MCP config. Pipe the full
\`mcp.json\` text on stdin — it is validated and written VERBATIM
(your own formatting is preserved). This REPLACES the whole config, so
to just ADD a server use \`add\` (it merges, keeping your others); use
\`clear\` to wipe everything or \`remove\` to drop a single server.

The config is the standard MCP shape:

  {
    "mcpServers": {
      "my-stdio":  { "command": "npx", "args": ["-y", "some-server"] },
      "my-remote": { "type": "http", "url": "https://example.com/mcp" }
    }
  }

Server names match /^[A-Za-z0-9_-]{1,64}$/. At spawn each name is
namespaced to \`silverhand_profile__<name>\` so it never shadows the
user's own MCP servers; the config is merged ADDITIVELY (it never
overwrites the user's runtime config).

Effect is NEXT SPAWN — a running agent does not pick up the change
until it is respawned.

stdin:  the raw mcp.json text (validated; invalid JSON / schema is
        rejected with validation_error and nothing is written).
stdout: { "ok": true, "bytes_written": <n> }.`,
  flags: [] as const,
  async run({ client }) {
    const raw = await readRawStdin('silverhand profile mcp set');
    // The backend re-validates (fail-loud) and the host re-validates again;
    // we send the raw text straight through so the persisted file is the
    // exact bytes the agent piped.
    return client.setProfileMcp(raw);
  },
};

const validateCommand: Command = {
  verb: 'validate',
  summary: 'Validate profile MCP JSON from stdin without writing it.',
  help: `silverhand profile mcp validate

Validate \`mcp.json\` text from stdin against the canonical schema
WITHOUT writing it. A cheap local pre-check before \`set\` — it makes
no backend call.

stdin:  the raw mcp.json text.
stdout: { "ok": true, "server_count": <n> } on success; a
        validation_error (exit 1) describing the first problem otherwise.`,
  flags: [] as const,
  async run() {
    const raw = await readRawStdin('silverhand profile mcp validate');
    const parsed = parseMcpConfig(raw);
    if (!parsed.ok) {
      throw new CliError({
        code: 'validation_error',
        message: parsed.error,
        retriable: false,
      });
    }
    return {
      ok: true,
      server_count: Object.keys(parsed.config.mcpServers).length,
    };
  },
};

const probeCommand: Command = {
  verb: 'probe',
  summary: "Live-test one of this agent's profile MCP servers (connect + initialize).",
  help: `silverhand profile mcp probe --server <name> [--tools]

Open a ONE-SHOT live connection to a configured profile MCP server,
run the MCP \`initialize\` handshake, and close it immediately. Unlike
\`validate\` (static, offline), this actually reaches the server. The
connection never outlives the call.

  --server <name>   Raw server name (the key in your mcp.json) to probe.
  --tools           Also run \`tools/list\` and return the tool names.

stdout: a McpProbeResult —
  { "ok": true,  "phase": "initialize", "server_info": {...} }      (--tools off)
  { "ok": true,  "phase": "tools", "tools": [{ "name", "description" }] }
  { "ok": false, "phase": "parse|not_found|connect|initialize|tools",
    "message": "<redacted reason>" }
Connection failures are reported in the body (not an error). Secrets
(header/env values, URL query) never appear in \`message\`.`,
  flags: ['server'] as const,
  booleanFlags: ['tools'] as const,
  async run({ client, args }) {
    const server = args.flags.server;
    if (typeof server !== 'string' || server.length === 0) {
      throw new CliError({
        code: 'validation_error',
        message:
          '`--server <name>` is required: the raw MCP server name to probe.',
        retriable: false,
      });
    }
    return client.probeProfileMcp(server, args.flags.tools === true);
  },
};

const addCommand: Command = {
  verb: 'add',
  summary:
    "Add servers to the executing agent's profile MCP config (merges; never clobbers existing).",
  help: `silverhand profile mcp add [--replace]

Add one or more MCP servers to the executing agent's profile config,
MERGING into what is already there — existing servers are always kept.
This is the safe way to "add an MCP server"; \`set\` REPLACES the whole
config and would drop your other servers.

Pipe a standard \`mcp.json\` on stdin; its \`mcpServers\` are merged into
the current config.

  --replace   Allow overwriting a server that already exists under the
              same name. WITHOUT it, a name collision fails with conflict
              and nothing is written — so \`add\` never silently clobbers
              an existing server. Even with --replace, only the named
              servers change; all others are preserved.

Effect is NEXT SPAWN — a running agent keeps the old config until it is
respawned.

stdin:  a standard mcp.json ({ "mcpServers": { ... } }); validated
        (invalid JSON / schema → validation_error, nothing written).
stdout: { "ok": true, "added": [<names>], "total": <n> }.`,
  flags: [] as const,
  booleanFlags: ['replace'] as const,
  async run({ client, args }) {
    const raw = await readRawStdin('silverhand profile mcp add');
    const input = parseMcpConfig(raw);
    if (!input.ok) {
      throw new CliError({
        code: 'validation_error',
        message: input.error,
        retriable: false,
      });
    }
    const incoming = input.config.mcpServers;
    const names = Object.keys(incoming);
    if (names.length === 0) {
      throw new CliError({
        code: 'validation_error',
        message: 'nothing to add: the piped mcpServers is empty.',
        retriable: false,
      });
    }
    const { raw: currentRaw } = await client.getProfileMcp();
    let current: Record<string, McpServerConfig> = {};
    if (currentRaw != null) {
      const cur = parseMcpConfig(currentRaw);
      if (!cur.ok) {
        throw new CliError({
          code: 'validation_error',
          message: `current mcp.json is not valid (${cur.error}); fix it with \`set\` first.`,
          retriable: false,
        });
      }
      current = cur.config.mcpServers;
    }
    if (args.flags.replace !== true) {
      const collisions = names.filter(name => name in current);
      if (collisions.length > 0) {
        throw new CliError({
          code: 'conflict',
          message:
            `server(s) already exist: ${collisions.join(', ')}. ` +
            'Use --replace to overwrite them, or `remove` them first. ' +
            'Other servers are never touched.',
          retriable: false,
        });
      }
    }
    const merged = { ...current, ...incoming };
    await client.setProfileMcp(`${JSON.stringify({ mcpServers: merged }, null, 2)}\n`);
    return { ok: true, added: names, total: Object.keys(merged).length };
  },
};

const removeCommand: Command = {
  verb: 'remove',
  summary: "Remove one server from the executing agent's profile MCP config.",
  help: `silverhand profile mcp remove --server <name>

Remove a single server from the executing agent's profile MCP config,
leaving the others untouched. Reads the current \`mcp.json\`, deletes
the named server, and writes the rest back.

  --server <name>   The server name (key in your mcp.json) to remove.

A server name that is not present fails with not_found (nothing is
written). To wipe the whole config instead, use \`clear\`.

Effect is NEXT SPAWN — a running agent keeps the old config until it
is respawned.

stdout: { "ok": true, "removed": <name>, "remaining": <n> }.`,
  flags: ['server'] as const,
  async run({ client, args }) {
    const server = args.flags.server;
    if (typeof server !== 'string' || server.length === 0) {
      throw new CliError({
        code: 'validation_error',
        message:
          '`--server <name>` is required: the MCP server name to remove.',
        retriable: false,
      });
    }
    const { raw } = await client.getProfileMcp();
    if (raw == null) {
      throw new CliError({
        code: 'not_found',
        message: 'no profile MCP config to remove from (it is unset).',
        retriable: false,
      });
    }
    const parsed = parseMcpConfig(raw);
    if (!parsed.ok) {
      throw new CliError({
        code: 'validation_error',
        message: `current mcp.json is not valid (${parsed.error}); fix it with \`set\` first.`,
        retriable: false,
      });
    }
    const servers = parsed.config.mcpServers;
    if (!(server in servers)) {
      throw new CliError({
        code: 'not_found',
        message: `server '${server}' is not in the profile MCP config.`,
        retriable: false,
      });
    }
    delete servers[server];
    // Re-serialize the canonical config (a structural edit reformats by
    // design); set re-validates and writes it on the owning host.
    await client.setProfileMcp(`${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
    return { ok: true, removed: server, remaining: Object.keys(servers).length };
  },
};

const clearCommand: Command = {
  verb: 'clear',
  summary: "Remove ALL servers from the executing agent's profile MCP config.",
  help: `silverhand profile mcp clear

Clear the executing agent's profile MCP config — removes ALL servers
(writes \`{ "mcpServers": {} }\`). \`get\` then returns an empty config,
not null. To remove a single server instead, use \`remove\`.

Effect is NEXT SPAWN — a running agent keeps the old config until it
is respawned.

stdout: { "ok": true, "cleared": true }.`,
  flags: [] as const,
  async run({ client }) {
    await client.setProfileMcp('{\n  "mcpServers": {}\n}\n');
    return { ok: true, cleared: true };
  },
};

export const profileFacets: readonly FacetGroup[] = [
  {
    facet: 'mcp',
    summary: "Manage this agent's custom MCP servers.",
    commands: [
      getCommand,
      setCommand,
      addCommand,
      removeCommand,
      clearCommand,
      validateCommand,
      probeCommand,
    ],
  },
];

/** Read all of stdin as a UTF-8 string. Fails loudly when stdin is a TTY
 *  (the agent forgot to pipe a body) or empty — mirrors the stdin-only
 *  contract of `message send`. */
async function readRawStdin(cmd: string): Promise<string> {
  if (process.stdin.isTTY) {
    throw new CliError({
      code: 'validation_error',
      subkind: 'stdin_is_tty',
      message:
        `${cmd} reads the mcp.json text from stdin, but stdin is a TTY. ` +
        `Pipe it — e.g. \`cat mcp.json | ${cmd}\` or ` +
        `\`${cmd} <<'SILVERHAND_EOF' ... SILVERHAND_EOF\`.`,
      retriable: false,
    });
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);
  if (buffer.byteLength === 0) {
    throw new CliError({
      code: 'validation_error',
      subkind: 'empty_stdin',
      message: `${cmd} received 0 bytes on stdin. Pipe the mcp.json text.`,
      retriable: false,
    });
  }
  return buffer.toString('utf8');
}
