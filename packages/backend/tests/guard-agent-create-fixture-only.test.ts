/**
 * #task:2014 (v71 §4.2) tripwire: `AgentRepo.create` is FIXTURE-ONLY.
 *
 * An Agent is the `agents` row PLUS its inbox placement, and the only writer of
 * that pair is `AgentProvisioningPersistence.reserveAgentAggregate`
 * (`AgentRepo.reserveForMaterialize` + `ConversationRepo.insertAgentInbox` in one
 * transaction). `create()` writes the bare row, so an agent born through it has
 * no destination for a mention of its handle — and because the CC now runs INSIDE
 * the sender's message transaction (§5), the failure would not land on the agent:
 * `requireAgentInbox` throws `AgentInboxMissingError` and aborts a HUMAN's send.
 * `getByName` has no `materialization_status` filter, so the handle is reachable
 * the instant the row exists; there is no window in which a row-without-inbox is
 * merely incomplete rather than harmful.
 *
 * `create()` survives only because 70-odd fixtures use it to get a row cheaply,
 * and most of them never touch a CC or inbox read face. That is a test-side
 * convenience, so this gate pins the half that matters: no production module may
 * call it. Scope is production sources only (`packages/backend/src`).
 *
 * Remedy when this fires: do not add an allowlist entry. Call
 * `reserveAgentAggregate` — if the new caller genuinely wants a row with no
 * aggregate (an import path, a repair tool), that is a new named operation whose
 * docblock has to say what answers a mention of its handle.
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

describe('AgentRepo.create is fixture-only (#task:2014 aggregate invariant)', () => {
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

  it('the one production writer of the aggregate pairs the row with an inbox', () => {
    // The positive half: `reserveForMaterialize` reaches production through the
    // aggregate factory only, and that factory inserts the inbox. Read as text
    // because the claim is about the SHAPE of the composition — a future edit
    // that dropped the inbox insert would still typecheck and still pass every
    // behavioral test that does not mention an inbox.
    const adapter = readFileSync(
      resolve(PRODUCTION_ROOT, 'repos', 'agent-provisioning-persistence.ts'),
      'utf8',
    );
    const factory = adapter.slice(adapter.indexOf('reserveAgentAggregate'));
    expect(factory).toContain('reserveForMaterialize');
    expect(factory).toContain('insertAgentInbox');

    const callers: string[] = [];
    for (const file of walkSources(PRODUCTION_ROOT)) {
      if (file.endsWith(join('repos', 'agent-repo.ts'))) continue;
      // The two modules that legitimately name it: the port DECLARATION and the
      // adapter that implements the aggregate factory around it.
      if (file.endsWith(join('application', 'agent-provisioning-ports.ts'))) continue;
      if (file.endsWith(join('repos', 'agent-provisioning-persistence.ts'))) continue;
      if (readFileSync(file, 'utf8').includes('reserveForMaterialize(')) {
        callers.push(relative(REPO_ROOT, file));
      }
    }
    // Nothing outside that pair may reach the bare reserve — in particular
    // `create-agent.ts`, which used to call it directly and would silently
    // recreate the inbox-less row if it ever did again.
    expect(callers).toEqual([]);
  });
});
