import { useEffect, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import * as Select from '@radix-ui/react-select';
import { ChevronDown } from 'lucide-react';
import {
  FilterSelectItem,
  FILTER_SELECT_TRIGGER_CLASS,
  FILTER_SELECT_CONTENT_CLASS,
} from '@/components/ui/filter-select';
import { cn } from '@/lib/cn';
import { ProfileSection } from '@/features/common/ProfileSummarySections';
import { getCurrentUserId } from '@/lib/current-user';
import { messageActivityRange, messageActivityYears } from './message-activity-calendar';
import { MessageActivityCalendar } from './MessageActivityCalendar';
import {
  shanghaiDate,
  profileMessageCountsOptions,
  type ProfileMessageSubject,
} from './message-counts';

export function ProfileMessageActivity({
  subject,
}: {
  subject: ProfileMessageSubject;
}): JSX.Element {
  return (
    <MessageActivitySection
      key={`${getCurrentUserId()}:${subject.kind}:${subject.id}`}
      subject={subject}
    />
  );
}

function MessageActivitySection({ subject }: { subject: ProfileMessageSubject }): JSX.Element {
  const [year, setYear] = useState<number | 'recent'>('recent');
  const [availableYears, setAvailableYears] = useState<number[]>([]);

  const today = shanghaiDate();
  const currentYear = Number(today.slice(0, 4));

  const range = messageActivityRange(year, today);
  const queries = useQueries({
    queries: messageActivityYears(range).map((value) =>
      profileMessageCountsOptions(getCurrentUserId(), subject, value),
    ),
  });

  const data = queries.every((query) => query.data)
    ? queries
        .flatMap((query) => query.data?.days ?? [])
        .filter((day) => day.date >= range.start && day.date <= range.end)
    : undefined;

  const isError = queries.some((query) => query.isError);
  const isFetching = queries.some((query) => query.isFetching);

  const yearOptions = queries.flatMap((query) => query.data?.available_years ?? []).join(',');

  useEffect(() => {
    if (yearOptions) {
      setAvailableYears(yearOptions.split(',').map(Number));
    }
  }, [yearOptions]);

  const years = [
    ...new Set([...(year === 'recent' ? [] : [year]), currentYear, ...availableYears]),
  ].sort((a, b) => b - a);
  const total = data?.reduce((sum, day) => sum + day.count, 0) ?? 0;

  return (
    <ProfileSection
      title="Message activity"
      headerSlot={
        <Select.Root
          value={String(year)}
          onValueChange={(value) => setYear(value === 'recent' ? 'recent' : Number(value))}
        >
          <Select.Trigger
            aria-label="Message activity period"
            className={cn(FILTER_SELECT_TRIGGER_CLASS, 'w-auto')}
          >
            <Select.Value />
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
                <FilterSelectItem value="recent">Last year</FilterSelectItem>
                {years.map((value) => (
                  <FilterSelectItem key={value} value={String(value)}>
                    {value}
                  </FilterSelectItem>
                ))}
              </Select.Viewport>
            </Select.Content>
          </Select.Portal>
        </Select.Root>
      }
    >
      {isError ? (
        <div
          className="flex min-h-40 items-center justify-center gap-3 text-xs text-text-muted"
          role="status"
        >
          <span>Message activity unavailable.</span>
          <button
            type="button"
            className="text-text-primary underline underline-offset-2 focus-outline"
            onClick={() => void Promise.all(queries.map((query) => query.refetch()))}
            disabled={isFetching}
          >
            Retry
          </button>
        </div>
      ) : data ? (
        <div>
          <p className="mb-5 text-xs text-text-muted">
            {total.toLocaleString()} {total === 1 ? 'message' : 'messages'}{' '}
            {year === 'recent' ? 'in the last year' : `in ${year}`}
          </p>
          <MessageActivityCalendar year={year} days={data} today={today} />
        </div>
      ) : (
        <div
          className="flex min-h-40 flex-col justify-center gap-4"
          role="status"
          aria-label="Loading message activity"
        >
          <div className="h-3 w-40 animate-pulse rounded-[var(--control-radius)] bg-bg-elevated" />
          <div className="h-28 animate-pulse rounded-[var(--control-radius)] bg-bg-elevated" />
        </div>
      )}
    </ProfileSection>
  );
}
