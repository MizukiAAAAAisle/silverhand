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
import type {
  AgentWorkspaceFileRead,
  AgentWorkspaceTree,
  AgentWorkspaceTreeNode,
} from '@silverhand/shared';
import { Markdown } from '@/components/chat/Markdown';
import { cn } from '@/lib/cn';

/**
 * The read-only file browser for an agent's `.silverhand/agents/<id>/`
 * directory, factored out of `AgentWorkspacePane` so the **same renderer**
 * serves two data sources (#task:1191):
 *
 *  - the full members page → the agent **home** dir (L1 identity:
 *    `system_prompt.md` + the home `MEMORY.md`/`notes`);
 *  - the chat side panel → the **current workspace** L2 dir (`MEMORY.md` +
 *    `notes/` scoped to that workspace).
 *
 * The renderer is deliberately **source-blind**: it never builds a path and
 * never branches on home-vs-workspace. The container owns the queries (which
 * carry the source) and hands the resolved results in; the renderer only knows
 * "here is a tree, here is the selected file, render it." The only source-aware
 * inputs are the explicit `header` copy and `layout` props — everything else is
 * identical regardless of which dir is behind the wire. See Cindy #task:1190 for
 * the backend `workspace_id` scope this pairs with.
 */

/** Structural view of the tree query — just the fields the renderer reads, so
 *  the pure renderer stays decoupled from react-query's generic result type
 *  (any `UseQueryResult<AgentWorkspaceTree>` satisfies it). */
export interface WorkspaceTreeQuery {
  data: AgentWorkspaceTree | undefined;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
}

/** Structural view of the file query (see `WorkspaceTreeQuery`). */
export interface WorkspaceFileQuery {
  data: AgentWorkspaceFileRead | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
}

export type AgentWorkspaceLayout = 'full' | 'compact';

interface AgentWorkspaceBrowserProps {
  treeQuery: WorkspaceTreeQuery;
  fileQuery: WorkspaceFileQuery;
  selectedPath: string | null;
  onSelect: (path: string | null) => void;
  onRefresh: () => void;
  /** Source-specific descriptive copy shown in the header (e.g. "Agent home —
   *  system_prompt.md is global identity…" for home, "此 workspace 的 memory" for
   *  a scoped view). */
  header: React.ReactNode;
  /** `full` (default) = two-column tree + preview for the wide members page.
   *  `compact` = single-column drill-in for the narrow chat side panel. */
  layout?: AgentWorkspaceLayout;
}

/**
 * Lift selection out of the renderer so BOTH containers (home + scoped) share
 * the same "drop a selection that disappears" behaviour without duplicating the
 * effects. The container runs this against its own tree query, then feeds
 * `selectedPath` to its file query.
 *
 * `autoSelectFirstFile` (default true) auto-picks the first file when nothing is
 * selected — right for the two-column layout whose preview pane is always
 * visible (an empty preview pane looks broken). The compact drill-in passes `false`:
 * it must START at the file list, and auto-selecting would both skip the list
 * and make the `Files` back button (`onSelect(null)`) un-stickable, since this
 * effect would immediately re-pick (Cindy #task:1191 P1).
 */
export function useWorkspaceSelection(
  tree: AgentWorkspaceTree | undefined,
  options?: { autoSelectFirstFile?: boolean },
): {
  selectedPath: string | null;
  setSelectedPath: (path: string | null) => void;
} {
  const autoSelectFirstFile = options?.autoSelectFirstFile ?? true;
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  // Default to the first FILE once the tree loads so the preview has something
  // to show. Directories are skipped (no file → no preview). Gated on
  // `autoSelectFirstFile` so the compact drill-in stays on the list.
  useEffect(() => {
    if (!autoSelectFirstFile) return;
    if (selectedPath !== null) return;
    const firstFile = tree?.nodes.find(n => n.kind === 'file');
    if (firstFile) setSelectedPath(firstFile.path);
  }, [tree, selectedPath, autoSelectFirstFile]);

  // If the selected path disappears between refreshes (the agent deleted a note
  // while we were looking at it), drop the selection so the preview falls back
  // to the placeholder; the auto-select effect re-runs next render.
  useEffect(() => {
    if (selectedPath === null) return;
    const stillExists = tree?.nodes.some(
      n => n.kind === 'file' && n.path === selectedPath,
    );
    if (tree && !stillExists) setSelectedPath(null);
  }, [tree, selectedPath]);

  return { selectedPath, setSelectedPath };
}

