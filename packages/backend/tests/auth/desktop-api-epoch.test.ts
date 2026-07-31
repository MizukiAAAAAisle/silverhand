import { describe, expect, it, afterEach } from 'vitest';
import {
  apiPaths,
  CLIENT_INFO_HEADER,
  DESKTOP_API_EPOCH_HEADER,
  DESKTOP_SERVER_API_EPOCH,
  UpgradeRequiredBodySchema,
} from '@silverhand/shared';
import { checkDesktopApiEpochOnUpgrade } from '../../src/auth/desktop-api-epoch.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import type { IncomingMessage } from 'node:http';

/**
 * #task:1761 — behavior tests for the desktop↔server API epoch admission.
 * Admission input is the DEDICATED epoch header (round-2: the fail-open
 * client-info telemetry header plays no role here). Asserts status codes,
 * structured body fields, and routing only — never message copy.
 */

const EPOCH = String(DESKTOP_SERVER_API_EPOCH);

describe('desktop api epoch admission (REST)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('observation bridge: admits current, pre-epoch (missing header), and malformed values', async () => {
    t = buildTestApp();
    const h = http(t);
    const current = await h.get(apiPaths.me, {
      headers: { [DESKTOP_API_EPOCH_HEADER]: EPOCH },
    });
    expect(current.status).toBe(200);
    // pre-epoch desktop: no epoch header at all
    const missing = await h.get(apiPaths.me);
    expect(missing.status).toBe(200);
    // malformed value normalizes to epoch 0, still admitted under min=0
    const malformed = await h.get(apiPaths.me, {
      headers: { [DESKTOP_API_EPOCH_HEADER]: 'not-a-number' },
    });
    expect(malformed.status).toBe(200);
    // client-info telemetry header alone is NOT admission input; its absence
    // or presence must not change the outcome.
    const telemetryOnly = await h.get(apiPaths.me, {
      headers: { [CLIENT_INFO_HEADER]: 'garbage' },
    });
    expect(telemetryOnly.status).toBe(200);
  });

  it('post-cutoff: rejects below-minimum clients with a structured 426 and admits current ones', async () => {
    t = buildTestApp({
      desktopApiEpoch: { minimumClientEpoch: DESKTOP_SERVER_API_EPOCH },
    });
    const h = http(t);
    // missing header → epoch 0 → fail closed
    const missing = await h.get(apiPaths.me);
    expect(missing.status).toBe(426);
    const body = UpgradeRequiredBodySchema.parse(await missing.json());
    expect(body.reason).toBe('client_too_old');
    expect(body.server_api_epoch).toBe(DESKTOP_SERVER_API_EPOCH);
    expect(body.minimum_client_epoch).toBe(DESKTOP_SERVER_API_EPOCH);
    // current client passes the same gate via the dedicated header only
    const current = await h.get(apiPaths.me, {
      headers: { [DESKTOP_API_EPOCH_HEADER]: EPOCH },
    });
    expect(current.status).toBe(200);
  });

  it('post-cutoff: exempt discovery routes stay reachable for the rejected generation', async () => {
    t = buildTestApp({
      desktopApiEpoch: { minimumClientEpoch: DESKTOP_SERVER_API_EPOCH },
    });
    const h = http(t);
    const info = await h.get(apiPaths.serverInfo);
    expect(info.status).toBe(200);
    const infoBody = (await info.json()) as {
      desktop_api?: { current_epoch: number; minimum_client_epoch: number };
    };
    expect(infoBody.desktop_api?.current_epoch).toBe(DESKTOP_SERVER_API_EPOCH);
    expect(typeof infoBody.desktop_api?.minimum_client_epoch).toBe('number');
    const health = await h.get(apiPaths.health);
    expect(health.status).toBe(200);
  });

  it('advertises desktop_api on server/info in the default build', async () => {
    t = buildTestApp();
    const h = http(t);
    const res = await h.get(apiPaths.serverInfo);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      desktop_api?: { current_epoch: number; minimum_client_epoch: number };
    };
    expect(body.desktop_api).toBeDefined();
    expect(body.desktop_api!.current_epoch).toBe(DESKTOP_SERVER_API_EPOCH);
  });
});

describe('desktop api epoch admission (event-WS, same source)', () => {
  function fakeUpgradeReq(epoch?: string): IncomingMessage {
    return {
      headers: epoch === undefined ? {} : { [DESKTOP_API_EPOCH_HEADER]: epoch },
    } as IncomingMessage;
  }

  it('admits current and pre-epoch generations under the bridge, rejects below a raised minimum', () => {
    expect(checkDesktopApiEpochOnUpgrade(fakeUpgradeReq())).toBeNull();
    expect(checkDesktopApiEpochOnUpgrade(fakeUpgradeReq(EPOCH))).toBeNull();
    const rejected = checkDesktopApiEpochOnUpgrade(fakeUpgradeReq(), {
      minimumClientEpoch: DESKTOP_SERVER_API_EPOCH,
    });
    expect(rejected).not.toBeNull();
    expect(UpgradeRequiredBodySchema.parse(rejected).reason).toBe(
      'client_too_old',
    );
    // REST/WS source parity: the same header admits on both halves.
    expect(
      checkDesktopApiEpochOnUpgrade(fakeUpgradeReq(EPOCH), {
        minimumClientEpoch: DESKTOP_SERVER_API_EPOCH,
      }),
    ).toBeNull();
  });
});
