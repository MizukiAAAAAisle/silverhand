import { ArrowDownToLine } from "lucide-react";

/**
 * Drop-target slot shown at the top of a kanban column's body while a task
 * card is dragged over it (#task:784, shiki feedback). Pairs with the
 * column-level `--bg-row-selected` wash: the wash says "this column is
 * armed", the slot says "the card will land here".
 *
 * Geometry routes through the shared `data-panel-card="placeholder"`
 * contract (global.css) so corners are squared in every theme (forza6
 * hard-cut) and forza6 supplies its 2px dashed poster stroke automatically
 * — no hardcoded `rounded-*`. Ink + border colour use `--text-on-selected`
 * so the slot reads as dark-on-brand against the bold selected column fill
 * in both poster and warm themes (forza6 overrides the border to its black
 * dashed stroke, which equals `--text-on-selected`, so the two stay in
 * sync).
 *
 * Rendered as an `<li>` so it slots into the column's task `<ul>` and
 * inherits its `space-y` rhythm; `aria-hidden` because it is a transient
 * visual cue, not a focusable control.
 */
export function TaskDropPlaceholder(): JSX.Element {
  return (
    <li aria-hidden>
      <div
        data-panel-card="placeholder"
        data-task-drop-placeholder
        className="flex items-center justify-center gap-1.5 border border-dashed border-text-on-selected px-2 py-3 text-(length:--text-meta) font-medium uppercase tracking-wider text-text-on-selected"
      >
        <ArrowDownToLine className="size-3.5" aria-hidden />
        Drop here
      </div>
    </li>
  );
}
