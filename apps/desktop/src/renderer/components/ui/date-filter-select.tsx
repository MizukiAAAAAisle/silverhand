import * as Select from '@radix-ui/react-select';
import dayjs from 'dayjs';
import { ChevronDown, Clock } from 'lucide-react';
import {
  FilterSelectItem,
  FILTER_SELECT_TRIGGER_CLASS,
  FILTER_SELECT_CONTENT_CLASS,
} from '@/components/ui/filter-select';

/**
 * Shared "filter by recency" dropdown, converged on the option semantics
 * ArchivedChannelsPanel already shipped (shiki #task:1258: don't invent a new
 * date shell). ArchivedChannelsPanel and SavedListView share both the option
 * set and the `dateFilterSince` cutoff helper, so "Last 2 weeks" means the same
 * thing on every surface. Built on the Radix-Select primitive
 * (`filter-select.tsx`).
 */
export type DateFilterValue = 'all' | '30d' | '14d' | '7d';

export const DATE_FILTER_OPTIONS: Array<{ value: DateFilterValue; label: string }> = [
  { value: 'all', label: 'All time' },
  { value: '30d', label: 'Last 30 days' },
  { value: '14d', label: 'Last 2 weeks' },
  { value: '7d', label: 'Last 1 week' },
];

/** Lower-bound epoch-ms cutoff for a date filter, or `null` for "all time". */
export function dateFilterSince(value: DateFilterValue): number | null {
  if (value === '30d') return dayjs().subtract(30, 'day').valueOf();
  if (value === '14d') return dayjs().subtract(14, 'day').valueOf();
  if (value === '7d') return dayjs().subtract(7, 'day').valueOf();
  return null;
}

export function DateFilterSelect({
  value,
  onChange,
  ariaLabel = 'Date filter',
}: {
  value: DateFilterValue;
  onChange: (value: DateFilterValue) => void;
  ariaLabel?: string;
}): JSX.Element {
  const selected =
    DATE_FILTER_OPTIONS.find(o => o.value === value)?.label ?? 'All time';
  return (
    <Select.Root value={value} onValueChange={v => onChange(v as DateFilterValue)}>
      <Select.Trigger aria-label={ariaLabel} className={FILTER_SELECT_TRIGGER_CLASS}>
        <span className="flex min-w-0 items-center gap-1.5">
          <Clock className="size-3.5 text-text-muted" />
          <span className="truncate">{selected}</span>
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
            {DATE_FILTER_OPTIONS.map(option => (
              <FilterSelectItem
                key={option.value}
                value={option.value}
                icon={<Clock className="size-3.5" />}
              >
                {option.label}
              </FilterSelectItem>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
