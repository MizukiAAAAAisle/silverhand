import { useMemo } from 'react';
import { Bookmark, Search } from 'lucide-react';
import { cn } from '@/lib/cn';
import { CURRENT_USER_ID, formatUserDisplayName } from '@/lib/current-user';
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
  /** Dedicated global search view under the chat section. */
  searchActive: boolean;
  onSelectSearch: () => void;
  /** Live count from the saved-messages query cache. Pass undefined
   *  on first paint (before the query resolves) so the badge stays
   *  hidden instead of flashing 0. */
  savedCount: number | undefined;
}

export function Sidebar(props: SidebarProps): JSX.Element {
  const { dms, regular, archived } = useMemo(() => {
    const dms: ChannelItem[] = [];
    const regular: ChannelItem[] = [];
    const archived: ChannelItem[] = [];
    for (const c of props.channels) {
      if (c.archived) archived.push(c);
      else if (c.kind === 'dm') dms.push(c);
      else regular.push(c);
    }
    return { dms, regular, archived };
  }, [props.channels]);

  // While the Saved view is active, suppress channel highlighting so
  // the Saved entry visually owns selection.
  const channelHighlight =
    props.savedActive || props.searchActive ? null : props.selectedChannelId;

  return (
    <aside className="flex h-full w-[var(--sidebar-width)] shrink-0 flex-col bg-[var(--bg-channels-sidebar)]">
      <nav className="flex-1 overflow-y-auto py-1.5">
        <button
          type="button"
          onClick={props.onSelectSearch}
          className={cn(
            'mx-1.5 mb-1 flex w-[calc(100%-0.75rem)] items-center gap-2 border-2 px-2 py-1.5 text-left text-sm transition-colors',
            props.searchActive
              ? 'border-accent bg-bg-selected text-text-on-selected'
              : 'border-transparent text-text-secondary hover:border-accent hover:bg-white/70 hover:text-text-primary',
          )}
        >
          <Search className="size-3.5" />
          <span>Search</span>
        </button>

        <button
          type="button"
          onClick={props.onSelectSaved}
          className={cn(
            'mx-1.5 mb-1.5 flex w-[calc(100%-0.75rem)] items-center gap-2 border-2 px-2 py-1.5 text-left text-sm transition-colors',
            props.savedActive
              ? 'border-accent bg-bg-selected text-text-on-selected'
              : 'border-transparent text-text-secondary hover:border-accent hover:bg-white/70 hover:text-text-primary',
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
        {archived.length > 0 ? (
          <ChannelGroup
            label="ARCHIVED"
            kind="regular"
            channels={archived}
            selectedChannelId={channelHighlight}
            onSelectChannel={props.onSelectChannel}
            defaultExpanded={false}
          />
        ) : null}
      </nav>

      <div className="border-t border-border-subtle px-3 py-2.5">
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <div className="size-7 rounded-full bg-bg-elevated" />
          <div className="min-w-0 flex-1 truncate text-text-secondary">
            {formatUserDisplayName(CURRENT_USER_ID)}
          </div>
        </div>
      </div>
    </aside>
  );
}
