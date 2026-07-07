import type { DesktopProfileSaveWithTestResult } from '../../../preload/api';

export const SETTINGS_SERVER_URL_SAVE_MAX_ATTEMPTS = 3;
const SETTINGS_SERVER_URL_SAVE_RETRY_DELAYS_MS = [250, 750] as const;

export type SaveServerConnectionProfileFn = (input: {
  serverUrl: string;
}) => Promise<DesktopProfileSaveWithTestResult>;

interface SaveServerConnectionProfileWithSettingsRetryOptions {
  serverUrl: string;
  save: SaveServerConnectionProfileFn;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function saveServerConnectionProfileWithSettingsRetry({
  serverUrl,
  save,
  maxAttempts = SETTINGS_SERVER_URL_SAVE_MAX_ATTEMPTS,
  sleep = defaultSleep,
}: SaveServerConnectionProfileWithSettingsRetryOptions): Promise<DesktopProfileSaveWithTestResult> {
  const attempts = Math.max(1, Math.floor(maxAttempts));
  let lastResult: DesktopProfileSaveWithTestResult | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await save({ serverUrl });
    lastResult = result;
    if (!isRetryableSettingsProfileSaveResult(result) || attempt === attempts) {
      return result;
    }
    await sleep(retryDelayMs(attempt));
  }
  return lastResult ?? save({ serverUrl });
}

export function isRetryableSettingsProfileSaveResult(
  result: DesktopProfileSaveWithTestResult,
): boolean {
  return (
    !result.ok &&
    result.phase === 'test' &&
    (result.test.kind === 'tls_failed' || result.test.kind === 'network_failed')
  );
}

function retryDelayMs(attempt: number): number {
  return SETTINGS_SERVER_URL_SAVE_RETRY_DELAYS_MS[
    Math.min(attempt - 1, SETTINGS_SERVER_URL_SAVE_RETRY_DELAYS_MS.length - 1)
  ] ?? SETTINGS_SERVER_URL_SAVE_RETRY_DELAYS_MS[0];
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
