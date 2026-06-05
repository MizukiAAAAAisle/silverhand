import type { BackendLogger } from '../context.js';
import type { AgentRuntimeHost } from '../runtime/agent-runtime-host.js';

export const IDLE_REAP_TTL_MS = 30 * 60_000;
export const IDLE_REAP_SWEEP_INTERVAL_MS = 60_000;

export interface IdleReaperServiceOptions {
  runtimeHost: AgentRuntimeHost;
  logger: BackendLogger;
  now?: () => number;
  ttlMs?: number;
  sweepIntervalMs?: number;
  disableAutoTick?: boolean;
}

export class IdleReaperService {
  private readonly runtimeHost: AgentRuntimeHost;
  private readonly logger: BackendLogger;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly sweepIntervalMs: number;
  private readonly disableAutoTick: boolean;
  private sweepTimer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(opts: IdleReaperServiceOptions) {
    this.runtimeHost = opts.runtimeHost;
    this.logger = opts.logger;
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? IDLE_REAP_TTL_MS;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? IDLE_REAP_SWEEP_INTERVAL_MS;
    this.disableAutoTick = opts.disableAutoTick ?? false;
  }

  start(): void {
    if (this.disableAutoTick || this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void this.tick().catch(err =>
        this.logger.error({ err }, 'idle-reaper-service: sweep tick failed'),
      );
    }, this.sweepIntervalMs);
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const result = await this.runtimeHost.reapIdleRuntimes({
        ttlMs: this.ttlMs,
        now: this.now(),
      });
      if (result.reaped > 0 || result.failed > 0) {
        this.logger.info(
          {
            kind: 'runtime',
            action: 'idle_reap_sweep',
            ...result,
          },
          'idle reaper sweep completed',
        );
      }
    } finally {
      this.ticking = false;
    }
  }
}
