import { delimiter } from 'node:path';
import {
  expandProxyEnv,
  SILVERHAND_AGENT_ID_ENV,
  SILVERHAND_AUTH_TOKEN_ENV,
  SILVERHAND_CONVERSATION_ID_ENV,
  SILVERHAND_SERVER_URL_ENV,
} from '@silverhand/shared';
import type { DaemonProxyConfig } from './proxy-config.js';
import type { Driver } from '../drivers/index.js';
import type { StartOptions } from '../protocol.js';

export interface DaemonSpawnEnvInput {
  driver: Driver;
  options: StartOptions;
  conversationId: string;
  agentId: string;
  binDir: string;
  proxyConfig?: DaemonProxyConfig;
  baseProcessEnv?: NodeJS.ProcessEnv;
}

export function buildDaemonSpawnEnv(
  input: DaemonSpawnEnvInput,
): NodeJS.ProcessEnv {
  const options = input.options;
  let env = input.driver.applyEnv(input.baseProcessEnv ?? process.env);
  if (
    input.proxyConfig?.proxy_url &&
    input.proxyConfig.proxy_runtimes.includes(options.driver.kind)
  ) {
    const proxyEnv = expandProxyEnv(input.proxyConfig.proxy_url);
    if (proxyEnv) env = { ...env, ...proxyEnv };
  }

  const currentPath = env.PATH ?? process.env.PATH ?? '';
  return {
    ...env,
    [SILVERHAND_CONVERSATION_ID_ENV]: input.conversationId,
    [SILVERHAND_AGENT_ID_ENV]: input.agentId,
    [SILVERHAND_SERVER_URL_ENV]: options.env_policy.silverhand.server_url,
    [SILVERHAND_AUTH_TOKEN_ENV]: options.env_policy.silverhand.auth_token,
    PATH: currentPath ? `${input.binDir}${delimiter}${currentPath}` : input.binDir,
  };
}
