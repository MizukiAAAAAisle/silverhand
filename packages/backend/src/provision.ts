import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';

/**
 * Block dangerous workspace_path values before any filesystem write or delete
 * touches them. User-selected paths must be absolute and must not target the
 * filesystem root, home directory, or Silverhand state internals.
 *
 * Auto-generated workspace paths live under `<silverhandDir>/workspaces/*`;
 * that one subtree is the only allowed child of the Silverhand state dir.
 */
export function validateWorkspacePath(
  workspacePath: string,
  silverhandDir: string,
  workspacesRoot: string,
): { ok: true; resolved: string } | { ok: false; reason: string } {
  if (typeof workspacePath !== 'string' || workspacePath.trim() === '') {
    return { ok: false, reason: 'workspace_path is empty' };
  }
  if (!isAbsolute(workspacePath)) {
    return { ok: false, reason: 'workspace_path must be absolute' };
  }
  const resolved = resolve(workspacePath);
  if (resolved === '/' || resolved === sep) {
    return { ok: false, reason: 'workspace_path cannot be the filesystem root' };
  }
  if (resolved === resolve(homedir())) {
    return { ok: false, reason: 'workspace_path cannot be the home directory' };
  }

  const stateRoot = resolve(silverhandDir);
  const generatedRoot = resolve(workspacesRoot);
  const insideStateRoot = resolved === stateRoot || resolved.startsWith(stateRoot + sep);
  if (insideStateRoot && !resolved.startsWith(generatedRoot + sep)) {
    return {
      ok: false,
      reason: 'workspace_path cannot live inside the silverhand state dir (except under workspaces/)',
    };
  }

  return { ok: true, resolved };
}

export async function ensureWorkspacesRoot(workspacesRoot: string): Promise<void> {
  await mkdir(workspacesRoot, { recursive: true });
}

