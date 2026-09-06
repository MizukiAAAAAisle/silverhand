import { describe, expect, it } from 'vitest';
import { messageActivityCalendar, messageActivityLevel } from './message-activity-calendar';

describe('message activity calendar coordinates', () => {
  it('fills missing past days with zero without counting future or adjacent-year data', () => {
    const cells = messageActivityCalendar(2026, [
      { date: '2026-01-01', count: 12 },
      { date: '2026-01-03', count: 99 },
      { date: '2025-12-31', count: 42 },
    ], '2026-01-02');
    expect(cells.filter(cell => cell.visible)).toEqual([
      { date: '2026-01-01', count: 12, visible: true },
      { date: '2026-01-02', count: 0, visible: true },
    ]);
    expect(cells.reduce((sum, cell) => sum + cell.count, 0)).toBe(12);
    expect(cells[0]?.date).toBe('2025-12-28');
  });

  it('keeps leap day and the final day in a 54-week leap calendar', () => {
    const cells = messageActivityCalendar(2000, [{ date: '2000-02-29', count: 7 }], '2001-01-01');
    expect(cells).toHaveLength(378);
    expect(cells.filter(cell => cell.visible)).toHaveLength(366);
    expect(cells.find(cell => cell.date === '2000-02-29')?.count).toBe(7);
    expect(cells.find(cell => cell.date === '2000-12-31')?.visible).toBe(true);
  });

  it('uses date keys verbatim, independent of the runtime timezone', () => {
    const cells = messageActivityCalendar(2024, [{ date: '2024-03-10', count: 3 }], '2024-03-10');
    expect(cells.find(cell => cell.date === '2024-03-10')).toEqual({ date: '2024-03-10', count: 3, visible: true });
  });

  it.each([[0, 0], [1, 1], [29, 1], [30, 2], [99, 2], [100, 3], [219, 3], [220, 4]])('maps %i messages to level %i', (count, level) => {
    expect(messageActivityLevel(count)).toBe(level);
  });
});
