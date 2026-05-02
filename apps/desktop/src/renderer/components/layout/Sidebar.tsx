import { useMemo } from 'react';
import { Bookmark } from 'lucide-react';
import { cn } from '@/lib/cn';
import { ChannelGroup, type ChannelItem } from './ChannelsPanel';

interface SidebarProps {
  channels: ChannelItem[];
  selectedChannelId: string | null;
  onSelectChannel: (id: string) => void;
  onCreateChannel: () => void;
  /** When true, the Saved view is the active main view — channel rows
   *  appear unselected and the Saved entry highlights instead. */
  savedActive: boolean;
  onSelectSaved: () => void;
  /** Live count from the saved-messages query cache. Pass undefined
   *  on first paint (before the query resolves) so the badge stays
   *  hidden instead of flashing 0. */
  savedCount: number | undefined;
}

export function Sidebar(props: SidebarProps): JSX.Element {
  const { dms, regular } = useMemo(() => {
    const dms: ChannelItem[] = [];
    const regular: ChannelItem[] = [];
    for (const c of props.channels) {
      (c.kind === 'dm' ? dms : regular).push(c);
    }
    return { dms, regular };
  }, [props.channels]);

  // While the Saved view is active, suppress channel highlighting so
  // the Saved entry visually owns selection.
  const channelHighlight = props.savedActive ? null : props.selectedChannelId;

  return (
    <aside className="flex h-full w-[var(--sidebar-width)] flex-col bg-[var(--bg-channels-sidebar)]">
      <nav className="flex-1 overflow-y-auto py-1.5">
        <button
          type="button"
          onClick={props.onSelectSaved}
          className={cn(
            'mx-1.5 mb-1.5 flex w-[calc(100%-0.75rem)] items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
            props.savedActive
              ? 'bg-bg-selected text-text-on-selected'
              : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
          )}
        >
          <Bookmark
            className={cn(
              'size-3.5',
              props.savedActive ? 'fill-current' : '',
            )}
          />
          <span>Saved</span>
          {props.savedCount !== undefined && props.savedCount > 0 ? (
            <span
              className={cn(
                'text-xs tabular-nums',
                props.savedActive ? 'text-text-on-selected/70' : 'text-text-muted',
              )}
            >
              {props.savedCount}
            </span>
          ) : null}
        </button>

        <ChannelGroup
          label="DM"
          kind="dm"
          channels={dms}
          selectedChannelId={channelHighlight}
          onSelectChannel={props.onSelectChannel}
          emptyHint="新建 agent 时会自动创建 DM"
        />
        <ChannelGroup
          label="CHANNELS"
          kind="regular"
          channels={regular}
          selectedChannelId={channelHighlight}
          onSelectChannel={props.onSelectChannel}
          onAdd={props.onCreateChannel}
          emptyHint={
            <>
              还没有频道。点{' '}
              <kbd className="rounded bg-bg-elevated px-1 py-0.5">+</kbd> 新建。
            </>
          }
        />
      </nav>

      <div className="border-t border-border-subtle px-3 py-2.5">
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <div className="size-7 rounded-full bg-bg-elevated" />
          <div className="min-w-0 flex-1 truncate text-text-secondary">local</div>
        </div>
      </div>
    </aside>
  );
}
