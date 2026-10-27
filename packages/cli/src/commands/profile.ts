/**
 * `silverhand profile` — profile config. The WRITE side is always the
 * executing subject's own (Human/Agent isomorphism): there is no target flag
 * on any verb that changes something, and the backend pins it structurally.
 * The READ side of profile metadata also answers for a PEER
 * (`get --handle <name>`, #task:1823), because "who is @X and what do they
 * own" is a question every collaborator has and identity is not private
 * within a workspace.
 *
 * Two grammars coexist under this noun (#task:1178):
 *   - Faceted:  `silverhand profile mcp <verb>`  — custom MCP servers.
 *               ALWAYS self: it is host-local L1 config and may carry
 *               credentials, so it takes no `--handle`.
 *   - Flat:     `silverhand profile get|update`  — profile metadata
 *               (display name / description / avatar). The dispatcher tries
 *               the facet token first; an unknown facet falls through to a
 *               flat verb, so `profile mcp …` and `profile get` never clash.
 *
 * MCP config is stored as raw JSON at the agent's L1 `mcp.json` (the host is
 * the single source of truth — no DB copy). It is loaded ADDITIVELY at the
 * NEXT spawn (no hot reload): claude/qoder via `--mcp-config`, codex via
 * per-server `-c mcp_servers.*` overrides. Server names are namespaced to
 * `silverhand_profile__<name>` at spawn so they never collide with the user's
 * own MCP servers.
 *
 * Profile metadata (display_name / description / avatar) lives in DB columns
 * on `agents`, NOT in an L1 file — so `profile get|update` write straight
 * through the backend (no host round-trip). The avatar is a stored BLOB; its
 * `avatar_url` is a derived read-only Silverhand route, never a foreign URL.
 * `--avatar-url` is a one-shot IMPORT source: the CLI downloads the bytes
 * here (never the backend — no SSRF surface) and uploads them like a local
 * file; the URL itself is never persisted.
 */
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import {
  AVATAR_MAX_BYTES,
  AVATAR_MAX_SIZE_LABEL,
  UpdateProfileInputSchema,
  parseMcpConfig,
  type McpServerConfig,
  type UpdateProfileInput,
} from '@silverhand/shared';
import type { Command, FacetGroup } from './index.js';
import { flagBool, flagString } from '../parse.js';
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
        message: '`--server <name>` is required: the raw MCP server name to probe.',
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
      const collisions = names.filter((name) => name in current);
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
        message: '`--server <name>` is required: the MCP server name to remove.',
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

// ── Flat profile-metadata verbs (`profile get|update`, #task:1178) ─────

interface AvatarBytes {
  buffer: Buffer;
  filename: string;
  contentType: string;
}

/** Sniff the image MIME from magic bytes — the four types the avatar
 *  service accepts. We sniff the actual BYTES (never trust a URL's
 *  Content-Type header or a filename suffix), so a mislabeled source
 *  fails loud here; the backend avatar service stays the authoritative
 *  size/type validator. Returns null when the bytes are not a supported
 *  image. */
function sniffImageMime(buf: Buffer): string | null {
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buf.length >= 6 && buf.toString('ascii', 0, 4) === 'GIF8') {
    return 'image/gif';
  }
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/** Wrap raw avatar bytes after a cheap, fail-fast local pre-check (empty
 *  / size cap / sniffed type). The backend avatar service re-validates
 *  authoritatively — this just sets a correct content-type and rejects an
 *  obvious non-image before the upload round-trip. */
function toAvatarBytes(buffer: Buffer, filename: string): AvatarBytes {
  if (buffer.byteLength === 0) {
    throw new CliError({
      code: 'validation_error',
      message: 'avatar source is empty (0 bytes).',
      retriable: false,
    });
  }
  if (buffer.byteLength > AVATAR_MAX_BYTES) {
    throw new CliError({
      code: 'validation_error',
      message: `avatar must be ${AVATAR_MAX_SIZE_LABEL} or smaller.`,
      retriable: false,
    });
  }
  const contentType = sniffImageMime(buffer);
  if (!contentType) {
    throw new CliError({
      code: 'validation_error',
      message: 'avatar must be a PNG, JPEG, GIF, or WEBP image (checked from the bytes).',
      retriable: false,
    });
  }
  return { buffer, filename, contentType };
}

/** Resolve avatar bytes from a LOCAL file. Mirrors `file upload`'s
 *  absolute-path contract; MIME is sniffed from the bytes. */
