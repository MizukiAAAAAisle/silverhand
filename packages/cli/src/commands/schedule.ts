/**
 * `silverhand schedule` — create, list, cancel.
 */
import type {
  ScheduleCreateInput,
  ScheduleListInput,
  ScheduleListStatusFilter,
} from '@silverhand/shared';
import { CliError } from '../errors.js';
import { flagBool, flagNumber, flagString } from '../parse.js';
import type { Command } from './index.js';

const createCommand: Command = {
  verb: 'create',
  summary: 'Create a self-wake schedule for this agent.',
  help: `silverhand schedule create --message <text> --kind once|interval|cron
                            [<kind-specific flags>]
                            [--until-at <epoch_ms>] [--max-occurrences N]
                            [--allow-unbounded]

Common flags:
  --message <text>         Required. Echoed in the wake message — write
                           the actual instruction to your future self.
                           1..500 chars.
  --kind once|interval|cron Required. Time policy.

once flags (exactly one):
  --fire-at <epoch_ms>     Absolute UTC fire time.
  --delay-seconds N        Convenience: now + N seconds. Min 30s.

interval flags:
  --every-seconds N        Required. Cadence. Min 60.
  --start-at <epoch_ms>    Optional. First fire. Defaults to now+every.

cron flags:
  --expression <cron>      Required. 5-field UNIX cron (minute granularity).
  --timezone <iana>        Required. IANA tz name, e.g. Asia/Shanghai.

Repeat-only options (rejected on once):
  --until-at <epoch_ms>    Repeat schedules end at this UTC time.
  --max-occurrences N      Repeat schedules stop after N fires.
  --allow-unbounded        Required true for repeat schedules with neither
                           --until-at nor --max-occurrences set.

stdout: { "schedule": ScheduleDto }`,
  booleanFlags: ['allow-unbounded'],
  async run({ client, args }) {
    const message = flagString(args, 'message');
    const kind = flagString(args, 'kind') as
      | 'once'
      | 'interval'
      | 'cron'
      | undefined;
    if (!message || !kind) {
      throw new CliError({
        code: 'validation_error',
        message: 'schedule create requires --message and --kind',
        retriable: false,
      });
    }
    const untilAt = flagNumber(args, 'until-at');
    const maxOccurrences = flagNumber(args, 'max-occurrences');
    const allowUnbounded = flagBool(args, 'allow-unbounded');

    let input: ScheduleCreateInput;
    if (kind === 'once') {
      const fireAt = flagNumber(args, 'fire-at');
      const delaySeconds = flagNumber(args, 'delay-seconds');
      input = {
        message,
        spec: {
          kind: 'once',
          ...(fireAt !== undefined ? { fire_at: fireAt } : {}),
          ...(delaySeconds !== undefined ? { delay_seconds: delaySeconds } : {}),
        },
      };
    } else if (kind === 'interval') {
      const everySeconds = flagNumber(args, 'every-seconds');
      const startAt = flagNumber(args, 'start-at');
      if (everySeconds === undefined) {
        throw new CliError({
          code: 'validation_error',
          message: 'interval schedule requires --every-seconds',
          retriable: false,
        });
      }
      input = {
        message,
        spec: {
          kind: 'interval',
          every_seconds: everySeconds,
          ...(startAt !== undefined ? { start_at: startAt } : {}),
        },
        ...(untilAt !== undefined ? { until_at: untilAt } : {}),
        ...(maxOccurrences !== undefined ? { max_occurrences: maxOccurrences } : {}),
        ...(allowUnbounded !== undefined ? { allow_unbounded: allowUnbounded } : {}),
      };
    } else if (kind === 'cron') {
      const expression = flagString(args, 'expression');
      const timezone = flagString(args, 'timezone');
      if (!expression || !timezone) {
        throw new CliError({
          code: 'validation_error',
          message: 'cron schedule requires --expression and --timezone',
          retriable: false,
        });
      }
      input = {
        message,
        spec: { kind: 'cron', expression, timezone },
        ...(untilAt !== undefined ? { until_at: untilAt } : {}),
        ...(maxOccurrences !== undefined ? { max_occurrences: maxOccurrences } : {}),
        ...(allowUnbounded !== undefined ? { allow_unbounded: allowUnbounded } : {}),
      };
    } else {
      throw new CliError({
        code: 'validation_error',
        message: `--kind must be one of once|interval|cron; got ${kind}`,
        retriable: false,
      });
    }
    return client.createSchedule(input);
  },
};

const listCommand: Command = {
  verb: 'list',
  summary: 'List your active/historical schedules.',
  help: `silverhand schedule list [--status pending|firing|active|done|cancelled|failed|all]
                          [--limit N]

Lists this agent's schedules ordered by next_fire_at ASC. No cross-agent
visibility.

Flags:
  --status   Default "all". "active" = pending OR firing.
  --limit N  Default 100, max 200.

stdout: ScheduleListOutput JSON.`,
  async run({ client, args }) {
    const status = flagString(args, 'status') as
      | ScheduleListStatusFilter
      | undefined;
    if (
      status &&
      !['pending', 'firing', 'active', 'done', 'cancelled', 'failed', 'all'].includes(
        status,
      )
    ) {
      throw new CliError({
        code: 'validation_error',
        message: `--status must be one of pending|firing|active|done|cancelled|failed|all; got ${status}`,
        retriable: false,
      });
    }
    const limit = flagNumber(args, 'limit');
    const input: ScheduleListInput = {
      ...(status ? { status } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
    return client.listSchedules(input);
  },
};

const cancelCommand: Command = {
  verb: 'cancel',
  summary: 'Cancel one of your schedules.',
  help: `silverhand schedule cancel --schedule-id <id>

Cancels a pending or firing schedule. Terminal states (done, cancelled,
failed) are not cancellable. Cancel races with an in-flight fire are
accepted: the wake may still be delivered, but no further fires occur.

stdout: { "schedule": ScheduleDto }`,
  async run({ client, args }) {
    const scheduleId = flagString(args, 'schedule-id');
    if (!scheduleId) {
      throw new CliError({
        code: 'validation_error',
        message: '--schedule-id is required',
        retriable: false,
      });
    }
    return client.cancelSchedule({ schedule_id: scheduleId });
  },
};

export const scheduleCommands: readonly Command[] = [
  createCommand,
  listCommand,
  cancelCommand,
];
