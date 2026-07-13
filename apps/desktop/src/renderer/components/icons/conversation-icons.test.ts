import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MessageSquare } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { ThreadIcon } from './conversation-icons';

/**
 * Invariant: "Thread" is one product concept with ONE glyph, defined once in
 * the SSOT, and every surface that shows a thread — list, detail header,
 * collapse toggle, a message's thread entry / reply badge, a quoted thread
 * reference, the activity thread-root — imports `ThreadIcon`, never a raw lucide
 * glyph. The source-message locate (`ExternalLink`) and NavRail's Chat tab glyph
 * (the compound `MessagesSquare`) are separate concepts, not thread consumers.
 */

function readSource(relFromHere: string): string {
  return readFileSync(fileURLToPath(new URL(relFromHere, import.meta.url)), 'utf8');
}

/** Every name imported from `lucide-react` across ALL such imports in the
 *  file — a single `match` would miss a raw glyph parked in a second
 *  `from 'lucide-react'` import, silently passing the fence. */
function lucideImportedNames(src: string): string[] {
  const names: string[] = [];
  for (const m of src.matchAll(
    /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'lucide-react'/g,
  )) {
    const group = m[1];
    if (!group) continue;
    for (const n of group.split(',').map(s => s.trim()).filter(Boolean)) {
      names.push(n);
    }
  }
  return names;
}

describe('conversation-icons — the single Thread glyph', () => {
  it('ThreadIcon is exactly MessageSquare (guards a silent swap)', () => {
    expect(ThreadIcon).toBe(MessageSquare);
  });
});

describe('lucideImportedNames — aggregates every lucide import', () => {
  it('catches a raw glyph parked in a SECOND lucide-react import', () => {
    const src = [
      "import { X } from 'lucide-react';",
      "import { ThreadIcon } from '@/components/icons/conversation-icons';",
      "import { MessageSquare } from 'lucide-react';",
    ].join('\n');
    const names = lucideImportedNames(src);
    // A single `match` would stop at `{ X }` and miss this — the fence must
    // still see the stale glyph in the second import.
    expect(names).toContain('MessageSquare');
    expect(names).toContain('X');
  });
});

describe('every thread consumer routes through the ThreadIcon SSOT', () => {
  // A consumer must never hand-roll a thread bubble by importing the raw glyph —
  // the SSOT owns it. `MessageSquare` (the thread glyph) is banned in these
  // files; the compound `MessagesSquare` too (NavRail's tab has no home here).
  // Other action glyphs (`CornerUpLeft` etc.) are NOT banned, so a future
  // genuine Reply action isn't blocked by this Thread SSOT test. The affordances
  // themselves are locked by an exact `<ThreadIcon` count.
  const BANNED_RAW_GLYPHS = ['MessageSquare', 'MessagesSquare'];
  const STALE_ALIASES = ['ThreadIdentityIcon', 'ThreadsCollectionIcon'];

  // The count of thread affordances each surface renders — bump intentionally
  // when a surface gains or loses one. A mismatch means either a new thread
  // affordance skipped the SSOT or an existing one was dropped.
  const CONSUMERS: Array<{ name: string; src: string; threadIcons: number }> = [
    { name: 'ChannelView (thread header + collapse toggle + "thread of")', src: readSource('../layout/ChannelView.tsx'), threadIcons: 3 },
    { name: 'ChannelThreadsPanel (list header + empty state)', src: readSource('../layout/ChannelThreadsPanel.tsx'), threadIcons: 2 },
    { name: 'ThreadPanel (thread detail header)', src: readSource('../layout/ThreadPanel.tsx'), threadIcons: 1 },
    { name: 'MessageItem (top-right Thread entry + collapsed reply badge)', src: readSource('../chat/MessageItem.tsx'), threadIcons: 2 },
    { name: 'QuotedMessagePreview ("thread from")', src: readSource('../chat/QuotedMessagePreview.tsx'), threadIcons: 1 },
    { name: 'ActivityView (thread-root summary)', src: readSource('../layout/ActivityView.tsx'), threadIcons: 1 },
  ];

  for (const { name, src, threadIcons } of CONSUMERS) {
    it(`${name} renders ${threadIcons} ThreadIcon(s), never a raw bubble glyph or stale alias`, () => {
      const names = lucideImportedNames(src);
      for (const glyph of BANNED_RAW_GLYPHS) {
        expect(names).not.toContain(glyph);
      }
      for (const alias of STALE_ALIASES) {
        expect(src).not.toContain(alias);
      }
      const uses = src.match(/<ThreadIcon\b/g)?.length ?? 0;
      expect(uses).toBe(threadIcons);
    });
  }
});
