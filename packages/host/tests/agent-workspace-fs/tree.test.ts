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
  listAgentWorkspaceTree,
  validateVirtualPathShape,
} from '../../src/daemon/agent-workspace-fs/index.js';
import { agentHomeWorkspaceId } from '@silverhand/shared';

/**
 * Integration tests for the new `agent_workspace_tree` daemon handler
 * (#task:811). The handler walks the homedir-resolved agent home dir
 * recursively and returns a flat list of every visible entry. Cases
 * covered:
 *  - normal flat read (system_prompt + MEMORY + notes/), virtual paths
 *    use `/` separators on every platform.
 *  - empty agent dir → empty tree (graceful, not an error).
 *  - never-materialized agent (no agent dir) → empty tree.
 *  - dotfiles (`.hidden.md`, `.git/config`) filtered at every depth.
 *  - symlinks (intermediate or leaf) skipped.
 *  - directory-first ordering, alphabetic within a parent.
 *  - HARD fs failure (chmod 000 on a sub-dir) → typed `fs_unavailable`.
 *
 * relocation-v1 §7 task 4 (registry demotion): a regular workspace resolves
 * PURELY by its deterministic agent-centric coordinate — no registry is
 * constructed or consulted anywhere in this call chain (the deps type has no
 * `registry` field at all). These tests never build a `WorkspaceRegistry`, so
 * any accidental re-introduction of a registry lookup would fail-closed with
 * no binding/file and break them.
 */

const AGENT_ID = 'aid-tree';

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

