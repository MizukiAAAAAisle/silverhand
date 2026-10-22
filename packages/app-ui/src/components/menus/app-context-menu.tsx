import { useCallback, useEffect, useRef, useState } from "react";
import type { ComponentPropsWithoutRef, ReactElement, ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronRightIcon } from "@/icons";
import { cn } from "@/lib/cn";

const MENU_CONTENT_CLASS =
  "z-[var(--z-popover)] min-w-[180px] rounded-md border border-border bg-bg-floating p-1 text-xs text-text-primary shadow-popover outline-none";

const MENU_ITEM_CLASS = cn(
  // `cursor-pointer` on hover so the menu reads as actionable; Radix's
  // default `cursor: default` made these feel like read-only labels.
  // Disabled items downgrade to `not-allowed` via the data-disabled
  // selector below so the affordance still tracks the actual state.
  "flex select-none items-center gap-2 rounded-sm px-2 py-1.5 outline-none transition-colors",
  "cursor-pointer data-disabled:cursor-not-allowed",
  "data-disabled:pointer-events-none data-disabled:opacity-50",
  "data-highlighted:bg-bg-hover data-highlighted:text-text-primary",
);

function AppMenuItemContent({
  icon,
  children,
  trailing,
}: {
  icon: ReactNode;
  children: ReactNode;
  trailing?: ReactNode;
}): JSX.Element {
  return (
    <>
      <span className="flex size-3.5 shrink-0 items-center justify-center text-text-muted">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing ? (
        <span className="shrink-0 text-(length:--text-badge) text-text-muted">{trailing}</span>
      ) : null}
    </>
  );
}

/** At most one context menu is open. On touch, Radix dismisses an open menu on
 *  the `click` after an outside press, and a long press never produces one, so
 *  a long press on another row would open a second menu over the first. Radix's
 *  context menu cannot be closed from outside, so opening one remounts the
 *  previous one, which drops its open state. */
let closeOpenMenu: (() => void) | null = null;

function useSingleOpenMenu() {
  const [generation, setGeneration] = useState(0);
  const closeRef = useRef(() => setGeneration((value) => value + 1));

  useEffect(() => {
    const close = closeRef.current;
    return () => {
      if (closeOpenMenu === close) {
        closeOpenMenu = null;
      }
    };
  }, []);

  const onOpenChange = useCallback((open: boolean) => {
    const close = closeRef.current;
    if (open) {
      if (closeOpenMenu && closeOpenMenu !== close) {
        closeOpenMenu();
      }
      closeOpenMenu = close;
    } else if (closeOpenMenu === close) {
      closeOpenMenu = null;
    }
  }, []);

  return { generation, onOpenChange };
}

export function AppContextMenu({
  trigger,
  children,
  contentClassName,
  triggerClassName,
  triggerRef,
  disabled = false,
  onCloseAutoFocus,
}: {
  trigger: ReactElement;
  triggerClassName?: string;
  triggerRef?: React.Ref<HTMLSpanElement>;
  disabled?: boolean;
  onCloseAutoFocus?: ComponentPropsWithoutRef<typeof ContextMenu.Content>["onCloseAutoFocus"];
  children: ReactNode;
  /** Extra classes merged onto the menu content — e.g. a narrower `min-w-*`
   *  than the shared default for a compact single-action menu. */
  contentClassName?: string;
}): JSX.Element {
  const menu = useSingleOpenMenu();

  return (
    <ContextMenu.Root key={menu.generation} onOpenChange={menu.onOpenChange}>
      <ContextMenu.Trigger
        asChild
        className={triggerClassName}
        ref={triggerRef}
        disabled={disabled}
        style={disabled ? { WebkitTouchCallout: "default" } : undefined}
      >
        {trigger}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          data-app-menu
          collisionPadding={8}
          className={cn(MENU_CONTENT_CLASS, contentClassName)}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          {children}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

export function AppContextMenuItem({
  icon,
  children,
  trailing,
  disabled,
  onSelect,
}: {
  icon: ReactNode;
  children: ReactNode;
  trailing?: ReactNode;
  disabled?: boolean;
  onSelect?: () => void;
}): JSX.Element {
  return (
    <ContextMenu.Item disabled={disabled} onSelect={onSelect} className={MENU_ITEM_CLASS}>
      <AppMenuItemContent icon={icon} trailing={trailing}>
        {children}
      </AppMenuItemContent>
    </ContextMenu.Item>
  );
}

/** A row of emoji at the top of a menu; each one is a menu item, so arrow keys
 *  and selection close the menu like any other item. */
export function AppContextMenuReactions({
  emojis,
  labelFor,
  onPick,
}: {
  emojis: readonly string[];
  labelFor: (emoji: string) => string;
  onPick: (emoji: string) => void;
}): JSX.Element {
  return (
    <div data-app-menu-reactions className="flex items-center justify-between gap-1 px-1 py-0.5">
      {emojis.map((emoji) => (
        <ContextMenu.Item
          key={emoji}
          aria-label={labelFor(emoji)}
          onSelect={() => onPick(emoji)}
          className="flex aspect-square min-w-0 max-w-9 flex-1 cursor-pointer select-none items-center justify-center rounded-full text-xl leading-none outline-none transition-colors data-highlighted:bg-bg-hover"
        >
          {emoji}
        </ContextMenu.Item>
      ))}
    </div>
  );
}

export function AppContextMenuSeparator(): JSX.Element {
  return <ContextMenu.Separator className="my-1 h-px bg-border-subtle/60" />;
}

/**
 * Nested context submenu — a `▸` trigger row whose children mount only while
 * the submenu is open (Radix `SubContent` is not force-mounted). Put any
 * lazily-fetched child (e.g. a per-channel preference query) inside it so it
 * fires on hover, not on every parent-row render.
 */
export function AppContextMenuSub({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger className={cn(MENU_ITEM_CLASS, "data-[state=open]:bg-bg-hover")}>
        <AppMenuItemContent icon={icon} trailing={<ChevronRightIcon className="size-3.5" />}>
          {label}
        </AppMenuItemContent>
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent data-app-menu className={MENU_CONTENT_CLASS} sideOffset={2}>
          {children}
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}

export function AppDropdownMenu({
  trigger,
  children,
  align = "end",
  side = "bottom",
  contentClassName,
}: {
  trigger: ReactElement;
  children: ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom";
  /** Extra classes merged onto the menu content — e.g. a narrower
   *  `min-w-*` than the shared default for compact menus. */
  contentClassName?: string;
}): JSX.Element {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={align}
          side={side}
          sideOffset={4}
          data-app-menu
          className={cn(MENU_CONTENT_CLASS, contentClassName)}
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function AppDropdownMenuItem({
  icon,
  children,
  trailing,
  disabled,
  onSelect,
}: {
  icon: ReactNode;
  children: ReactNode;
  trailing?: ReactNode;
  disabled?: boolean;
  onSelect?: () => void;
}): JSX.Element {
  return (
    <DropdownMenu.Item disabled={disabled} onSelect={onSelect} className={MENU_ITEM_CLASS}>
      <AppMenuItemContent icon={icon} trailing={trailing}>
        {children}
      </AppMenuItemContent>
    </DropdownMenu.Item>
  );
}
