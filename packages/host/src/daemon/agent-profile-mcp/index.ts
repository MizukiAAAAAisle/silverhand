import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  MCP_CONFIG_FILENAME,
  parseMcpConfig,
} from '@silverhand/shared';
import {
  type AgentProfileMcpReadParams,
  type AgentProfileMcpReadResult,
  type AgentProfileMcpWriteParams,
  type AgentProfileMcpWriteResult,
  type AgentProfileMcpErrorCode,
} from '../../protocol.js';
import { DaemonTypedError } from '../typed-error.js';
import { resolveAgentDir } from '../agent-materialize/index.js';

/**
 * Daemon handlers for `agent_profile_mcp_read` / `agent_profile_mcp_write`
 * (#task:1135) — the host-local truth behind `silverhand profile mcp get|set`.
 *
 * The raw config lives at `<agentHome>/mcp.json` (L1). Read returns the raw
 * text or null (absent = the normal "no MCP" case, not an error). Write
 * re-validates the canonical schema (fail-loud `invalid_config`) then replaces
 * the file ATOMICALLY (tmp write + rename) so a concurrent spawn never reads a
 * half-written file. The backend route is the primary validation authority;
 * the daemon re-validates as belt-and-suspenders. No fs path crosses the wire —
 * the daemon resolves the L1 dir from `agent_id` (I1).
 */
export class AgentProfileMcpError extends DaemonTypedError {
  constructor(
    readonly code: AgentProfileMcpErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentProfileMcpError';
  }
}

export interface AgentProfileMcpDeps {
  /**
   * The EXACT agents root agent-home resolution joins onto, from the
   * composition root. Required — no implicit default (#task:1813).
   */
  agentHomeRootDir: string;
}

export async function readAgentProfileMcp(
  params: AgentProfileMcpReadParams,
  deps: AgentProfileMcpDeps,
): Promise<AgentProfileMcpReadResult> {
  const filePath = join(resolveAgentDir(params.agent_id, deps), MCP_CONFIG_FILENAME);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return { ok: true, raw };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { ok: true, raw: null };
    }
    throw toProfileMcpError(err);
  }
}

export async function writeAgentProfileMcp(
  params: AgentProfileMcpWriteParams,
  deps: AgentProfileMcpDeps,
): Promise<AgentProfileMcpWriteResult> {
  // Re-validate fail-loud before touching disk: a bad payload never persists.
  const parsed = parseMcpConfig(params.raw);
  if (!parsed.ok) {
    throw new AgentProfileMcpError('invalid_config', parsed.error);
  }

  const agentDir = resolveAgentDir(params.agent_id, deps);
  const filePath = join(agentDir, MCP_CONFIG_FILENAME);
  // Persist the raw text verbatim (the user's own formatting), not a
  // re-serialized copy — the file is the truth the pane shows back.
  const bytes = Buffer.byteLength(params.raw, 'utf-8');
  const tmpPath = join(
    agentDir,
    `.${MCP_CONFIG_FILENAME}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await fs.mkdir(dirname(filePath), { recursive: true });
    await fs.writeFile(tmpPath, params.raw, { mode: 0o600 });
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw toProfileMcpError(err);
  }
  return { ok: true, bytes_written: bytes };
}

function toProfileMcpError(err: unknown): AgentProfileMcpError {
  if (err instanceof AgentProfileMcpError) return err;
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) {
    return new AgentProfileMcpError(
      'fs_unavailable',
      err instanceof Error ? err.message : String(err),
    );
  }
  return new AgentProfileMcpError(
    'internal_error',
    err instanceof Error ? err.message : String(err),
  );
}
