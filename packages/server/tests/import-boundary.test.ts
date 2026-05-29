import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const serverSrcRoot = fileURLToPath(new URL('../src', import.meta.url));

interface SourceFile {
  path: string;
  content: string;
}

function sourceFiles(root: string): SourceFile[] {
  const out: SourceFile[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.ts')) {
        out.push({ path: fullPath, content: readFileSync(fullPath, 'utf8') });
      }
    }
  };
  visit(root);
  return out;
}

describe('standalone server import boundary', () => {
  it('keeps the package/server entrypoint free of host and desktop imports', () => {
    const offenders = sourceFiles(serverSrcRoot)
      .filter(source =>
        /from\s+['"](?:@silverhand\/host|electron|.*spawn-prep|.*workspace-files|.*apps\/desktop)/.test(
          source.content,
        ) ||
        /from\s+['"]node:os['"]/.test(source.content) ||
        /\bprocess\.cwd\s*\(/.test(source.content),
      )
      .map(source => source.path);

    expect(offenders).toEqual([]);
  });
});
