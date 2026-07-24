/**
 * #task:1603 — layout-v2 marker (docs/app-data-layout-v2.md §6.4).
 *
 * `desktop/data-layout.json` is the physical-layout SELECTION fact for
 * migration-aware binaries: written atomically once both facets AND the
 * eager session pass finish, read once at process entry to pick the
 * resolver version. `version` stays 2 (the physical layout); `sessions`
 * is the session-pass completion fact. Unverifiable inputs fail the pass
 * CLOSED before any marker write (P1-2), so a marker WITHOUT `sessions`
 * can only come from the pre-completion dogfood build on the dev
 * machine — that catch-up reader lives here in the deletable migration
 * unit and nowhere else.
 */
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { DesktopLayoutVersion } from '@silverhand/shared/app-data-layout';

const DataLayoutMarkerSchema = z
  .object({
    version: z.literal(2),
    migrated_at: z.number().int().nonnegative(),
    from: z.literal('legacy-v1'),
    sessions: z
      .object({ migrated_at: z.number().int().nonnegative() })
      .strict()
      .optional(),
    /** #task:1608 — the computer-slot fact: durable computer data lives at
     *  `computers/<computer_id>` (no `local` alias). Absent only on the
     *  pre-revision dogfood marker; the slot catch-up arm stamps it. */
    computer_slot: z
      .object({ migrated_at: z.number().int().nonnegative() })
      .strict()
      .optional(),
    /** #task:1608 workspace-data convergence — the flat registry fact:
     *  the current binding's registry lives at
     *  `workspace-data/workspace-registry.json` with raw-id managed dirs.
     *  Absent only on pre-convergence dogfood markers; the workspace
     *  catch-up arm stamps it AFTER registry lift + dir renames + session
     *  cwd renames all succeed. */
    workspace_layout: z
      .object({ migrated_at: z.number().int().nonnegative() })
      .strict()
      .optional(),
  })
  .strict();

export type DataLayoutMarker = z.infer<typeof DataLayoutMarkerSchema>;

/**
 * Read the marker and decide the active layout version. Fail-closed
 * discipline inverted on purpose: an ABSENT marker is the well-defined
 * legacy state, but an unreadable/corrupt marker is NOT "legacy" — the
 * installation may already be physically v2, and running legacy paths
 * against it would split the authority. Callers must treat `corrupt` as
 * a startup-blocking state.
 */
export function readDataLayoutMarker(
  markerPath: string,
  readFile: (path: string) => string = p => readFileSync(p, 'utf-8'),
): { state: 'absent' } | { state: 'v2'; marker: DataLayoutMarker } | { state: 'corrupt'; detail: string } {
  let raw: string;
  try {
    raw = readFile(markerPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' };
    return { state: 'corrupt', detail: (err as Error).message };
  }
  try {
    const parsed = DataLayoutMarkerSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return { state: 'corrupt', detail: parsed.error.issues[0]?.message ?? 'schema mismatch' };
    }
    return { state: 'v2', marker: parsed.data };
  } catch (err) {
    return { state: 'corrupt', detail: (err as Error).message };
  }
}

export function layoutVersionFromMarker(
  state: ReturnType<typeof readDataLayoutMarker>,
): DesktopLayoutVersion | 'blocked' {
  switch (state.state) {
    case 'absent':
      return 'legacy-v1';
    case 'v2':
      return 'v2';
    case 'corrupt':
      return 'blocked';
  }
}

/** Atomic tmp+rename, owner-only (§6.4). A torn write is impossible via
 *  rename; a lost-marker crash simply re-runs the idempotent migration. */
export function writeDataLayoutMarker(
  markerPath: string,
  migratedAt: number,
  sessionsMigratedAt: number,
  computerSlotMigratedAt: number,
  workspaceLayoutMigratedAt: number,
): void {
  const marker: DataLayoutMarker = {
    version: 2,
    migrated_at: migratedAt,
    from: 'legacy-v1',
    sessions: { migrated_at: sessionsMigratedAt },
    computer_slot: { migrated_at: computerSlotMigratedAt },
    workspace_layout: { migrated_at: workspaceLayoutMigratedAt },
  };
  mkdirSync(dirname(markerPath), { recursive: true, mode: 0o700 });
  const tmp = `${markerPath}.migrating`;
  writeFileSync(tmp, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, markerPath);
}
