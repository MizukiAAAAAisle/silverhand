import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Transport-brand cast fence (docs/brand-typed-seq-v1.md §4 / §8).
 *
 * `TransportSeq` / `TransportEpoch` are nominal brands. There are exactly two
 * legal ways to obtain one in `backend/src/ws/`:
 *   1. decode at a validated boundary — `decodeTransportSeq` / `decodeTransportEpoch`
 *      (inbound ResumeFrame is the only such site today), or
 *   2. advance an existing TransportSeq through the single named `+1` boundary
 *      `advanceTransportSeq`,
 * and thereafter the brand flows through already-branded surfaces (the
 * ScopeEventBus epoch/seq → ReplayEntry / ScopedEvent → wire frames) with no
 * re-branding at all.
 *
 * A bare `as TransportSeq` / `as TransportEpoch` cast would bypass both
 * boundaries and silently re-admit an unvalidated / cross-space number. This
 * fence makes that a compile-of-the-suite failure rather than a review catch —
 * the "no `as` hatch" bar is structural, not disciplinary.
 */
describe('transport-brand cast fence (backend/src/ws)', () => {
  const wsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'ws');
  // Matches `as TransportSeq`, `as TransportEpoch`, and the `as unknown as …`
  // double-cast escape hatch. Whitespace-tolerant.
  const CAST = /\bas\s+(?:unknown\s+as\s+)?Transport(?:Seq|Epoch)\b/;

  it('has zero bare `as TransportSeq` / `as TransportEpoch` casts in src/ws', () => {
    const offenders: string[] = [];
    for (const entry of readdirSync(wsDir)) {
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
      const full = join(wsDir, entry);
      const src = readFileSync(full, 'utf8');
      src.split('\n').forEach((line, i) => {
        if (CAST.test(line)) {
          offenders.push(`${relative(wsDir, full)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
