import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Handler-layer ordering fence for the jump seam (#task:2052, @Paul P1).
//
// `resolveJumpNav` decides WHAT a jump does; this fence locks WHEN the handler
// acts on it. `requestJump(params)` is not a pure prime: it POSTs `markRead`
// (an irreversible server write that clears the conversation's unread) and
// stashes a `jumpTarget`. So a `fail-closed` jump — a workspace-less target the
// pair list has not answered — must return ABOVE `requestJump`, or it clears an
// unread and leaves a dangling target for a conversation it then refuses to
// open (worse than the wrong-place jump this ticket removed: silent, and state
// still changed). Symmetrically, the inline-find exemption (`isInlineFind`)
// must return BELOW `requestJump`, because priming is its entire function and a
// DM inline find is workspace-less — hoisting it above the prime would strand
// it during any pair-list refetch.
//
// This is a SEQUENCE property of a handler that closes over `nav`, `requestJump`
// and query state, and the desktop test env is `node` (no jsdom/RTL) — so, like
// the sibling `useBoard.viewer-scope.test.ts` fence, it asserts source order.
// The marker guards fail loudly (not vacuously at index -1) if an anchor is
// renamed, which is the point: a refactor that reorders these must update the
// fence deliberately.

describe('handleJumpToMessage: fail-closed does zero side effects; inline find still primes', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./App.tsx', import.meta.url)),
    'utf8',
  );

  const HANDLER = 'const handleJumpToMessage = (params: MessageJumpTarget)';
  const PRIME = 'requestJump(params);';
  const FAIL_CLOSED = "if (jumpNav === 'fail-closed') return false;";
  const INLINE_FIND_RETURN = 'if (isInlineFind) return false;';

  it('has exactly one prime call and one fail-closed guard to reason about', () => {
    expect(source.split(PRIME)).toHaveLength(2);
    expect(source.split(FAIL_CLOSED)).toHaveLength(2);
    expect(source.split(INLINE_FIND_RETURN)).toHaveLength(2);
  });

  it('returns fail-closed BEFORE priming (no markRead, no stashed jumpTarget)', () => {
    const handlerAt = source.indexOf(HANDLER);
    expect(handlerAt).toBeGreaterThanOrEqual(0);
    const body = source.slice(handlerAt);
    const failClosedAt = body.indexOf(FAIL_CLOSED);
    const primeAt = body.indexOf(PRIME);
    expect(failClosedAt).toBeGreaterThanOrEqual(0);
    expect(primeAt).toBeGreaterThanOrEqual(0);
    expect(failClosedAt).toBeLessThan(primeAt);
  });

  it('runs the inline-find exemption AFTER priming (priming is its function)', () => {
    const handlerAt = source.indexOf(HANDLER);
    const body = source.slice(handlerAt);
    const inlineReturnAt = body.indexOf(INLINE_FIND_RETURN);
    const primeAt = body.indexOf(PRIME);
    expect(inlineReturnAt).toBeGreaterThanOrEqual(0);
    expect(primeAt).toBeGreaterThanOrEqual(0);
    expect(primeAt).toBeLessThan(inlineReturnAt);
  });
});
