/**
 * #task:2035 — the producer/consumer fence for "a DirectPair that comes into
 * existence is announced" (@Cindy's boundary 2, corrected by her B4).
 *
 * WHAT IT DEFENDS, and why a runtime test cannot. `tests/routes/direct-pairs.test.ts`
 * proves that the doors that exist TODAY announce the pair they opened. The failure
 * mode that outlives those tests is a SECOND way to mint one — the human-initiated
 * "Message this agent" door (#task:2036) is the known one — reaching the row
 * without the announcement. No test of today's doors goes red for that, and the
 * symptom is the exact bug #task:2035 fixed: a row a cold `GET /api/direct-pairs`
 * shows and a live client never learns about.
 *
 * THE FIRST VERSION OF THIS FENCE DID NOT PROVE IT, and the correction is the
 * reason the file reads the way it does. It counted mint calls and calls of an
 * `announceDeliveryTargetAllocation` helper that ONE route funnel invoked. @Cindy's
 * mutation: add a production wrapper that just forwards to `resolveDeliveryTarget`.
 * It mints through the allowed resolver site, never reaches the funnel, and both
 * counts stay unchanged — 3/3 green over a pair nobody hears about. The hole was
 * not in the scanner: the invariant itself was "the callers happen to be right",
 * which no scanner can close.
 *
 * So the announcement moved INTO the mint, as a required port on the resolver
 * ({@link DeliveryTargetAllocationPort}), and the remaining static obligation is
 * the one a compiler cannot state: THAT PORT HAS EXACTLY ONE PRODUCTION
 * IMPLEMENTATION, THE ONE THAT PUBLISHES. A hand-rolled `{ directPairOpened() {} }`
 * — the shape a door in a hurry reaches for — fails this gate, and the author is
 * made to answer where its announcement comes from.
 *
 * Both directions are asserted for each set, because each miss is a different
 * silent hole: an UNEXPECTED site is an unannounced (or differently announced) pair,
 * and a MISSING expected site means the mint or the announcement was moved while
 * every allowlist entry still reads as if it were in force.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const backendRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(backendRoot, '..', '..');

/** Every production source root a mint could hide in. The renderer is included on
 *  purpose: #task:2036's door is a UI entry point, and "the client opens the pair by
 *  calling the repo" must fail here rather than in review. */
const PRODUCTION_ROOTS = [
  join(repoRoot, 'packages/shared/src'),
  join(repoRoot, 'packages/backend/src'),
  join(repoRoot, 'packages/host/src'),
  join(repoRoot, 'packages/cli/src'),
  join(repoRoot, 'packages/server/src'),
  join(repoRoot, 'apps/desktop/src'),
];

/**
 * A CALL of the mint, not a mention of it.
 *
 * `\.` is what makes it a call through an object (the repo, or the resolver's port):
 * the method DEFINITION in `conversation-repo.ts` and the port MEMBER in
 * `delivery-target-resolution.ts` are declarations and are not matched, while the
 * trailing `\(` keeps prose like "ConversationRepo.getOrCreateDirectPair derives
 * `created` from …" out of the offender list. Comments are not stripped: a commented
 * -out call is still a call someone is about to restore, and the reason line costs
 * nothing.
 */
const MINT_CALL = /\.getOrCreateDirectPair\s*\(/;

/**
 * The allocation obligation, by the name only its implementers and its one caller
 * can avoid spelling.
 *
 * Any mention, not just a call: an implementation writes `directPairOpened:` or
 * `directPairOpened(id) {`, and a forwarder writes `.directPairOpened(`. All three
 * are the thing being fenced, so the pattern is the bare identifier and the
 * allowlist below is what carries the distinction.
 */
const OBLIGATION = /\bdirectPairOpened\b/;

/**
 * Where a pair may be minted, and why each site is allowed to.
 *
 * The value is the REASON, not a checkbox: an entry that cannot state how its
 * announcement happens is an entry that should not be here.
 */
const ALLOWED_MINT_SITES: Record<string, string> = {
  'packages/backend/src/repos/delivery-target-persistence.ts':
    'the resolver PORT wiring — passes the repo method through, adds no new caller',
  'packages/backend/src/application/delivery-target-resolution.ts':
    'the ONE allocating arm; announces through `ports.allocations` in the same breath',
};

/**
 * Who may name the obligation. TWO files, and the shape of the list is the
 * invariant: one declaration-and-caller, one implementation.
 *
 * A third entry is the thing this gate exists to stop — a second implementation is
 * an announcement nobody wired, and a second caller is an announcement for a row
 * that did not just come into existence. Note that the PORT WIRING
 * (`delivery-target-persistence.ts`) is deliberately absent: it composes the
 * implementation through `directPairAllocationPort(...)`, so its appearance here
 * would mean someone inlined a second announcer beside the real one.
 */
const ALLOWED_OBLIGATION_SITES: Record<string, string> = {
  'packages/backend/src/application/delivery-target-resolution.ts':
    'DECLARES the port and CALLS it, from the allocating arm, when the row was created',
  'packages/backend/src/application/direct-pairs-changed.ts':
    'the ONE implementation: publishes `direct_pairs_changed` to the pair’s human participants',
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') ? [path] : [];
  });
}

function filesMatching(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const root of PRODUCTION_ROOTS) {
    for (const file of sourceFiles(root)) {
      if (pattern.test(readFileSync(file, 'utf8'))) {
        hits.push(relative(repoRoot, file));
      }
    }
  }
  return hits.sort();
}

describe('direct-pair open is announced (#task:2035 producer/consumer fence)', () => {
  it('mints a DirectPair only inside the arm that announces it', () => {
    expect(filesMatching(MINT_CALL)).toEqual(Object.keys(ALLOWED_MINT_SITES).sort());
  });

  it('has exactly one implementation of the allocation obligation', () => {
    expect(filesMatching(OBLIGATION)).toEqual(
      Object.keys(ALLOWED_OBLIGATION_SITES).sort(),
    );
  });

  it('proves the scanners see a new mint / a second announcer instead of passing vacuously', () => {
    // A #task:2036-shaped bypass: a human door opening the line itself, and a door
    // satisfying the obligation with a port of its own that publishes nothing.
    const bypass = `
      const opened = this.conversations.getOrCreateDirectPair(me, them, now);
      const allocations = { directPairOpened: () => {} };
    `;
    expect(MINT_CALL.test(bypass)).toBe(true);
    expect(OBLIGATION.test(bypass)).toBe(true);

    // …and that the mint pattern does not fire on a DECLARATION or a MENTION, which
    // is what would make the allowlists above quietly wrong in the other direction.
    const declarationsAndProse = `
      getOrCreateDirectPair(a: X, b: X, now: number): Opened;
      // ConversationRepo.getOrCreateDirectPair derives created from the row count.
    `;
    expect(MINT_CALL.test(declarationsAndProse)).toBe(false);
  });
});
