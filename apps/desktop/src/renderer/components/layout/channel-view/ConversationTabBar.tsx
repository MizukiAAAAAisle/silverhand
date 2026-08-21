import { FileText, MessageSquare, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { restrictToHorizontalAxis } from '@dnd-kit/modifiers';
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { cn } from '@/lib/cn';
import { animateLayoutChanges } from '@/components/layout/list-drag-sort';
import {
  AppContextMenu,
  AppContextMenuItem,
} from '@/components/menus/AppContextMenu';
import { isRemovable, tabKey, type Tab } from '@/lib/conversation-tabs';
import { TaskIcon } from '@/components/tasks/TaskIcon';

/**
 * Per-conversation view tab strip (#task:2121) — a Slack-style horizontal bar
 * under the conversation header. Builtins (Chat / Tasks) and the viewer's custom
 * tabs (attachment previewers, #task:2122) share ONE draggable order: any tab
 * can be dragged to any slot; only custom tabs can be removed (builtins have no
 * remove affordance). Removal is right-click only — a custom tab carries no close
 * icon (shiki 2026-08-21), so the strip stays flat and a builtin can never grow
 * a control it must never offer. Overflow scrolls horizontally with a hidden
 * scrollbar (`.scrollbar-hide`) — no dropdown; the `＋` producer is deferred
 * pending its scope (no custom-tab producer lands until #task:2122).
 *
 * Drag-reorder is LOCAL state (not the cache-driven sidebar sort), so the
 * frame-desync invariants in `list-drag-sort.tsx` don't apply — the reorder
 * result becomes state synchronously in `onDragEnd`. We reuse only its
 * `animateLayoutChanges` settle guard for a consistent slide/settle feel.
 */
export interface ConversationTabBarProps {
  tabs: Tab[];
  activeKey: string;
  onActivate: (key: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  /** Remove a custom tab from this conversation (non-destructive; builtins never
   *  call it — {@link isRemovable} decides whether the affordance renders). */
  onClose: (key: string) => void;
}

interface TabPresentation {
  icon: LucideIcon;
  label: string;
}

/** A tab's icon + label. Exhaustive over the {@link Tab} union so a new custom
 *  kind must declare its presentation here rather than fall through to a blank
 *  chip. */
function tabPresentation(tab: Tab): TabPresentation {
  switch (tab.kind) {
    case 'chat':
      return { icon: MessageSquare, label: 'Chat' };
    case 'tasks':
      return { icon: TaskIcon, label: 'Tasks' };
    case 'attachment':
      return { icon: FileText, label: tab.filename };
  }
}

export function ConversationTabBar({
  tabs,
  activeKey,
  onActivate,
  onReorder,
  onClose,
}: ConversationTabBarProps): JSX.Element {
  const ids = tabs.map(tabKey);
  const sensors = useSensors(
    // 4px activation so a plain click still activates the tab rather than
    // starting a drag (same threshold as the sidebar sort).
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  return (
    <div
      data-conversation-tabs
      className="flex h-[var(--conversation-tab-strip-height)] shrink-0 items-stretch gap-1 overflow-x-auto border-b border-border-subtle px-2 scrollbar-hide"
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToHorizontalAxis]}
        onDragEnd={({ active, over }) => {
          if (!over || active.id === over.id) return;
          const from = ids.indexOf(String(active.id));
          const to = ids.indexOf(String(over.id));
          if (from < 0 || to < 0) return;
          onReorder(from, to);
        }}
      >
        <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
          {tabs.map(tab => {
            const key = tabKey(tab);
            return (
              <SortableTab
                key={key}
                id={key}
                presentation={tabPresentation(tab)}
                active={key === activeKey}
                onActivate={() => onActivate(key)}
                // Builtins pass no remover, so the context menu never mounts for
                // them — the non-removable invariant is enforced by absence, not
                // a disabled item.
                onClose={isRemovable(tab) ? () => onClose(key) : undefined}
              />
            );
          })}
        </SortableContext>
      </DndContext>
    </div>
  );
}

function SortableTab({
  id,
  presentation,
  active,
  onActivate,
  onClose,
}: {
  id: string;
  presentation: TabPresentation;
  active: boolean;
  onActivate: () => void;
  /** Present only for removable (custom) tabs — its presence is what mounts the
   *  right-click "Remove" menu. */
  onClose?: () => void;
}): JSX.Element {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, animateLayoutChanges });
  const { icon: Icon, label } = presentation;
  const button = (
    <button
      ref={setNodeRef}
      type="button"
      onClick={onActivate}
      style={{
        transform: transform
          ? `translate3d(${transform.x}px, 0, 0)`
          : undefined,
        transition,
        opacity: isDragging ? 0.6 : undefined,
        zIndex: isDragging ? 1 : undefined,
        position: isDragging ? 'relative' : undefined,
      }}
      {...attributes}
      {...listeners}
      // Tab semantics win over dnd-kit's default `role="button"` (spread above).
      role="tab"
      aria-selected={active}
      className={cn(
        // The active tab is marked by a bottom ink border + primary ink; the
        // strip's own bottom border shows through for inactive tabs. A 2px
        // border on both states (transparent when inactive) keeps the label
        // baseline from shifting on activation. 稳定 > 自适应. The underline is
        // ink (not accent): a view tab is a utility navigator, so it stays in
        // the neutral ink vocabulary and matches its own label ink.
        'flex shrink-0 cursor-pointer select-none items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 text-xs transition-colors',
        active
          ? 'border-text-primary text-text-primary'
          : 'border-transparent text-text-muted hover:text-text-primary',
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {label}
    </button>
  );

  // A custom tab carries no close icon (shiki 2026-08-21): removal is the
  // right-click menu's single action, so the strip stays flat and a builtin
  // never shows a control it must not offer.
  if (!onClose) return button;
  return (
    <AppContextMenu trigger={button}>
      <AppContextMenuItem icon={<X className="size-3.5" />} onSelect={onClose}>
        Remove
      </AppContextMenuItem>
    </AppContextMenu>
  );
}
