import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const backendSrcRoot = fileURLToPath(new URL('../src', import.meta.url));

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
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      out.push({ path: fullPath, content: readFileSync(fullPath, 'utf8') });
    }
  };
  visit(root);
  return out;
}

describe('legacy viewer_user_id bridge tripwire', () => {
  it('keeps backend src from reintroducing current-viewer settings bridges', () => {
    const forbidden =
      /\bgetViewerUserId\b|\bbridgeLegacyViewer|settings\.set\(\s*SETTINGS_KEYS\.VIEWER_USER_ID/;
    const offenders = sourceFiles(backendSrcRoot)
      .filter(source => forbidden.test(source.content))
      .map(source => source.path);

    expect(offenders).toEqual([]);
  });
});
