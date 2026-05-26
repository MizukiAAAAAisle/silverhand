import type { HostWsServerController } from './host-ws-server.js';
import {
  HOST_TOKEN_ROTATION_GRACE_MS,
  HostTokenService,
  type IssuedHostToken,
} from '../auth/host-token.js';
import type { BackendLogger } from '../context.js';

export type HostTokenRotationErrorCode =
  | 'daemon_rejected'
  | 'daemon_host_mismatch';

export class HostTokenRotationError extends Error {
  constructor(
    readonly code: HostTokenRotationErrorCode,
    message: string,
    readonly details: {
      hostId: string;
      daemonReason?: string;
    },
  ) {
    super(message);
    this.name = 'HostTokenRotationError';
  }
}

export interface HostTokenRotationCoordinatorOptions {
  hostTokens: HostTokenService;
  transport: HostWsServerController;
  logger: BackendLogger;
  now?: () => number;
  graceMs?: number;
  timeoutMs?: number;
}

export interface HostTokenRotationResult {
  hostId: string;
  issued: IssuedHostToken;
  issuedAt: number;
  graceUntil: number;
  configRefreshedAt: number;
}

export class HostTokenRotationCoordinator {
  private readonly now: () => number;
  private readonly graceMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly opts: HostTokenRotationCoordinatorOptions) {
    this.now = opts.now ?? Date.now;
    this.graceMs = opts.graceMs ?? HOST_TOKEN_ROTATION_GRACE_MS;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async rotateHostToken(hostId: string): Promise<HostTokenRotationResult> {
    const prepared = this.opts.hostTokens.prepareHostTokenRotation({
      hostId,
      now: this.now(),
      graceMs: this.graceMs,
    });
    const daemonResult = await this.opts.transport.sendCommand(
      hostId,
      'rotate_token',
      {
        host_id: hostId,
        host_token: prepared.hostToken,
        issued_at: prepared.issuedAt,
        grace_until: prepared.graceUntil,
      },
      { timeoutMs: this.timeoutMs },
    );

    if (!daemonResult.rotated) {
      this.opts.logger.warn(
        {
          kind: 'host_token_rotation',
          action: 'daemon_rejected',
          hostId,
          reason: daemonResult.reason,
          message: daemonResult.message,
        },
        'host token rotation rejected by daemon; database credentials unchanged',
      );
      throw new HostTokenRotationError(
        'daemon_rejected',
        `daemon rejected host token rotation: ${daemonResult.reason}`,
        { hostId, daemonReason: daemonResult.reason },
      );
    }
    if (daemonResult.host_id !== hostId) {
      this.opts.logger.warn(
        {
          kind: 'host_token_rotation',
          action: 'daemon_host_mismatch',
          hostId,
          daemon_host_id: daemonResult.host_id,
        },
        'host token rotation daemon ack host mismatch; database credentials unchanged',
      );
      throw new HostTokenRotationError(
        'daemon_host_mismatch',
        `daemon acknowledged rotation for ${daemonResult.host_id}, expected ${hostId}`,
        { hostId },
      );
    }

    const issued = this.opts.hostTokens.completePreparedHostTokenRotation(prepared);
    this.opts.logger.info(
      {
        kind: 'host_token_rotation',
        action: 'completed',
        hostId,
        credentialId: issued.credential.id,
        issuedAt: prepared.issuedAt,
        graceUntil: prepared.graceUntil,
        configRefreshedAt: daemonResult.config_refreshed_at,
      },
      'host token rotation completed after daemon config refresh',
    );
    return {
      hostId,
      issued,
      issuedAt: prepared.issuedAt,
      graceUntil: prepared.graceUntil,
      configRefreshedAt: daemonResult.config_refreshed_at,
    };
  }
}
