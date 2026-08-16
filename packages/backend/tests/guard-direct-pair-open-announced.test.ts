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
 * So the announcement moved INTO the mint, as a required port ({@link
 * DirectPairOpenedPort}) on the one operation both doors funnel through
 * (`openDirectPair`, extracted to its own module for #task:2036 precisely because
 * the human door is that second caller). The remaining static obligation is the
 * one a compiler cannot state: THAT PORT HAS EXACTLY ONE PRODUCTION
 * IMPLEMENTATION, THE ONE THAT PUBLISHES. A hand-rolled `{ directPairOpened() {} }`
 * — the shape a door in a hurry reaches for — fails this gate, and the author is
 * made to answer where its announcement comes from.
 *
 * Both directions are asserted for each set, because each miss is a different
 * silent hole: an UNEXPECTED site is an unannounced (or differently announced) pair,
 * and a MISSING expected site means the mint or the announcement was moved while
 * every allowlist entry still reads as if it were in force.
 *
 * A SECOND correction, same shape as the first (@Cindy #task:2036). The fence once
 * reduced each file to a boolean — "does a mint appear here" — so a second mint
 * added to an ALREADY-ALLOWED file (a new exported helper in `open-direct-pair.ts`
 * that get-or-creates again without announcing) left every assertion green while
 * reintroducing the exact hole. The allowlist now carries a per-file SITE COUNT:
 * both a same-file second site and a new file trip it, and the patterns exclude
 * declarations and prose so the counts cannot be padded into silence.
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
 * can avoid spelling — counted as SITES, not files.
 *
 * A definition or a call, not a prose mention: an implementation writes
 * `directPairOpened(id) {` or `directPairOpened: (id) =>`, a declaration writes
 * `directPairOpened(conversationId): void`, and a caller writes `.directPairOpened(`
 * — all end the identifier with `(` or `:`. A docblock that merely NAMES the port
 * (`the directPairOpened obligation`, `{@link DirectPairOpenedPort}`) has neither
 * and is not counted, so the per-file count below cannot be inflated by prose into
 * hiding a real second site.
 */
const OBLIGATION = /directPairOpened\s*[(:]/;

/**
 * Where a pair may be minted, HOW MANY TIMES each site may name it, and why.
 *
 * The count is the invariant, not just the file: an entry that cannot state how
 * its announcement happens should not be here, and a site that mints once more
 * than declared is the hole this gate exists to stop.
 */
const ALLOWED_MINT_SITES: Record<string, { count: number; reason: string }> = {
  'packages/backend/src/repos/delivery-target-persistence.ts': {
    count: 2,
    reason:
      'the PORT wiring for BOTH doors — the resolver bag and the human-door bag each forward the repo method into a `DirectPairMintPort`, adding no new caller',
  },
  'packages/backend/src/application/open-direct-pair.ts': {
    count: 1,
    reason:
      'the ONE mint operation both doors funnel through; announces through `ports.allocations` in the same breath',
  },
};

/**
 * Who may name the obligation, and HOW MANY TIMES. TWO files, and the shape of the
 * counts is the invariant: one declaration-and-caller (2 sites — the port member
 * plus the single call from the mint), one implementation (1 site).
 *
 * A third file, or one extra site in either of these, is the thing this gate stops
 * — a second implementation is an announcement nobody wired, and a second caller
 * is an announcement for a row that did not just come into existence. The PORT
 * WIRING (`delivery-target-persistence.ts`) is deliberately absent: it composes the
 * implementation through `directPairAllocationPort(...)`, so its appearance here
 * would mean someone inlined a second announcer beside the real one.
 */
const ALLOWED_OBLIGATION_SITES: Record<string, { count: number; reason: string }> = {
  'packages/backend/src/application/open-direct-pair.ts': {
    count: 2,
    reason:
      'DECLARES the port member and CALLS it, from the one mint operation, when the row was created',
  },
  'packages/backend/src/application/direct-pairs-changed.ts': {
    count: 1,
    reason:
      'the ONE implementation: publishes `direct_pairs_changed` to the pair’s human participants',
  },
};

/** Occurrences of `pattern` in one blob — the counting primitive both the site
 *  fence and its own sensitivity meta-test run through, so a second same-file site
 *  is a `2`, not a re-confirmed `true`. */
function countIn(content: string, pattern: RegExp): number {
  return (content.match(new RegExp(pattern.source, 'g')) ?? []).length;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') ? [path] : [];
  });
}

/** Per-file site counts across every production root, `{}` entries omitted. */
function siteCounts(pattern: RegExp): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const root of PRODUCTION_ROOTS) {
    for (const file of sourceFiles(root)) {
      const n = countIn(readFileSync(file, 'utf8'), pattern);
      if (n > 0) counts[relative(repoRoot, file)] = n;
    }
  }
  return counts;
}

/** The declared shape, `{file: count}`, to compare `siteCounts` against. */
function expectedCounts(
  sites: Record<string, { count: number }>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(sites).map(([file, { count }]) => [file, count]),
  );
}

describe('direct-pair open is announced (#task:2035 producer/consumer fence)', () => {
  it('mints a DirectPair only at the pinned sites, and only as many times as declared', () => {
    expect(siteCounts(MINT_CALL)).toEqual(expectedCounts(ALLOWED_MINT_SITES));
  });

  it('names the allocation obligation only at the pinned sites, and only as many times as declared', () => {
    expect(siteCounts(OBLIGATION)).toEqual(expectedCounts(ALLOWED_OBLIGATION_SITES));
  });

  it('counts a SECOND same-file site instead of collapsing it to a boolean', () => {
    // The #task:2036-shaped bypass @Cindy proved: a second exported function in an
    // ALREADY-ALLOWED file that get-or-creates again without announcing. A file-
    // membership fence stays green (the file is still "allowed"); a site COUNT goes
    // to 2 and trips, because the allowlist declares exactly one mint there.
    const secondMintSameFile = `
      export function openDirectPair(...) {
        const opened = ports.conversations.getOrCreateDirectPair(x, y, now);
        if (opened.created) ports.allocations.directPairOpened(opened.conversation.id);
        return opened.conversation;
      }
      export function openDirectPairSneakily(...) {
        return ports.conversations.getOrCreateDirectPair(x, y, now).conversation; // no announce
      }
    `;
    expect(countIn(secondMintSameFile, MINT_CALL)).toBe(2);
    expect(countIn(secondMintSameFile, OBLIGATION)).toBe(1);

    // A DECLARATION and PROSE inflate neither count: the method definition has no
    // leading `.`, and a docblock that only names the port has no `(`/`:` after it —
    // which is what keeps the per-file counts above from being padded into silence.
    const declarationsAndProse = `
      getOrCreateDirectPair(a: X, b: X, now: number): Opened;
      // ConversationRepo.getOrCreateDirectPair derives created from the row count.
      // The directPairOpened obligation travels with the mint; see {@link DirectPairOpenedPort}.
    `;
    expect(countIn(declarationsAndProse, MINT_CALL)).toBe(0);
    expect(countIn(declarationsAndProse, OBLIGATION)).toBe(0);
  });
});
