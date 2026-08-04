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
 *
 * relocation-v1 §6 raised `MINIMUM_CLIENT_API_EPOCH` to the current epoch, so
 * the DEFAULT build now fails closed on the pre-epoch generation; the former
 * observation-bridge pins are inverted below. The `minimumClientEpoch` seam
 * survives as the way to prove the gate reads the configured minimum rather
 * than the compiled constant. A pre-epoch desktop is emulated by
 * `http(t, {}, { omitDesktopApiEpoch: true })` — the harness otherwise stamps
 * the header like a current desktop does.
 */

const EPOCH = String(DESKTOP_SERVER_API_EPOCH);

describe('desktop api epoch admission (REST)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('default build: admits a current epoch, fails closed on pre-epoch (missing header) and malformed values', async () => {
    t = buildTestApp();
    const current = await http(t).get(apiPaths.me, {
      headers: { [DESKTOP_API_EPOCH_HEADER]: EPOCH },
    });
    expect(current.status).toBe(200);
    // pre-epoch desktop: no epoch header at all
    const preEpoch = http(t, {}, { omitDesktopApiEpoch: true });
    const missing = await preEpoch.get(apiPaths.me);
    expect(missing.status).toBe(426);
    const body = UpgradeRequiredBodySchema.parse(await missing.json());
    expect(body.reason).toBe('client_too_old');
    expect(body.server_api_epoch).toBe(DESKTOP_SERVER_API_EPOCH);
    expect(body.minimum_client_epoch).toBe(DESKTOP_SERVER_API_EPOCH);
    // malformed value normalizes to epoch 0 → same rejection
    const malformed = await http(t).get(apiPaths.me, {
      headers: { [DESKTOP_API_EPOCH_HEADER]: 'not-a-number' },
    });
    expect(malformed.status).toBe(426);
    // client-info telemetry header alone is NOT admission input: it neither
    // rescues a pre-epoch client nor spoils a current one.
    const telemetryOnly = await preEpoch.get(apiPaths.me, {
      headers: { [CLIENT_INFO_HEADER]: 'garbage' },
    });
    expect(telemetryOnly.status).toBe(426);
    const currentWithTelemetry = await http(t).get(apiPaths.me, {
      headers: { [CLIENT_INFO_HEADER]: 'garbage' },
    });
    expect(currentWithTelemetry.status).toBe(200);
  });

  it('the gate reads the CONFIGURED minimum: a minimum above this build refuses even a current client', async () => {
    t = buildTestApp({
      desktopApiEpoch: { minimumClientEpoch: DESKTOP_SERVER_API_EPOCH + 1 },
    });
    const res = await http(t).get(apiPaths.me);
    expect(res.status).toBe(426);
    const body = UpgradeRequiredBodySchema.parse(await res.json());
    expect(body.reason).toBe('client_too_old');
    expect(body.server_api_epoch).toBe(DESKTOP_SERVER_API_EPOCH);
    expect(body.minimum_client_epoch).toBe(DESKTOP_SERVER_API_EPOCH + 1);
  });

  it('exempt discovery routes stay reachable for the rejected generation', async () => {
    t = buildTestApp();
    const h = http(t, {}, { omitDesktopApiEpoch: true });
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

  it('admits the current generation, rejects pre-epoch under the default and a raised minimum', () => {
    expect(checkDesktopApiEpochOnUpgrade(fakeUpgradeReq(EPOCH))).toBeNull();
    const rejectedByDefault = checkDesktopApiEpochOnUpgrade(fakeUpgradeReq());
    expect(rejectedByDefault).not.toBeNull();
    expect(UpgradeRequiredBodySchema.parse(rejectedByDefault).reason).toBe(
      'client_too_old',
    );
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
