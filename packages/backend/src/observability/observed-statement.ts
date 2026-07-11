import { performance } from 'node:perf_hooks';
import type DatabaseTypes from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import type { BackendLogger } from '../context.js';
import type { BackendMetrics, DbStatementOperation, DbStatementOutcome } from './metrics.js';
import { currentBackendRequestContext } from './request-context.js';

const DEFAULT_SLOW_STATEMENT_MS = 100;
const QUERY_NAME_PATTERN = /^[a-z][a-z0-9_.-]{1,95}$/;

interface DatabaseObservation {
  metrics?: BackendMetrics;
  logger?: BackendLogger;
  slowStatementMs: number;
}

const observations = new WeakMap<Db, DatabaseObservation>();

export function configureDatabaseObservation(
  db: Db,
  observation: {
    metrics?: BackendMetrics;
    logger?: BackendLogger;
    slowStatementMs?: number;
  },
): void {
  observations.set(db, {
    ...observation,
    slowStatementMs: observation.slowStatementMs ?? DEFAULT_SLOW_STATEMENT_MS,
  });
}

export interface ObservedStatement<BindParameters extends unknown[], Result> {
  readonly database: Db;
  readonly source: string;
  readonly reader: boolean;
  readonly readonly: boolean;
  readonly busy: boolean;
  run(...params: BindParameters): DatabaseTypes.RunResult;
  get(...params: BindParameters): Result | undefined;
  all(...params: BindParameters): Result[];
  iterate(...params: BindParameters): IterableIterator<Result>;
  pluck(toggleState?: boolean): this;
  expand(toggleState?: boolean): this;
  raw(toggleState?: boolean): this;
  bind(...params: BindParameters): this;
  columns(): DatabaseTypes.ColumnDefinition[];
  safeIntegers(toggleState?: boolean): this;
}

export function prepareObserved<
  BindParameters extends unknown[] | Record<string, unknown> = unknown[],
  Result = unknown,
>(
  db: Db,
  queryName: string,
  source: string,
): BindParameters extends unknown[]
  ? ObservedStatement<BindParameters, Result>
  : ObservedStatement<[BindParameters], Result> {
  assertQueryName(queryName);
  const native = db.prepare<BindParameters, Result>(source) as DatabaseTypes.Statement<
    BindParameters extends unknown[] ? BindParameters : [BindParameters],
    Result
  >;
  return new ObservedStatementImpl(native, queryName) as unknown as BindParameters extends unknown[]
    ? ObservedStatement<BindParameters, Result>
    : ObservedStatement<[BindParameters], Result>;
}

class ObservedStatementImpl<BindParameters extends unknown[], Result>
  implements ObservedStatement<BindParameters, Result>
{
  constructor(
    private readonly native: DatabaseTypes.Statement<BindParameters, Result>,
    private readonly queryName: string,
  ) {}

  get database(): Db {
    return this.native.database;
  }
  get source(): string {
    return this.native.source;
  }
  get reader(): boolean {
    return this.native.reader;
  }
  get readonly(): boolean {
    return this.native.readonly;
  }
  get busy(): boolean {
    return this.native.busy;
  }

  run(...params: BindParameters): DatabaseTypes.RunResult {
    return this.observe('run', () => this.native.run(...params));
  }

  get(...params: BindParameters): Result | undefined {
    return this.observe('get', () => this.native.get(...params));
  }

  all(...params: BindParameters): Result[] {
    return this.observe('all', () => this.native.all(...params));
  }

  iterate(...params: BindParameters): IterableIterator<Result> {
    const timer = new StatementExecutionTimer(this.native.database, this.queryName, 'iterate');
    let nativeIterator: IterableIterator<Result>;
    try {
      nativeIterator = timer.measure(() => this.native.iterate(...params));
    } catch (err) {
      timer.finish(err);
      throw err;
    }
    return new ObservedIterator(nativeIterator, timer);
  }

  pluck(toggleState?: boolean): this {
    this.native.pluck(toggleState);
    return this;
  }

  expand(toggleState?: boolean): this {
    this.native.expand(toggleState);
    return this;
  }

  raw(toggleState?: boolean): this {
    this.native.raw(toggleState);
    return this;
  }

  bind(...params: BindParameters): this {
    this.native.bind(...params);
    return this;
  }

  columns(): DatabaseTypes.ColumnDefinition[] {
    return this.native.columns();
  }

  safeIntegers(toggleState?: boolean): this {
    this.native.safeIntegers(toggleState);
    return this;
  }

  private observe<T>(operation: DbStatementOperation, callback: () => T): T {
    const timer = new StatementExecutionTimer(this.native.database, this.queryName, operation);
    try {
      const result = timer.measure(callback);
      timer.finish();
      return result;
    } catch (err) {
      timer.finish(err);
      throw err;
    }
  }
}

