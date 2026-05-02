import { useMemo, useState } from 'react';
import { Bookmark } from 'lucide-react';
import dayjs from 'dayjs';
import type { SavedMessageDto } from '@silverhand/shared';
import { Markdown } from '@/components/chat/Markdown';
import { useSavedMessages, useUnsaveMessage } from '@/features/saved/hooks';

interface SavedListViewProps {
  /** Called when the user clicks a saved entry. The parent owns view
   *  routing — flips back to channel view, selects the channel +
   *  session, and forwards the message id to the next SessionView
   *  render so it can scroll + flash. */
  onJump: (params: {
    channelId: string;
    sessionId: string;
    messageId: string;
  }) => void;
}

export function SavedListView({ onJump }: SavedListViewProps): JSX.Element {
  const { data, isLoading } = useSavedMessages();
  const unsave = useUnsaveMessage();

  return (
    <main className="flex h-full flex-1 flex-col bg-bg-base">
      <header className="flex h-[var(--titlebar-height)] shrink-0 items-center gap-2 border-b border-border-subtle px-4">
        <Bookmark className="size-3.5 fill-current text-accent" />
        <span className="font-serif text-sm font-semibold text-text-primary">
          Saved
        </span>
        {data ? (
          <span className="text-xs text-text-muted">{data.length}</span>
        ) : null}
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {isLoading ? (
          <div className="text-sm text-text-muted">加载中…</div>
        ) : !data || data.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-text-muted">
            还没有 saved 消息。在任意消息上 hover 后点 bookmark。
          </div>
        ) : (
          <ul className="space-y-2">
            {data.map(item => (
              <SavedItem
                key={item.id}
                item={item}
                onJump={() =>
                  onJump({
                    channelId: item.channel_id,
                    sessionId: item.session_id,
                    messageId: item.message.id,
                  })
                }
                onUnsave={() => unsave.mutate(item.message.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

function SavedItem({
  item,
  onJump,
  onUnsave,
}: {
  item: SavedMessageDto;
  onJump: () => void;
  onUnsave: () => void;
}): JSX.Element {
  const [hover, setHover] = useState(false);
  const sender = useMemo(() => {
    if (item.message.from_kind === 'user') return 'you';
    if (item.agent_name) return `@${item.agent_name}`;
    return '@agent';
  }, [item]);
  const when = useMemo(
    () => dayjs(item.saved_at).format('YYYY-MM-DD HH:mm'),
    [item.saved_at],
  );

  return (
    <li>
      {/* The whole card is clickable. Bookmark/unsave is a nested button —
          stopPropagation prevents it from firing the jump. */}
      <div
        role="button"
        tabIndex={0}
        onClick={onJump}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onJump();
          }
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        className={
          'border-2 bg-bg-floating px-4 py-3 transition-colors ' +
          (hover ? 'border-accent' : 'border-border')
        }
      >
        <header className="mb-2 flex items-center gap-2 text-xs text-text-muted">
          <span className="font-medium text-text-primary">#{item.channel_name}</span>
          <span>·</span>
          <span className="truncate">{item.session_title}</span>
          <span>·</span>
          <span>{sender}</span>
          <span>·</span>
          <span>{when}</span>
          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              onUnsave();
            }}
            className="ml-auto text-accent hover:text-accent-hover"
            title="取消保存"
            aria-label="取消保存"
          >
            <Bookmark className="size-3.5 fill-current" />
          </button>
        </header>

        <div className="text-sm text-text-primary">
          <Markdown content={item.message.content} />
        </div>
      </div>
    </li>
  );
}
