import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mainRoot = fileURLToPath(new URL('..', import.meta.url));
const preloadRoot = fileURLToPath(new URL('../../preload', import.meta.url));
const rendererRoot = fileURLToPath(new URL('../../renderer', import.meta.url));

const allowedBackendImports = [
].sort();

const allowedServerImports = [
  'CategorizedLoggers',
  'FileLogger',
  'RunningBackend',
  'createCategorizedLoggers',
  'startEmbeddedSilverhandServer',
].sort();

const cataloguedIpcHandlers = [
  'active-conversation:set',
  'attachment:openExternal',
  'auth:getState',
  'auth:login',
  'auth:logout',
  'auth:signup',
  'backend:info',
  'backend:request',
  'backend:upload',
  'badge:setCount',
  'dialog:pickDirectory',
  'export:copyPng',
  'export:savePng',
  'hosts:revoke',
  'hosts:rotate',
  'notification:show',
  'shell:openExternal',
  'shell:showItemInFolder',
  'window:setAlwaysOnTop',
].sort();

interface SourceFile {
  path: string;
  content: string;
}

function sourceFiles(root: string, extensions: ReadonlySet<string>): SourceFile[] {
  const out: SourceFile[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') visit(fullPath);
        continue;
      }
      if (!entry.isFile() || /\.test\.tsx?$/.test(entry.name)) continue;
      const ext = entry.name.endsWith('.tsx') ? '.tsx' : entry.name.endsWith('.ts') ? '.ts' : '';
      if (!extensions.has(ext)) continue;
      out.push({ path: fullPath, content: readFileSync(fullPath, 'utf8') });
    }
  };
  visit(root);
  return out;
}

function stripComments(value: string): string {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function importedPackageSymbols(source: SourceFile, packageName: string): string[] {
  const escapedPackageName = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const symbols: string[] = [];
  const statements = source.content.matchAll(
    new RegExp(
      `import\\s+(?:type\\s+)?\\{([^;]*?)\\}\\s+from\\s+['"]${escapedPackageName}['"]`,
      'g',
    ),
  );
  for (const match of statements) {
    for (const part of stripComments(match[1] ?? '').split(',')) {
      const symbol = part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (symbol) symbols.push(symbol);
    }
  }
  const allBackendImports = [
    ...source.content.matchAll(
      new RegExp(
        `import\\s+[^;]*from\\s+['"]${escapedPackageName}(?:\\/[^'"]*)?['"]`,
        'g',
      ),
    ),
  ];
  const unsupportedBackendImports = [
    ...source.content.matchAll(
      new RegExp(
        `import\\s+(?:type\\s+)?(?:\\*\\s+as\\s+\\w+|[A-Za-z_$][\\w$]*(?:\\s*,\\s*(?:\\*\\s+as\\s+\\w+|\\{[^;]*\\}))?)\\s+from\\s+['"]${escapedPackageName}(?:\\/[^'"]*)?['"]`,
        'g',
      ),
    ),
    ...source.content.matchAll(
      new RegExp(
        `import\\s+['"]${escapedPackageName}(?:\\/[^'"]*)?['"]`,
        'g',
      ),
    ),
  ];
  if (unsupportedBackendImports.length > 0) {
    symbols.push(`UNPARSED:${source.path}`);
  }
  if (allBackendImports.length > 0 && symbols.length === 0) {
    symbols.push(`UNPARSED:${source.path}`);
  }
  return symbols;
}

describe('desktop protocol purity catalogue', () => {
  it('fails loud on unsupported backend import forms mixed with named imports', () => {
    const imports = importedPackageSymbols({
      path: 'example.ts',
      content: `
        import { startBackend } from '@silverhand/backend';
        import * as backend from '@silverhand/backend';
      `,
    }, '@silverhand/backend');

    expect(imports).toContain('startBackend');
    expect(imports).toContain('UNPARSED:example.ts');
  });

  it('keeps direct @silverhand/backend imports fenced to the embedded boot path allowlist', () => {
    const imports = sourceFiles(mainRoot, new Set(['.ts']))
      .flatMap(source => importedPackageSymbols(source, '@silverhand/backend'))
      .sort();

    expect(imports).toEqual(allowedBackendImports);
  });

  it('keeps direct @silverhand/server imports fenced to the embedded boot path allowlist', () => {
    const imports = sourceFiles(mainRoot, new Set(['.ts']))
      .flatMap(source => importedPackageSymbols(source, '@silverhand/server'))
      .sort();

    expect(imports).toEqual(allowedServerImports);
  });

  it('keeps main IPC handlers in sync with the protocol-purity catalogue', () => {
    const channels = sourceFiles(mainRoot, new Set(['.ts']))
      .flatMap(source =>
        [...source.content.matchAll(/ipcMain\.handle\(\s*['"`]([^'"`]+)['"`]/g)]
          .map(match => match[1]),
      )
      .sort();

    expect(channels).toEqual(cataloguedIpcHandlers);
  });

  it('keeps renderer code from importing backend internals directly', () => {
    const offenders = sourceFiles(rendererRoot, new Set(['.ts', '.tsx']))
      .filter(source =>
        /from\s+['"]@silverhand\/backend(?:\/[^'"]*)?['"]/.test(source.content),
      )
      .map(source => source.path);

    expect(offenders).toEqual([]);
  });

  it('contains no renderer-facing BackendInfo auth_token consumers', () => {
    const offenders = [
      ...sourceFiles(preloadRoot, new Set(['.ts'])),
      ...sourceFiles(rendererRoot, new Set(['.ts', '.tsx'])),
    ]
      .filter(source => /\bauth_token\b|\.auth_token\b/.test(source.content))
      .map(source => source.path);

    expect(offenders).toEqual([]);
  });
});
