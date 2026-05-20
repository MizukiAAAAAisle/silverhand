import { describe, expect, it } from 'vitest';
import type { ScheduleDto } from '@silverhand/shared';
import { formatFiredCount } from './AgentSchedulesCard';

function makeSchedule(overrides: Partial<ScheduleDto> = {}): ScheduleDto {
  return {
    id: 's-0',
    owner_agent_id: 'a-0',
    target_conversation_id: 'conv-0',
    title: 'Wake title',
    message: 'wake',
    spec: { kind: 'once', fire_at: 1700000000 },
    next_fire_at: 1700000000,
    status: 'pending',
    fired_count: 0,
    last_fired_at: null,
    max_occurrences: null,
    until_at: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  } as ScheduleDto;
}

describe('AgentSchedulesCard formatFiredCount', () => {
  it('once schedules always read as `N / 1 fired`, never `∞`', () => {
    // Cindy PR-3 review finding: a `once` row's capacity is always 1.
    // `max_occurrences` is repeat-only — null on a once row means
    // "not applicable", NOT "unlimited". The old formatter showed
    // `0 / ∞ fired` for a pending one-shot, which would mislead the
    // #task:184 audit/recovery flow.
    expect(
      formatFiredCount(makeSchedule({ spec: { kind: 'once', fire_at: 1 } })),
    ).toBe('0 / 1 fired');
    expect(
      formatFiredCount(
        makeSchedule({
          spec: { kind: 'once', fire_at: 1 },
          status: 'done',
          fired_count: 1,
        }),
      ),
    ).toBe('1 / 1 fired');
  });

  it('interval schedules show the explicit cap when present', () => {
    expect(
      formatFiredCount(
        makeSchedule({
          spec: { kind: 'interval', every_seconds: 60 },
          fired_count: 12,
          max_occurrences: 100,
        }),
      ),
    ).toBe('12 / 100 fired');
  });

  it('interval schedules without a cap read as `N / ∞ fired`', () => {
    expect(
      formatFiredCount(
        makeSchedule({
          spec: { kind: 'interval', every_seconds: 60 },
          fired_count: 12,
        }),
      ),
    ).toBe('12 / ∞ fired');
  });

  it('cron schedules follow the same repeat rules as interval', () => {
    expect(
      formatFiredCount(
        makeSchedule({
          spec: {
            kind: 'cron',
            expression: '0 9 * * 1',
            timezone: 'Asia/Shanghai',
          },
          fired_count: 4,
        }),
      ),
    ).toBe('4 / ∞ fired');
    expect(
      formatFiredCount(
        makeSchedule({
          spec: {
            kind: 'cron',
            expression: '0 9 * * 1',
            timezone: 'Asia/Shanghai',
          },
          fired_count: 4,
          max_occurrences: 10,
        }),
      ),
    ).toBe('4 / 10 fired');
  });
});
