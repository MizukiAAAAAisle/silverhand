/**
 * #task:2014 tripwire: `AgentRepo.create` is FIXTURE-ONLY.
 *
 * WHAT IT DEFENDS, AND WHAT IT USED TO. Until #task:2072 the claim was aggregate
 * shape: an Agent was the `agents` row PLUS its inbox placement, `create()` wrote
 * only the row, so an agent born through it had no destination for a mention of
 * its handle. That subject is gone — the CC copies into the AUTHOR's direct pair
 * with the agent, which a bare row is enough to mint, so a row on its own is now a
 * complete Agent.
 *
 * The gate survives its own premise because a SECOND reason was always underneath
 * it, and that one is untouched: `create()` writes `materialization_status`
 * DEFAULT — `'active'` — and no `idempotency_key`. Both halves are harmful in
 * production and neither is visible to the type checker:
 *
 *   - `'active'` is what every read face and the runtime lane treat as "this agent
 *     was materialized" (`ACTIVE_ONLY`). A row written here had no L2 dispatch, so
 *     no daemon ever built its home — an agent that is live to every viewer and
 *     has nothing on disk behind it.
 *   - no `idempotency_key` means no `findByIdempotencyKey` short-circuit, so the
 *     retry of a POST that timed out mid-flight creates a SECOND agent instead of
 *     returning the first.
 *
 * `create()` survives only because 70-odd fixtures use it to get a row cheaply and
 * do not care about either property. That is a test-side convenience, so this gate
 * pins the half that matters: no production module may call it. Scope is
 * production sources only (`packages/backend/src`).
 *
 * Remedy when this fires: do not add an allowlist entry. Go through
 * `AgentProvisioningPersistence.reserveAgentRow` and the materialize lifecycle —
 * if the new caller genuinely wants a row that is born active and unkeyed (an
 * import path, a repair tool), that is a new named operation whose docblock has to
 * say who materialized the thing it is declaring live.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const PRODUCTION_ROOT = resolve(REPO_ROOT, 'packages', 'backend', 'src');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

/** `<receiver>.create(` where the receiver names an AgentRepo binding. Matches
 *  the naming every module already uses for it (`agents`, `agentRepo`,
 *  `this.agents`, `deps.agents`), which is what a real new caller would write. */
const AGENT_CREATE_CALL_RE =
  /\b(?:this\.|deps\.)?(?:agents|agentRepo|agentsRepo)\s*\.\s*create\s*\(/g;

function* walkSources(root: string): Generator<string> {
  for (const entry of readdirSync(root)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const abs = join(root, entry);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      yield* walkSources(abs);
      continue;
    }
    const dot = entry.lastIndexOf('.');
    if (!SOURCE_EXTENSIONS.has(dot < 0 ? '' : entry.slice(dot))) continue;
    yield abs;
  }
}

describe('AgentRepo.create is fixture-only (#task:2014 lifecycle invariant)', () => {
  it('no production module calls it', () => {
    const offenders: string[] = [];
    for (const file of walkSources(PRODUCTION_ROOT)) {
      // The declaration itself lives here; the gate is about CALLERS.
      if (file.endsWith(join('repos', 'agent-repo.ts'))) continue;
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(AGENT_CREATE_CALL_RE)) {
        offenders.push(`${relative(REPO_ROOT, file)}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the pattern still matches the fixtures that DO call it, so the scan is not vacuous', () => {
    // Sensitivity check for the regex, not for production: if a rename made
    // `agents.create(` unmatchable, the assertion above would go green for the
    // wrong reason. Tests are the population that legitimately calls it.
    let calls = 0;
    for (const file of walkSources(resolve(REPO_ROOT, 'packages', 'backend', 'tests'))) {
      for (const _ of readFileSync(file, 'utf8').matchAll(AGENT_CREATE_CALL_RE)) {
        calls += 1;
      }
    }
    expect(calls).toBeGreaterThan(0);
  });

  // A THIRD case used to live here and was deleted with the aggregate (#task:2072),
  // not merely re-pointed. It read the adapter as text to assert that the factory
  // paired `reserveForMaterialize` with `insertAgentInbox`, and then that nobody
  // outside the port declaration and the adapter named the bare reserve — because a
  // direct caller "would silently recreate the inbox-less row". There is no such row
  // any more: the reserve is one INSERT, and a hypothetical direct
  // `deps.agents.reserveForMaterialize(…)` from `create-agent.ts` (whose type is in
  // scope, so nothing but review stops it) writes exactly what the port writes. What
  // remains is a ports-discipline preference with no failure mode behind it, and a
  // fence that pins one of those teaches the next reader that an invariant is being
  // defended when none is. Should the reserve ever grow a second effect, the fence to
  // write is over THAT pairing, not over the name.
});
