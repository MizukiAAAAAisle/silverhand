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

// Guard #2 (#task:1244): conversation FOCUS is also a passive surface, so it
// must not drain notification read_at either. The old focus-effect bug wrote
// `read_at` for the focused conversation on focus alone (no cursor advance),
// silently evicting cursor-unread @me mentions. We fence both ends of that
// wiring at source level (node test env, no RTL):
//   - the activity-source hook (`features/app-shell/activity-source.ts`, split
//     out of App.tsx in #task:1291) must keep EXACTLY ONE
//     `markConversationNotificationsRead.mutate` call — the active
//     activity-source-open (paired with a cursor→head advance, self-consistent).
//   - App.tsx must never call the drain DIRECTLY — it only threads the mutation
//     into the hook. A re-introduced focus-drain in the shell would show up here.
//   - the focus selector (`secondary-pane.ts`) must never wire that mutation.
describe('conversation focus surface — must not drain notification read_at', () => {
  const appSource = readFileSync(
    fileURLToPath(new URL('../../App.tsx', import.meta.url)),
    'utf8',
  );
  const activitySourceHook = readFileSync(
    fileURLToPath(
      new URL('../app-shell/activity-source.ts', import.meta.url),
    ),
    'utf8',
  );
  const focusSelectorSource = readFileSync(
    fileURLToPath(new URL('../../lib/secondary-pane.ts', import.meta.url)),
    'utf8',
  );
  const DRAIN_CALL = 'markConversationNotificationsRead.mutate';

  it('the activity-source hook invokes the notification drain exactly once — the active source-open', () => {
    const calls =
      activitySourceHook.match(/markConversationNotificationsRead\.mutate\(/g) ?? [];
    expect(calls).toHaveLength(1);
    // The sole survivor must be the cursor→head-paired activity-source-open, not
    // a focus-keyed call. If this literal changes, re-verify it is still active.
    expect(activitySourceHook).toContain(`${DRAIN_CALL}(activitySourceReadChannelId)`);
  });

  it('App.tsx never invokes the notification drain directly (no focus-drain)', () => {
    // The shell threads the mutation into useActivitySource as a prop but must
    // never call `.mutate` itself — a re-introduced focus-drain lands here.
    expect(appSource).not.toContain(`${DRAIN_CALL}(`);
  });

  it('the focus selector never wires the notification drain', () => {
    expect(focusSelectorSource).not.toContain(DRAIN_CALL);
  });
});
