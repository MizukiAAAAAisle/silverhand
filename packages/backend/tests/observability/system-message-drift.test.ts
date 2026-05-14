/**
 * Drift guard for system message subtypes.
 *
 * Two invariants kept honest by static source scanning:
 *
 *   1. Every `systemSubtype('…')` and `taskSystemSubtype('…')` literal
 *      argument inside `packages/backend/src/**` maps to an entry in
 *      `SYSTEM_SUBTYPES` (with `taskSystemSubtype(kind)` expanding to
 *      `task_${kind}` first). A producer using a name not in the
 *      registry fails CI.
 *
 *   2. Every `SYSTEM_SUBTYPES` entry has at least one producer in
 *      `packages/backend/src/**`. A registry entry with no producer
 *      fails CI — either delete the entry or wire up the producer.
 *
 * The grep is deliberately literal-only: producers must pass a string
 * literal through the helper (`systemSubtype('mention_cc')`,
 * `taskSystemSubtype('claim')`). Dynamic call sites (`systemSubtype(x)`
 * with a non-literal `x`) are not supported and would be invisible to
 * this drift test — by convention we don't allow them.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  SYSTEM_SUBTYPES,
  TASK_MUTATION_KINDS,
  TASK_SUBTYPES,
} from '@silverhand/shared';

const BACKEND_SRC = join(__dirname, '..', '..', 'src');

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkTsFiles(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

const SYSTEM_SUBTYPE_CALL = /\bsystemSubtype\(\s*['"]([a-z_][a-z0-9_]*)['"]\s*\)/g;
const TASK_SUBTYPE_CALL =
  /\btaskSystemSubtype\(\s*['"]([a-z_][a-z0-9_]*)['"]\s*\)/g;
const TASK_SUBTYPE_DYNAMIC =
  /\btaskSystemSubtype\(\s*[A-Za-z_][A-Za-z0-9_.]*\s*\)/g;

interface ProducerHit {
  file: string;
  match: string;
  arg: string;
}

function scanProducers(): {
  current: ProducerHit[];
  taskKinds: ProducerHit[];
  /** Dynamic taskSystemSubtype calls, e.g. `taskSystemSubtype(args.kind)`.
   *  These can't be statically derived to a single subtype, but their
   *  presence signals task-subtype producers exist; the test treats them
   *  as covering ALL TASK_SUBTYPES (since the kind union is closed). */
  dynamicTaskCalls: ProducerHit[];
} {
  const current: ProducerHit[] = [];
  const taskKinds: ProducerHit[] = [];
  const dynamicTaskCalls: ProducerHit[] = [];
  for (const file of walkTsFiles(BACKEND_SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(SYSTEM_SUBTYPE_CALL)) {
      current.push({ file, match: m[0]!, arg: m[1]! });
    }
    for (const m of text.matchAll(TASK_SUBTYPE_CALL)) {
      taskKinds.push({ file, match: m[0]!, arg: m[1]! });
    }
    // Re-scan for dynamic call shape; the literal regex above already
    // consumed string-arg calls, so any remaining `taskSystemSubtype(...)`
    // here uses a non-literal argument.
    const literalCount = (text.match(/\btaskSystemSubtype\(\s*['"]/g) ?? []).length;
    const totalCount =
      (text.match(/\btaskSystemSubtype\(/g) ?? []).length;
    if (totalCount > literalCount) {
      for (const m of text.matchAll(TASK_SUBTYPE_DYNAMIC)) {
        dynamicTaskCalls.push({ file, match: m[0]!, arg: '<dynamic>' });
      }
    }
  }
  return { current, taskKinds, dynamicTaskCalls };
}

describe('system message subtype drift guard', () => {
  const producers = scanProducers();

  it('every systemSubtype(…) literal arg is in SYSTEM_SUBTYPES', () => {
    const known = new Set<string>(SYSTEM_SUBTYPES);
    for (const hit of producers.current) {
      expect(
        known.has(hit.arg),
        `producer ${hit.file} writes systemSubtype('${hit.arg}') — not in SYSTEM_SUBTYPES`,
      ).toBe(true);
    }
  });

  it('every taskSystemSubtype(…) literal arg is in TASK_MUTATION_KINDS', () => {
    const known = new Set<string>(TASK_MUTATION_KINDS);
    for (const hit of producers.taskKinds) {
      expect(
        known.has(hit.arg),
        `producer ${hit.file} writes taskSystemSubtype('${hit.arg}') — not in TASK_MUTATION_KINDS`,
      ).toBe(true);
    }
  });

  it('every SYSTEM_SUBTYPES entry has at least one backend producer', () => {
    // Build the producer-known set: literal `systemSubtype(...)` args
    // plus everything implied by `taskSystemSubtype(...)` (literal kinds
    // expand to `task_${kind}`; dynamic calls are treated as covering
    // every `TASK_SUBTYPES` entry since the kind union is closed).
    const produced = new Set<string>();
    for (const hit of producers.current) produced.add(hit.arg);
    for (const hit of producers.taskKinds) produced.add(`task_${hit.arg}`);
    if (producers.dynamicTaskCalls.length > 0) {
      for (const ts of TASK_SUBTYPES) produced.add(ts);
    }

    const orphans: string[] = [];
    for (const subtype of SYSTEM_SUBTYPES) {
      if (!produced.has(subtype)) orphans.push(subtype);
    }
    expect(
      orphans,
      `SYSTEM_SUBTYPES entries with no producer: ${orphans.join(', ')}`,
    ).toEqual([]);
  });

  it('found at least one producer (sanity check — drift guard isn\'t silently empty)', () => {
    const total =
      producers.current.length +
      producers.taskKinds.length +
      producers.dynamicTaskCalls.length;
    expect(total, 'no systemSubtype/taskSystemSubtype calls scanned').toBeGreaterThan(0);
  });
});
