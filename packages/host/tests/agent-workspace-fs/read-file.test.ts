import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentWorkspaceFsError,
  MAX_PREVIEW_BYTES,
  readAgentWorkspaceFile,
} from '../../src/daemon/agent-workspace-fs/index.js';
import { agentHomeWorkspaceId } from '@silverhand/shared';
import { AgentWorkspaceFileReadParamsSchema } from '../../src/protocol.js';

/**
 * Integration tests for the new `agent_workspace_file_read` daemon
 * handler (#task:811). Cases covered:
 *  - normal read (system_prompt + nested notes/foo.md), echoes the
 *    canonical virtual path back in the result.
 *  - read cap → `truncated: true` with the in-band suffix. Every size
 *    here is derived from the exported `MAX_PREVIEW_BYTES` so raising
 *    the cap doesn't silently turn a boundary case into a small file.
 *  - shape-bad inputs → `forbidden_path` (no I/O).
 *  - symlink leaf or intermediate → `forbidden_path`.
 *  - missing leaf / intermediate → `not_found`.
 *  - asking for a directory → `not_found`.
 *  - HARD fs failure (chmod 000 leaf) → `fs_unavailable`.
 *
 * relocation-v1 §7 task 4 (registry demotion): a regular workspace resolves
 * PURELY by its deterministic agent-centric coordinate — no registry is
 * constructed or consulted (the deps type has no `registry` field). A
 * never-materialized bundle is an ordinary fs absence (`not_found`), never a
 * `workspace_not_provisioned` refusal.
 */

const AGENT_ID = 'aid-read-file';

let homeDir = '';
function agentDir(): string {
  return join(homeDir, '.silverhand', 'agents', AGENT_ID);
}
/** The deterministic agent-centric L2 bundle dir for a regular workspace —
 *  `<agent home>/workspaces/<workspace_id>` (relocation-v1 §3.2). No registry
 *  provision; the coordinate is always computable. */
function l2BundleDir(workspaceId = 'ws_1'): string {
  return join(agentDir(), 'workspaces', workspaceId);
}

