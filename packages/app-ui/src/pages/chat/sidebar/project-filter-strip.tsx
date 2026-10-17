import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import type { AgentDto } from "@silverhand/shared";
import { cn } from "@/lib/cn";
import { ChevronDownIcon, SearchIcon } from "@/icons";
import { Button } from "@/components/ui/button";
import { WorkspaceIcon } from "@/components/workspace-icon";
import { OptionRow } from "@/features/tasks/components/task-filter-bar";
import { useRovingList } from "@/features/tasks/model/task-filter-keyboard";
import { useCoarsePointer } from "@/navigation/layout";
import type { WorkspaceItem } from "./workspaces-panel";

/**
 * The Recent list's project filter: a strip of chips, and once the chips overflow,
 * a trigger that opens every project as a searchable list (pointer devices only).
 */
export function ProjectFilterStrip(props: {
  workspaces: readonly WorkspaceItem[];
  value: string | null;
  onChange: (workspaceId: string | null) => void;
  agentsById?: ReadonlyMap<string, AgentDto>;
  ownerAgentAvatarUrls: ReadonlyMap<string, string | null>;
}): JSX.Element {
  const stripRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const touch = useCoarsePointer();

  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) {
      return;
    }

    const measure = (): void => setOverflowing(strip.scrollWidth > strip.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [props.workspaces]);

  // A mouse wheel only scrolls vertically, so over the strip it moves the chips
  // sideways. The listener is native because React's wheel listener is passive
  // and cannot keep the list behind from scrolling too.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) {
      return;
    }

    const onWheel = (event: WheelEvent): void => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
        return;
      }
      if (strip.scrollWidth <= strip.clientWidth) {
        return;
      }
      event.preventDefault();
      strip.scrollLeft += event.deltaY;
    };
    strip.addEventListener("wheel", onWheel, { passive: false });
    return () => strip.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const chip = stripRef.current?.querySelector<HTMLElement>('[aria-checked="true"]');
    chip?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.value]);

  return (
    <>
      <div
        ref={stripRef}
        role="radiogroup"
        aria-label="Filter by project"
        className="scrollbar-hide flex min-w-0 flex-1 gap-1 overflow-x-auto mask-[linear-gradient(to_right,black_calc(100%-1.5rem),transparent)] pr-4"
      >
        <FilterChip
          label="All"
          selected={props.value === null}
          onSelect={() => props.onChange(null)}
        />
        {props.workspaces.map((w) => (
          <FilterChip
            key={w.id}
            label={w.name}
            selected={props.value === w.id}
            onSelect={() => props.onChange(w.id)}
          />
        ))}
      </div>
      {/* Touch swipes the strip natively; the picker answers the mouse. */}
      {overflowing && !touch ? <ProjectPicker {...props} /> : null}
    </>
  );
}

function ProjectPicker(props: {
  workspaces: readonly WorkspaceItem[];
  value: string | null;
  onChange: (workspaceId: string | null) => void;
  agentsById?: ReadonlyMap<string, AgentDto>;
  ownerAgentAvatarUrls: ReadonlyMap<string, string | null>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const listId = useId();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? props.workspaces.filter((w) => w.name.toLowerCase().includes(q)) : props.workspaces;
  }, [props.workspaces, query]);
  const options: readonly (WorkspaceItem | null)[] = query.trim() ? filtered : [null, ...filtered];

  const changeOpen = (next: boolean): void => {
    setOpen(next);
    if (!next) {
      setQuery("");
    }
  };
  const pick = (workspaceId: string | null): void => {
    props.onChange(workspaceId);
    changeOpen(false);
  };
  const roving = useRovingList({
    count: options.length,
    open,
    resetKey: query,
    onSelect: (index) => {
      const option = options[index];
      if (option !== undefined) {
        pick(option?.id ?? null);
      }
    },
  });
  const optionId = (index: number): string => `${listId}-opt-${index}`;

  return (
    <Popover.Root open={open} onOpenChange={changeOpen}>
      <Popover.Trigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="All projects"
          title="All projects"
          className={cn("size-7 shrink-0", open && "bg-bg-hover text-text-primary")}
        >
          <ChevronDownIcon className="size-4" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={4}
          data-dropdown-frame
          className="z-(--z-toolbar) flex max-h-[50vh] w-60 flex-col rounded-(--select-content-radius) bg-bg-floating p-1 shadow-popover outline-none"
        >
          <div
            data-input=""
            className="flex items-center gap-1.5 rounded-(--control-radius) border-(length:--control-border-width) border-border bg-bg-base px-2 py-1.5 transition-colors focus-within:border-border-focus"
          >
            <SearchIcon className="size-3.5 shrink-0 text-text-muted" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={roving.onKeyDown}
              role="combobox"
              aria-expanded={open}
              aria-controls={listId}
              aria-activedescendant={optionId(roving.activeIndex)}
              placeholder="Search projects…"
              className="w-full bg-transparent text-xs text-text-primary outline-none placeholder:text-text-muted"
            />
          </div>
          <div
            role="listbox"
            id={listId}
            className="scrollbar-hide mt-1 min-h-0 flex-1 overflow-y-auto"
          >
            {options.map((option, index) => (
              <OptionRow
                key={option?.id ?? "all"}
                selected={props.value === (option?.id ?? null)}
                neutral={option === null}
                active={roving.activeIndex === index}
                id={optionId(index)}
                optionRef={(el) => roving.registerItem(index, el)}
                onHover={() => roving.setActiveIndex(index)}
                onSelect={() => pick(option?.id ?? null)}
              >
                {option ? (
                  <span className="flex min-w-0 items-center gap-2">
                    <WorkspaceIcon
                      ownerAgentId={option.owner_agent_id}
                      agentsById={props.agentsById}
                      ownerAgentAvatarUrls={props.ownerAgentAvatarUrls}
                    />
                    <span className="truncate">{option.name}</span>
                  </span>
                ) : (
                  "All"
                )}
              </OptionRow>
            ))}
            {filtered.length === 0 ? (
              <p className="px-2 py-3 text-center text-(length:--text-meta) italic text-text-muted">
                No matches
              </p>
            ) : null}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function FilterChip({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-filter-chip
      onClick={onSelect}
      className={cn(
        "h-6 max-w-32 shrink-0 truncate rounded-(--chip-radius) border-(length:--control-border-width) px-2 text-xs font-medium transition-colors focus-outline",
        selected
          ? "border-(--border-row-selected) bg-(--bg-row-selected) text-text-on-selected"
          : "border-border-subtle text-text-secondary hover:border-(--border-control-hover) hover:text-text-primary",
      )}
    >
      {label}
    </button>
  );
}