export function AgentWorkspaceBrowser({
  treeQuery,
  fileQuery,
  selectedPath,
  onSelect,
  onRefresh,
  header,
  layout = 'full',
}: AgentWorkspaceBrowserProps): JSX.Element {
  return layout === 'compact' ? (
    <CompactBrowser
      treeQuery={treeQuery}
      fileQuery={fileQuery}
      selectedPath={selectedPath}
      onSelect={onSelect}
      onRefresh={onRefresh}
      header={header}
    />
  ) : (
    <FullBrowser
      treeQuery={treeQuery}
      fileQuery={fileQuery}
      selectedPath={selectedPath}
      onSelect={onSelect}
      onRefresh={onRefresh}
      header={header}
    />
  );
}

type LayoutBrowserProps = Omit<AgentWorkspaceBrowserProps, 'layout'>;

/**
 * Wide two-column layout for the members page: a 280px file tree on the left,
 * the preview filling the rest. Both columns scroll internally — the outer
 * column must NOT add its own scrollbar (#task:812).
 */
function FullBrowser({
  treeQuery,
  fileQuery,
  selectedPath,
  onSelect,
  onRefresh,
  header,
}: LayoutBrowserProps): JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <header className="flex shrink-0 items-center gap-3">
        <div className="min-w-0 flex-1 text-xs leading-relaxed text-text-muted">
          {header}
        </div>
        <RefreshButton onRefresh={onRefresh} isFetching={treeQuery.isFetching} />
      </header>

      <div
        // Routed through `--card-radius` so warm/forza6 stay 0 (poster
        // hard-cut) and slack-dark gets 8px. #task:912 review round 6.
        className="flex min-h-0 flex-1 overflow-hidden rounded-[var(--card-radius)] border border-border-subtle bg-bg-floating"
      >
        <aside className="flex w-[280px] shrink-0 flex-col overflow-y-auto border-r border-border-subtle bg-bg-base">
          <TreeColumn
            treeQuery={treeQuery}
            selectedPath={selectedPath}
            onSelect={onSelect}
          />
        </aside>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <WorkspaceFilePreview path={selectedPath} fileQuery={fileQuery} />
        </section>
      </div>
    </div>
  );
}

/**
 * Narrow single-column drill-in for the chat side panel: the file list fills
 * the panel; tapping a file slides to its preview with a back affordance. A
 * two-column tree+preview doesn't fit a ~360px dock, so we trade simultaneity
 * for fit — one thing on screen at a time, no horizontal cramming (#task:1191).
 */
function CompactBrowser({
  treeQuery,
  fileQuery,
  selectedPath,
  onSelect,
}: LayoutBrowserProps): JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {selectedPath === null ? (
        // No top toolbar in the drill-in list: the side panel passes no header
        // copy, and a bar holding only a refresh icon read as orphaned chrome
        // (shiki). The file list opens directly; refresh rides query staleness +
        // remount-on-reopen. The full members page keeps its refresh.
        <div className="min-h-0 flex-1 overflow-y-auto">
          <TreeColumn
            treeQuery={treeQuery}
            selectedPath={selectedPath}
            onSelect={onSelect}
          />
        </div>
      ) : (
        <>
          <header className="flex shrink-0 items-center gap-1.5 border-b border-border-subtle px-2 py-2">
            <button
              type="button"
              onClick={() => onSelect(null)}
              className="flex items-center rounded-[var(--row-radius)] p-1 text-text-muted transition-colors hover:text-text-primary"
              aria-label="Back to file list"
              title="Back to file list"
            >
              <ChevronRight className="size-4 rotate-180" />
            </button>
            <span
              className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-text-primary"
              title={selectedPath}
            >
              {leafName(selectedPath)}
            </span>
          </header>
          <div className="min-h-0 flex-1 overflow-hidden">
            <WorkspaceFilePreview
              path={selectedPath}
              fileQuery={fileQuery}
              variant="compact"
            />
          </div>
        </>
      )}
    </div>
  );
}

function RefreshButton({
  onRefresh,
  isFetching,
}: {
  onRefresh: () => void;
  isFetching: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onRefresh}
      disabled={isFetching}
      data-panel-control="row-action"
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center text-text-muted transition-all duration-150 hover:scale-110 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus disabled:opacity-50 disabled:hover:scale-100"
      aria-label="Refresh workspace files"
      title="Refresh"
    >
      <RefreshCcw className={cn('size-3.5', isFetching && 'animate-spin')} />
    </button>
  );
}

