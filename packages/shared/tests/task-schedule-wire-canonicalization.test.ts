import { describe, expect, it } from 'vitest';
import {
  CanonicalPositiveIntegerQuerySchema,
  ClaimTasksInputSchema,
  EditTaskInputSchema,
  PositiveJsSafeIntegerSchema,
  ScheduleCreateInputSchema,
  UnclaimTaskInputSchema,
  UpdateTaskStatusInputSchema,
} from '../src/index.js';
import corpus from './fixtures/task-schedule-wire-canonicalization.json' with { type: 'json' };

describe('task/schedule positive JS-safe wire numbers', () => {
  it('uses the shared numeric authority for all four task mutation fields', () => {
    for (const entry of corpus.positive_js_safe) {
      expect(PositiveJsSafeIntegerSchema.safeParse(entry.value).success, entry.name).toBe(
        entry.accepted,
      );
      expect(
        ClaimTasksInputSchema.safeParse({ task_numbers: [entry.value] }).success,
        `claim: ${entry.name}`,
      ).toBe(entry.accepted);
      for (const schema of [
        UnclaimTaskInputSchema,
        UpdateTaskStatusInputSchema,
        EditTaskInputSchema,
      ]) {
        const extra =
          schema === UpdateTaskStatusInputSchema
            ? { status: 'done' }
            : schema === EditTaskInputSchema
              ? { title: 'edited' }
              : {};
        expect(
          schema.safeParse({ task_number: entry.value, ...extra }).success,
          `${entry.name}`,
        ).toBe(entry.accepted);
      }
    }
  });

  it('applies the safe bound to all six schedule-create numeric fields', () => {
    for (const entry of corpus.positive_js_safe) {
      const onceFire = {
        title: 'x',
        message: 'x',
        target_conversation: '#x',
        spec: { kind: 'once', fire_at: entry.value },
      };
      const onceDelay = {
        title: 'x',
        message: 'x',
        target_conversation: '#x',
        spec: { kind: 'once', delay_seconds: entry.value },
      };
      for (const body of [onceFire, onceDelay]) {
        expect(ScheduleCreateInputSchema.safeParse(body).success, entry.name).toBe(entry.accepted);
      }

      const intervalBase = {
        title: 'x',
        message: 'x',
        target_conversation: '#x',
        spec: { kind: 'interval', every_seconds: 60, start_at: entry.value },
        max_occurrences: 1,
      };
      expect(ScheduleCreateInputSchema.safeParse(intervalBase).success, entry.name).toBe(
        entry.accepted,
      );
      for (const field of ['until_at', 'max_occurrences'] as const) {
        const body = {
          title: 'x',
          message: 'x',
          target_conversation: '#x',
          spec: { kind: 'interval', every_seconds: 60 },
          [field]: entry.value,
        };
        expect(ScheduleCreateInputSchema.safeParse(body).success, `${field}: ${entry.name}`).toBe(
          entry.accepted,
        );
      }
    }

    for (const [value, accepted] of [
      [60, true],
      [59, false],
      [9007199254740992, false],
    ] as const) {
      expect(
        ScheduleCreateInputSchema.safeParse({
          title: 'x',
          message: 'x',
          target_conversation: '#x',
          spec: { kind: 'interval', every_seconds: value },
          max_occurrences: 1,
        }).success,
      ).toBe(accepted);
    }
  });

  it('accepts exactly the shared canonical positive decimal query corpus', () => {
    for (const entry of corpus.canonical_query) {
      const parsed = CanonicalPositiveIntegerQuerySchema.safeParse(entry.raw);
      expect(parsed.success, entry.raw).toBe(entry.accepted);
      if (parsed.success && entry.accepted) expect(parsed.data).toBe(entry.value);
    }
  });
});
