/**
 * #task:2000 (option B) tripwire: `messages.content` is WRITE-ONCE.
 *
 * The wake path memoizes a message's addressing set by message id
 * (`src/runtime/reference-memo.ts`), and the only thing that makes that sound is
 * that a stored body never changes: `id → references` is then a pure function of
 * durable state, and the memo is an accelerator rather than a second authority.
 * An edit is modelled as a new row, so the derived answer is keyed to a new id.
 *
 * If message editing ever lands as an in-place `UPDATE messages … SET content`,
 * the memo would keep serving the OLD addressing set for the new body — the
 * question "does this batch address me" silently answered against text nobody
 * wrote any more. A main-line message is still delivered either way (that fanout
 * never reads references), so the failure is invisible: no error, no
 * wrong-looking output, just a recipient told the batch is somebody else's, or an
 * edit that aimed a message at someone and framed it as an undirected broadcast.
 * So the invariant gets a gate at the only place it can be checked mechanically —
 * the SQL itself.
 *
 * Scope: production sources only (`packages/backend/src`, `packages/shared/src`,
 * which owns the migrations). Tests are excluded on purpose: fixtures legitimately
 * rewrite `created_at` / `thread_root_id` to build histories, and a test that
 * rewrote `content` would be exercising a write face that this gate keeps from
 * existing in the first place.
 *
 * Remedy when this fires: do not add an allowlist entry. Either keep edits
 * append-only (new row, new id — the current model), or make the memo key carry a
 * content version and update `reference-memo.ts`'s soundness comment in the same
 * commit.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SCANNED_ROOTS = [
  resolve(REPO_ROOT, 'packages', 'backend', 'src'),
  resolve(REPO_ROOT, 'packages', 'shared', 'src'),
];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

/**
 * Each `UPDATE messages` statement, as the text from the keyword up to the
 * statement terminator. Bounded by `;` (SQL) or a backtick (end of a template
 * literal holding a single statement), so one statement's columns cannot be read
 * as another's.
 */
const UPDATE_MESSAGES_RE = /update\s+messages\b[^;`]*/gi;
/** A `content` column assigned in that statement's SET clause. */
const ASSIGNS_CONTENT_RE = /\bset\b[\s\S]*?\bcontent\s*=/i;
/** Any column assigned — used to tell real SQL from prose that names it. */
const ASSIGNS_ANY_COLUMN_RE = /\bset\s+\w+\s*=/i;

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

describe('messages.content is write-once (#task:2000 reference memo invariant)', () => {
  it('no production SQL assigns messages.content in an UPDATE', () => {
    const offenders: string[] = [];
    for (const root of SCANNED_ROOTS) {
      for (const file of walkSources(root)) {
        const text = readFileSync(file, 'utf8');
        for (const match of text.matchAll(UPDATE_MESSAGES_RE)) {
          if (ASSIGNS_CONTENT_RE.test(match[0])) {
            offenders.push(
              `${relative(REPO_ROOT, file)}: ${match[0].replace(/\s+/g, ' ').slice(0, 120)}`,
            );
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('finds the UPDATE statements that DO exist, so the scan is not vacuously green', () => {
    // Sensitivity check for the gate itself: the migrations rewrite other
    // columns (metadata, author_*), so a zero-match scan would mean the regex or
    // the roots drifted, not that the invariant holds. Counts only statements
    // that actually assign a column, so prose mentioning `UPDATE messages`
    // cannot keep this green on its own.
    let statements = 0;
    for (const root of SCANNED_ROOTS) {
      for (const file of walkSources(root)) {
        for (const match of readFileSync(file, 'utf8').matchAll(
          UPDATE_MESSAGES_RE,
        )) {
          if (ASSIGNS_ANY_COLUMN_RE.test(match[0])) statements += 1;
        }
      }
    }
    expect(statements).toBeGreaterThan(0);
  });
});
