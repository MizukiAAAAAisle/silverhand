/**
 * opencode spawn-time config assembly — the single owner of the
 * `OPENCODE_CONFIG_CONTENT` env value Silverhand injects at spawn.
 *
 * Why an env var: opencode has no additive `--mcp-config` / system-prompt flag
 * the way claude (`--append-system-prompt-file`) or codex
 * (`developerInstructions`) do, and its ACP surface (`session/new` /
 * `session/prompt`) carries no direct system-prompt field. Instead opencode
 * reads `OPENCODE_CONFIG_CONTENT` and **deep-merges it over the user's on-disk
 * config, env winning on conflicting leaves** (verified empirically against
 * opencode 1.17.14 via `opencode debug config`). That single fact shapes this
 * module:
 *  - We inject ONLY our own keys; the user's settings / hooks / plugins / MCP
 *    are inherited automatically (no need to read + re-merge the user config).
 *  - Standing prompt rides a dedicated custom agent (`agent.<SILVERHAND_OPENCODE_AGENT>.prompt`);
 *    the ACP driver then selects it (`session` config `mode` →
 *    {@link SILVERHAND_OPENCODE_AGENT}) so the agent runs under our manual.
 *  - Profile MCP servers (already domain-prefixed) deep-merge alongside the
 *    user's own under `mcp`.
 *
 * This is host-agnostic and node-free (pure string assembly); the host reads
 * the standing-prompt file and sets the env. Keeping the SHAPE here means the
 * env-seam producer and the ACP driver's `mode` selector agree on one agent
 * name and one config layout instead of two hand-copied literals.
 */
import type { OpencodeMcpServer } from './mcp-config.js';

/**
 * The custom opencode agent name our standing prompt is injected under, and
 * that the ACP driver selects via the session `mode` config option. One
 * constant so the env-seam producer (writes `agent.<name>.prompt`) and the
 * driver (sets `mode = <name>`) can never drift.
 */
export const SILVERHAND_OPENCODE_AGENT = 'silverhand';

export interface OpencodeConfigContentInput {
  /**
   * The materialized standing system prompt CONTENT (platform manual + L1/L2
   * memory). Injected as the custom agent's `prompt`. opencode's `agent.prompt`
   * is an inline string (no file-ref form), so this is the full text.
   */
  standingPrompt?: string | null;
  /**
   * Domain-prefixed profile MCP fragment from `toOpencodeMcpConfig`, or `null`
   * when the subject has no profile MCP layer.
   */
  mcpConfig?: { mcp: Record<string, OpencodeMcpServer> } | null;
}

/**
 * Assemble the `OPENCODE_CONFIG_CONTENT` JSON string from the pieces the spawn
 * path resolves. Returns `null` when there is nothing to inject (no standing
 * prompt and no MCP) so the caller can omit the env entirely and let opencode
 * run on the pure user config. Only non-empty sections are emitted, so the
 * deep-merge never clobbers a user key we don't actually set.
 */
export function buildOpencodeConfigContent(input: OpencodeConfigContentInput): string | null {
  const config: {
    agent?: Record<string, { prompt: string }>;
    mcp?: Record<string, OpencodeMcpServer>;
  } = {};

  if (input.standingPrompt && input.standingPrompt.trim().length > 0) {
    config.agent = {
      [SILVERHAND_OPENCODE_AGENT]: { prompt: input.standingPrompt },
    };
  }

  if (input.mcpConfig && Object.keys(input.mcpConfig.mcp).length > 0) {
    config.mcp = input.mcpConfig.mcp;
  }

  if (Object.keys(config).length === 0) return null;
  return JSON.stringify(config);
}
