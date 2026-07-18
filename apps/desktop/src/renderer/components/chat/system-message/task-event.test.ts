import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CLUSTERABLE_SUBTYPES } from '@/components/chat/groupMessages';

// `task_edit` (#task:1531) is a task_* lifecycle system message: `@actor
// edited #task:N`. Two things about it are decision branches, not painting,
// so they earn a fence — the verb WORD itself ("edited") is copy and is NOT
// asserted:
//
//  1. The verb ternary must map `task_edit → 'edited'` in BOTH the enriched
//     and the degraded row. If that explicit case is dropped, `task_edit`
//     silently falls through to the `'unclaimed'` default — a wrong verb, a
//     real correctness regression (not a cosmetic one).
//  2. An edit is a DEFINITION change, never a status transition, so it takes
//     the plain-verb shape (like create/claim), NOT the `moved … → pill`
//     shape. The only pill path is the `subtype === 'task_status'` early
//     return, so a `task_edit` verb mapping proves it stays off that path.
//  3. `task_edit` participates in the activity cluster with the rest of the
//     task_* family (create → edit → claim arrive in one work burst);
//     excluding it would split a run into cluster / standalone / cluster.
//
// Desktop test env is `node` (no jsdom/RTL), so the verb mapping is asserted
// on source structure, like the sibling task fences.

describe('task-event row — task_edit renders as an "edited" verb, not a status move', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./task-event.tsx', import.meta.url)),
    'utf8',
  );

  it('maps task_edit to its own verb in both the enriched and degraded rows', () => {
    // Two ternaries (enriched `TaskEventBody` + `TaskEventRowDegraded`) each
    // need the explicit `task_edit` case ahead of the `'unclaimed'` fallback.
    const enrichedCase = source.includes("subtype === 'task_edit'");
    const degradedCase = source.includes("meta.subtype === 'task_edit'");
    expect(enrichedCase).toBe(true);
    expect(degradedCase).toBe(true);
    expect(source).toContain("'edited'");
  });

  it('never routes task_edit through the status-transition (pill) shape', () => {
    // The ONLY `→ pill` path is the status early-return; task_edit is not
    // task_status, so it must not appear as a status-pill subtype branch.
    expect(source).not.toContain("subtype === 'task_edit'\n    ) {");
    // The status pill is reserved for the single `task_status` branch.
    expect(source).toContain("if (subtype === 'task_status')");
  });

  it('clusters task_edit with the rest of the task_* lifecycle family', () => {
    expect(CLUSTERABLE_SUBTYPES.has('task_edit')).toBe(true);
  });
});
