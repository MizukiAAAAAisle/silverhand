import * as Select from "@radix-ui/react-select";
import { ChevronDown, Monitor } from "lucide-react";
import type { HostAvailability, HostDto } from "@silverhand/shared";
import {
  FilterSelectItem,
  FILTER_SELECT_TRIGGER_CLASS,
  FILTER_SELECT_CONTENT_CLASS,
} from "@/components/ui/filter-select";
import {
  computerUnavailableLabel,
  hostDisplayName,
  isComputerAvailable,
} from "@/features/computer-shell/model/host-display";
import { cn } from "@/lib/cn";

/**
 * Placement computer picker — a Radix `Select` over the caller's already
 * `placeable`-filtered computers. One dropdown design shared by Create Agent
 * and Create Workspace (both labelled "Computer") so both placement pickers read
 * identically (#task:1358).
 *
 * Placement needs BOTH axes and neither is derived from `kind`: lifecycle
 * eligibility is the backend `placeable` predicate (the caller filters on it),
 * and availability is live per-host status (`availabilityById`, #task:1359). A
 * computer whose daemon is offline is still `placeable`, so it stays visible but
 * renders disabled with a reason badge ("Offline"/"Unreachable") — the user can
 * see it exists and why it can't be picked, rather than it silently vanishing.
 *
 * The picker is always rendered by callers; its state follows the *available*
 * count: 0 computers → disabled trigger; the caller preselects the sole
 * available one and passes `value = null` when the user must choose. `null`
 * maps to Radix's empty-string "no selection" so the placeholder shows.
 */
export function ComputerPicker({
  id,
  hosts,
  availabilityById,
  value,
  onChange,
  placeholder = "Select a computer",
  ariaLabel = "Computer",
}: {
  id?: string;
  hosts: HostDto[];
  availabilityById: Map<string, HostAvailability | undefined>;
  value: string | null;
  onChange: (hostId: string) => void;
  placeholder?: string;
  ariaLabel?: string;
}): JSX.Element {
  const isEmpty = hosts.length === 0;
  return (
    <Select.Root value={value ?? ""} onValueChange={onChange} disabled={isEmpty}>
      <Select.Trigger
        id={id}
        aria-label={ariaLabel}
        className={cn(
          FILTER_SELECT_TRIGGER_CLASS,
          "data-disabled:cursor-not-allowed data-disabled:opacity-60",
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <Monitor className="size-3.5 shrink-0 text-text-muted" />
          <Select.Value
            placeholder={isEmpty ? "No computers available" : placeholder}
            className="truncate"
          />
        </span>
        <Select.Icon>
          <ChevronDown className="size-3.5 text-text-muted" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          data-dropdown-frame
          className={FILTER_SELECT_CONTENT_CLASS}
        >
          <Select.Viewport className="p-1">
            {hosts.map((host) => {
              const availability = availabilityById.get(host.id);
              const available = isComputerAvailable(availability);
              return (
                <FilterSelectItem
                  key={host.id}
                  value={host.id}
                  icon={<Monitor className="size-3.5" />}
                  disabled={!available}
                  suffix={
                    available ? undefined : (computerUnavailableLabel(availability) ?? undefined)
                  }
                >
                  {hostDisplayName(host)}
                </FilterSelectItem>
              );
            })}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
