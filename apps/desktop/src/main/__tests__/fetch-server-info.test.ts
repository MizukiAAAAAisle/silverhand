import { describe, expect, it } from 'vitest';
import {
  fetchServerInfoWithRetry,
  type ServerInfoFetcher,
  type SleepFn,
} from '../fetch-server-info.js';

function response(
  status: number,
  body: unknown,
  statusText = status === 200 ? 'OK' : 'Bad Gateway',
): Awaited<ReturnType<ServerInfoFetcher>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

describe('fetchServerInfoWithRetry', () => {
  it('returns server info without sleeping on the first successful attempt', async () => {
    const sleeps: number[] = [];
    const result = await fetchServerInfoWithRetry({
      url: 'https://example.test/api/server/info',
      fetcher: async () => response(200, { signup_enabled: false }),
      sleep: async ms => {
        sleeps.push(ms);
      },
    });

    expect(result).toEqual({ signup_enabled: false });
    expect(sleeps).toEqual([]);
  });

  it('silently retries transient fetch failures before surfacing boot gate', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const result = await fetchServerInfoWithRetry({
      url: 'https://example.test/api/server/info',
      retryDelaysMs: [10, 20],
      fetcher: async () => {
        attempts += 1;
        if (attempts < 3) throw new TypeError('fetch failed');
        return response(200, { signup_enabled: true });
      },
      sleep: async ms => {
        sleeps.push(ms);
      },
    });

    expect(result).toEqual({ signup_enabled: true });
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([10, 20]);
  });

  it('retries transient non-2xx responses and throws the final raw error', async () => {
    const sleeps: number[] = [];
    const statuses = [502, 503, 404];
    const fetcher: ServerInfoFetcher = async () => {
      const status = statuses.shift();
      if (status === undefined) throw new Error('unexpected extra attempt');
      return response(
        status,
        `upstream ${status}`,
        status === 404 ? 'Not Found' : 'Bad Gateway',
      );
    };

    await expect(
      fetchServerInfoWithRetry({
        url: 'https://example.test/api/server/info',
        retryDelaysMs: [10, 20],
        fetcher,
        sleep: async ms => {
          sleeps.push(ms);
        },
      }),
    ).rejects.toThrow('404 Not Found: upstream 404');

    expect(statuses).toEqual([]);
    expect(sleeps).toEqual([10, 20]);
  });

  it('does not retry a 2xx response that is not Silverhand server info', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const sleep: SleepFn = async ms => {
      sleeps.push(ms);
    };

    await expect(
      fetchServerInfoWithRetry({
        url: 'https://example.test/api/server/info',
        fetcher: async () => {
          attempts += 1;
          return response(200, { unexpected: 'shape' });
        },
        sleep,
      }),
    ).rejects.toThrow('invalid server info response');

    expect(attempts).toBe(1);
    expect(sleeps).toEqual([]);
  });
});
