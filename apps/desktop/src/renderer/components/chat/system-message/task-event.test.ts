import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CLUSTERABLE_SUBTYPES } from '@/components/chat/groupMessages';

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
