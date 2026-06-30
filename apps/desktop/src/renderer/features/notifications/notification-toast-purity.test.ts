import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Guard #1 (#task:1244): a toast is a transient SURFACING event, never an
// eliminate intent. Under Activity v1 `notifications.read_at` is the
// load-bearing directed-claim signal, so if the toast effect auto-wrote
// `read_at` it would silently evict an unread @me from Activity before the
// user acted on it (the dalaran "unread but Activity empty" bug). Re-toast
// dedup is owned by the in-memory `seenIds` set, NOT by read-state — so the
// notification must stay unread until an ACTIVE eliminate path clears it.
//
// The desktop test env is `node` (no jsdom/RTL), so we cannot render the hook
// and assert no network call. Instead — in the spirit of `protocol-purity` —
// we statically fence the toast hook's source: it must not POST to the
// notification-read endpoint. The fence is SCOPED to `useNotificationToasts`
// because the same file legitimately exports `useMarkNotificationsRead` (the
// notification-panel's EXPLICIT mark-read = an active surface, allowed).

const READ_ENDPOINT = '/api/notifications/read';

function sliceFunctionBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  if (start === -1) {
    throw new Error(`could not find "${declaration}" — was the hook renamed?`);
  }
  // The hook ends where the next top-level function declaration begins.
  const rest = source.slice(start + declaration.length);
  const nextDecl = rest.search(/\n(?:export )?function /);
  return nextDecl === -1 ? rest : rest.slice(0, nextDecl);
}

describe('notification toast surface — surfaced ≠ eliminated', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./hooks.ts', import.meta.url)),
    'utf8',
  );

  it('useNotificationToasts never writes notifications.read_at (no auto-read on toast)', () => {
    const body = sliceFunctionBody(source, 'export function useNotificationToasts(');
    expect(body).not.toContain(READ_ENDPOINT);
  });

  it('the explicit useMarkNotificationsRead mutation still owns the read endpoint', () => {
    // Sanity: we only fenced the PASSIVE surface. The explicit (active) mark-read
    // mutation must keep its legitimate call — otherwise the fence above is
    // trivially "passing" because the whole capability was deleted.
    const body = sliceFunctionBody(source, 'export function useMarkNotificationsRead(');
    expect(body).toContain(READ_ENDPOINT);
  });
});
