import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';

// One result writer while Node runs; the outer entry appends exit/cleanup only
// after it has waited for this process. Counts are derived, never hand-written.
export class AcceptanceRecord {
  constructor(out, names) {
    assert.equal(new Set(names).size, names.length, 'Duplicate scenario id');
    this.out = resolve(out);
    this.file = resolve(out, 'raw.json');
    this.data = existsSync(this.file) ? JSON.parse(readFileSync(this.file)) : {};
    assert(
      !this.data.steps?.length ||
        (this.data.steps.every((row) => row.status === 'not_executed') &&
          JSON.stringify(this.data.steps.map((row) => row.id)) === JSON.stringify(names)),
      'Refusing to replace previous actions',
    );
    this.data.steps = names.map((id) => ({ id, status: 'not_executed' }));
    this.data.observations = [];
    this.flush();
  }
  flush() {
    writeFileSync(this.file + '.tmp', JSON.stringify(this.data, null, 2));
    renameSync(this.file + '.tmp', this.file);
    const counts = { planned: this.data.steps.length };
    for (const status of ['passed', 'failed', 'running', 'not_executed'])
      counts[status] = this.data.steps.filter((row) => row.status === status).length;
    counts.groups = Object.fromEntries(
      ['original12', 'B1', 'B2', ...(this.data.steps.some((row) => row.id.startsWith('DIAG.')) ? ['DIAG'] : []), ...(this.data.steps.some((row) => row.id.startsWith('B3.')) ? ['PRE', 'B3'] : [])].map((group) => [
        group,
        Object.fromEntries(
          ['passed', 'failed', 'running', 'not_executed'].map((status) => [
            status,
            this.data.steps.filter(
              (row) =>
                (row.id.includes('.') ? row.id.split('.')[0] : 'original12') === group &&
                row.status === status,
            ).length,
          ]),
        ),
      ]),
    );
    writeFileSync(resolve(this.out, 'counts.json'), JSON.stringify(counts, null, 2));
  }
  observe(name, value) {
    this.data.observations.push({ name, at: new Date().toISOString(), value });
    this.flush();
  }
  pass(id, detail) {
    const row = this.data.steps.find((row) => row.id === id);
    assert(row, 'Unknown scenario ' + id);
    assert.equal(row.status, 'not_executed', 'Repeated scenario ' + id);
    Object.assign(row, { status: 'passed', detail, finished_at: new Date().toISOString() });
    this.flush();
  }
  async step(id, fn) {
    const row = this.data.steps.find((row) => row.id === id);
    assert(row, 'Unknown scenario ' + id);
    assert.equal(row.status, 'not_executed', 'Repeated scenario ' + id);
    Object.assign(row, { status: 'running', started_at: new Date().toISOString() });
    this.flush();
    try {
      row.detail = await fn();
      row.status = 'passed';
      console.log('PASS ' + id);
    } catch (error) {
      row.status = 'failed';
      row.error = String(error);
      throw error;
    } finally {
      row.finished_at = new Date().toISOString();
      this.flush();
    }
  }
  fail(error) {
    if (!this.data.steps.some((row) => row.status === 'failed')) {
      const row =
        this.data.steps.find((row) => row.status === 'running') ??
        this.data.steps.find((row) => row.status === 'not_executed');
      if (row)
        Object.assign(row, {
          status: 'failed',
          error: String(error),
          finished_at: new Date().toISOString(),
        });
    }
    this.data.first_error ??= { type: error?.constructor?.name ?? 'Error', message: String(error) };
    this.data.status = 'failed';
    this.flush();
  }
  complete() {
    assert(
      this.data.steps.every((row) => row.status === 'passed'),
      'Some scenarios did not execute',
    );
    this.data.status = 'passed';
    this.flush();
  }
}