class ObservedIterator<Result> implements IterableIterator<Result> {
  constructor(
    private readonly native: IterableIterator<Result>,
    private readonly timer: StatementExecutionTimer,
  ) {}

  [Symbol.iterator](): IterableIterator<Result> {
    return this;
  }

  next(...args: [] | [undefined]): IteratorResult<Result> {
    try {
      const result = this.timer.measure(() => this.native.next(...args));
      if (result.done) this.timer.finish();
      return result;
    } catch (err) {
      this.timer.finish(err);
      throw err;
    }
  }

  return(value?: unknown): IteratorResult<Result> {
    try {
      const result = this.timer.measure(() =>
        this.native.return
          ? this.native.return(value as never)
          : ({ done: true, value } as IteratorReturnResult<unknown>),
      );
      this.timer.finish();
      return result as IteratorResult<Result>;
    } catch (err) {
      this.timer.finish(err);
      throw err;
    }
  }

  throw(error?: unknown): IteratorResult<Result> {
    try {
      if (!this.native.throw) throw error;
      const result = this.timer.measure(() => this.native.throw!(error));
      if (result.done) this.timer.finish();
      return result;
    } catch (err) {
      this.timer.finish(err);
      throw err;
    }
  }
}

class StatementExecutionTimer {
  private elapsedMs = 0;
  private finished = false;

  constructor(
    private readonly db: Db,
    private readonly queryName: string,
    private readonly operation: DbStatementOperation,
  ) {}

  measure<T>(callback: () => T): T {
    const startedAt = performance.now();
    try {
      return callback();
    } finally {
      this.elapsedMs += performance.now() - startedAt;
    }
  }

  finish(error?: unknown): void {
    if (this.finished) return;
    this.finished = true;
    const observation = observations.get(this.db);
    if (!observation) return;
    const outcome = statementOutcome(error);
    observation.metrics?.observeDbStatement({
      queryName: this.queryName,
      operation: this.operation,
      outcome,
      elapsedMs: this.elapsedMs,
    });
    if (error || this.elapsedMs >= observation.slowStatementMs) {
      const request = currentBackendRequestContext();
      observation.logger?.warn(
        {
          queryName: this.queryName,
          operation: this.operation,
          outcome,
          elapsedMs: roundMs(this.elapsedMs),
          thresholdMs: observation.slowStatementMs,
          requestId: request?.requestId,
          method: request?.method,
          errorCode: sqliteErrorCode(error),
        },
        error ? 'db: statement failed' : 'db: slow statement',
      );
    }
  }
}

function assertQueryName(queryName: string): void {
  if (!QUERY_NAME_PATTERN.test(queryName)) {
    throw new Error(
      `invalid observed query name ${JSON.stringify(queryName)}; expected ${QUERY_NAME_PATTERN}`,
    );
  }
}

function statementOutcome(error: unknown): DbStatementOutcome {
  const code = sqliteErrorCode(error);
  if (code?.startsWith('SQLITE_BUSY')) return 'busy';
  if (code?.startsWith('SQLITE_LOCKED')) return 'locked';
  return error ? 'error' : 'ok';
}

function sqliteErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function roundMs(ms: number): number {
  return Math.round(ms * 10) / 10;
}
