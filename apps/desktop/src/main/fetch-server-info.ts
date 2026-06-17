import { ServerInfoSchema, type ServerInfo } from '@silverhand/shared';

export type ServerInfoFetcher = (
  input: string,
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}>;

export type SleepFn = (ms: number) => Promise<void>;

export const SERVER_INFO_RETRY_DELAYS_MS = [250, 750] as const;

export interface FetchServerInfoWithRetryOptions {
  url: string;
  fetcher?: ServerInfoFetcher;
  sleep?: SleepFn;
  retryDelaysMs?: readonly number[];
}

class InvalidServerInfoResponseError extends Error {
  override name = 'InvalidServerInfoResponseError';
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

const defaultSleep: SleepFn = ms =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

async function fetchServerInfoOnce(
  url: string,
  fetcher: ServerInfoFetcher,
): Promise<ServerInfo> {
  const res = await fetcher(url);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  const parsed = ServerInfoSchema.safeParse(parseJson(text));
  if (!parsed.success) {
    throw new InvalidServerInfoResponseError(
      `invalid server info response: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

function shouldRetryServerInfoError(err: unknown): boolean {
  return !(err instanceof InvalidServerInfoResponseError);
}

export async function fetchServerInfoWithRetry(
  opts: FetchServerInfoWithRetryOptions,
): Promise<ServerInfo> {
  const fetcher = opts.fetcher ?? (globalThis.fetch as ServerInfoFetcher);
  const sleep = opts.sleep ?? defaultSleep;
  const retryDelaysMs = opts.retryDelaysMs ?? SERVER_INFO_RETRY_DELAYS_MS;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchServerInfoOnce(opts.url, fetcher);
    } catch (err) {
      const retryDelayMs = retryDelaysMs[attempt];
      if (retryDelayMs === undefined || !shouldRetryServerInfoError(err)) {
        throw err;
      }
      await sleep(retryDelayMs);
    }
  }
}
