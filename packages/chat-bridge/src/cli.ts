#!/usr/bin/env node
import { parseArgs } from './args.js';
import { startBridge } from './server.js';
import { initBridgeLogger, log } from './logger.js';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  initBridgeLogger({ sessionId: args.sessionId, agentId: args.agentId, runtime: args.runtime });
  try {
    await startBridge(args);
  } catch (err) {
    log('error', { err }, 'chat-bridge: startBridge threw');
    throw err;
  }
}

main().catch(err => {
  log('error', { err }, 'chat-bridge: fatal');
  console.error('[chat-bridge] fatal:', err);
  process.exit(1);
});