/** Tree column states (loading / error / empty / tree) shared by both layouts. */
function TreeColumn({
  treeQuery,
  selectedPath,
  onSelect,
}: {
  treeQuery: WorkspaceTreeQuery;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}): JSX.Element {
  if (treeQuery.isLoading) {
    return <div className="px-3 py-3 text-xs text-text-muted">Loading…</div>;
  }
  if (treeQuery.isError) {
    return (
      <div className="px-3 py-3 text-xs text-error">
        Failed to load workspace files.
      </div>
    );
  }
  if (treeQuery.data && treeQuery.data.nodes.length === 0) {
    return (
      <div className="px-3 py-3 text-xs text-text-muted">No files here yet.</div>
    );
  }
  if (treeQuery.data) {
    return (
      <WorkspaceFileTree
        tree={treeQuery.data}
        selectedPath={selectedPath}
        onSelect={onSelect}
      />
    );
  }
  return <></>;
}

/**
 * Render the flat tree as an indented list. The wire shape is flat
 * (`{ path, kind }[]`), already sorted (parent dir, kind=directory first,
 * name); we walk it once, computing depth from segment count.
 *
 * Directories track an open/closed state — a closed directory hides its
 * descendants from the rendered list (we never re-fetch; the filter is purely
 * UI). Directories themselves are not selectable; their click toggles
 * open/closed.
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
  // Default: every directory open. A user with a deeply-nested notes tree can
  // still collapse them; for the common case (top-level files + one `notes/`
  // dir) the tree should read as "everything visible" out of the box.
  const allDirs = useMemo(
    () => tree.nodes.filter(n => n.kind === 'directory').map(n => n.path),
    [tree],
  );
  const [openDirs, setOpenDirs] = useState<Set<string>>(() => new Set(allDirs));
  // Newly-discovered dirs (after a refresh) auto-open so the user doesn't have
  // to chase the new entries down.
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
          // Row vocabulary — picks up theme `--row-radius` (warm/forza6 = 0 for
          // scan-line, slack-dark = 6px for Slack-style soft list rows).
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
        // Row vocabulary — see DirNode comment above; same `--row-radius` token
        // covers folder + file rows so the tree reads as a single surface.
        // #task:912 review round 4.
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

/** Pick a glyph based on the file extension. Markdown gets the document glyph
 *  (richer affordance — the preview will render it), everything else gets the
 *  generic file glyph. We deliberately don't drive a wider glyph palette here;
 *  the goal is "this is a text file you can read", not full file-type theming. */
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

/**
 * File preview, fed an already-resolved file query (no hook coupling — the
 * container owns the source-scoped query). The `full` variant shows the full
 * path + size/mtime + copy-path header; `compact` drops the chrome (the
 * drill-in header already names the file) and only keeps the truncation banner
 * + body.
 */
function WorkspaceFilePreview({
  path,
  fileQuery,
  variant = 'full',
}: {
  path: string | null;
  fileQuery: WorkspaceFileQuery;
  variant?: AgentWorkspaceLayout;
}): JSX.Element {
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
        <span className="font-medium">Couldn't read {leafName(path)}.</span>
        <span className="text-text-muted">It may be unavailable right now.</span>
      </div>
    );
  }
  if (!fileQuery.data) return <div />;
  const file = fileQuery.data;
  const isMarkdown = path.endsWith('.md') || path.endsWith('.markdown');
  return (
    <div className="flex h-full min-h-0 flex-col">
      {variant === 'full' ? (
        <header className="flex shrink-0 items-center gap-2 border-b border-border-subtle bg-bg-base px-4 py-2">
          <FileText className="size-3.5 shrink-0 text-text-muted" />
          <span
            className="min-w-0 flex-1 truncate font-mono text-[12px] text-text-primary"
            title={path}
          >
            {path}
          </span>
          <span className="shrink-0 text-[11px] text-text-muted">
            {formatBytes(file.size)} ·{' '}
            {dayjs(file.mtime).format('YYYY-MM-DD HH:mm')}
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
      ) : null}
      {file.truncated ? (
        <div
          data-panel-card="placeholder"
          className="shrink-0 border-b border-warning/40 bg-warning/10 px-4 py-2 text-[11px] text-text-on-warning"
        >
          Preview truncated at 512 KB. The full file lives on the agent's host —
          not all of it is shown here.
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto bg-bg-floating px-4 py-3 text-sm text-text-primary">
        {isMarkdown ? (
          // No render budget here: a single large markdown file is not a
          // rendering problem, and the content is already bounded by the
          // daemon's read cap (the banner above says so when it bit).
          <Markdown content={file.content} renderBudget="unbounded" />
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-[12px]">
            {file.content}
          </pre>
        )}
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
