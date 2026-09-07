import { queryOptions, useQuery } from '@tanstack/react-query';
import {
  apiPaths,
  ProfileMessageCountsSchema,
  type ProfileMessageCounts,
} from '@silverhand/shared';
import { api } from '@/lib/api';
import { getCurrentUserId } from '@/lib/current-user';

export type ProfileMessageSubject = ProfileMessageCounts['subject'];
export const profileMessageCountsKey = (
  viewerId: string | null,
  subject: ProfileMessageSubject,
  year: number,
) => ['profile-message-counts', viewerId, subject.kind, subject.id, year] as const;

export function profileMessageCountsOptions(
  viewerId: string | null,
  subject: ProfileMessageSubject,
  year: number,
) {
  return queryOptions({
    queryKey: profileMessageCountsKey(viewerId, subject, year),
    queryFn: async ({ signal }) => {
      if (!viewerId || getCurrentUserId() !== viewerId) throw new Error('Session changed.');
      const data = ProfileMessageCountsSchema.parse(
        await api(`${apiPaths.profileMessageCounts(subject.kind, subject.id)}?year=${year}`, {
          signal,
        }),
      );
      if (getCurrentUserId() !== viewerId) throw new Error('Session changed.');
      if (
        data.subject.kind !== subject.kind ||
        data.subject.id !== subject.id ||
        data.year !== year
      ) {
        throw new Error('Message activity response does not match the profile.');
      }
      return data;
    },
    enabled: viewerId !== null,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    retry: false,
  });
}

export function useProfileMessageCounts(subject: ProfileMessageSubject, year: number) {
  return useQuery(profileMessageCountsOptions(getCurrentUserId(), subject, year));
}

export function shanghaiDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
