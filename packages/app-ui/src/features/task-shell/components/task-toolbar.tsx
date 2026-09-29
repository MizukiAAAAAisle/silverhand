import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TaskFilterBar, FILTER_ROW_TRIGGER_BOX, type TaskFilterBarProps } from "./task-filter-bar";

/** Global and conversation boards share the entire responsive toolbar. */
export function TaskToolbar({
  onCreate,
  ...filters
}: TaskFilterBarProps & { onCreate: () => void }) {
  return (
    <div
      data-task-board-toolbar
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle px-4 py-2"
    >
      <TaskFilterBar {...filters} />
      <Button
        type="button"
        variant="primary"
        className={`shrink-0 gap-1.5 ${FILTER_ROW_TRIGGER_BOX}`}
        onClick={onCreate}
      >
        <Plus className="size-3.5" />
        New task
      </Button>
    </div>
  );
}