async function readAvatarFile(path: string): Promise<AvatarBytes> {
  if (!isAbsolute(path)) {
    throw new CliError({
      code: 'validation_error',
      message: '--avatar-file must be an absolute path.',
      retriable: false,
    });
  }
  let buffer: Buffer;
  try {
    buffer = await readFile(path);
  } catch (err) {
    throw new CliError({
      code: 'not_found',
      message: `cannot read avatar file at ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      retriable: false,
    });
  }
  return toAvatarBytes(buffer, basename(path));
}

const MAX_AVATAR_REDIRECTS = 5;
const AVATAR_DOWNLOAD_TIMEOUT_MS = 20_000;

/** Download an avatar from an http(s) URL — CLI-SIDE BY DESIGN, never the
 *  backend. The backend must never fetch an agent-supplied URL (that would
 *  open an SSRF surface from the trusted network); the agent runtime
 *  already has network access, so a CLI fetch adds none. The URL is a
 *  one-shot IMPORT source — it is never persisted; the stored avatar is the
 *  blob. Guards: http(s) only, bounded redirects, streaming size cap,
 *  timeout, fail-loud. */
async function downloadAvatar(rawUrl: string): Promise<AvatarBytes> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CliError({
      code: 'validation_error',
      message: `--avatar-url is not a valid URL: ${rawUrl}`,
      retriable: false,
    });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AVATAR_DOWNLOAD_TIMEOUT_MS);
  try {
    let current = url;
    let redirects = 0;
    let res: Response;
    for (;;) {
      if (current.protocol !== 'http:' && current.protocol !== 'https:') {
        throw new CliError({
          code: 'validation_error',
          message: `--avatar-url must be http(s); got ${current.protocol}`,
          retriable: false,
        });
      }
      res = await fetch(current, { redirect: 'manual', signal: controller.signal });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) break;
        if (++redirects > MAX_AVATAR_REDIRECTS) {
          throw new CliError({
            code: 'validation_error',
            message: `--avatar-url exceeded ${MAX_AVATAR_REDIRECTS} redirects.`,
            retriable: false,
          });
        }
        current = new URL(loc, current);
        continue;
      }
      break;
    }
    if (!res.ok) {
      throw new CliError({
        code: 'validation_error',
        message: `--avatar-url download failed: HTTP ${res.status}.`,
        retriable: false,
      });
    }
    const buffer = await readBodyCapped(res, AVATAR_MAX_BYTES);
    const name = basename(current.pathname) || 'avatar';
    return toAvatarBytes(buffer, name);
  } catch (err) {
    if (err instanceof CliError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new CliError({
        code: 'validation_error',
        message: `--avatar-url download timed out after ${AVATAR_DOWNLOAD_TIMEOUT_MS}ms.`,
        retriable: false,
      });
    }
    throw new CliError({
      code: 'validation_error',
      message: `--avatar-url download failed: ${err instanceof Error ? err.message : String(err)}`,
      retriable: false,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Read a fetch body, aborting once it exceeds `cap` bytes so a huge
 *  remote file can't OOM the CLI (the size cap is also re-enforced by the
 *  avatar service on the uploaded bytes). */
async function readBodyCapped(res: Response, cap: number): Promise<Buffer> {
  const body = res.body;
  if (!body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > cap) {
      throw new CliError({
        code: 'validation_error',
        message: `avatar must be ${AVATAR_MAX_SIZE_LABEL} or smaller.`,
        retriable: false,
      });
    }
    return buf;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel();
        throw new CliError({
          code: 'validation_error',
          message: `avatar exceeds ${AVATAR_MAX_SIZE_LABEL}; download aborted.`,
          retriable: false,
        });
      }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks);
}

const profileGetCommand: Command = {
  verb: 'get',
  summary:
    "Print an agent's profile (display name, description, avatar) — yours, or a peer's with --handle.",
  help: `silverhand profile get [--handle <name>] [--workspace-id <id>]

Print profile metadata. Without flags this is the SELF view — the executing
agent's own profile, i.e. the fields it can change with \`profile update\`.
Distinct from \`profile mcp get\` (custom MCP config, self-only always).

  --handle <name>       Read ANOTHER agent's profile instead (read-only; a
                        leading @ is fine). Use it to find out who a peer is
                        and what they own before handing work over.
  --workspace-id <id>   Which workspace the peer lookup is scoped to.
                        Defaults to this conversation's workspace. A
                        workspace-less placement (a DM) has no such
                        default — name the workspace there.

A peer read is READ-ONLY and needs the target to be an agent in that
workspace; anything else — no such handle, a human's handle, an agent in a
workspace you two don't share — is the same not_found.

stdout: an AgentProfileDto —
  { "id", "name", "display_name",
    "description": <string|null>, "avatar_url": <string|null> }
\`avatar_url\` is a derived, read-only Silverhand URL (or null) — set your own
avatar via \`profile update --avatar-file|--avatar-url\`, never by writing
this field. There is no way to write another agent's profile.`,
  flags: ['handle', 'workspace-id'] as const,
  async run({ client, args }) {
    const handle = flagString(args, 'handle');
    const workspaceId = flagString(args, 'workspace-id');
    if (handle === undefined) {
      if (workspaceId !== undefined) {
        throw new CliError({
          code: 'validation_error',
          message:
            '--workspace-id only applies to a peer lookup; pass --handle <name> too (your own profile is workspace-independent).',
          retriable: false,
        });
      }
      const { profile } = await client.getProfile();
      return profile;
    }
    const { profile } = await client.getPeerProfile(handle, workspaceId);
    return profile;
  },
};

const profileUpdateCommand: Command = {
  verb: 'update',
  summary: "Update the executing agent's own profile (display name, description, avatar).",
  help: `silverhand profile update [--display-name <name>] [--description <text>]
                          [--avatar-file <path> | --avatar-url <url> | --clear-avatar]

Update the executing agent's OWN profile (self only — there is no target
flag; the subject is always whoever runs the CLI). Pass any combination of
the text flags; at most ONE avatar action.

  --display-name <name>   New display name (1..64 chars).
  --description <text>    New description (<= 2000 chars; "" sets it empty).
  --avatar-file <path>    Set the avatar from a LOCAL file (absolute path).
  --avatar-url <url>      Set the avatar by downloading an http(s) image.
                          The URL is a one-shot import source — Silverhand
                          stores the bytes as its own avatar blob and never
                          persists or hot-links the URL.
  --clear-avatar          Remove the current avatar.

Avatar: PNG / JPEG / GIF / WEBP, ${AVATAR_MAX_SIZE_LABEL} max. The type is
checked from the bytes; the backend avatar service is the authoritative
size/type validator. \`--avatar-file\`, \`--avatar-url\`, and \`--clear-avatar\`
are mutually exclusive.

Order: the URL is downloaded (and the file read) BEFORE any write, so a bad
source leaves your profile untouched; the avatar is applied before the text.

stdout: the updated AgentProfileDto (same shape as \`profile get\`).`,
  flags: ['display-name', 'description', 'avatar-file', 'avatar-url'] as const,
  booleanFlags: ['clear-avatar'] as const,
  async run({ client, args }) {
    const displayName = flagString(args, 'display-name');
    const description = flagString(args, 'description');
    const avatarFile = flagString(args, 'avatar-file');
    const avatarUrl = flagString(args, 'avatar-url');
    const clearAvatar = flagBool(args, 'clear-avatar') === true;

    const avatarActions = [avatarFile !== undefined, avatarUrl !== undefined, clearAvatar].filter(
      Boolean,
    ).length;
    if (avatarActions > 1) {
      throw new CliError({
        code: 'validation_error',
        message: 'choose at most one of --avatar-file, --avatar-url, --clear-avatar.',
        retriable: false,
      });
    }
    const hasText = displayName !== undefined || description !== undefined;
    if (!hasText && avatarActions === 0) {
      throw new CliError({
        code: 'validation_error',
        message:
          'nothing to update: pass at least one of --display-name, --description, ' +
          '--avatar-file, --avatar-url, --clear-avatar.',
        retriable: false,
      });
    }

    // 1. Pre-validate text against the shared contract for a fast, clear
    //    error (the backend re-validates as the authority).
    let textInput: UpdateProfileInput | null = null;
    if (hasText) {
      const candidate: Record<string, unknown> = {};
      if (displayName !== undefined) candidate.display_name = displayName;
      if (description !== undefined) candidate.description = description;
      const parsed = UpdateProfileInputSchema.safeParse(candidate);
      if (!parsed.success) {
        throw new CliError({
          code: 'validation_error',
          message: parsed.error.issues[0]?.message ?? 'invalid profile fields',
          retriable: false,
        });
      }
      textInput = parsed.data;
    }

    // 2. Resolve avatar bytes (read file / download URL) BEFORE the write,
    //    so a bad source never reaches the backend (Cindy #4).
    let avatarBytes: AvatarBytes | null = null;
    if (avatarFile !== undefined) avatarBytes = await readAvatarFile(avatarFile);
    else if (avatarUrl !== undefined) avatarBytes = await downloadAvatar(avatarUrl);

    // 3. Apply the whole edit in ONE request — text + avatar travel together
    //    and are all pre-validated (text schema + downloaded/read avatar bytes)
    //    before any write, so a bad source can't land a partial edit. The
    //    backend is NOT cross-store atomic (avatar blob then text columns, no
    //    spanning txn), but returns the canonical updated profile.
    const { profile } = await client.updateProfile({
      ...(textInput?.display_name !== undefined ? { display_name: textInput.display_name } : {}),
      ...(textInput && 'description' in textInput
        ? { description: textInput.description ?? '' }
        : {}),
      ...(avatarBytes
        ? {
            avatar: {
              action: 'set' as const,
              buffer: avatarBytes.buffer,
              filename: avatarBytes.filename,
              contentType: avatarBytes.contentType,
            },
          }
        : clearAvatar
          ? { avatar: { action: 'clear' as const } }
          : {}),
    });
    return profile;
  },
};

/** Flat verbs on the `profile` noun — coexist with the `mcp` facet via the
 *  dispatcher's facet-then-flat resolution. */
export const profileCommands: readonly Command[] = [profileGetCommand, profileUpdateCommand];

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
