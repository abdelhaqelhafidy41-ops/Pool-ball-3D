import type {
  ClientToServerMessage,
  ConnectionState,
  OnlineAvatarId,
  ServerToClientMessage,
} from './shared/protocol';

const SESSION_ID_KEY = 'ultimate_pool_ws_session_id';
const RECONNECT_TOKEN_KEY = 'ultimate_pool_ws_reconnect_token';
const CONNECT_TIMEOUT_MS = 10000;

export interface NetworkManagerListeners {
  onConnectionChange: (state: ConnectionState) => void;
  onMessage: (msg: ServerToClientMessage) => void;
  onLatencyUpdate: (latencyMs: number) => void;
  onConnectionError?: (message: string) => void;
}

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function resolveWebSocketUrl(
  envWsUrl?: string,
  loc?: { protocol: string; host: string },
): string {
  const configured = (envWsUrl ?? '').trim();
  if (configured) {
    let candidate = configured;
    if (!/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(candidate)) {
      const hostPart = candidate.split('/')[0]?.split(':')[0] ?? '';
      const defaultScheme = isLocalHostname(hostPart) ? 'ws://' : 'wss://';
      candidate = `${defaultScheme}${candidate.replace(/^\/+/, '')}`;
    }

    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === 'https:') {
        parsed.protocol = 'wss:';
      } else if (parsed.protocol === 'http:') {
        parsed.protocol = 'ws:';
      }

      const pageIsHttps = loc?.protocol === 'https:';
      if (
        (pageIsHttps || !isLocalHostname(parsed.hostname)) &&
        parsed.protocol === 'ws:' &&
        !isLocalHostname(parsed.hostname)
      ) {
        parsed.protocol = 'wss:';
      }

      if (!parsed.pathname || parsed.pathname === '/') {
        parsed.pathname = '/ws';
      }
      return parsed.toString();
    } catch {
      return candidate;
    }
  }

  if (loc && loc.host) {
    const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${loc.host}/ws`;
  }

  return 'ws://127.0.0.1:3000/ws';
}

export function resolveHttpBaseUrl(
  envWsUrl?: string,
  loc?: { protocol: string; host: string },
): string {
  const configured = (envWsUrl ?? '').trim();
  if (!configured) return '';

  const wsUrl = resolveWebSocketUrl(configured, loc);
  try {
    const parsed = new URL(wsUrl);
    if (parsed.protocol === 'wss:') {
      parsed.protocol = 'https:';
    } else if (parsed.protocol === 'ws:') {
      parsed.protocol = 'http:';
    }
    return parsed.origin;
  } catch {
    return '';
  }
}

export class NetworkManager {
  private ws: WebSocket | null = null;
  private connectionState: ConnectionState = 'disconnected';
  private intentionallyClosed = false;
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private connectTimeoutTimer: number | null = null;
  private pingTimer: number | null = null;
  private listeners: NetworkManagerListeners;

  private sessionId: string | null = null;
  private reconnectToken: string | null = null;
  private activeRoomId: string | null = null;
  private handshakeReady = false;
  private pendingMessages: ClientToServerMessage[] = [];
  private profileProvider: () => { displayName: string; avatarId: OnlineAvatarId };
  private lastLatencyMs = 35;

  constructor(
    listeners: NetworkManagerListeners,
    profileProvider: () => { displayName: string; avatarId: OnlineAvatarId },
  ) {
    this.listeners = listeners;
    this.profileProvider = profileProvider;

    try {
      if (typeof window !== 'undefined' && window.sessionStorage) {
        this.sessionId = window.sessionStorage.getItem(SESSION_ID_KEY);
        this.reconnectToken = window.sessionStorage.getItem(RECONNECT_TOKEN_KEY);
      }
    } catch {
      // Ignore storage access errors
    }
  }

  public getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  public getActiveRoomId(): string | null {
    return this.activeRoomId;
  }

  public getCurrentWebSocketUrl(): string {
    return this.buildWebSocketUrl(this.activeRoomId);
  }

  public getSessionCredentials(): { sessionId: string | null; reconnectToken: string | null } {
    return { sessionId: this.sessionId, reconnectToken: this.reconnectToken };
  }

  public saveSessionCredentials(sessionId: string, reconnectToken: string): void {
    this.sessionId = sessionId;
    this.reconnectToken = reconnectToken;
    try {
      if (typeof window !== 'undefined' && window.sessionStorage) {
        window.sessionStorage.setItem(SESSION_ID_KEY, sessionId);
        window.sessionStorage.setItem(RECONNECT_TOKEN_KEY, reconnectToken);
      }
    } catch {
      // Ignore storage restriction
    }
  }

  public bindRoomSocket(roomId: string | null): void {
    const normalized = roomId?.trim() || null;
    if (this.activeRoomId === normalized) return;

    this.activeRoomId = normalized;
    this.handshakeReady = false;
    if (!normalized) {
      this.pendingMessages = [];
    }
    this.clearReconnectTimer();
    this.clearConnectTimeout();
    this.stopPingLoop();

    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      try {
        old.close(1000, 'Switching WebSocket scope');
      } catch {
        // Ignore
      }
    }

    if (!this.intentionallyClosed) {
      this.connect();
    }
  }

  public retryConnect(): void {
    this.intentionallyClosed = false;
    this.reconnectAttempts = 0;
    this.clearReconnectTimer();
    this.clearConnectTimeout();
    this.stopPingLoop();
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      try {
        old.close(1000, 'Manual retry');
      } catch {
        // Ignore
      }
    }
    this.connect();
  }

  public connect(): void {
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.intentionallyClosed = false;
    this.handshakeReady = false;
    this.clearReconnectTimer();
    this.clearConnectTimeout();
    this.setConnectionState(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    const url = this.buildWebSocketUrl(this.activeRoomId);
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.listeners.onConnectionError?.(
        `Invalid WebSocket server URL (${url}). Verify VITE_WS_URL configuration.`,
      );
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    if (typeof window !== 'undefined') {
      this.connectTimeoutTimer = window.setTimeout(() => {
        if (this.ws !== socket || this.handshakeReady) return;
        this.listeners.onConnectionError?.(
          `Connection to multiplayer server timed out (${url}). Retrying...`,
        );
        try {
          socket.close(4000, 'Connection timeout');
        } catch {
          // Ignore
        }
      }, CONNECT_TIMEOUT_MS);
    }

    socket.onopen = () => {
      if (this.ws !== socket) return;
      this.reconnectAttempts = 0;
      const profile = this.profileProvider();

      if (this.sessionId && this.reconnectToken) {
        this.sendRaw(socket, {
          type: 'session:resume',
          sessionId: this.sessionId,
          reconnectToken: this.reconnectToken,
          displayName: profile.displayName,
          avatarId: profile.avatarId,
        });
      } else {
        this.sendRaw(socket, {
          type: 'session:init',
          displayName: profile.displayName,
          avatarId: profile.avatarId,
          latencyMs: this.lastLatencyMs,
        });
      }
    };

    socket.onmessage = (evt) => {
      if (this.ws !== socket) return;
      try {
        const msg = JSON.parse(String(evt.data)) as ServerToClientMessage;
        if (msg.type === 'pong') {
          const rtt = Math.max(1, Math.round(Date.now() - msg.clientTimeMs));
          this.lastLatencyMs = rtt;
          this.listeners.onLatencyUpdate(rtt);
          return;
        }
        if (msg.type === 'session:ready') {
          this.clearConnectTimeout();
          this.saveSessionCredentials(msg.sessionId, msg.reconnectToken);
          this.handshakeReady = true;
          this.listeners.onMessage(msg);
          this.setConnectionState('connected');
          this.flushPendingMessages();
          this.startPingLoop();
          return;
        }
        this.listeners.onMessage(msg);
      } catch {
        // Ignore malformed frames
      }
    };

    socket.onclose = (evt) => {
      if (this.ws !== socket) return;
      const failedBeforeHandshake = !this.handshakeReady;
      this.ws = null;
      this.handshakeReady = false;
      this.clearConnectTimeout();
      this.stopPingLoop();
      if (this.intentionallyClosed) {
        this.setConnectionState('disconnected');
        return;
      }
      if (failedBeforeHandshake && evt.code !== 1000 && evt.code !== 4000) {
        this.listeners.onConnectionError?.(
          `Unable to connect to multiplayer server (${url}). Verify the server is running and VITE_WS_URL is reachable.`,
        );
      }
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      if (this.ws !== socket) return;
      if (!this.handshakeReady) {
        this.listeners.onConnectionError?.(
          `WebSocket connection failed (${url}). Retrying connection...`,
        );
      }
    };
  }

  public disconnect(): void {
    this.intentionallyClosed = true;
    this.handshakeReady = false;
    this.activeRoomId = null;
    this.pendingMessages = [];
    this.clearReconnectTimer();
    this.clearConnectTimeout();
    this.stopPingLoop();
    if (this.ws) {
      const target = this.ws;
      this.ws = null;
      try {
        target.close(1000, 'Client disconnect');
      } catch {
        // Ignore
      }
    }
    this.setConnectionState('disconnected');
  }

  public send(msg: ClientToServerMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.handshakeReady) {
      if (
        !this.intentionallyClosed &&
        msg.type !== 'ping' &&
        msg.type !== 'session:init' &&
        msg.type !== 'session:resume'
      ) {
        if (this.pendingMessages.length >= 25) {
          this.pendingMessages.shift();
        }
        this.pendingMessages.push(msg);
      }
      return false;
    }
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private sendRaw(socket: WebSocket, msg: ClientToServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  }

  private flushPendingMessages(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.handshakeReady) return;
    const queued = this.pendingMessages.splice(0, this.pendingMessages.length);
    for (const msg of queued) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  public simulateConnectionDropForDebug(): void {
    if (this.ws) {
      this.ws.close(4500, 'Simulated drop');
    }
  }

  private buildWebSocketUrl(roomId: string | null = null): string {
    const loc = typeof window !== 'undefined' ? window.location : undefined;
    const base = resolveWebSocketUrl(import.meta.env.VITE_WS_URL, loc);
    if (!roomId) return base;
    try {
      const parsed = new URL(base);
      parsed.searchParams.set('roomId', roomId);
      return parsed.toString();
    } catch {
      const sep = base.includes('?') ? '&' : '?';
      return `${base}${sep}roomId=${encodeURIComponent(roomId)}`;
    }
  }

  private setConnectionState(next: ConnectionState): void {
    if (this.connectionState === next) return;
    this.connectionState = next;
    this.listeners.onConnectionChange(next);
  }

  private startPingLoop(): void {
    this.stopPingLoop();
    this.send({
      type: 'ping',
      clientTimeMs: Date.now(),
      latencyMs: this.lastLatencyMs,
    });
    this.pingTimer = window.setInterval(() => {
      this.send({
        type: 'ping',
        clientTimeMs: Date.now(),
        latencyMs: this.lastLatencyMs,
      });
    }, 5000);
  }

  private stopPingLoop(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this.setConnectionState('reconnecting');
    const delayMs = Math.min(8000, 600 * Math.pow(1.6, this.reconnectAttempts));
    this.reconnectAttempts++;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.intentionallyClosed) {
        this.connect();
      }
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearConnectTimeout(): void {
    if (this.connectTimeoutTimer !== null) {
      window.clearTimeout(this.connectTimeoutTimer);
      this.connectTimeoutTimer = null;
    }
  }
}
