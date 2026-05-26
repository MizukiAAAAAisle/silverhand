#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  runAdminCommand,
  ServerEnvConfigError,
  startStandaloneSilverhandServer,
} from './index.js';

async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv[0] === 'admin') {
    process.exitCode = await runAdminCommand(argv.slice(1));
    return;
  }
  if (argv[0] === '--help' || argv[0] === '-h') {
    console.log('Usage:\n  silverhand-server\n  silverhand-server admin <subcommand>');
    return;
  }
  if (argv.length > 0) {
    console.error(`[silverhand-server] unknown argument: ${argv[0]}`);
    process.exitCode = 1;
    return;
  }

  const running = await startStandaloneSilverhandServer();
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    console.log(`[silverhand-server] received ${signal}; shutting down`);
    await running.close();
    process.exit(0);
  };
  process.once('SIGINT', signal => void shutdown(signal));
  process.once('SIGTERM', signal => void shutdown(signal));
  console.log(`[silverhand-server] listening at ${running.url}`);
}

if (isMainModule()) {
  main().catch(err => {
    if (err instanceof ServerEnvConfigError) {
      console.error(`[silverhand-server] invalid configuration: ${err.message}`);
    } else {
      console.error('[silverhand-server] boot failed:', err);
    }
    process.exit(1);
  });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return !!entry && fileURLToPath(import.meta.url) === resolve(entry);
}
