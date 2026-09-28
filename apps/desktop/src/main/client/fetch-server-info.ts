import { ServerInfoSchema, type ServerInfo } from "@silverhand/shared";

export type ServerInfoFetcher = (
  input: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}>;

const SERVER_INFO_RETRY_DELAYS_MS = [250, 750] as const;

export interface FetchServerInfoWithRetryOptions {
  url: string;
  fetcher?: ServerInfoFetcher;
  retryDelaysMs?: readonly number[];
  signal?: AbortSignal;
}

class InvalidServerInfoResponseError extends Error {
  override name = "InvalidServerInfoResponseError";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function fetchServerInfoOnce(
  url: string,
  fetcher: ServerInfoFetcher,
  signal?: AbortSignal,
): Promise<ServerInfo> {
  const res = await fetcher(url, signal ? { signal } : undefined);
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
  const retryDelaysMs = opts.retryDelaysMs ?? SERVER_INFO_RETRY_DELAYS_MS;

  for (let attempt = 0; ; attempt += 1) {
    if (opts.signal?.aborted) {
      throw new Error("server info fetch aborted");
    }
    try {
      return await fetchServerInfoOnce(opts.url, fetcher, opts.signal);
    } catch (err) {
      const retryDelayMs = retryDelaysMs[attempt];
      if (retryDelayMs === undefined || !shouldRetryServerInfoError(err) || opts.signal?.aborted) {
        throw err;
      }
      if (!opts.signal) {
        await sleep(retryDelayMs);
        continue;
      }
      const signal = opts.signal;
      let abort = (): void => {};
      try {
        await Promise.race([
          sleep(retryDelayMs),
          new Promise<never>((_, reject) => {
            abort = () => reject(new Error("server info retry aborted"));
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
          }),
        ]);
      } finally {
        signal.removeEventListener("abort", abort);
      }
    }
  }
}
