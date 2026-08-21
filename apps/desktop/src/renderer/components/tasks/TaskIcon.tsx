import { ListChecks, type LucideIcon } from 'lucide-react';

/**
 * The Task ENTITY icon — Lucide `ListChecks`, the single source for every surface
 * that names Tasks as a thing (the nav rail, the per-conversation view tab, the
 * global Tasks section, the task-detail header). shiki #task:2121: one icon, one
 * source — a surface consumes THIS, never `ListChecks` directly, so the glyph is
 * changed in one place and can never drift between surfaces.
 *
 * Identity only: which glyph means "Task". Size and color are the consumer's
 * (layout), passed through `className` at the call site — the identity-vs-layout
 * split, same as every other identity primitive. The per-STATUS icons
 * (todo / in_progress / …) are a DIFFERENT vocabulary (status, not entity) and
 * stay in `TASK_STATUS_ICON`; this is not their source.
 */
export const TaskIcon: LucideIcon = ListChecks;