describe('listAgentWorkspaceTree', () => {
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'shtree-home-'));
  });
  afterEach(() => {
    try {
      rmSync(homeDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('returns an empty tree for a brand-new agent (no dir yet)', async () => {
    const r = await listAgentWorkspaceTree({ agent_id: AGENT_ID }, { homeDir });
    expect(r.ok).toBe(true);
    expect(r.tree.nodes).toEqual([]);
  });

  it('walks system_prompt + MEMORY + notes/ as a flat tree', async () => {
    const dir = agentDir();
    mkdirSync(join(dir, 'notes'), { recursive: true });
    writeFileSync(join(dir, 'system_prompt.md'), 'sp');
    writeFileSync(join(dir, 'MEMORY.md'), 'mem');
    writeFileSync(join(dir, 'notes', 'a.md'), 'a');
    writeFileSync(join(dir, 'notes', 'b.md'), 'b');

    const r = await listAgentWorkspaceTree({ agent_id: AGENT_ID }, { homeDir });
    expect(r.ok).toBe(true);
    const paths = r.tree.nodes.map(n => `${n.kind}:${n.path}`);
    // Preorder: each directory is followed immediately by its
    // descendants, then the next sibling. Within one parent, dirs
    // sort before files and entries are alphabetic per kind. Cindy
    // round-1 P2 — the renderer iterates `nodes` in order and
    // computes depth from path segments; a global flat sort would
    // separate `notes/a.md` from its parent `notes/` and break the
    // visual tree layout.
    expect(paths).toEqual([
      'directory:notes',
      'file:notes/a.md',
      'file:notes/b.md',
      'file:MEMORY.md',
      'file:system_prompt.md',
    ]);
  });

  it('walks a scoped regular workspace L2 bundle by deterministic coordinate — zero registry', async () => {
    const home = agentDir();
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'system_prompt.md'), 'l1');

    // Bundle materialized at the deterministic coordinate (as first spawn
    // would do) — NO registry provision.
    const scoped = l2BundleDir();
    mkdirSync(join(scoped, 'notes'), { recursive: true });
    writeFileSync(join(scoped, 'MEMORY.md'), 'l2');
    writeFileSync(join(scoped, 'notes', 'work.md'), 'work');

    const r = await listAgentWorkspaceTree(
      { agent_id: AGENT_ID, workspace_id: 'ws_1' },
      { homeDir },
    );
    const paths = r.tree.nodes.map(n => `${n.kind}:${n.path}`);
    expect(paths).toEqual([
      'directory:notes',
      'file:notes/work.md',
      'file:MEMORY.md',
    ]);
    expect(paths).not.toContain('file:system_prompt.md');
  });

  it('resolves an agent-home workspace id back to home without consulting the registry', async () => {
    const dir = agentDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'system_prompt.md'), 'l1');
    writeFileSync(join(dir, 'MEMORY.md'), 'home');

    const r = await listAgentWorkspaceTree(
      {
        agent_id: AGENT_ID,
        workspace_id: agentHomeWorkspaceId(AGENT_ID),
      },
      { homeDir },
    );
    const paths = r.tree.nodes.map(n => n.path);
    expect(paths).toEqual(['MEMORY.md', 'system_prompt.md']);
  });

  it('resolves a regular workspace with ZERO registry — a pure-DB-created workspace whose bundle first-spawn materialized reads by coordinate (relocation-v1 §7-4 falsifier)', async () => {
    // Model the U4 end-state: the workspace was created as a pure DB write
    // (no `workspace_provision`, no registry binding anywhere), then its
    // bundle was materialized at first spawn. The tree must resolve purely by
    // the deterministic agent-centric coordinate. No registry is constructed;
    // if the resolver still consulted one it would fail-closed here.
    const scoped = l2BundleDir('ws_pure_db');
    mkdirSync(scoped, { recursive: true });
    writeFileSync(join(scoped, 'MEMORY.md'), 'l2');

    const r = await listAgentWorkspaceTree(
      { agent_id: AGENT_ID, workspace_id: 'ws_pure_db' },
      { homeDir },
    );
    expect(r.ok).toBe(true);
    expect(r.tree.nodes.map(n => n.path)).toEqual(['MEMORY.md']);
  });

  it('a never-materialized regular workspace degrades to an empty tree — NOT a workspace_not_provisioned refusal (relocation-v1 §7-4)', async () => {
    // The coordinate is always computable; a bundle that was never spawned is
    // an ordinary filesystem absence, so the tree is empty rather than
    // fail-closed. No registry, no 409.
    const r = await listAgentWorkspaceTree(
      { agent_id: AGENT_ID, workspace_id: 'ws_never_spawned' },
      { homeDir },
    );
    expect(r.ok).toBe(true);
    expect(r.tree.nodes).toEqual([]);
  });

  it('emits preorder across multi-level nesting (root: dirA, fileR; dirA: dirB, fileA; dirB: fileB)', async () => {
    const dir = agentDir();
    mkdirSync(join(dir, 'dirA', 'dirB'), { recursive: true });
    writeFileSync(join(dir, 'fileR.md'), 'r');
    writeFileSync(join(dir, 'dirA', 'fileA.md'), 'a');
    writeFileSync(join(dir, 'dirA', 'dirB', 'fileB.md'), 'b');

    const r = await listAgentWorkspaceTree({ agent_id: AGENT_ID }, { homeDir });
    const paths = r.tree.nodes.map(n => `${n.kind}:${n.path}`);
    // Preorder, dir-first within each parent. Even though `fileR.md`
    // has the same parent as `dirA`, it appears AFTER every descendant
    // of `dirA` because preorder walks dirA's subtree first.
    expect(paths).toEqual([
      'directory:dirA',
      'directory:dirA/dirB',
      'file:dirA/dirB/fileB.md',
      'file:dirA/fileA.md',
      'file:fileR.md',
    ]);
  });

  it('filters dotfiles at every depth', async () => {
    const dir = agentDir();
    mkdirSync(join(dir, 'notes'), { recursive: true });
    mkdirSync(join(dir, '.hiddenDir'), { recursive: true });
    writeFileSync(join(dir, '.env'), 'secret');
    writeFileSync(join(dir, 'MEMORY.md'), 'mem');
    writeFileSync(join(dir, 'notes', '.gitkeep'), '');
    writeFileSync(join(dir, 'notes', 'real.md'), 'r');

    const r = await listAgentWorkspaceTree({ agent_id: AGENT_ID }, { homeDir });
    const paths = r.tree.nodes.map(n => n.path);
    expect(paths).not.toContain('.env');
    expect(paths).not.toContain('.hiddenDir');
    expect(paths).not.toContain('notes/.gitkeep');
    expect(paths).toContain('MEMORY.md');
    expect(paths).toContain('notes/real.md');
  });

  it('skips symlinks (intermediate and leaf) without revealing the target', async () => {
    const dir = agentDir();
    const outside = mkdtempSync(join(tmpdir(), 'shtree-outside-'));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(outside, 'leak'), 'never');
      // Leaf symlink in the agent dir
      symlinkSync(join(outside, 'leak'), join(dir, 'leak.md'));
      // Intermediate symlink (a "notes" link to an outside dir)
      symlinkSync(outside, join(dir, 'notes'));
      // A real file alongside, to prove the rest of the walk continues
      writeFileSync(join(dir, 'MEMORY.md'), 'mem');

      const r = await listAgentWorkspaceTree(
        { agent_id: AGENT_ID },
        { homeDir },
      );
      const paths = r.tree.nodes.map(n => n.path);
      expect(paths).toEqual(['MEMORY.md']);
      // The symlink target name should never leak into the tree:
      expect(paths.some(p => p.includes('leak'))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('uses `/` separators on every platform for the wire path', async () => {
    const dir = agentDir();
    mkdirSync(join(dir, 'notes', 'sub'), { recursive: true });
    writeFileSync(join(dir, 'notes', 'sub', 'nested.md'), 'n');
    const r = await listAgentWorkspaceTree({ agent_id: AGENT_ID }, { homeDir });
    expect(r.tree.nodes.some(n => n.path === 'notes/sub/nested.md')).toBe(true);
    expect(r.tree.nodes.every(n => !n.path.includes('\\'))).toBe(true);
  });

  it('skips a POSIX file whose name contains a backslash (Cindy round-2 P1)', async () => {
    // POSIX filenames may legitimately contain `\\`. The wire path
    // namespace is `/`-joined and the read endpoint's parser refuses
    // any segment containing `\\`. If the tree handler emitted such
    // an entry, its `path` would (a) get its `\\` normalized to `/`
    // and become a fake nesting that doesn't round-trip, and (b)
    // potentially collide with a real same-name nested file. The
    // shared `isAllowedSegmentName` gate skips it server-side.
    const dir = agentDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'foo\\bar.md'), 'sneaky');
    writeFileSync(join(dir, 'MEMORY.md'), 'mem');

    const r = await listAgentWorkspaceTree({ agent_id: AGENT_ID }, { homeDir });
    const paths = r.tree.nodes.map(n => n.path);
    // The sneaky entry must not appear, in any normalization.
    expect(paths).not.toContain('foo\\bar.md');
    expect(paths).not.toContain('foo/bar.md');
    expect(paths).toContain('MEMORY.md');
  });

  it('every emitted node path round-trips through validateVirtualPathShape (invariant)', async () => {
    // Any tree node `path` MUST be feedable to
    // `agent_workspace_file_read` without the parser refusing it. We
    // build a moderately interesting tree and assert the wire-shape
    // invariant directly. A future tree-walk regression that lets a
    // bad name through (NUL / backslash / dotfile / …) would break
    // this contract immediately.
    const dir = agentDir();
    mkdirSync(join(dir, 'notes', 'sub'), { recursive: true });
    writeFileSync(join(dir, 'system_prompt.md'), 'sp');
    writeFileSync(join(dir, 'MEMORY.md'), 'mem');
    writeFileSync(join(dir, 'notes', 'a.md'), 'a');
    writeFileSync(join(dir, 'notes', 'sub', 'nested.md'), 'n');
    // Adversarial entries — must be skipped, but the invariant has
    // to hold over EVERY node returned regardless.
    writeFileSync(join(dir, '.hidden'), 'h');
    writeFileSync(join(dir, 'foo\\bar.md'), 'b');

    const r = await listAgentWorkspaceTree({ agent_id: AGENT_ID }, { homeDir });
    expect(r.tree.nodes.length).toBeGreaterThan(0);
    for (const node of r.tree.nodes) {
      const v = validateVirtualPathShape(node.path);
      // Append `node.path` so a failure surfaces the offending entry.
      expect(v.ok, `path "${node.path}" failed shape validation`).toBe(true);
    }
  });

  it('refuses when the agent home dir itself is a symlink (forbidden_path)', async () => {
    // Agent home dir replaced with a symlink to a real dir somewhere
    // else with arbitrary contents. A pure realpath() would silently
    // re-base the walk onto the target. The shared `resolveAgentHomeBase`
    // lstats the base FIRST and refuses (Cindy round-1 P1 #2).
    const outside = mkdtempSync(join(tmpdir(), 'shtree-symbase-'));
    try {
      writeFileSync(join(outside, 'should-not-appear.md'), 'leak');
      const dir = agentDir();
      // Parent of agent dir must exist; the symlink REPLACES the agent dir.
      mkdirSync(join(homeDir, '.silverhand', 'agents'), { recursive: true });
      symlinkSync(outside, dir);

      await expect(
        listAgentWorkspaceTree({ agent_id: AGENT_ID }, { homeDir }),
      ).rejects.toBeInstanceOf(AgentWorkspaceFsError);
      await expect(
        listAgentWorkspaceTree({ agent_id: AGENT_ID }, { homeDir }),
      ).rejects.toMatchObject({ code: 'forbidden_path' });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('fails closed with fs_unavailable on a HARD readdir error', async () => {
    if (process.getuid?.() === 0) return; // root bypasses perms
    const dir = agentDir();
    const notes = join(dir, 'notes');
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(dir, 'MEMORY.md'), 'mem');
    writeFileSync(join(notes, 'a.md'), 'a');
    chmodSync(notes, 0o000);
    try {
      await expect(
        listAgentWorkspaceTree({ agent_id: AGENT_ID }, { homeDir }),
      ).rejects.toBeInstanceOf(AgentWorkspaceFsError);
      await expect(
        listAgentWorkspaceTree({ agent_id: AGENT_ID }, { homeDir }),
      ).rejects.toMatchObject({ code: 'fs_unavailable' });
    } finally {
      chmodSync(notes, 0o755);
    }
  });
});
