import {
  type ReasoningEffort,
  type RuntimeKind,
  RuntimeKindSchema,
} from './db/schema.js';

/**
 * Single source of truth for per-runtime UI facts.
 *
 * Before this existed, runtime `label` / selectability / proxy ordering
 * were hand-copied into four+ renderer sites (`CreateAgentDialog`,
 * `AgentProfileCard`, `HostDetailView` proxy form, `AgentMcpPane`), so
 * adding a runtime meant manually scanning for every copy — and qoder
 * was silently missed in create + profile the first time. This catalog
 * is the ubiquitous-language home for those facts; every consumer reads
 * from here. Renderer-only concerns (brand icon / tint colors) stay in
 * the renderer — this owns label / availability / capability, not pixels.
 */
export interface RuntimeCatalogEntry {
  kind: RuntimeKind;
  /** Short brand name (proxy form, MCP messages): "Claude". */
  label: string;
  /** Product / CLI name for the agent create + profile pickers:
   *  "Claude Code". Equal to `label` when there's no distinct CLI name. */
  cliLabel: string;
  /**
   * Offerable as an agent runtime in the create / profile pickers. This
   * is a curated PRODUCT flag, NOT "has a driver": cursor has a driver
   * but isn't offered yet. Invariant (asserted host-side, where driver
   * registration is visible): `selectable ⇒ hasDriver(kind)` — we never
   * offer a runtime we can't actually spawn.
   */
  selectable: boolean;
  /**
   * User-facing reasoning-effort options for this runtime, in display
   * order (empty = no Reasoning control). Values are the canonical
   * lowercase tokens stored + passed to the driver verbatim; kept
   * PER-RUNTIME so widening the shared `ReasoningEffortSchema` (e.g.
   * qoder's `none`/`max`) can't leak into another runtime's picker —
   * codex stays `low/medium/high/xhigh`, qoder gets the full set.
   */
  reasoningEffortOptions: readonly ReasoningEffort[];
  /**
   * Profile MCP servers load at spawn for this runtime. Source of truth
   * is the host spawn loader (`mcp-spawn.ts`); this mirrors it and a
   * host-side test asserts the two stay in lockstep.
   */
  supportsProfileMcp: boolean;
  /**
   * Suggested model values for the profile model picker (e.g. qoder's
   * capability tiers). Free-text model ids are ALWAYS also allowed —
   * these are quick-pick suggestions, not a closed enum. `[]` = no
   * suggestions (free-text only).
   */
  modelSuggestions: readonly string[];
}

// Exhaustive by construction: `Record<RuntimeKind, …>` forces an entry
// for every runtime kind, so a new kind can't ship without a catalog row.
const CATALOG: Record<RuntimeKind, RuntimeCatalogEntry> = {
  claude: {
    kind: 'claude',
    label: 'Claude',
    cliLabel: 'Claude Code',
    selectable: true,
    reasoningEffortOptions: [],
    supportsProfileMcp: true,
    modelSuggestions: [],
  },
  codex: {
    kind: 'codex',
    label: 'Codex',
    cliLabel: 'Codex CLI',
    selectable: true,
    reasoningEffortOptions: ['low', 'medium', 'high', 'xhigh'],
    supportsProfileMcp: true,
    modelSuggestions: [],
  },
  qoder: {
    kind: 'qoder',
    label: 'Qoder',
    cliLabel: 'Qoder',
    selectable: true,
    // qoder's full canonical set from the qodercli binary.
    reasoningEffortOptions: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    supportsProfileMcp: false,
    // The five capability tiers from `qodercli --list-models`. Specific
    // model ids (Qwen*/GLM*/DeepSeek*/Kimi*/MiniMax*) go through free
    // text, per shiki: keep the tiers as suggestions, allow custom ids.
    modelSuggestions: ['Auto', 'Ultimate', 'Performance', 'Efficient', 'Lite'],
  },
  cursor: {
    kind: 'cursor',
    label: 'Cursor',
    cliLabel: 'Cursor',
    selectable: false,
    reasoningEffortOptions: [],
    supportsProfileMcp: false,
    modelSuggestions: [],
  },
  gemini: {
    kind: 'gemini',
    label: 'Gemini',
    cliLabel: 'Gemini',
    selectable: false,
    reasoningEffortOptions: [],
    supportsProfileMcp: false,
    modelSuggestions: [],
  },
};

/**
 * Display order for the pickers and the proxy runtime list: selectable
 * runtimes first (create/profile order), then roadmap runtimes. A test
 * asserts this is a permutation of `RuntimeKindSchema.options` so a new
 * kind can't be omitted from the ordering.
 */
const RUNTIME_ORDER: readonly RuntimeKind[] = [
  'claude',
  'codex',
  'qoder',
  'cursor',
  'gemini',
];

/** All runtime entries in display order. Proxy form lists every kind
 *  (availability-agnostic); create/profile filter on `selectable`. */
export const RUNTIME_CATALOG: readonly RuntimeCatalogEntry[] = RUNTIME_ORDER.map(
  kind => CATALOG[kind],
);

/** All known runtime kinds in display order. */
export const RUNTIME_ORDER_LIST: readonly RuntimeKind[] = RUNTIME_ORDER;

export function runtimeCatalogEntry(kind: RuntimeKind): RuntimeCatalogEntry {
  return CATALOG[kind];
}

/** Short brand label ("Claude"). Falls back to the raw kind for any
 *  value outside the enum (defensive; the type makes this unreachable). */
export function runtimeLabel(kind: RuntimeKind): string {
  return CATALOG[kind]?.label ?? kind;
}

/** Product / CLI label ("Claude Code"). */
export function runtimeCliLabel(kind: RuntimeKind): string {
  return CATALOG[kind]?.cliLabel ?? kind;
}

/** True if the runtime exposes a reasoning-effort control. */
export function runtimeSupportsReasoningEffort(kind: RuntimeKind): boolean {
  return CATALOG[kind].reasoningEffortOptions.length > 0;
}

/**
 * Domain invariant: a stored `reasoning_effort` must be `null` (unset) OR a
 * value this runtime actually supports (per its catalog options). The UI
 * picker only offers valid values, but this is the AUTHORITATIVE check the
 * write boundary (create + update) enforces so a direct-API call or a
 * runtime switch can't persist e.g. qoder's `max` onto a codex agent (which
 * would then forward an out-of-range value to the codex driver). Keeping the
 * rule here — beside the options it reads — means create and update share one
 * definition instead of two hand-copied allowlists.
 */
export function reasoningEffortValidForRuntime(
  kind: RuntimeKind,
  value: ReasoningEffort | null | undefined,
): boolean {
  if (value === null || value === undefined) return true;
  return CATALOG[kind].reasoningEffortOptions.includes(value);
}

/** Generic display label for a reasoning-effort value (title-cased):
 *  `xhigh` → "Xhigh", `none` → "None". Persistence + driver args use
 *  the raw lowercase token; this is display-only. */
export function reasoningEffortLabel(value: ReasoningEffort): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Guard used by tests to keep `RUNTIME_ORDER` exhaustive. */
export function runtimeCatalogCoversAllKinds(): boolean {
  return (
    RUNTIME_ORDER.length === RuntimeKindSchema.options.length &&
    RuntimeKindSchema.options.every(k => RUNTIME_ORDER.includes(k))
  );
}
