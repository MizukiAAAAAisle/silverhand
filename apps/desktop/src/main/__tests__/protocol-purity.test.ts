import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import desktopPackage from '../../../package.json';

const mainRoot = fileURLToPath(new URL('..', import.meta.url));
const preloadRoot = fileURLToPath(new URL('../../preload', import.meta.url));
const rendererRoot = fileURLToPath(new URL('../../renderer', import.meta.url));
const desktopRoot = fileURLToPath(new URL('../../../', import.meta.url));

const allowedBackendImports = [
  // D3.a Commit 4: the freshness predicate in `outbound-attach.ts`
  // takes a `HostWsAttachment | null` snapshot so its unit tests can
  // assert the predicate purely without spinning up the backend. The
  // type is structural (hostId / connectionId / attachedAt scalars)
  // and carries no runtime dependency. Adding it does NOT relax the
  // wider "desktop main does not import backend runtime" fence — only
  // a shape type crosses, never a function or class.
  'HostWsAttachment',
  // D3.c Commit 3: `outbound-reload.ts` is the Settings save
  // orchestrator and threads the same `HostWsAttachment` shape
  // through its `GetHostAttachmentFn` dep so the fresh-attach
  // watchdog after a `host_outbound_reload` IPC uses the same
  // predicate as the attach path. Same structural type, same
  // zero-runtime guarantee — second occurrence allowed for the
  // second consumer file.
  'HostWsAttachment',
  // D4.a Commit 5c-2: `profile-phase2.ts` is the profile-driven
  // sibling of `outbound-reload.ts` (§7.5 phase-2 orchestrator).
  // Same structural `HostWsAttachment` dep for the same fresh-attach
  // watchdog predicate — third occurrence allowed for the third
  // consumer file.
  'HostWsAttachment',
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
  'hosts:proxyConfig:get',
  'hosts:proxyConfig:set',
  'notification:show',
  // D4.a Commit 5c-2 — partial_apply_pending state machine IPC.
  // `partialApply:get` returns the in-memory state; `partialApply:retry`
  // re-runs phase-2 against the on-disk profile. Both are local
  // desktop UX concerns — NOT crossed into the wire / daemon protocol
  // per §7.6 (R4 boundary).
  'partialApply:get',
  'partialApply:retry',
  // D4.a Commit 2 — Setup Wizard / Settings server connection profile
  // IPC surface (see `main/index.ts` "D4.a Commit 2 — Server connection
  // profile IPC surface" block for the boundary discipline).
  'profile:clear',
  'profile:get',
  'profile:saveWithTest',
  'settings:saveServerUrl',
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

  it('bundles workspace server code into the desktop main build', () => {
    const config = readFileSync(
      join(desktopRoot, 'electron.vite.config.ts'),
      'utf8',
    );

    expect(config).toMatch(
      /const workspaceDeps = \[[\s\S]*'@silverhand\/server'[\s\S]*\];/,
    );
  });

  it('remote-only main build aliases @silverhand/server to a desktop-local stub', () => {
    const config = readFileSync(
      join(desktopRoot, 'electron.vite.config.ts'),
      'utf8',
    );
    const stub = readFileSync(
      join(mainRoot, 'remote-only-server-stub.ts'),
      'utf8',
    );

    expect(config).toMatch(/SILVERHAND_DESKTOP_REMOTE_ONLY/);
    expect(config).toMatch(/@silverhand\/server/);
    expect(config).toMatch(/remote-only-server-stub\.ts/);
    expect(stub).not.toMatch(/@silverhand\/server|@silverhand\/backend/);
    expect(stub).toMatch(/startEmbeddedSilverhandServer/);
    expect(stub).toMatch(/remote-only/);
  });

  it('remote-only package config excludes embedded backend/native runtime packages', () => {
    const config = readFileSync(
      join(desktopRoot, 'electron-builder.remote-only.yml'),
      'utf8',
    );
    const packageScript = readFileSync(
      join(desktopRoot, '../../scripts/package.sh'),
      'utf8',
    );
    const afterPackScript = readFileSync(
      join(desktopRoot, 'scripts/afterPack.cjs'),
      'utf8',
    );
    const remoteOnlyPackage = readFileSync(
      join(desktopRoot, 'package.remote-only.json'),
      'utf8',
    );

    expect(config).toMatch(/appId:\s*com\.silverhand\.desktop/);
    expect(config).toMatch(/productName:\s*Silverhand-remote-server/);
    expect(config).toMatch(/artifactName:\s*\$\{productName\}-\$\{version\}-\$\{arch\}\.\$\{ext\}/);
    expect(config).toMatch(/output:\s*release-remote-server/);
    for (const dep of [
      '@hono',
      'hono',
      'better-sqlite3',
      '@node-rs/argon2',
      '@node-rs/argon2-darwin-arm64',
    ]) {
      expect(config).toContain(`!node_modules/${dep}`);
    }
    expect(config).not.toMatch(/^asarUnpack:/m);
    expect(packageScript).toMatch(/--remote-only/);
    expect(packageScript).toMatch(/--server-url/);
    expect(packageScript).toMatch(/SILVERHAND_DESKTOP_REMOTE_ONLY/);
    expect(config).toMatch(/package\.remote-only\.json/);
    expect(remoteOnlyPackage).toContain('"zod"');
    expect(remoteOnlyPackage).not.toMatch(
      /@hono|hono|better-sqlite3|@node-rs\/argon2|@silverhand\/server|@silverhand\/backend/,
    );
    expect(afterPackScript).toMatch(/rewriteRemoteOnlyAsar/);
    expect(afterPackScript).toMatch(/SILVERHAND_DESKTOP_REMOTE_ONLY/);
    expect(afterPackScript).toMatch(/package\.remote-only\.json/);
    expect(afterPackScript).toMatch(/ElectronAsarIntegrity/);
  });

  it('keeps bundled workspace packages out of packaged app runtime dependencies', () => {
    const workspaceRuntimeDeps = Object.keys(desktopPackage.dependencies)
      .filter(name => name.startsWith('@silverhand/'))
      .sort();

    expect(workspaceRuntimeDeps).toEqual([]);
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

  // #task:1133 — embedded-only-source guard. Some signals are observable
  // ONLY inside the embedded backend process and are structurally
  // null/empty in a remote-server deployment (the registry lives in the
  // remote backend, not the desktop). Reading one without a remote second
  // source is the #task:1132 / #task:1010 bug class (a connected local
  // computer rendered offline). These two guards keep new consumers from
  // re-introducing it.
  it('every renderer local_host_ws_attached_at consumer also consults the remote availability fallback (#task:1132 class)', () => {
    // `local_host_ws_attached_at` is the in-process WS attach timestamp;
    // it is structurally null when the backend runs remotely. Any renderer
    // surface that derives connection/online state from it MUST also
    // consult host-status `availability` — directly, or via the
    // connection-state helpers (`isLocalHostAttached` /
    // `describeConnectionState`) / `useHostStatusQuery` that fold it in.
    // The #task:1132 bug was App.tsx mapping `attached_at === null`
    // straight to offline with no availability fallback. A new consumer
    // that does the same trips this guard; the fix is to route the
    // judgment through the helper, not to add the file here.
    const fallbackTokens =
      /\bavailability\b|\bisLocalHostAttached\b|\bdescribeConnectionState\b|\buseHostStatusQuery\b/;
    const offenders = sourceFiles(rendererRoot, new Set(['.ts', '.tsx']))
      .filter(source => source.content.includes('local_host_ws_attached_at'))
      .filter(source => !fallbackTokens.test(source.content))
      .map(source => source.path);

    expect(offenders).toEqual([]);
  });

  it('keeps main getEmbeddedHostWsController() call sites catalogued with remote-arm degrade semantics (#task:1133)', () => {
    // `getEmbeddedHostWsController()` returns null on the remote arm (no
    // in-process WS attachment registry). Every call site is an
    // observe/degrade path that handles the null arm (watchdog stays
    // un-armed; status comes from a renderer poll / typed claim error
    // instead of registry observation). The count is pinned so a NEW
    // consumer forces the author to confirm + document the remote-arm
    // degrade before it lands — the same review the #task:1132 class needs.
    // Catalogued sites in main/index.ts: local-host attach snapshot,
    // attach-watchdog arm, host_outbound_attach watchdog, save-URL verify
    // watchdog, profile phase-2 watchdog, shutdown detach.
    const callSites = sourceFiles(mainRoot, new Set(['.ts'])).flatMap(source =>
      [
        ...stripComments(source.content).matchAll(
          /(?<!function\s)getEmbeddedHostWsController\(\)/g,
        ),
      ].map(() => source.path),
    );

    expect(callSites.length).toBe(6);
  });
});
