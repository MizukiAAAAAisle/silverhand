import type {
  ClientFrame,
  EventFrame,
  ResumeFrame,
  ServerFrame,
  SubscribedFrame,
  SubscribeFrame,
} from '@silverhand/shared';
import { getBackendInfo } from './api';

const EVENT_WS_PATH = '/api/ws/events';
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 30_000] as const;

export type WsClientStatus =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'connected'
  | 'disconnected';

export type WsClientListener = (frame: ServerFrame) => void;
export type WsStatusListener = (status: WsClientStatus) => void;

export interface WsScopeSubscription {
  unsubscribe(): void;
}

interface ResumePosition {
  epoch: string;
  lastSeq: number;
}

class EventWsClient {
  private ws: WebSocket | null = null;
  private status: WsClientStatus = 'idle';
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;
  private readonly frameListeners = new Set<WsClientListener>();
  private readonly statusListeners = new Set<WsStatusListener>();
  private readonly desiredScopes = new Map<string, number>();
  private readonly positions = new Map<string, ResumePosition>();
  private readonly confirmedScopes = new Set<string>();

  connect(): void {
    this.shouldReconnect = true;
    if (
      this.status === 'connecting' ||
      this.status === 'authenticating' ||
      this.status === 'connected'
    ) {
      return;
    }
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    void this.openSocket();
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    const ws = this.ws;
    this.ws = null;
    this.confirmedScopes.clear();
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      ws.close(1000, 'client_disconnect');
    }
    this.setStatus('disconnected');
  }

  subscribe(scope: string): WsScopeSubscription {
    const previousCount = this.desiredScopes.get(scope) ?? 0;
    this.desiredScopes.set(scope, previousCount + 1);
    this.connect();
    if (
      previousCount === 0 ||
      (this.status === 'connected' && !this.confirmedScopes.has(scope))
    ) {
      this.sendIfConnected({ type: 'subscribe', scope });
    }

    return {
      unsubscribe: () => {
        const count = this.desiredScopes.get(scope) ?? 0;
        if (count <= 1) {
          this.desiredScopes.delete(scope);
          this.positions.delete(scope);
          this.confirmedScopes.delete(scope);
          this.sendIfConnected({ type: 'unsubscribe', scope });
        } else {
          this.desiredScopes.set(scope, count - 1);
        }
      },
    };
  }

  resume(scope: string, position: ResumePosition): void {
    this.positions.set(scope, position);
    this.sendResume({ [scope]: position });
  }

  onFrame(listener: WsClientListener): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onStatus(listener: WsStatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  getStatus(): WsClientStatus {
    return this.status;
  }

  private async openSocket(): Promise<void> {
    this.clearReconnectTimer();
    this.setStatus('connecting');
    let url: string;
    let token: string;
    try {
      const info = await getBackendInfo();
      url = eventWsUrl(info.url);
      token = info.auth_token;
    } catch {
      this.scheduleReconnect();
      return;
    }

    if (!this.shouldReconnect) return;
    const ws = new WebSocket(url);
    this.ws = ws;
    this.confirmedScopes.clear();

    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      this.setStatus('authenticating');
      this.sendOnSocket(ws, { type: 'auth', token });
    });

    ws.addEventListener('message', raw => {
      if (this.ws !== ws) return;
      const frame = parseServerFrame(raw.data);
      if (!frame) return;
      this.handleFrame(frame);
    });

    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.confirmedScopes.clear();
      this.setStatus('disconnected');
      if (this.shouldReconnect) this.scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // `close` follows for network errors; keep the state transition in one path.
    });
  }

  private handleFrame(frame: ServerFrame): void {
    if (frame.type === 'authenticated') {
      this.reconnectAttempt = 0;
      this.confirmedScopes.clear();
      this.setStatus('connected');
      this.resubscribeDesiredScopes();
    } else if (frame.type === 'ping') {
      this.send({ type: 'pong' });
    } else if (frame.type === 'subscribed') {
      this.confirmedScopes.add(frame.scope);
      this.recordPosition(frame);
    } else if (frame.type === 'event') {
      this.recordPosition(frame);
    } else if (frame.type === 'snapshot_required') {
      this.positions.delete(frame.scope);
    }

    for (const listener of Array.from(this.frameListeners)) {
      listener(frame);
    }
  }

  private resubscribeDesiredScopes(): void {
    for (const scope of this.desiredScopes.keys()) {
      this.send({ type: 'subscribe', scope });
    }
    const resumeScopes: ResumeFrame['scopes'] = {};
    for (const [scope, position] of this.positions.entries()) {
      if (!this.desiredScopes.has(scope)) continue;
      resumeScopes[scope] = position;
    }
    if (Object.keys(resumeScopes).length > 0) {
      this.sendResume(resumeScopes);
    }
  }

  private recordPosition(frame: EventFrame | SubscribedFrame): void {
    const previous = this.positions.get(frame.scope);
    if (
      previous &&
      previous.epoch === frame.epoch &&
      previous.lastSeq >= frame.seq
    ) {
      return;
    }

    this.positions.set(frame.scope, {
      epoch: frame.epoch,
      lastSeq: frame.seq,
    });
  }

  private sendResume(scopes: ResumeFrame['scopes']): void {
    if (Object.keys(scopes).length === 0) return;
    this.sendIfConnected({ type: 'resume', scopes });
  }

  private sendIfConnected(frame: ClientFrame): void {
    if (
      this.status !== 'connected' ||
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    this.send(frame);
  }

  private send(frame: ClientFrame): void {
    if (!this.ws) return;
    this.sendOnSocket(this.ws, frame);
  }

  private sendOnSocket(ws: WebSocket, frame: ClientFrame): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(frame));
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const index = Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1);
    const delay = RECONNECT_DELAYS_MS[index]!;
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) void this.openSocket();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private setStatus(status: WsClientStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of Array.from(this.statusListeners)) {
      listener(status);
    }
  }
}

export const eventWsClient = new EventWsClient();

export function connectEventWs(): void {
  eventWsClient.connect();
}

export function subscribeWsScope(scope: SubscribeFrame['scope']): WsScopeSubscription {
  return eventWsClient.subscribe(scope);
}

export function onWsFrame(listener: WsClientListener): () => void {
  return eventWsClient.onFrame(listener);
}

export function onWsStatus(listener: WsStatusListener): () => void {
  return eventWsClient.onStatus(listener);
}

function eventWsUrl(baseUrl: string): string {
  const url = new URL(EVENT_WS_PATH, baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function parseServerFrame(data: unknown): ServerFrame | null {
  if (typeof data !== 'string') return null;
  try {
    const parsed = JSON.parse(data) as unknown;
    if (!isRecord(parsed) || typeof parsed.type !== 'string') return null;
    return parsed as unknown as ServerFrame;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
