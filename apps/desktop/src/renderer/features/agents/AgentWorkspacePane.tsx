import { useEffect, useMemo, useState } from 'react';
import {
  ChevronRight,
  Copy,
  File as FileIcon,
  FileText,
  Folder,
  FolderOpen,
  RefreshCcw,
} from 'lucide-react';
import dayjs from 'dayjs';
import { useQueryClient } from '@tanstack/react-query';
import type {
  AgentWorkspaceTree,
  AgentWorkspaceTreeNode,
} from '@silverhand/shared';
import { Markdown } from '@/components/chat/Markdown';
import { cn } from '@/lib/cn';
import { useAgentWorkspaceFile, useAgentWorkspaceTree } from './hooks';

interface AgentWorkspacePaneProps {
  agentId: string;
  /** The agent's host_id, used to gate the "Reveal in Finder" affordance.
   *  We don't have an absolute fs path on the wire anymore (the daemon
   *  owns paths, the wire only carries virtual ones); the gate stays as
   *  a visibility hint for the local-host case. */
  hostId: string;
  /** True when the user owns the agent's host AND that host is the
   *  local desktop session — only then can `showItemInFolder` reach a
   *  meaningful absolute path. We don't currently surface a "reveal"
   *  for the new pane (no absolute path on the wire); kept on the prop
   *  surface for forward-compat. */
  canRevealPath: boolean;
}

/**
 * #task:811 — two-column read-only browser for the agent's home
 * workspace files (`~/.silverhand/agents/<id>/`).
 *
 * Why two protocols, not one:
 *  - The old single-shot snapshot route (`AgentWorkspaceCard`) baked
 *    the renderer's categorisation into the wire (`system_prompt` /
 *    `MEMORY` / `notes`). That wire shape locked the UI: any future
 *    file (e.g. `CONSENSUS.md` lives at the workspace level today, but
 *    a per-agent variant would have nowhere to go) needed wire churn.
 *  - The new pair speaks one virtual-path namespace rooted at the
 *    agent home dir. The UI can categorize (or not) however it wants;
 *    new files just appear in the tree.
 *
 * Layout:
 *
 *   ┌────────────────────────────┬──────────────────────────────────┐
 *   │ Tree (320px, scroll)       │ Preview (flex-1, scroll)         │
 *   │  ▾ notes/                  │  notes/work-log.md  · 2.4 KB     │
 *   │     ⋄ project.md           │  ─────────────────────────────── │
 *   │     ⋄ work-log.md ◀ sel    │  Rendered markdown with syntax   │
 *   │  ⋄ MEMORY.md               │  highlighting via the existing   │
 *   │  ⋄ system_prompt.md        │  Markdown component.             │
 *   └────────────────────────────┴──────────────────────────────────┘
 *
 * The right column always renders something — a placeholder for the
 * empty state (no file selected), a loading shimmer while the file
 * fetches, an error banner for typed daemon errors, and a 64KB
 * truncation banner above the content when the daemon flagged
 * `truncated:true`.
 */
