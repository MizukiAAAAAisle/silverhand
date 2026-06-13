import type { UserPresenceEvent } from '@silverhand/shared';
import type { UserRepo } from '../repos/user-repo.js';
import type { ScopeEventBus } from '../ws/scope-event-bus.js';

interface PresenceLogger {
  warn(obj: unknown, msg?: string): void;
}

export interface PresenceRegistryOptions {
  events: ScopeEventBus;
  users: Pick<UserRepo, 'touchLastSeen'>;
  offlineGraceMs?: number;
  now?: () => number;
  logger?: PresenceLogger;
}

export class PresenceRegistry {
  private readonly events: ScopeEventBus;
  private readonly users: Pick<UserRepo, 'touchLastSeen'>;
  private readonly offlineGraceMs: number;
  private readonly now: () => number;
  private readonly logger?: PresenceLogger;
  private readonly connectionsByUser = new Map<string, Set<string>>();
  private readonly offlineTimers = new Map<string, NodeJS.Timeout>();
  private readonly pendingOfflineAt = new Map<string, number>();

  constructor(opts: PresenceRegistryOptions) {
    this.events = opts.events;
    this.users = opts.users;
    this.offlineGraceMs = opts.offlineGraceMs ?? 20_000;
    this.now = opts.now ?? Date.now;
    this.logger = opts.logger;
  }

  onConnect(userId: string, connectionId: string): void {
    const existing = this.connectionsByUser.get(userId);
    const wasOnline = this.isOnline(userId);
    this.cancelPendingOffline(userId);

    const connections = existing ?? new Set<string>();
    connections.add(connectionId);
    this.connectionsByUser.set(userId, connections);

    if (!wasOnline) {
      this.publish({
        user_id: userId,
        presence: 'online',
        last_seen_at: null,
      });
    }
  }

  onDisconnect(userId: string, connectionId: string): void {
    const connections = this.connectionsByUser.get(userId);
    if (!connections?.delete(connectionId)) return;
    if (connections.size > 0) return;

    this.connectionsByUser.delete(userId);
    this.scheduleOffline(userId, this.now());
  }

  isOnline(userId: string): boolean {
    return this.connectionsByUser.has(userId) || this.offlineTimers.has(userId);
  }

  dispose(): void {
    for (const timer of this.offlineTimers.values()) clearTimeout(timer);
    this.offlineTimers.clear();
    this.pendingOfflineAt.clear();
    this.connectionsByUser.clear();
  }

  private scheduleOffline(userId: string, disconnectedAt: number): void {
    this.cancelPendingOffline(userId);
    this.pendingOfflineAt.set(userId, disconnectedAt);
    const timer = setTimeout(() => {
      this.offlineTimers.delete(userId);
      const lastSeenAt = this.pendingOfflineAt.get(userId) ?? disconnectedAt;
      this.pendingOfflineAt.delete(userId);
      if (this.connectionsByUser.has(userId)) return;
      try {
        this.users.touchLastSeen(userId, lastSeenAt);
      } catch (err) {
        this.logger?.warn(
          { err, userId, lastSeenAt },
          'presence: failed to persist last_seen_at',
        );
      }
      this.publish({
        user_id: userId,
        presence: 'offline',
        last_seen_at: lastSeenAt,
      });
    }, this.offlineGraceMs);
    timer.unref?.();
    this.offlineTimers.set(userId, timer);
  }

  private cancelPendingOffline(userId: string): void {
    const timer = this.offlineTimers.get(userId);
    if (timer) clearTimeout(timer);
    this.offlineTimers.delete(userId);
    this.pendingOfflineAt.delete(userId);
  }

  private publish(event: UserPresenceEvent): void {
    this.events.publishToScope('app', 'user_presence', event);
  }
}
