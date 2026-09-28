import { createContext, useContext, type ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { animateLayoutChanges, sortableItemStyle } from "./list-drag-sort";

type BranchDragHandle = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "setActivatorNodeRef" | "isDragging"
>;
const BranchDragContext = createContext<BranchDragHandle | null>(null);

export function useSidebarBranchDrag(): BranchDragHandle | null {
  return useContext(BranchDragContext);
}

export function SortableSidebarBranch({
  id,
  children,
  disabled,
}: {
  id: string;
  children: ReactNode;
  disabled?: boolean;
}) {
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, animateLayoutChanges, disabled });

  return (
    <div ref={setNodeRef} style={sortableItemStyle({ transform, transition, isDragging })}>
      <BranchDragContext.Provider
        value={{ attributes, listeners, setActivatorNodeRef, isDragging }}
      >
        {children}
      </BranchDragContext.Provider>
    </div>
  );
}
