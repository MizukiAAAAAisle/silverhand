import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import contract from '../src/daemon-admission.json' with { type: 'json' };
import { DAEMON_ADMISSION } from '../src/daemon-admission.generated.js';
import { apiPaths } from '../src/api/paths.js';
import { PROTOCOL_VERSIONS } from '../src/protocol-versions.js';
import { HOST_WS_CLOSE_REASON_UPDATE_REQUIRED } from '../src/api/host.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

describe('daemon admission authority', () => {
  it('emits the lowercase terminal reason understood by released daemon 0.2.0', () => {
    expect(contract.updateRequiredCloseReason).toBe('update_required');
    expect(HOST_WS_CLOSE_REASON_UPDATE_REQUIRED).toBe(contract.updateRequiredCloseReason);
  });
  it('keeps the checked-in TypeScript projection generated', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/generate-daemon-admission.mjs', '--check'],
      { cwd: packageRoot, encoding: 'utf8' },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it('drives both strict daemon axes without conflating them', () => {
    expect(DAEMON_ADMISSION).toEqual(contract);
    expect(PROTOCOL_VERSIONS.host).toBe(contract.hostProtocolVersion);
    expect(PROTOCOL_VERSIONS.outbound).toBe(contract.outboundProtocolVersion);
    expect(apiPaths.hostConnect).toBe(contract.hostWebSocketPath);
  });
});