describe('readAgentWorkspaceFile', () => {
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'shrf-home-'));
  });
  afterEach(() => {
    try {
      rmSync(homeDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('reads a top-level file and echoes the virtual path', async () => {
    const dir = agentDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'MEMORY.md'), 'i remember');

    const r = await readAgentWorkspaceFile(
      { agent_id: AGENT_ID, path: 'MEMORY.md' },
      { homeDir },
    );
    expect(r.ok).toBe(true);
    expect(r.file.path).toBe('MEMORY.md');
    expect(r.file.content).toBe('i remember');
    expect(r.file.truncated).toBe(false);
    expect(r.file.size).toBe('i remember'.length);
  });

  it('reads from a scoped regular workspace L2 bundle by deterministic coordinate — zero registry', async () => {
    const home = agentDir();
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'MEMORY.md'), 'home memory');

    // Bundle materialized at the deterministic coordinate (as first spawn
    // would do) — NO registry provision.
    const scoped = l2BundleDir();
    mkdirSync(scoped, { recursive: true });
    writeFileSync(join(scoped, 'MEMORY.md'), 'workspace memory');

    const r = await readAgentWorkspaceFile(
      { agent_id: AGENT_ID, workspace_id: 'ws_1', path: 'MEMORY.md' },
      { homeDir },
    );
    expect(r.file.content).toBe('workspace memory');
  });

  it('resolves an agent-home workspace id back to home without consulting the registry', async () => {
    const dir = agentDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'system_prompt.md'), 'l1 prompt');

    const r = await readAgentWorkspaceFile(
      {
        agent_id: AGENT_ID,
        workspace_id: agentHomeWorkspaceId(AGENT_ID),
        path: 'system_prompt.md',
      },
      { homeDir },
    );
    expect(r.file.content).toBe('l1 prompt');
  });

  it('resolves a regular workspace with ZERO registry — a pure-DB-created workspace whose bundle first-spawn materialized reads by coordinate (relocation-v1 §7-4 falsifier)', async () => {
    // Model the U4 end-state: the workspace was created as a pure DB write
    // (no `workspace_provision`, no registry binding anywhere), then its
    // bundle was materialized at first spawn. The read must resolve purely by
    // the deterministic agent-centric coordinate. No registry is constructed;
    // if the resolver still consulted one it would fail-closed here.
    const scoped = l2BundleDir('ws_pure_db');
    mkdirSync(scoped, { recursive: true });
    writeFileSync(join(scoped, 'MEMORY.md'), 'l2');

    const r = await readAgentWorkspaceFile(
      { agent_id: AGENT_ID, workspace_id: 'ws_pure_db', path: 'MEMORY.md' },
      { homeDir },
    );
    expect(r.file.content).toBe('l2');
  });

  it('a never-materialized regular workspace file read degrades to not_found — NOT a workspace_not_provisioned refusal (relocation-v1 §7-4)', async () => {
    // The coordinate is always computable; a bundle that was never spawned is
    // an ordinary filesystem absence, so reading a file inside it is a plain
    // `not_found` rather than a fail-closed 409. No registry, no provisioning.
    await expect(
      readAgentWorkspaceFile(
        {
          agent_id: AGENT_ID,
          workspace_id: 'ws_never_spawned',
          path: 'MEMORY.md',
        },
        { homeDir },
      ),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('reads a nested file via virtual path with `/` separator', async () => {
    const dir = agentDir();
    mkdirSync(join(dir, 'notes'), { recursive: true });
    writeFileSync(join(dir, 'notes', 'work-log.md'), '## entry');

    const r = await readAgentWorkspaceFile(
      { agent_id: AGENT_ID, path: 'notes/work-log.md' },
      { homeDir },
    );
    expect(r.ok).toBe(true);
    expect(r.file.content).toBe('## entry');
  });

  it('caps a large file at the preview cap and marks it truncated', async () => {
    const dir = agentDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'MEMORY.md'), 'x'.repeat(MAX_PREVIEW_BYTES + 500));
    const r = await readAgentWorkspaceFile(
      { agent_id: AGENT_ID, path: 'MEMORY.md' },
      { homeDir },
    );
    expect(r.file.truncated).toBe(true);
    expect(r.file.content).toContain('(truncated;');
    // size reflects the real on-disk size, not the capped preview length.
    expect(r.file.size).toBe(MAX_PREVIEW_BYTES + 500);
  });

  it('does not slurp the entire file: bounded read at the syscall layer', async () => {
    // Cindy round-1 P1 #1 — the cap must be a RESOURCE bound, not
    // just a response truncation. We patch `fs.promises.readFile` to
    // flag if it ever runs (the new implementation uses `open` +
    // bounded `read`); a regression that re-introduces `fs.readFile`
    // would trip this test instead of silently slurping a multi-GB
    // file. Patching goes through `node:fs.promises` (a plain object)
    // rather than the `node:fs/promises` ESM namespace (read-only
    // bindings, can't reassign).
    const dir = agentDir();
    mkdirSync(dir, { recursive: true });
    // Comfortably over the cap so we can prove the truncated arm fires
    // AND that metadata reflects the on-disk size, not the bytes read.
    const big = 'a'.repeat(MAX_PREVIEW_BYTES + 64 * 1024);
    writeFileSync(join(dir, 'MEMORY.md'), big);

    const fs = await import('node:fs');
    const original = fs.promises.readFile;
    let readFileCalled = false;
    fs.promises.readFile = ((...args: unknown[]) => {
      readFileCalled = true;
      return (original as (...a: unknown[]) => unknown)(...args);
    }) as typeof fs.promises.readFile;
    try {
      const r = await readAgentWorkspaceFile(
        { agent_id: AGENT_ID, path: 'MEMORY.md' },
        { homeDir },
      );
      expect(readFileCalled).toBe(false);
      expect(r.file.truncated).toBe(true);
      expect(r.file.size).toBe(big.length);
      // Preview content stays at the cap + suffix; never the full file.
      expect(
        r.file.content.length,
      ).toBeLessThanOrEqual(MAX_PREVIEW_BYTES + 200 /* suffix headroom */);
    } finally {
      fs.promises.readFile = original;
    }
  });

  it('reads exactly MAX bytes without flagging truncated', async () => {
    // Boundary: a file whose size === MAX must NOT be marked truncated.
    // The "+1" extra read returns exactly MAX bytes, not MAX+1.
    const dir = agentDir();
    mkdirSync(dir, { recursive: true });
    const exact = 'b'.repeat(MAX_PREVIEW_BYTES);
    writeFileSync(join(dir, 'MEMORY.md'), exact);
    const r = await readAgentWorkspaceFile(
      { agent_id: AGENT_ID, path: 'MEMORY.md' },
      { homeDir },
    );
    expect(r.file.truncated).toBe(false);
    expect(r.file.size).toBe(exact.length);
    expect(r.file.content).toBe(exact);
  });

  it('flags truncated for a file exactly MAX+1 bytes long; preview is the first MAX bytes verbatim', async () => {
    // Cindy round-2 P2 — a single-shot `read(MAX+1)` could return
    // SHORT (signal / partial cache / FUSE) on a regular file, leaving
    // bytesRead < MAX even when the on-disk size is > MAX. The
    // implementation now uses a loop AND drives `truncated` from
    // `lstat.size`, so a one-byte-over file flips the flag and slices
    // exactly the first MAX bytes of real content (NOT
    // `Buffer.allocUnsafe`'s tail) into the preview.
    const dir = agentDir();
    mkdirSync(dir, { recursive: true });
    const oneOver = 'c'.repeat(MAX_PREVIEW_BYTES + 1);
    writeFileSync(join(dir, 'MEMORY.md'), oneOver);
    const r = await readAgentWorkspaceFile(
      { agent_id: AGENT_ID, path: 'MEMORY.md' },
      { homeDir },
    );
    expect(r.file.truncated).toBe(true);
    expect(r.file.size).toBe(oneOver.length);
    // Preview MUST start with exactly the first MAX bytes of file
    // content — proves we sliced what we read, not unread tail of
    // `allocUnsafe`. End MUST be the truncation suffix.
    expect(r.file.content.startsWith('c'.repeat(MAX_PREVIEW_BYTES))).toBe(true);
    expect(r.file.content.endsWith('(truncated;')).toBe(false); // suffix has trailing chars after
    expect(r.file.content).toContain('(truncated;');
    // Preview length is bounded: MAX preview bytes + suffix headroom.
    expect(r.file.content.length).toBeLessThanOrEqual(MAX_PREVIEW_BYTES + 200);
  });

  it('survives short reads: forcing the first read syscalls to return 1 byte at a time still fills the preview', async () => {
    // Cindy round-2 P2 — even under short-read pressure (filesystem
    // returning 1 byte per `read(2)` call), the loop must accumulate
    // MAX_PREVIEW_BYTES + 1 bytes (or hit EOF) and the truncation flag
    // must come from `lstat.size`, NOT a single syscall's return. We
    // simulate by wrapping `fs.promises.open` to override the returned
    // FileHandle's `read` method.
    const dir = agentDir();
    mkdirSync(dir, { recursive: true });
    // Over the cap, so the preview is the first MAX bytes verbatim and
    // the flag is lstat-driven. Pattern lets us assert byte-exact.
    const total = MAX_PREVIEW_BYTES + 6 * 1024;
    const big = 'd'.repeat(total);
    writeFileSync(join(dir, 'MEMORY.md'), big);

    const fs = await import('node:fs');
    const origOpen = fs.promises.open;
    fs.promises.open = (async (...args: Parameters<typeof origOpen>) => {
      const handle = await origOpen(...args);
      const origRead = handle.read.bind(handle);
      // Force the FIRST calls to return 1 byte each, then let the real
      // syscall through. One byte per call for the whole cap would be
      // half a million awaits; the bug this guards (trusting a single
      // `read`'s `bytesRead`) is already exposed by the first short
      // return, and the tail proves the loop resumes full-length reads
      // from the right offset.
      const SHORT_CALLS = 16;
      let call = 0;
      // (typed loosely: FileHandle.read is overloaded — `Parameters<…>`
      // only sees the options-form overload. The production caller
      // hits the positional overload, which is what we wrap here.)
      (handle as unknown as {
        read: (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) => Promise<{ bytesRead: number; buffer: Buffer }>;
      }).read = async (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => {
        call += 1;
        const r = await (
          origRead as unknown as (
            buf: Buffer,
            off: number,
            len: number,
            pos: number,
          ) => Promise<{ bytesRead: number; buffer: Buffer }>
        )(buffer, offset, call <= SHORT_CALLS ? 1 : length, position);
        return r;
      };
      return handle;
    }) as typeof origOpen;
    try {
      const r = await readAgentWorkspaceFile(
        { agent_id: AGENT_ID, path: 'MEMORY.md' },
        { homeDir },
      );
      expect(r.file.truncated).toBe(true); // lstat-driven, not bytesRead-driven
      expect(r.file.size).toBe(total);
      expect(r.file.content.startsWith('d'.repeat(MAX_PREVIEW_BYTES))).toBe(
        true,
      );
      expect(r.file.content).toContain('(truncated;');
    } finally {
      fs.promises.open = origOpen;
    }
  });

  it.each([
    'system_prompt.md/', // trailing slash
    '/MEMORY.md', // leading slash
    'notes/../etc/passwd', // dot-dot in middle
    '../etc/passwd', // dot-dot at start
    'notes/.', // dot leaf
    '.git/config', // dotfile intermediate
    'notes/.gitkeep', // dotfile leaf
    'notes/foo\\bar.md', // backslash
  ])('rejects shape-bad input %j as forbidden_path', async path => {
    const dir = agentDir();
    mkdirSync(dir, { recursive: true });
    await expect(
      readAgentWorkspaceFile(
        { agent_id: AGENT_ID, path },
        { homeDir },
      ),
    ).rejects.toMatchObject({ code: 'forbidden_path' });
  });

  it('rejects empty string at the wire schema boundary (path: z.string().min(1))', () => {
    // The intent params schema enforces `min(1)`, so an empty string
    // never reaches the handler. We pin the wire-side guard so a
    // future schema relax can't leak an empty path to the resolver.
    const r = AgentWorkspaceFileReadParamsSchema.safeParse({
      agent_id: AGENT_ID,
      path: '',
    });
    expect(r.success).toBe(false);
  });

  it('refuses a leaf symlink even when the target exists inside the base', async () => {
    const dir = agentDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'real.md'), 'real');
    symlinkSync(join(dir, 'real.md'), join(dir, 'link.md'));

    await expect(
      readAgentWorkspaceFile(
        { agent_id: AGENT_ID, path: 'link.md' },
        { homeDir },
      ),
    ).rejects.toMatchObject({ code: 'forbidden_path' });
  });

  it('refuses an intermediate symlink (caught by per-segment lstat walk)', async () => {
    const dir = agentDir();
    mkdirSync(join(dir, 'real-notes'), { recursive: true });
    writeFileSync(join(dir, 'real-notes', 'inner.md'), 'inner');
    symlinkSync(join(dir, 'real-notes'), join(dir, 'notes'));

    await expect(
      readAgentWorkspaceFile(
        { agent_id: AGENT_ID, path: 'notes/inner.md' },
        { homeDir },
      ),
    ).rejects.toMatchObject({ code: 'forbidden_path' });
  });

  it('returns not_found for a missing leaf', async () => {
    const dir = agentDir();
    mkdirSync(dir, { recursive: true });
    await expect(
      readAgentWorkspaceFile(
        { agent_id: AGENT_ID, path: 'MEMORY.md' },
        { homeDir },
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('returns not_found for a missing intermediate dir', async () => {
    const dir = agentDir();
    mkdirSync(dir, { recursive: true });
    await expect(
      readAgentWorkspaceFile(
        { agent_id: AGENT_ID, path: 'notes/a.md' },
        { homeDir },
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('returns not_found when the resolved path is a directory', async () => {
    const dir = agentDir();
    mkdirSync(join(dir, 'notes'), { recursive: true });
    await expect(
      readAgentWorkspaceFile(
        { agent_id: AGENT_ID, path: 'notes' },
        { homeDir },
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses when the agent home dir itself is a symlink (forbidden_path)', async () => {
    // Same root-symlink guard the tree handler uses — both endpoints
    // share `resolveAgentHomeBase`. Cindy round-1 P1 #2.
    const outside = mkdtempSync(join(tmpdir(), 'shrf-symbase-'));
    try {
      writeFileSync(join(outside, 'leak.md'), 'never');
      const dir = agentDir();
      mkdirSync(join(homeDir, '.silverhand', 'agents'), { recursive: true });
      symlinkSync(outside, dir);

      await expect(
        readAgentWorkspaceFile(
          { agent_id: AGENT_ID, path: 'leak.md' },
          { homeDir },
        ),
      ).rejects.toMatchObject({ code: 'forbidden_path' });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('fails closed with fs_unavailable on a HARD read error', async () => {
    if (process.getuid?.() === 0) return; // root bypasses perms
    const dir = agentDir();
    mkdirSync(dir, { recursive: true });
    const sp = join(dir, 'system_prompt.md');
    writeFileSync(sp, 'secret');
    chmodSync(sp, 0o000);
    try {
      await expect(
        readAgentWorkspaceFile(
          { agent_id: AGENT_ID, path: 'system_prompt.md' },
          { homeDir },
        ),
      ).rejects.toBeInstanceOf(AgentWorkspaceFsError);
      await expect(
        readAgentWorkspaceFile(
          { agent_id: AGENT_ID, path: 'system_prompt.md' },
          { homeDir },
        ),
      ).rejects.toMatchObject({ code: 'fs_unavailable' });
    } finally {
      chmodSync(sp, 0o644);
    }
  });
});
