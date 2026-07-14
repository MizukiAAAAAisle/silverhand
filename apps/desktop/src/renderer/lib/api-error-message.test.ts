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
    workspace_path_conflict:
      'This folder is already used by another Silverhand workspace; choose a different folder.',
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
      // Compare to the configured copy — the routing (code → message) is the
      // contract, not the sentence text.
    ).toBe(options.knownCodeMessages.local_host_unbound);
  });

  it('lets known codes replace noisy backend path details', () => {
    expect(
      describeApiError(
        new ApiError(
          409,
          'Conflict',
          JSON.stringify({
            error:
              'path /Users/alice/work/my-workspace is already bound to workspace ws_other',
            code: 'workspace_path_conflict',
          }),
        ),
        options,
      ),
    ).toBe(options.knownCodeMessages.workspace_path_conflict);
  });

  it('surfaces unknown backend reasons instead of a generic fallback', () => {
    const msg = describeApiError(
      new ApiError(
        409,
        'Conflict',
        JSON.stringify({
          error: 'workspace name already exists',
          code: 'workspace_name_taken',
        }),
      ),
      options,
    );
    // Contract: an unknown code surfaces the backend detail + the raw code so
    // the user/operator can act, rather than collapsing to the generic
    // fallback. Assert those pieces are carried, not the exact wording.
    expect(msg).toContain('workspace name already exists');
    expect(msg).toContain('workspace_name_taken');
    expect(msg).not.toBe(options.fallbackMessage);
  });

  it('falls back to HTTP status when the body has no usable reason', () => {
    const msg = describeApiError(
      new ApiError(500, 'Internal Server Error', JSON.stringify({ issues: [] })),
      options,
    );
    // No usable body reason → the HTTP status is preserved in the message.
    expect(msg).toContain('500');
    expect(msg).toContain('Internal Server Error');
  });

  it('preserves backend-unreachable copy', () => {
    expect(
      describeApiError(
        new ApiError(0, 'Network Error', '{}', 'backend_unreachable'),
        options,
      ),
    ).toBe(options.backendUnreachableMessage);
  });

  it('surfaces plain Error messages in bounded form', () => {
    // The underlying error message is carried through, not swallowed.
    expect(describeApiError(new Error('boom'), options)).toContain('boom');
  });
});
