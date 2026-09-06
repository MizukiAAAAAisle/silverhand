export interface MessageActivityDay {
  date: string;
  count: number;
}

export interface MessageActivityCell extends MessageActivityDay {
  visible: boolean;
}

/** Date keys are calendar coordinates from the server's reporting timezone. */
export function messageActivityCalendar(
  year: number,
  days: readonly MessageActivityDay[],
  today: string,
): MessageActivityCell[] {
  const first = new Date(Date.UTC(year, 0, 1));
  const end = new Date(Date.UTC(year + 1, 0, 1));
  const offset = first.getUTCDay();
  const length = Math.ceil(((end.getTime() - first.getTime()) / 86_400_000 + offset) / 7) * 7;
  const counts = new Map(days.map(day => [day.date, day.count]));
  return Array.from({ length }, (_, index) => {
    const date = new Date(Date.UTC(year, 0, 1 - offset + index)).toISOString().slice(0, 10);
    const visible = date.startsWith(`${year}-`) && date <= today;
    return { date, count: visible ? counts.get(date) ?? 0 : 0, visible };
  });
}

export function messageActivityLevel(count: number): number {
  if (count === 0) return 0;
  if (count < 30) return 1;
  if (count < 100) return 2;
  if (count < 220) return 3;
  return 4;
}
