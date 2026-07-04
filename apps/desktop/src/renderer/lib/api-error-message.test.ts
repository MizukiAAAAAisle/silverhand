import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { describeApiError, parseApiErrorBody } from './api-error-message';

const options = {
  actionLabel: "Couldn't create the workspace",
  backendUnreachableMessage:
    "Can't reach the backend. Check your connection and try again.",
  fallbackMessage: "Couldn't create the workspace. Please try again.",
  knownCodeMessages: {
    local_host_unbound:
      'No connected computer can store this workspace. Connect one and try again.',
  },
};

describe('parseApiErrorBody', () => {
  it('extracts the backend-curated error and code from JSON bodies', () => {
    expect(
      parseApiErrorBody(
        JSON.stringify({
          error: 'workspace name already exists',
          code: 'workspace_name_taken',
        }),
      ),
    ).toEqual({
      code: 'workspace_name_taken',
      detail: 'workspace name already exists',
    });
  });

  it('falls back across supported detail fields', () => {
    expect(
      parseApiErrorBody(JSON.stringify({ message: 'materialize timed out' })),
    ).toEqual({ code: null, detail: 'materialize timed out' });
    expect(parseApiErrorBody(JSON.stringify({ reason: 'quota exceeded' }))).toEqual({
      code: null,
      detail: 'quota exceeded',
    });
  });

  it('bounds raw non-JSON bodies', () => {
    const parsed = parseApiErrorBody('x'.repeat(400));
    expect(parsed.code).toBeNull();
    expect(parsed.detail).toHaveLength(320);
    expect(parsed.detail?.endsWith('…')).toBe(true);
  });
});

describe('describeApiError', () => {
  it('keeps known typed codes on their tailored user-facing copy', () => {
    expect(
      describeApiError(
        new ApiError(
          409,
          'Conflict',
          JSON.stringify({
            error: 'local host not bound',
            code: 'local_host_unbound',
          }),
        ),
        options,
      ),
    ).toBe(
      'No connected computer can store this workspace. Connect one and try again.',
    );
  });

  it('surfaces unknown backend reasons instead of a generic fallback', () => {
    expect(
      describeApiError(
        new ApiError(
          409,
          'Conflict',
          JSON.stringify({
            error: 'workspace name already exists',
            code: 'workspace_name_taken',
          }),
        ),
        options,
      ),
    ).toBe(
      "Couldn't create the workspace: workspace name already exists (workspace_name_taken).",
    );
  });

  it('falls back to HTTP status when the body has no usable reason', () => {
    expect(
      describeApiError(
        new ApiError(500, 'Internal Server Error', JSON.stringify({ issues: [] })),
        options,
      ),
    ).toBe("Couldn't create the workspace: HTTP 500 Internal Server Error.");
  });

  it('preserves backend-unreachable copy', () => {
    expect(
      describeApiError(
        new ApiError(0, 'Network Error', '{}', 'backend_unreachable'),
        options,
      ),
    ).toBe("Can't reach the backend. Check your connection and try again.");
  });

  it('surfaces plain Error messages in bounded form', () => {
    expect(describeApiError(new Error('boom'), options)).toBe(
      "Couldn't create the workspace: boom.",
    );
  });
});