export function AgentWorkspacePane({
  agentId,
  // hostId / canRevealPath kept on the surface for forward-compat —
  // an absolute-path "reveal" affordance can come back when the wire
  // grows a "where on disk is this?" field. For now the daemon owns
  // paths and the renderer never sees them.
  hostId: _hostId,
  canRevealPath: _canRevealPath,
}: AgentWorkspacePaneProps): JSX.Element {
  const treeQuery = useAgentWorkspaceTree(agentId);
  const qc = useQueryClient();

  // Selected path: default to the first FILE in the tree once loaded
  // so the preview has something to show. We deliberately skip
  // directories — clicking a dir collapses/expands but never selects
  // a file (no file → no preview).
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  useEffect(() => {
    if (selectedPath !== null) return;
    const firstFile = treeQuery.data?.nodes.find(n => n.kind === 'file');
    if (firstFile) setSelectedPath(firstFile.path);
  }, [treeQuery.data, selectedPath]);

  // If the selected path disappears between refreshes (the agent
  // deleted a note while we were looking at it), drop the selection
  // so the preview falls back to the placeholder. The next render
  // re-runs the auto-select effect above.
  useEffect(() => {
    if (selectedPath === null) return;
    const stillExists = treeQuery.data?.nodes.some(
      n => n.kind === 'file' && n.path === selectedPath,
    );
    if (treeQuery.data && !stillExists) setSelectedPath(null);
  }, [treeQuery.data, selectedPath]);

  const onRefresh = () => {
    qc.invalidateQueries({
      queryKey: ['agents', agentId, 'workspace'],
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <header className="flex shrink-0 items-center gap-3">
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-text-muted">
          Agent home —{' '}
          <span className="font-mono">system_prompt.md</span> is global
          identity;{' '}
          <span className="font-mono">MEMORY.md</span> +{' '}
          <span className="font-mono">notes/</span> are this workspace's memory.
        </p>
        <button
          type="button"
          onClick={onRefresh}
          disabled={treeQuery.isFetching}
          data-panel-control="row-action"
          className="inline-flex h-7 w-7 items-center justify-center text-text-muted transition-all duration-150 hover:scale-110 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus disabled:opacity-50 disabled:hover:scale-100"
          aria-label="Refresh workspace files"
          title="Refresh"
        >
          <RefreshCcw
            className={cn('size-3.5', treeQuery.isFetching && 'animate-spin')}
          />
        </button>
      </header>

      <div
        // Routed through `--card-radius` so warm/forza6 stay 0 (poster
        // hard-cut) and slack-dark gets 8px (Slack-style rounded
        // container with hairline border). #task:912 review round 6.
        className="flex min-h-0 flex-1 overflow-hidden rounded-[var(--card-radius)] border border-border-subtle bg-bg-floating"
      >
        <aside className="flex w-[280px] shrink-0 flex-col overflow-y-auto border-r border-border-subtle bg-bg-base">
          {treeQuery.isLoading ? (
            <div className="px-3 py-3 text-xs text-text-muted">Loading…</div>
          ) : treeQuery.isError ? (
            <div className="px-3 py-3 text-xs text-error">
              Failed to load workspace files.
            </div>
          ) : treeQuery.data && treeQuery.data.nodes.length === 0 ? (
            <div className="px-3 py-3 text-xs text-text-muted">
              No files here yet.
            </div>
          ) : treeQuery.data ? (
            <WorkspaceFileTree
              tree={treeQuery.data}
              selectedPath={selectedPath}
              onSelect={setSelectedPath}
            />
          ) : null}
        </aside>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <WorkspaceFilePreview agentId={agentId} path={selectedPath} />
        </section>
      </div>
    </div>
  );
}

/**
 * Render the flat tree as an indented list. The wire shape is flat
 * (`{ path, kind }[]`), already sorted (parent dir, kind=directory
 * first, name); we walk it once, computing depth from segment count.
 *
 * Directories track an open/closed state — a closed directory hides
 * its descendants from the rendered list (we never re-fetch; the
 * filter is purely UI). Directories themselves are not selectable;
 * their click toggles open/closed.
 */
function WorkspaceFileTree({
  tree,
  selectedPath,
  onSelect,
}: {
  tree: AgentWorkspaceTree;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}): JSX.Element {
  // Default: every directory open. A user with a deeply-nested notes
  // tree can still collapse them; for the common case (top-level
  // files + one `notes/` dir) the tree should read as "everything
  // visible" out of the box.
  const allDirs = useMemo(
    () => tree.nodes.filter(n => n.kind === 'directory').map(n => n.path),
    [tree],
  );
  const [openDirs, setOpenDirs] = useState<Set<string>>(() => new Set(allDirs));
  // Newly-discovered dirs (after a refresh) auto-open so the user
  // doesn't have to chase the new entries down.
  useEffect(() => {
    setOpenDirs(prev => {
      const next = new Set(prev);
      for (const dir of allDirs) next.add(dir);
      return next;
    });
  }, [allDirs]);

  const toggleDir = (path: string) =>
    setOpenDirs(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const isHidden = (path: string): boolean => {
    // A node is hidden if any of its parent dirs is closed.
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const ancestor = parts.slice(0, i).join('/');
      if (!openDirs.has(ancestor)) return true;
    }
    return false;
  };

  return (
    <ul className="flex flex-col py-1 text-[12px]">
      {tree.nodes.map(node => {
        if (isHidden(node.path)) return null;
        const depth = node.path.split('/').length - 1;
        return (
          <li key={`${node.kind}:${node.path}`}>
            <TreeRow
              node={node}
              depth={depth}
              selected={node.kind === 'file' && node.path === selectedPath}
              isOpen={node.kind === 'directory' && openDirs.has(node.path)}
              onSelect={onSelect}
              onToggle={toggleDir}
            />
          </li>
        );
      })}
    </ul>
  );
}

function TreeRow({
  node,
  depth,
  selected,
  isOpen,
  onSelect,
  onToggle,
}: {
  node: AgentWorkspaceTreeNode;
  depth: number;
  selected: boolean;
  isOpen: boolean;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}): JSX.Element {
  const name = leafName(node.path);
  const indent = 8 + depth * 14;
  if (node.kind === 'directory') {
    return (
      <button
        type="button"
        onClick={() => onToggle(node.path)}
        className={cn(
          // Row vocabulary — picks up theme `--row-radius` (warm/forza6 = 0
          // for scan-line, slack-dark = 6px for Slack-style soft list rows).
          // #task:912 review round 4.
          'flex w-full items-center gap-1.5 rounded-[var(--row-radius)] py-1 pr-2 text-left text-text-secondary hover:bg-bg-hover',
        )}
        style={{ paddingLeft: indent }}
        title={node.path}
      >
        <ChevronRight
          className={cn(
            'size-3 shrink-0 text-text-muted transition-transform duration-150',
            isOpen && 'rotate-90',
          )}
        />
        {isOpen ? (
          <FolderOpen className="size-3.5 shrink-0 text-text-muted" />
        ) : (
          <Folder className="size-3.5 shrink-0 text-text-muted" />
        )}
        <span className="truncate font-mono">{name}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onSelect(node.path)}
      className={cn(
        // Row vocabulary — see DirNode comment above; same `--row-radius`
        // token covers folder + file rows so the tree reads as a single
        // surface. #task:912 review round 4.
        'flex w-full items-center gap-1.5 rounded-[var(--row-radius)] py-1 pr-2 text-left',
        selected
          ? 'bg-accent-2 text-text-on-accent-2'
          : 'text-text-primary hover:bg-bg-hover',
      )}
      style={{ paddingLeft: indent + 14 /* align with dir name col */ }}
      title={node.path}
    >
      <FileGlyph name={name} selected={selected} />
      <span className="truncate font-mono">{name}</span>
    </button>
  );
}

/** Pick a glyph based on the file extension. Markdown gets the
 *  document glyph (richer affordance — the preview will render it),
 *  everything else gets the generic file glyph. We deliberately
 *  don't drive a wider glyph palette here; the goal is "this is a
 *  text file you can read", not full file-type theming. */
function FileGlyph({
  name,
  selected,
}: {
  name: string;
  selected: boolean;
}): JSX.Element {
  const cls = cn(
    'size-3.5 shrink-0',
    selected ? 'text-text-on-accent-2' : 'text-text-muted',
  );
  if (name.endsWith('.md') || name.endsWith('.markdown')) {
    return <FileText className={cls} />;
  }
  return <FileIcon className={cls} />;
}

function leafName(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

function WorkspaceFilePreview({
  agentId,
  path,
}: {
  agentId: string;
  path: string | null;
}): JSX.Element {
  const fileQuery = useAgentWorkspaceFile(agentId, path);
  if (path === null) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-text-muted">
        Select a file to preview.
      </div>
    );
  }
  if (fileQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-text-muted">
        Loading {leafName(path)}…
      </div>
    );
  }
  if (fileQuery.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center text-xs text-error">
        <span className="font-medium">Failed to read {leafName(path)}.</span>
        <span className="text-text-muted">
          {(fileQuery.error as Error)?.message ?? 'unknown error'}
        </span>
      </div>
    );
  }
  if (!fileQuery.data) return <div />;
  const file = fileQuery.data;
  const isMarkdown = path.endsWith('.md') || path.endsWith('.markdown');
  return (
    <>
      <header className="flex shrink-0 items-center gap-2 border-b border-border-subtle bg-bg-base px-4 py-2">
        <FileText className="size-3.5 shrink-0 text-text-muted" />
        <span
          className="min-w-0 flex-1 truncate font-mono text-[12px] text-text-primary"
          title={path}
        >
          {path}
        </span>
        <span className="shrink-0 text-[11px] text-text-muted">
          {formatBytes(file.size)} · {dayjs(file.mtime).format('YYYY-MM-DD HH:mm')}
        </span>
        <button
          type="button"
          data-panel-control="row-action"
          className="inline-flex size-6 items-center justify-center text-text-muted transition-colors hover:text-text-primary"
          aria-label="Copy file path"
          title="Copy path"
          onClick={() => void navigator.clipboard.writeText(path)}
        >
          <Copy className="size-3" />
        </button>
      </header>
      {file.truncated ? (
        <div
          data-panel-card="placeholder"
          className="shrink-0 border-b border-warning/40 bg-warning/10 px-4 py-2 text-[11px] text-text-on-warning"
        >
          Preview truncated at 64 KB. The full file lives on the agent's host —
          not all of it is shown here.
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto bg-bg-floating px-4 py-3 text-sm text-text-primary">
        {isMarkdown ? (
          <Markdown content={file.content} />
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-[12px]">
            {file.content}
          </pre>
        )}
      </div>
    </>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
