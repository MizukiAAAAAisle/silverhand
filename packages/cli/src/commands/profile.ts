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
import { parseMcpConfig } from '@silverhand/shared';
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
(your own formatting is preserved). This REPLACES the whole config;
to remove all servers, pipe \`{"mcpServers":{}}\`.

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

export const profileFacets: readonly FacetGroup[] = [
  {
    facet: 'mcp',
    summary: 'Get, set, or validate this agent\'s custom MCP servers.',
    commands: [getCommand, setCommand, validateCommand],
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
