import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readMemoryNotesCatalog } from '../src/daemon/memory-notes-catalog.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeL2(): string {
  const root = mkdtempSync(join(tmpdir(), 'silverhand-memory-catalog-'));
  roots.push(root);
  mkdirSync(join(root, 'notes'), { recursive: true });
  return root;
}

function indexedNote(args: {
  name: string;
  description: string;
  category?: 'user' | 'feedback' | 'project';
}): string {
  return [
    '---',
    `name: ${args.name}`,
    `description: ${args.description}`,
    'metadata:',
    `  category: ${args.category ?? 'project'}`,
    '  source: agent-authored',
    'tags: [memory]',
    '---',
    '# Body',
    'Not injected.',
  ].join('\n');
}

describe('readMemoryNotesCatalog', () => {
  it('indexes recursive valid frontmatter and ignores unindexed files and symlinks', async () => {
    const l2 = makeL2();
    mkdirSync(join(l2, 'notes', 'domain'), { recursive: true });
    writeFileSync(
      join(l2, 'notes', 'user-preferences.md'),
      indexedNote({
        name: 'user-preferences',
        description: 'Communication and review preferences; read before proposing work.',
        category: 'user',
      }),
    );
    writeFileSync(
      join(l2, 'notes', 'domain', 'legacy.md'),
      '# Legacy Runtime Notes\n\nExisting content stays unchanged.',
    );
    writeFileSync(
      join(l2, 'notes', 'domain', 'runtime.md'),
      indexedNote({ name: 'runtime', description: 'Read before runtime work.' }),
    );
    writeFileSync(join(l2, 'notes', 'ignored.txt'), '# Not Markdown');
    const outside = join(l2, 'outside.md');
    writeFileSync(outside, indexedNote({ name: 'outside', description: 'no' }));
    symlinkSync(outside, join(l2, 'notes', 'linked.md'));

    await expect(readMemoryNotesCatalog(l2)).resolves.toEqual({
      entries: [
        {
          path: 'notes/domain/runtime.md',
          name: 'runtime',
          description: 'Read before runtime work.',
          category: 'project',
        },
        {
          path: 'notes/user-preferences.md',
          name: 'user-preferences',
          description: 'Communication and review preferences; read before proposing work.',
          category: 'user',
        },
      ],
      omittedCount: 0,
    });
  });

  it('silently omits invalid frontmatter, duplicate names, and unindexed files', async () => {
    const l2 = makeL2();
    writeFileSync(
      join(l2, 'notes', 'a.md'),
      indexedNote({ name: 'same-name', description: 'First valid note.' }),
    );
    writeFileSync(
      join(l2, 'notes', 'b.md'),
      indexedNote({ name: 'same-name', description: 'Duplicate name.' }),
    );
    writeFileSync(
      join(l2, 'notes', 'broken.md'),
      indexedNote({ name: 'Broken Name', description: 'Invalid name only.' }),
    );
    writeFileSync(
      join(l2, 'notes', 'missing-metadata.md'),
      '---\nname: valid-name\ndescription: missing metadata\n---\n# Broken',
    );
    writeFileSync(join(l2, 'notes', 'malformed.md'), '---\nname: [unterminated\n---\n# Malformed');
    writeFileSync(
      join(l2, 'notes', 'too-long.md'),
      indexedNote({
        name: 'too-long',
        description: 'x'.repeat(201),
      }),
    );
    writeFileSync(join(l2, 'notes', 'legacy.md'), 'No frontmatter; omitted.');

    const catalog = await readMemoryNotesCatalog(l2);

    expect(catalog.entries).toEqual([
      {
        path: 'notes/a.md',
        name: 'same-name',
        description: 'First valid note.',
        category: 'project',
      },
    ]);
    expect(catalog.omittedCount).toBe(0);
  });

  it('caps injected entries while reporting the omitted count', async () => {
    const l2 = makeL2();
    for (let index = 0; index <= 20; index += 1) {
      writeFileSync(
        join(l2, 'notes', `note-${String(index).padStart(3, '0')}.md`),
        indexedNote({
          name: `note-${String(index).padStart(3, '0')}`,
          description: `Read before working on note surface ${index}.`,
        }),
      );
    }

    const catalog = await readMemoryNotesCatalog(l2);

    expect(catalog.entries).toHaveLength(20);
    expect(catalog.omittedCount).toBe(1);
  });
});
