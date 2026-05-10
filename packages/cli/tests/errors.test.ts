import { describe, expect, it } from 'vitest';
import {
  CliError,
  ERROR_CODES,
  exitCodeFor,
  fromNetworkError,
  fromUnknown,
  mapHttpError,
  writeError,
} from '../src/errors.js';

describe('CliError contract', () => {
  it('exposes the contract codes for stable downstream branching', () => {
    expect(ERROR_CODES).toEqual([
      'not_found',
      'forbidden',
      'unauthorized',
      'validation_error',
      'conflict',
      'rate_limited',
      'upstream_unavailable',
      'internal',
    ]);
  });

  it('maps exit codes per the agent-facing contract', () => {
    expect(exitCodeFor('validation_error')).toBe(1);
    expect(exitCodeFor('not_found')).toBe(1);
    expect(exitCodeFor('conflict')).toBe(1);
    expect(exitCodeFor('rate_limited')).toBe(2);
    expect(exitCodeFor('upstream_unavailable')).toBe(2);
    expect(exitCodeFor('unauthorized')).toBe(3);
    expect(exitCodeFor('forbidden')).toBe(3);
    expect(exitCodeFor('internal')).toBe(1);
  });
});

describe('mapHttpError', () => {
  it('infers from status when body is empty', () => {
    expect(mapHttpError(404, '').code).toBe('not_found');
    expect(mapHttpError(401, '').code).toBe('unauthorized');
    expect(mapHttpError(403, '').code).toBe('forbidden');
    expect(mapHttpError(409, '').code).toBe('conflict');
    expect(mapHttpError(429, '').code).toBe('rate_limited');
    expect(mapHttpError(503, '').code).toBe('upstream_unavailable');
    expect(mapHttpError(418, '').code).toBe('validation_error');
  });

  it('marks 5xx and 429 as retriable, others as not', () => {
    expect(mapHttpError(503, '').retriable).toBe(true);
    expect(mapHttpError(429, '').retriable).toBe(true);
    expect(mapHttpError(404, '').retriable).toBe(false);
    expect(mapHttpError(401, '').retriable).toBe(false);
  });

  it('prefers a backend-supplied stable code over status inference', () => {
    const err = mapHttpError(
      400,
      JSON.stringify({ error: { code: 'conflict', message: 'task already done' } }),
    );
    expect(err.code).toBe('conflict');
    expect(err.message).toBe('task already done');
  });

  it('ignores backend-supplied codes that are not in our enum', () => {
    const err = mapHttpError(
      400,
      JSON.stringify({ error: { code: 'not_a_real_code', message: 'oops' } }),
    );
    expect(err.code).toBe('validation_error');
    // We still surface the friendly message even though we rejected the code.
    expect(err.message).toBe('oops');
  });

  it('accepts flat {code, message} bodies (no nesting)', () => {
    const err = mapHttpError(429, JSON.stringify({ code: 'rate_limited', message: 'slow down' }));
    expect(err.code).toBe('rate_limited');
    expect(err.message).toBe('slow down');
  });

  it('survives non-JSON bodies (proxy HTML, plain text)', () => {
    const err = mapHttpError(502, '<html>Bad Gateway</html>');
    expect(err.code).toBe('upstream_unavailable');
    expect(err.message).toMatch(/HTTP 502/);
  });
});

describe('fromNetworkError', () => {
  it('wraps fetch failures as transient/upstream_unavailable', () => {
    const err = fromNetworkError(new Error('connect ECONNREFUSED'));
    expect(err.code).toBe('upstream_unavailable');
    expect(err.retriable).toBe(true);
    expect(err.message).toMatch(/ECONNREFUSED/);
  });
});

describe('fromUnknown', () => {
  it('passes CliError through unchanged', () => {
    const orig = new CliError({ code: 'conflict', message: 'x', retriable: false });
    expect(fromUnknown(orig)).toBe(orig);
  });

  it('maps zod-style errors to validation_error', () => {
    const zodLike = {
      name: 'ZodError',
      errors: [{ path: ['title'], message: 'Required' }],
    };
    const err = fromUnknown(zodLike);
    expect(err.code).toBe('validation_error');
    expect(err.message).toMatch(/title/);
  });

  it('falls back to internal for unknown throws (no stack leak)', () => {
    const err = fromUnknown(new Error('nope'));
    expect(err.code).toBe('internal');
    expect(err.retriable).toBe(false);
    expect(err.message).not.toContain('at ');
  });
});

describe('writeError', () => {
  it('emits one-line JSON with the error payload in JSON mode', () => {
    const writes: string[] = [];
    const err = new CliError({ code: 'not_found', message: 'task #42 not found', retriable: false });
    writeError(err, { json: true, stderr: { write: s => writes.push(s) } });
    expect(writes.length).toBe(1);
    expect(writes[0]!.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(writes[0]!);
    expect(parsed).toEqual({
      error: { code: 'not_found', message: 'task #42 not found', retriable: false },
    });
  });

  it('emits a short prefixed line in human mode', () => {
    const writes: string[] = [];
    const err = new CliError({ code: 'forbidden', message: 'no access', retriable: false });
    writeError(err, { json: false, stderr: { write: s => writes.push(s) } });
    expect(writes[0]).toBe('silverhand: forbidden: no access\n');
  });

  it('never writes a stack trace', () => {
    const writes: string[] = [];
    const inner = new Error('boom');
    const cli = fromUnknown(inner);
    writeError(cli, { json: true, stderr: { write: s => writes.push(s) } });
    expect(writes[0]).not.toContain(' at ');
    expect(writes[0]).not.toContain('\n    at ');
  });
});
