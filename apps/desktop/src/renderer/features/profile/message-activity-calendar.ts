export interface MessageActivityDay {
  date: string;
  count: number;
}

export interface MessageActivityCell extends MessageActivityDay {
  visible: boolean;
}

export function messageActivityRange(selection: number | 'recent', today: string) {
  if (selection !== 'recent') {
    return { start: `${selection}-01-01`, end: `${selection}-12-31` };
  }

  const end = new Date(`${today}T00:00:00Z`);
  const start = new Date(end);
  start.setUTCFullYear(start.getUTCFullYear() - 1);

  if (start.getUTCMonth() !== end.getUTCMonth()) {
    start.setUTCDate(0);
  }

  start.setUTCDate(start.getUTCDate() + 1);

  return { start: start.toISOString().slice(0, 10), end: today };
}

export function messageActivityYears(range: { start: string; end: string }): number[] {
  const first = Number(range.start.slice(0, 4));
  const last = Number(range.end.slice(0, 4));

  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

/** Date keys are calendar coordinates from the server's reporting timezone. */
export function messageActivityCalendar(
  year: number | 'recent',
  days: readonly MessageActivityDay[],
  today: string,
): MessageActivityCell[] {
  const range = messageActivityRange(year, today);
  const first = new Date(`${range.start}T00:00:00Z`);
  const end = new Date(`${range.end}T00:00:00Z`);
  const offset = first.getUTCDay();
  const length = Math.ceil(((end.getTime() - first.getTime()) / 86_400_000 + 1 + offset) / 7) * 7;

  const counts = new Map(days.map((day) => [day.date, day.count]));

  return Array.from({ length }, (_, index) => {
    const date = new Date(first.getTime() + (index - offset) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const visible = date >= range.start && date <= range.end;

    return { date, count: visible && date <= today ? (counts.get(date) ?? 0) : 0, visible };
  });
}

export function messageActivityLevel(count: number): number {
  if (count === 0) {
    return 0;
  }

  if (count < 30) {
    return 1;
  }

  if (count < 100) {
    return 2;
  }

  if (count < 220) {
    return 3;
  }

  return 4;
}
