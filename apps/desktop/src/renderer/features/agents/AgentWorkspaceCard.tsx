import { useState } from 'react';
import { ChevronDown, ChevronRight, Copy, FolderOpen } from 'lucide-react';
import dayjs from 'dayjs';
import type {
  AgentWorkspaceDto,
  AgentWorkspaceFilePreview,
} from '@silverhand/shared';
import { Markdown } from '@/components/chat/Markdown';

interface AgentWorkspaceCardProps {
  workspace: AgentWorkspaceDto | undefined;
  isLoading: boolean;
}

export function AgentWorkspaceCard({
  workspace,
  isLoading,
}: AgentWorkspaceCardProps): JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-start justify-between gap-3">
        <p className="text-xs leading-relaxed text-text-muted">
          L1 (global) — what's here is shared across every channel this
          agent participates in.
        </p>
        {workspace ? <PathBar path={workspace.l1_path} /> : null}
      </header>

      {isLoading ? (
        <div className="text-sm text-text-muted">Loading…</div>
      ) : workspace ? (
        <div className="flex flex-col gap-3">
          <FileBlock
            title="system_prompt.md"
            file={workspace.system_prompt}
            defaultOpen
          />
          <FileBlock title="MEMORY.md" file={workspace.memory} defaultOpen />
          <NotesBlock notes={workspace.notes} />
        </div>
      ) : null}
    </div>
  );
}

function PathBar({ path }: { path: string }): JSX.Element {
  const onCopy = () => void navigator.clipboard.writeText(path);
  const onReveal = () => void window.agentHub.showItemInFolder(path);
  return (
    <div className="flex shrink-0 items-center gap-1 text-xs text-text-muted">
      <code
        className="max-w-[260px] truncate rounded bg-bg-base px-2 py-0.5 font-mono"
        dir="rtl"
        title={path}
      >
        {path}
      </code>
      <button
        type="button"
        className="flex size-6 items-center justify-center rounded text-text-muted hover:bg-bg-hover hover:text-text-primary"
        title="Copy path"
        onClick={onCopy}
      >
        <Copy className="size-3" />
      </button>
      <button
        type="button"
        className="flex size-6 items-center justify-center rounded text-text-muted hover:bg-bg-hover hover:text-text-primary"
        title="Reveal in Finder"
        onClick={onReveal}
      >
        <FolderOpen className="size-3.5" />
      </button>
    </div>
  );
}

function FileBlock({
  title,
  file,
  defaultOpen,
}: {
  title: string;
  file: AgentWorkspaceFilePreview | null;
  defaultOpen?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(!!defaultOpen);
  if (!file) {
    return (
      <div className="rounded-md border border-dashed border-border-subtle px-3 py-2 text-xs text-text-muted">
        {title} — not present yet
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-md border border-border-subtle">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center gap-2 bg-bg-base px-3 py-1.5 text-left text-xs text-text-secondary hover:bg-bg-hover"
      >
        {open ? (
          <ChevronDown className="size-3 text-text-muted" />
        ) : (
          <ChevronRight className="size-3 text-text-muted" />
        )}
        <span className="font-mono text-text-primary">{title}</span>
        <span className="ml-auto flex items-center gap-2 text-[11px] text-text-muted">
          <span>{formatBytes(file.size)}</span>
          <span>·</span>
          <span>{dayjs(file.mtime).format('YYYY-MM-DD HH:mm')}</span>
        </span>
      </button>
      {open ? (
        <div className="max-h-64 overflow-auto bg-bg-floating px-4 py-3 text-sm text-text-primary">
          <Markdown content={file.content} />
        </div>
      ) : null}
    </div>
  );
}

function NotesBlock({
  notes,
}: {
  notes: AgentWorkspaceDto['notes'];
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="overflow-hidden rounded-md border border-border-subtle">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center gap-2 bg-bg-base px-3 py-1.5 text-left text-xs text-text-secondary hover:bg-bg-hover"
      >
        {open ? (
          <ChevronDown className="size-3 text-text-muted" />
        ) : (
          <ChevronRight className="size-3 text-text-muted" />
        )}
        <span className="font-mono text-text-primary">notes/</span>
        <span className="ml-auto text-[11px] text-text-muted">
          {notes.length} file{notes.length === 1 ? '' : 's'}
        </span>
      </button>
      {open ? (
        notes.length === 0 ? (
          <div className="px-4 py-3 text-xs text-text-muted">
            No notes yet. Agent will fill this with cross-channel knowledge.
          </div>
        ) : (
          <ul className="bg-bg-floating">
            {notes.map(n => (
              <li
                key={n.name}
                className="flex items-center gap-2 border-t border-border-subtle px-4 py-1.5 text-xs first:border-t-0"
              >
                <span className="font-mono text-text-primary">{n.name}</span>
                <span className="ml-auto flex items-center gap-2 text-[11px] text-text-muted">
                  <span>{formatBytes(n.size)}</span>
                  <span>·</span>
                  <span>{dayjs(n.mtime).format('YYYY-MM-DD HH:mm')}</span>
                </span>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
