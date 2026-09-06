import { useEffect, useState } from 'react';
import { ProfileSection } from '@/features/common/ProfileSummarySections';
import { getCurrentUserId } from '@/lib/current-user';
import { MessageActivityCalendar } from './MessageActivityCalendar';
import { shanghaiDate, useProfileMessageCounts, type ProfileMessageSubject } from './message-counts';

export function ProfileMessageActivity({ subject }: { subject: ProfileMessageSubject }): JSX.Element {
  return <MessageActivitySection key={`${getCurrentUserId()}:${subject.kind}:${subject.id}`} subject={subject} />;
}

function MessageActivitySection({ subject }: { subject: ProfileMessageSubject }): JSX.Element {
  const today = shanghaiDate();
  const currentYear = Number(today.slice(0, 4));
  const [year, setYear] = useState(currentYear);
  const query = useProfileMessageCounts(subject, year);
  const [availableYears, setAvailableYears] = useState<number[]>([]);
  useEffect(() => {
    if (query.data) setAvailableYears(query.data.available_years);
  }, [query.data]);
  const years = [...new Set([year, currentYear, ...availableYears])].sort((a, b) => b - a);
  const total = query.data?.days.reduce((sum, day) => sum + day.count, 0) ?? 0;

  return (
    <ProfileSection title="Message activity" headerSlot={
      <select
        aria-label="Message activity year"
        value={year}
        onChange={event => setYear(Number(event.target.value))}
        className="rounded-[var(--control-radius)] border-[length:var(--control-border-width)] border-border bg-bg-floating px-2 py-1 text-xs text-text-primary focus-outline"
      >
        {years.map(value => <option key={value} value={value}>{value}</option>)}
      </select>
    }>
      {query.isError ? (
        <div className="flex min-h-40 items-center justify-center gap-3 text-xs text-text-muted" role="status">
          <span>Message activity unavailable.</span>
          <button type="button" className="text-text-primary underline underline-offset-2 focus-outline" onClick={() => void query.refetch()} disabled={query.isFetching}>Retry</button>
        </div>
      ) : query.data ? (
        <div>
          <p className="mb-5 text-xs text-text-muted">{total.toLocaleString()} {total === 1 ? 'message' : 'messages'} in {year}</p>
          <MessageActivityCalendar year={year} days={query.data.days} today={today} timezone={query.data.time_zone} />
        </div>
      ) : (
        <div className="flex min-h-40 flex-col justify-center gap-4" role="status" aria-label="Loading message activity">
          <div className="h-3 w-40 animate-pulse rounded-[var(--control-radius)] bg-bg-elevated" />
          <div className="h-28 animate-pulse rounded-[var(--control-radius)] bg-bg-elevated" />
        </div>
      )}
    </ProfileSection>
  );
}
