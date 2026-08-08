import type { ReactElement, ReactNode } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';

const MENU_CONTENT_CLASS =
  'z-[var(--z-popover)] min-w-[180px] rounded-md border border-border bg-bg-floating p-1 text-xs text-text-primary shadow-popover outline-none';

const MENU_ITEM_CLASS = cn(
  // `cursor-pointer` on hover so the menu reads as actionable; Radix's
  // default `cursor: default` made these feel like read-only labels.
  // Disabled items downgrade to `not-allowed` via the data-disabled
  // selector below so the affordance still tracks the actual state.
  'flex select-none items-center gap-2 rounded-sm px-2 py-1.5 outline-none transition-colors',
  'cursor-pointer data-[disabled]:cursor-not-allowed',
  'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
  'data-[highlighted]:bg-bg-hover data-[highlighted]:text-text-primary',
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
        <span className="shrink-0 text-[length:var(--text-badge)] text-text-muted">{trailing}</span>
      ) : null}
    </>
  );
}

export function AppContextMenu({
  trigger,
  children,
}: {
  trigger: ReactElement;
  children: ReactNode;
}): JSX.Element {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{trigger}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={MENU_CONTENT_CLASS}>
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
    <ContextMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={MENU_ITEM_CLASS}
    >
      <AppMenuItemContent icon={icon} trailing={trailing}>
        {children}
      </AppMenuItemContent>
    </ContextMenu.Item>
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
      <ContextMenu.SubTrigger
        className={cn(MENU_ITEM_CLASS, 'data-[state=open]:bg-bg-hover')}
      >
        <AppMenuItemContent
          icon={icon}
          trailing={<ChevronRight className="size-3.5" />}
        >
          {label}
        </AppMenuItemContent>
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent className={MENU_CONTENT_CLASS} sideOffset={2}>
          {children}
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}

export function AppDropdownMenu({
  trigger,
  children,
  align = 'end',
  contentClassName,
}: {
  trigger: ReactElement;
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
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
          sideOffset={4}
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
    <DropdownMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={MENU_ITEM_CLASS}
    >
      <AppMenuItemContent icon={icon} trailing={trailing}>
        {children}
      </AppMenuItemContent>
    </DropdownMenu.Item>
  );
}
