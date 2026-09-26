import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import contract from '../src/backend-admission.json' with { type: 'json' };
import { BACKEND_ADMISSION } from '../src/backend-admission.generated.js';
import { apiPaths } from '../src/api/paths.js';
import { PROTOCOL_VERSIONS } from '../src/protocol-versions.js';
import { EVENT_WS_SESSION_COOKIE } from '../src/config.js';
import {
  DESKTOP_API_EPOCH_HEADER,
  DESKTOP_SERVER_API_EPOCH,
  MINIMUM_CLIENT_API_EPOCH,
  MINIMUM_SERVER_API_EPOCH,
} from '../src/desktop-server-api-epoch.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

describe('backend admission authority', () => {
  it('keeps the checked-in TypeScript projection generated', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/generate-backend-admission.mjs', '--check'],
      { cwd: packageRoot, encoding: 'utf8' },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it('drives every desktop client admission consumer', () => {
    expect(BACKEND_ADMISSION).toEqual(contract);
    expect(PROTOCOL_VERSIONS.desktopApi).toBe(contract.desktopApi);
    expect(PROTOCOL_VERSIONS.desktopMinClient).toBe(contract.desktopMinClient);
    expect(PROTOCOL_VERSIONS.desktopMinServer).toBe(contract.desktopMinServer);
    expect(DESKTOP_SERVER_API_EPOCH).toBe(contract.desktopApi);
    expect(MINIMUM_CLIENT_API_EPOCH).toBe(contract.desktopMinClient);
    expect(MINIMUM_SERVER_API_EPOCH).toBe(contract.desktopMinServer);
    expect(apiPaths.eventWebSocket).toBe(contract.eventWebSocketPath);
    expect(EVENT_WS_SESSION_COOKIE).toBe(contract.eventWebSocketSessionCookie);
    expect(DESKTOP_API_EPOCH_HEADER).toBe(contract.desktopApiEpochHeader);
  });
});
