import { useId, useMemo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ChevronDown, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import { ChannelIcon } from "@/components/ChannelIcon";
import { FILTER_SELECT_TRIGGER_CLASS } from "@/components/ui/filter-select";
import { useRovingList, isImeComposing } from "@/features/task-shell/model/task-filter-keyboard";
import { OptionRow, type ChannelOption } from "@/features/task-shell/components/task-filter-bar";

/**
 * The create dialog's channel picker — a searchable combobox, NOT the plain
 * grouped Select the dialog first shipped. shiki 2026-07-29: a two-section
 * Workspaces/DMs split is still too long to scan, so options are (1) grouped
 * under ONE header per workspace / per DM (the source name), and (2) filterable
 * by a search box up top.
 *
 * This is a REQUIRED single-select — there is no "All" row (unlike the filter
 * bar's channel filter, whose null value means "no filter"). It reuses the
 * filter bar's `OptionRow` on purpose: the selected row wears the app-wide
 * selected-row vocabulary (`--bg-row-selected` fill + `--text-on-selected` ink),
 * the SAME colour the filter options use — never the magenta `accent-soft` tint
 * (shiki: the pink selected background was wrong). Keyboard nav rides the shared
 * `useRovingList` so arrows / Enter / Esc behave like every other task dropdown.
 */
export function CreateTaskChannelPicker({
  channelOptions,
  value,
  onChange,
}: {
  channelOptions: ChannelOption[];
  /** Selected channel id; '' when nothing is picked yet. */
  value: string;
  onChange: (id: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = value ? (channelOptions.find((o) => o.id === value) ?? null) : null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return channelOptions;
    return channelOptions.filter(
      (o) => o.label.toLowerCase().includes(q) || (o.sublabel?.toLowerCase().includes(q) ?? false),
    );
  }, [channelOptions, query]);

  // One group per workspace / per agent space, keyed by workspaceId and titled
  // by the source name (`sublabel`: the workspace name, or the agent's name for
  // an agent space — #task:2044). Regular workspaces sort before agent spaces;
  // insertion order is preserved within a group and
  // across same-kind groups (stable sort, comparator returns 0 on a tie).
  const groups = useMemo(() => {
    const byWorkspace = new Map<
      string,
      { title: string | null; group: ChannelOption["group"]; items: ChannelOption[] }
    >();
    for (const o of filtered) {
      let g = byWorkspace.get(o.workspaceId);
      if (!g) {
        g = { title: o.sublabel ?? null, group: o.group, items: [] };
        byWorkspace.set(o.workspaceId, g);
      }
      g.items.push(o);
    }
    return [...byWorkspace.values()].sort((a, b) =>
      a.group === b.group ? 0 : a.group === "workspace" ? -1 : 1,
    );
  }, [filtered]);

  // Flat, in-render-order list for roving keyboard nav — matches the visual
  // order (group by group) so arrows walk the list as it reads.
  const flatOptions = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const optionIndex = useMemo(() => {
    const m = new Map<string, number>();
    flatOptions.forEach((o, i) => m.set(o.id, i));
    return m;
  }, [flatOptions]);
  const listId = useId();
  const optionId = (index: number): string => `${listId}-opt-${index}`;
  const roving = useRovingList({
    count: flatOptions.length,
    open,
    resetKey: query,
    onSelect: (index) => {
      const o = flatOptions[index];
      if (o) {
        onChange(o.id);
        setOpen(false);
      }
    },
  });

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Channel"
          // Bordered field surface, like the dialog's Title input: forza6 paints
          // the poster ink frame + drop shadow off `[data-input]` (SSOT comment
          // in forza6-components.css). NOT `role='combobox'` — the inner search
          // input already carries that role, and a second combobox on the trigger
          // would confuse AT. Other themes leave `[data-input]` flat.
          data-input=""
          className={cn(FILTER_SELECT_TRIGGER_CLASS, "h-9")}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {selected ? (
              <>
                <ChannelIcon variant="sticker" />
                <span className="truncate">{selected.label}</span>
              </>
            ) : (
              <span className="text-text-muted">Select a channel</span>
            )}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-text-muted" />
        </button>
      </Popover.Trigger>
      <Popover.Content
        align="start"
        sideOffset={4}
        data-dropdown-frame
        // NO Popover.Portal: this picker lives inside a Radix Dialog, whose
        // scroll-lock (react-remove-scroll) blocks wheel scrolling on any
        // content portaled out to <body> — the list would open but refuse to
        // scroll (shiki 2026-07-30). Rendering inline keeps the panel inside the
        // dialog's own scroll-allowed subtree. The trade-off is that the search
        // box now sits inside the host <form>, so its Enter is guarded below so
        // it can never submit the form.
        className="z-(--z-popover) flex max-h-[42vh] w-(--radix-popover-trigger-width) min-w-60 flex-col rounded-(--select-content-radius) bg-bg-floating p-1 shadow-popover outline-none"
      >
        <div
          data-input=""
          className="flex items-center gap-1.5 rounded-(--control-radius) border-(length:--control-border-width) border-border bg-bg-base px-2 py-1.5 transition-colors focus-within:border-border-focus"
        >
          <Search className="size-3.5 shrink-0 text-text-muted" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Rendered inline (see above), so the search box is inside the host
              // <form>: a bare Enter would submit it. Swallow Enter here — except
              // while an IME composition is committing a candidate, where the key
              // belongs to the input method. Reads the SAME `isImeComposing`
              // predicate as the roving helper so the two can't drift (a legacy
              // keyCode===229 Enter must NOT be prevented here, matching the
              // reducer's bypass). Row selection is driven by the roving helper,
              // never by form submit.
              if (e.key === "Enter" && !isImeComposing(e.nativeEvent)) {
                e.preventDefault();
              }
              roving.onKeyDown(e);
            }}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-activedescendant={
              flatOptions.length > 0 ? optionId(roving.activeIndex) : undefined
            }
            placeholder="Search channels…"
            className="w-full bg-transparent text-xs text-text-primary outline-none placeholder:text-text-muted"
          />
        </div>
        <div role="listbox" id={listId} className="mt-1 min-h-0 flex-1 overflow-y-auto">
          {groups.map((g, gi) => (
            <div key={g.items[0]?.workspaceId ?? gi}>
              {g.title ? (
                <div className="px-2 pb-1 pt-2 text-(length:--text-badge) font-semibold uppercase tracking-wider text-text-muted">
                  {g.title}
                </div>
              ) : null}
              {g.items.map((o) => {
                const index = optionIndex.get(o.id) ?? -1;
                return (
                  <OptionRow
                    key={o.id}
                    selected={value === o.id}
                    active={roving.activeIndex === index}
                    id={optionId(index)}
                    optionRef={(el) => roving.registerItem(index, el)}
                    onHover={() => roving.setActiveIndex(index)}
                    onSelect={() => {
                      onChange(o.id);
                      setOpen(false);
                    }}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="shrink-0 text-text-muted">
                        <ChannelIcon variant="sticker" />
                      </span>
                      <span className="truncate">{o.label}</span>
                    </span>
                  </OptionRow>
                );
              })}
            </div>
          ))}
          {flatOptions.length === 0 ? (
            <p className="px-2 py-3 text-center text-(length:--text-meta) italic text-text-muted">
              No matches
            </p>
          ) : null}
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}
