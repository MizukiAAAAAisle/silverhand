import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentWorkspaceReadError,
  readAgentWorkspace,
} from '../../src/daemon/agent-workspace-read/index.js';

/**
 * D4.e-2 unit test for `readAgentWorkspace` — the host-local read body that
 * moved out of backend `agent-workspace.ts`. It must reproduce the
 * pre-D4.e behavior byte-for-byte: read `system_prompt.md` + `MEMORY.md` +
 * `notes/` from the agent's homedir-resolved L1 dir
 * (`<homeDir>/.silverhand/agents/<agent_id>`), preview-cap at 64 KiB,
 * newest-first notes, missing files → graceful null/[], and a HARD fs
 * failure → typed `fs_unavailable` (fail-closed, Cindy focus #3).
 */

const AGENT_ID = 'aid-read';

let homeDir = '';
function agentDir(): string {
  return join(homeDir, '.silverhand', 'agents', AGENT_ID);
}

describe('readAgentWorkspace', () => {
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'shd4e2-home-'));
  });
  afterEach(() => {
    try {
      rmSync(homeDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('reads system_prompt + MEMORY + notes from the homedir-resolved L1 dir', async () => {
    const dir = agentDir();
    mkdirSync(join(dir, 'notes'), { recursive: true });
    writeFileSync(join(dir, 'system_prompt.md'), 'i am sp');
    writeFileSync(join(dir, 'MEMORY.md'), 'i remember');
    writeFileSync(join(dir, 'notes', 'a.md'), 'note a');

    const r = await readAgentWorkspace({ agent_id: AGENT_ID }, { homeDir });
    expect(r.ok).toBe(true);
    // The daemon stamps the resolved path; the backend never derives it.
    expect(r.workspace.l1_path).toBe(dir);
    expect(r.workspace.system_prompt?.content).toBe('i am sp');
    expect(r.workspace.system_prompt?.truncated).toBe(false);
    expect(r.workspace.memory?.content).toBe('i remember');
    expect(r.workspace.notes.map(n => n.name)).toEqual(['a.md']);
  });

  it('returns null previews + empty notes for a brand-new (empty) agent dir', async () => {
    mkdirSync(agentDir(), { recursive: true });
    const r = await readAgentWorkspace({ agent_id: AGENT_ID }, { homeDir });
    expect(r.workspace.system_prompt).toBeNull();
    expect(r.workspace.memory).toBeNull();
    expect(r.workspace.notes).toEqual([]);
  });

  it('returns null previews + empty notes when the agent dir does not exist', async () => {
    // No mkdir: a never-materialized agent must read gracefully, not throw.
    const r = await readAgentWorkspace({ agent_id: AGENT_ID }, { homeDir });
    expect(r.workspace.system_prompt).toBeNull();
    expect(r.workspace.memory).toBeNull();
    expect(r.workspace.notes).toEqual([]);
  });

  it('caps a large file at 64 KiB and marks it truncated', async () => {
    const dir = agentDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'MEMORY.md'), 'x'.repeat(64 * 1024 + 500));
    const r = await readAgentWorkspace({ agent_id: AGENT_ID }, { homeDir });
    expect(r.workspace.memory?.truncated).toBe(true);
    expect(r.workspace.memory?.content).toContain('(truncated;');
    // size reflects the real on-disk size, not the capped preview length.
    expect(r.workspace.memory?.size).toBe(64 * 1024 + 500);
  });

  it('orders notes newest-first, skips dotfiles and subdirs', async () => {
    const notes = join(agentDir(), 'notes');
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, 'old.md'), 'old');
    writeFileSync(join(notes, 'new.md'), 'new');
    // Force a deterministic mtime ordering (old < new).
    const { utimesSync } = await import('node:fs');
    utimesSync(join(notes, 'old.md'), new Date(1000), new Date(1000));
    utimesSync(join(notes, 'new.md'), new Date(2000), new Date(2000));
    writeFileSync(join(notes, '.hidden.md'), 'hidden');
    mkdirSync(join(notes, 'subdir'));

    const r = await readAgentWorkspace({ agent_id: AGENT_ID }, { homeDir });
    expect(r.workspace.notes.map(n => n.name)).toEqual(['new.md', 'old.md']);
  });

  it('fails closed with fs_unavailable on a HARD read error (unreadable file)', async () => {
    // chmod 000 makes readFile throw EACCES for a non-root reader; stat
    // still reports a file, so the graceful missing-file path is bypassed
    // and the hard error must surface as the typed fs_unavailable.
    if (process.getuid?.() === 0) return; // root bypasses perms — skip
    const dir = agentDir();
    mkdirSync(dir, { recursive: true });
    const sp = join(dir, 'system_prompt.md');
    writeFileSync(sp, 'secret');
    chmodSync(sp, 0o000);
    try {
      await expect(
        readAgentWorkspace({ agent_id: AGENT_ID }, { homeDir }),
      ).rejects.toMatchObject({ code: 'fs_unavailable' });
      await expect(
        readAgentWorkspace({ agent_id: AGENT_ID }, { homeDir }),
      ).rejects.toBeInstanceOf(AgentWorkspaceReadError);
    } finally {
      chmodSync(sp, 0o644);
    }
  });

  it('fails closed with fs_unavailable on a HARD stat error (unsearchable agent dir)', async () => {
    // Cindy D4.e-2 P1: a hard error at the STAT stage (not readFile) must
    // also fail closed. chmod 000 on the agent dir removes search (x)
    // permission, so `stat(<dir>/system_prompt.md)` throws EACCES — which
    // pre-fix the `stat` catch swallowed as a graceful `null` (→ 200), the
    // exact silent-degrade this pin guards against.
    if (process.getuid?.() === 0) return; // root bypasses perms — skip
    const dir = agentDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'system_prompt.md'), 'sp');
    chmodSync(dir, 0o000);
    try {
      await expect(
        readAgentWorkspace({ agent_id: AGENT_ID }, { homeDir }),
      ).rejects.toMatchObject({ code: 'fs_unavailable' });
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  it('fails closed with fs_unavailable on a HARD readdir error (unreadable notes dir)', async () => {
    // Cindy D4.e-2 P1: a hard error listing `notes/` must fail closed, NOT
    // degrade to empty notes. The L1 files stay readable so the failure is
    // specifically the `readdir(notes)` EACCES — pre-fix swallowed as `[]`.
    if (process.getuid?.() === 0) return; // root bypasses perms — skip
    const dir = agentDir();
    const notes = join(dir, 'notes');
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(dir, 'system_prompt.md'), 'sp');
    writeFileSync(join(dir, 'MEMORY.md'), 'mem');
    writeFileSync(join(notes, 'a.md'), 'note a');
    chmodSync(notes, 0o000);
    try {
      await expect(
        readAgentWorkspace({ agent_id: AGENT_ID }, { homeDir }),
      ).rejects.toMatchObject({ code: 'fs_unavailable' });
    } finally {
      chmodSync(notes, 0o755);
    }
  });
});
