import { open, readdir } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import type { MemoryNoteCatalogEntry, MemoryNotesCatalog } from '@silverhand/shared';
import { parseDocument } from 'yaml';
import { z } from 'zod';

const MEMORY_NOTE_FRONTMATTER_READ_CAP_BYTES = 16 * 1024;
const MEMORY_NOTES_CATALOG_MAX_ENTRIES = 20;

const MemoryNoteFrontmatterSchema = z
  .object({
    name: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    description: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((value) => !/[\r\n\u0085\u2028\u2029]/u.test(value)),
    metadata: z
      .object({
        category: z.enum(['user', 'feedback', 'project']),
      })
      .passthrough(),
  })
  .passthrough();

type ParsedNote = { kind: 'entry'; entry: MemoryNoteCatalogEntry } | { kind: 'skip' };

/**
 * Build the current L2 note catalog from daemon-local files. The server never
 * receives note paths, metadata, or bodies. Symlinks are skipped so recursive
 * enumeration cannot escape the agent-owned notes directory.
 */
export async function readMemoryNotesCatalog(l2Dir: string): Promise<MemoryNotesCatalog> {
  const notesDir = join(l2Dir, 'notes');
  const paths = await collectMarkdownFiles(notesDir);
  paths.sort();

  const entries: MemoryNoteCatalogEntry[] = [];
  const declaredNames = new Set<string>();

  for (const absolutePath of paths) {
    const catalogPath = toCatalogPath(l2Dir, absolutePath);
    const parsed = await readCatalogNote(absolutePath, catalogPath);
    if (parsed.kind === 'skip') continue;
    if (declaredNames.has(parsed.entry.name)) continue;
    declaredNames.add(parsed.entry.name);
    entries.push(parsed.entry);
  }

  return {
    entries: entries.slice(0, MEMORY_NOTES_CATALOG_MAX_ENTRIES),
    omittedCount: Math.max(0, entries.length - MEMORY_NOTES_CATALOG_MAX_ENTRIES),
  };
}

async function collectMarkdownFiles(dir: string): Promise<string[]> {
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const paths: string[] = [];
  for (const dirent of dirents) {
    const absolutePath = join(dir, dirent.name);
    if (dirent.isSymbolicLink()) continue;
    if (dirent.isDirectory()) {
      paths.push(...(await collectMarkdownFiles(absolutePath)));
    } else if (dirent.isFile() && extname(dirent.name).toLowerCase() === '.md') {
      paths.push(absolutePath);
    }
  }
  return paths;
}

async function readCatalogNote(absolutePath: string, catalogPath: string): Promise<ParsedNote> {
  let text: string;
  try {
    text = await readPrefix(absolutePath, MEMORY_NOTE_FRONTMATTER_READ_CAP_BYTES);
  } catch {
    return { kind: 'skip' };
  }

  const body = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const lines = body.split(/\r?\n/u);
  if (lines[0]?.trim() !== '---') return { kind: 'skip' };

  const closingLine = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (closingLine < 0) {
    return { kind: 'skip' };
  }

  let rawFrontmatter: unknown;
  try {
    const document = parseDocument(lines.slice(1, closingLine).join('\n'), {
      schema: 'core',
      uniqueKeys: true,
    });
    if (document.errors.length > 0) throw new Error('invalid YAML');
    rawFrontmatter = document.toJS({ maxAliasCount: 0 });
  } catch {
    return { kind: 'skip' };
  }
  const frontmatter = MemoryNoteFrontmatterSchema.safeParse(rawFrontmatter);
  if (!frontmatter.success) return { kind: 'skip' };

  return {
    kind: 'entry',
    entry: {
      path: catalogPath,
      name: frontmatter.data.name,
      description: frontmatter.data.description,
      category: frontmatter.data.metadata.category,
    },
  };
}

async function readPrefix(path: string, capBytes: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(capBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, capBytes + 1, 0);
    let cut = Math.min(bytesRead, capBytes);
    while (cut > 0 && buffer[cut] !== undefined && (buffer[cut]! & 0xc0) === 0x80) {
      cut -= 1;
    }
    return buffer.subarray(0, cut).toString('utf8');
  } finally {
    await handle.close();
  }
}

function toCatalogPath(l2Dir: string, absolutePath: string): string {
  return relative(l2Dir, absolutePath).split(sep).join('/');
}
