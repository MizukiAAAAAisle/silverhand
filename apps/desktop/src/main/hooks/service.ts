import { randomUUID } from 'node:crypto';
import type { EventFrame } from '@silverhand/shared';
import { HOOK_LIMITS, type HookRule, type HookRun } from '@silverhand/client';
import { startCommand, type RunningCommand } from './command.js';

type Job = { run: HookRun; rule: HookRule; input: string };
export class HookService {
  private rules: HookRule[] = [];
  private closed = false;
  private retiring = new Set<Promise<unknown>>();
  private history: HookRun[] = [];
  private queue: Job[] = [];
  private running = new Map<string, { job: Job; command: RunningCommand }>();
  private session?: { identity: string; scope: string; lease: string; current: () => boolean };
  private cursor?: { epoch: string; seq: number };
  constructor(private limits: { concurrency: number; queue: number } = HOOK_LIMITS) {}
  updateRules(rules: HookRule[]) {
    this.rules = structuredClone(rules);
    this.queue = this.queue.filter((job) => {
      if (rules.some((rule) => rule.enabled && JSON.stringify(rule) === JSON.stringify(job.rule)))
        return true;
      this.complete(job.run, 'cancelled', 'Hook configuration changed');
      return false;
    });
  }
  beginFeed(identity: string, scope: string, current: () => boolean): string {
    if (this.closed) throw new Error('Hooks are shut down');
    if (this.session?.identity !== identity || !this.session.current()) this.revoke();
    const lease = randomUUID();
    this.session = { identity, scope, lease, current };
    return lease;
  }
  deliver(lease: string, frames: EventFrame[]): void {
    const session = this.session;
    if (!session || session.lease !== lease) return;
    if (!session.current()) {
      this.revoke();
      return;
    }
    if (!Array.isArray(frames) || frames.length > HOOK_LIMITS.batchSize)
      throw new Error('At most 8 events per batch');
    for (const frame of frames) validateFrame(frame);
    for (const frame of frames) {
      if (
        frame.type !== 'event' ||
        frame.scope !== session.scope ||
        !['notification', 'task_changed'].includes(frame.kind)
      )
        continue;
      if (this.cursor?.epoch === frame.epoch && frame.seq <= this.cursor.seq) continue;
      this.cursor = { epoch: frame.epoch, seq: frame.seq };
      for (const rule of this.rules) {
        if (
          !rule.enabled ||
          rule.event !== frame.kind ||
          !frame.payload ||
          typeof frame.payload !== 'object'
        )
          continue;
        if (
          Object.entries(rule.match ?? {}).some(
            ([key, value]) => (frame.payload as Record<string, unknown>)[key] !== value,
          )
        )
          continue;
        this.enqueue(rule, frame);
      }
    }
  }
  endFeed(lease: string) {
    if (this.session?.lease === lease) this.session.lease = '';
  }
  cancel(id: string) {
    const index = this.queue.findIndex((job) => job.run.id === id);
    if (index >= 0)
      this.complete(this.queue.splice(index, 1)[0]!.run, 'cancelled', 'Cancelled by user');
    this.running.get(id)?.command.cancel();
  }
  private enqueue(rule: HookRule, frame: EventFrame): string {
    const run: HookRun = {
      id: randomUUID(),
      ruleId: rule.id,
      name: rule.name,
      status: 'queued',
      createdAt: Date.now(),
      stdout: '',
      stderr: '',
      truncated: false,
    };
    if (this.queue.length >= this.limits.queue)
      this.complete(run, 'rejected', 'Hook queue is full');
    else {
      this.queue.push({ run, rule: structuredClone(rule), input: JSON.stringify(frame) + '\n' });
      this.pump();
    }
    return run.id;
  }
  private complete(run: HookRun, status: HookRun['status'], reason?: string) {
    Object.assign(run, { status, reason, finishedAt: Date.now() });
    this.history.unshift(run);
    this.history.length = Math.min(HOOK_LIMITS.history, this.history.length);
  }
  private pump() {
    while (this.running.size < this.limits.concurrency) {
      const index = this.queue.findIndex(
        (job) => ![...this.running.values()].some((active) => active.job.rule.id === job.rule.id),
      );
      if (index < 0) return;
      const job = this.queue.splice(index, 1)[0]!;
      job.run.status = 'running';
      const command = startCommand(job.rule.action, job.input);
      this.running.set(job.run.id, { job, command });
      void command.done.then((result) => {
        if (!this.running.delete(job.run.id)) return;
        Object.assign(job.run, result);
        this.complete(job.run, result.status, result.reason);
        this.pump();
      });
    }
  }
  runs(): HookRun[] {
    return structuredClone(
      [...this.running.values()]
        .map((v) => v.job.run)
        .concat(
          this.queue.map((j) => j.run),
          this.history,
        ),
    );
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    this.revoke();
    await Promise.all(this.retiring);
  }
  revoke() {
    this.session = undefined;
    this.cursor = undefined;
    this.queue = [];
    this.history = [];
    for (const { command } of this.running.values()) {
      command.cancel();
      this.retiring.add(command.done);
      void command.done.finally(() => this.retiring.delete(command.done));
    }
    this.running.clear();
  }
}

function validateFrame(frame: EventFrame): void {
  if (
    !frame ||
    frame.type !== 'event' ||
    typeof frame.scope !== 'string' ||
    frame.scope.length > 256 ||
    typeof frame.epoch !== 'string' ||
    !frame.epoch ||
    frame.epoch.length > 256 ||
    !Number.isSafeInteger(frame.seq) ||
    frame.seq < 0 ||
    typeof frame.kind !== 'string' ||
    !frame.payload ||
    typeof frame.payload !== 'object' ||
    Array.isArray(frame.payload) ||
    Buffer.byteLength(JSON.stringify(frame)) > HOOK_LIMITS.eventBytes
  )
    throw new Error('Invalid or oversized hook event');
}
