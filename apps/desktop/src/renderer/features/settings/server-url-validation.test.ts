import { describe, expect, it } from 'vitest';
import { validateServerUrlDraft } from './server-url-validation';

describe('validateServerUrlDraft', () => {
  it('keeps non-loopback http rejected by default', () => {
    const result = validateServerUrlDraft('http://215.192.147.162:8080');
    expect(result.kind).toBe('reject');
    if (result.kind !== 'reject') throw new Error('unreachable');
    expect(result.reason).toBe('insecure_remote_http_disallowed');
  });

  it('admits non-loopback http when this packaged client opted in', () => {
    const result = validateServerUrlDraft('http://215.192.147.162:8080', {
      allowInsecureRemote: true,
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.url.toString()).toBe('http://215.192.147.162:8080/');
  });
});
