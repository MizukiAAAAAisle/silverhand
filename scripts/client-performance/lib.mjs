import { readFile } from 'node:fs/promises';

export const REPORT_SCHEMA_VERSION = 1;

export function nearestRank(values, percentile) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (!Number.isFinite(percentile) || percentile < 0 || percentile > 1) {
    throw new Error(`percentile must be between 0 and 1 (got ${percentile})`);
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
  return sorted[index];
}

export function summarizePhase(raw) {
  const frameGaps = finiteNumbers(raw.frameGapsMs);
  const longTasks = finiteNumbers(raw.longTasksMs);
  const eventDurations = finiteNumbers(raw.eventDurationsMs);
  return {
    action_to_paint_ms: finiteOrNull(raw.actionToPaintMs),
    measured_ms: finiteOrNull(raw.measuredMs),
    renderer_started_at_ms: finiteOrNull(raw.rendererStartedAtMs),
    renderer_ended_at_ms: finiteOrNull(raw.rendererEndedAtMs),
    frames: frameGaps.length,
    frame_gap_ms: summarizeDistribution(frameGaps),
    frames_over_16_7_ms: frameGaps.filter(value => value > 16.7).length,
    frames_over_33_3_ms: frameGaps.filter(value => value > 33.3).length,
    frames_over_50_ms: frameGaps.filter(value => value > 50).length,
    long_tasks: {
      count: longTasks.length,
      total_ms: round(longTasks.reduce((sum, value) => sum + value, 0)),
      duration_ms: summarizeDistribution(longTasks),
    },
    event_duration_ms: summarizeDistribution(eventDurations),
    layout_shift_score: round(Number(raw.layoutShiftScore) || 0, 5),
    heap_before_bytes: finiteOrNull(raw.heapBeforeBytes),
    heap_after_bytes: finiteOrNull(raw.heapAfterBytes),
    heap_delta_bytes:
      Number.isFinite(raw.heapBeforeBytes) && Number.isFinite(raw.heapAfterBytes)
        ? raw.heapAfterBytes - raw.heapBeforeBytes
        : null,
    dom_nodes_before: integerOrNull(raw.domNodesBefore),
    dom_nodes_after: integerOrNull(raw.domNodesAfter),
  };
}

export function summarizeDistribution(values) {
  if (values.length === 0) {
    return { count: 0, p50: null, p95: null, p99: null, max: null };
  }
  return {
    count: values.length,
    p50: round(nearestRank(values, 0.5)),
    p95: round(nearestRank(values, 0.95)),
    p99: round(nearestRank(values, 0.99)),
    max: round(Math.max(...values)),
  };
}

export async function loadScenario(path) {
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  return validateScenario(parsed, path);
}

export function validateScenario(input, source = '<scenario>') {
  if (!isRecord(input)) throw new Error(`${source}: scenario must be an object`);
  if (input.schema_version !== 1) {
    throw new Error(`${source}: unsupported schema_version ${String(input.schema_version)}`);
  }
  requireNonEmptyString(input.id, `${source}: id`);
  requireNonEmptyString(input.title, `${source}: title`);
  if (!Array.isArray(input.phases) || input.phases.length === 0) {
    throw new Error(`${source}: phases must be a non-empty array`);
  }
  const ids = new Set();
  for (const [index, phase] of input.phases.entries()) {
    if (!isRecord(phase)) throw new Error(`${source}: phases[${index}] must be an object`);
    requireNonEmptyString(phase.id, `${source}: phases[${index}].id`);
    requireNonEmptyString(phase.label, `${source}: phases[${index}].label`);
    if (ids.has(phase.id)) throw new Error(`${source}: duplicate phase id ${phase.id}`);
    ids.add(phase.id);
    if (!Number.isInteger(phase.settle_ms) || phase.settle_ms < 0) {
      throw new Error(`${source}: phase ${phase.id} settle_ms must be a non-negative integer`);
    }
    if (!Number.isInteger(phase.observe_ms) || phase.observe_ms < 0) {
      throw new Error(`${source}: phase ${phase.id} observe_ms must be a non-negative integer`);
    }
    validateAction(phase.action, `${source}: phase ${phase.id}`);
  }
  return input;
}

export function interpolate(value, fixture) {
  if (typeof value !== 'string') return value;
  return value.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (_match, key) => {
    const replacement = fixture[key];
    if (typeof replacement !== 'string' && typeof replacement !== 'number') {
      throw new Error(`fixture does not define ${key}`);
    }
    return String(replacement);
  });
}

function validateAction(action, label) {
  if (!isRecord(action)) throw new Error(`${label}: action must be an object`);
  const allowed = new Set([
    'navigate',
    'click',
    'type',
    'scroll',
    'sidebar',
    'sidebar-reverse',
    'manual',
  ]);
  if (!allowed.has(action.kind)) throw new Error(`${label}: unsupported action ${String(action.kind)}`);
  if (action.kind === 'navigate') requireNonEmptyString(action.path, `${label}: action.path`);
  if (action.kind === 'click' || action.kind === 'type' || action.kind === 'scroll') {
    requireNonEmptyString(action.selector, `${label}: action.selector`);
  }
  if (action.kind === 'type') requireNonEmptyString(action.text, `${label}: action.text`);
  if (action.kind === 'scroll' && !Number.isFinite(action.delta_y)) {
    throw new Error(`${label}: action.delta_y must be finite`);
  }
  if (action.kind === 'sidebar' || action.kind === 'sidebar-reverse') {
    if (action.sidebar !== 'workspace' && action.sidebar !== 'channel') {
      throw new Error(`${label}: action.sidebar must be workspace or channel`);
    }
    if (typeof action.visible !== 'boolean') {
      throw new Error(`${label}: action.visible must be boolean`);
    }
  }
  if (
    action.kind === 'sidebar-reverse' &&
    (!Number.isInteger(action.interval_ms) || action.interval_ms < 0)
  ) {
    throw new Error(`${label}: action.interval_ms must be a non-negative integer`);
  }
  if (action.kind === 'manual') requireNonEmptyString(action.instruction, `${label}: action.instruction`);
}

function finiteNumbers(values) {
  return Array.isArray(values) ? values.filter(Number.isFinite) : [];
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? round(value) : null;
}

function integerOrNull(value) {
  return Number.isInteger(value) ? value : null;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
