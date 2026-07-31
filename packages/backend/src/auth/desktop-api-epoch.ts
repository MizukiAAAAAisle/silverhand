import type { Hono } from 'hono';
import type { IncomingMessage } from 'node:http';
import {
  DESKTOP_API_EPOCH_HEADER,
  DESKTOP_SERVER_API_EPOCH,
  MINIMUM_CLIENT_API_EPOCH,
  UPGRADE_REQUIRED_HTTP_STATUS,
  isDesktopApiEpochExemptPath,
  parseDesktopApiEpochHeader,
  type UpgradeRequiredBody,
} from '@silverhand/shared';
import type { BackendContext } from '../context.js';
import type { AppEnv } from './principal.js';

/**
 * #task:1761 — desktop↔server application API epoch admission (REST half).
 *
 * Authoritative enforcement of the safe-version-skew contract on the desktop
 * REST surface. The advertisement in `/api/server/info` is discovery only —
 * an old or hostile client can skip it, so every non-exempt `/api/*` request
 * is checked here BEFORE any business route runs.
 *
 * Surface scoping is structural, not inferential:
 *   - mounted at `/api/*`, so `/internal/*` (agent CLI), `/auth/*`, and
 *     `/readyz` are never touched;
 *   - the daemon's surfaces are exempt by name in the shared manifest;
 *   - "missing epoch" is therefore only ever a statement about the desktop
 *     surface, never about the CLI.
 *
 * The epoch is read from the DEDICATED `x-silverhand-desktop-api-epoch`
 * header (Cindy round-2 P1): its value is a compiled constant rendered to a
 * decimal string, so an epoch-aware desktop can never fail to send it — the
 * fail-open client-info telemetry header plays no role in admission. Absent
 * or malformed normalizes to epoch 0, the pre-epoch legacy generation. While
 * MINIMUM_CLIENT_API_EPOCH is 0 (observation bridge, exit conditions on the
 * constant), epoch 0 is admitted; once the minimum is raised, the same code
 * fails closed with a structured 426 body.
 */
/**
 * Test seam: the observation bridge ships with MINIMUM_CLIENT_API_EPOCH = 0,
 * which makes the rejection arm unreachable in production until the cutoff.
 * Tests inject a higher minimum to prove the fail-closed behavior the cutoff
 * will enable; production callers pass nothing and use the shared constant.
 */
export interface DesktopApiEpochOptions {
  minimumClientEpoch?: number;
}

export function installDesktopApiEpochMiddleware(
  app: Hono<AppEnv>,
  ctx: BackendContext,
  options: DesktopApiEpochOptions = {},
): void {
  const minimumClientEpoch =
    options.minimumClientEpoch ?? MINIMUM_CLIENT_API_EPOCH;
  app.use('/api/*', async (c, next) => {
    if (isDesktopApiEpochExemptPath(c.req.path)) {
      await next();
      return;
    }
    const clientEpoch = parseDesktopApiEpochHeader(
      c.req.header(DESKTOP_API_EPOCH_HEADER),
    );
    if (clientEpoch >= minimumClientEpoch) {
      await next();
      return;
    }
    ctx.logger.warn(
      {
        action: 'desktop_api_epoch_rejected',
        transport: 'rest',
        path: c.req.path,
        client_epoch: clientEpoch,
        minimum_client_epoch: minimumClientEpoch,
      },
      'desktop api epoch: client too old',
    );
    const body: UpgradeRequiredBody = {
      error: 'upgrade_required',
      reason: 'client_too_old',
      server_api_epoch: DESKTOP_SERVER_API_EPOCH,
      minimum_client_epoch: minimumClientEpoch,
    };
    return c.json(body, UPGRADE_REQUIRED_HTTP_STATUS);
  });
}

/**
 * WS half of the same gate, called by the event-WS upgrade handler after
 * authentication. Returns null when admitted, or the rejection body when the
 * client generation is below the server minimum (caller writes the 426).
 * Same epoch source and normalization as the REST half by construction.
 */
export function checkDesktopApiEpochOnUpgrade(
  req: IncomingMessage,
  options: DesktopApiEpochOptions = {},
): UpgradeRequiredBody | null {
  const minimumClientEpoch =
    options.minimumClientEpoch ?? MINIMUM_CLIENT_API_EPOCH;
  const clientEpoch = parseDesktopApiEpochHeader(
    req.headers[DESKTOP_API_EPOCH_HEADER],
  );
  if (clientEpoch >= minimumClientEpoch) return null;
  return {
    error: 'upgrade_required',
    reason: 'client_too_old',
    server_api_epoch: DESKTOP_SERVER_API_EPOCH,
    minimum_client_epoch: minimumClientEpoch,
  };
}
