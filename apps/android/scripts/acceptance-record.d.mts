export type ScenarioStatus = 'not_executed' | 'running' | 'passed' | 'failed';
export interface ScenarioResult {
  id: string;
  status: ScenarioStatus;
  detail?: unknown;
  error?: string;
  started_at?: string;
  finished_at?: string;
}
export class AcceptanceRecord {
  constructor(out: string, names: readonly string[]);
  readonly out: string;
  readonly file: string;
  data: Record<string, unknown> & { steps: ScenarioResult[]; observations: unknown[] };
  flush(): void;
  observe(name: string, value: unknown): void;
  pass(id: string, detail: unknown): void;
  step(id: string, fn: () => unknown | Promise<unknown>): Promise<void>;
  fail(error: unknown): void;
  complete(): void;
}
