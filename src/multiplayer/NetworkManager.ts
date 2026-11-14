import type {
  ClientToServerMessage,
  ConnectionState,
  OnlineAvatarId,
  ServerToClientMessage,
} from './shared/protocol';
import {
  getStoredPlayerIdentity,
  saveStoredPlayerIdentity,
} from './ProgressionClient';

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

function isRoomScopedMessage(msg: ClientToServerMessage): boolean {
  switch (msg.type) {
    case 'room:ready':
    case 'room:start':
    case 'room:cancel':
    case 'room:leave':
    case 'room:rematch':
    case 'game:aim':
    case 'game:spin':
    case 'game:called_shot':
    case 'game:place_cue':
    case 'game:shoot':
    case 'game:forfeit':
    case 'game:request_sync':
    case 'chat:room_send':
      return true;
    default:
      return false;
  }
}

export class NetworkManager {
  private lobbyWs: WebSocket | null = null;
  private lobbyState: ConnectionState = 'disconnected';
  private lobbyReconnectAttempts = 0;
  private lobbyReconnectTimer: number | null = null;
  private lobbyConnectTimeoutTimer: number | null = null;
  private lobbyPingTimer: number | null = null;
  private lobbyHandshakeReady = false;
  private lobbyPendingMessages: ClientToServerMessage[] = [];

  private roomWs: WebSocket | null = null;
  private roomReconnectAttempts = 0;
  private roomReconnectTimer: number | null = null;
  private roomConnectTimeoutTimer: number | null = null;
  private roomPingTimer: number | null = null;
  private roomHandshakeReady = false;
  private roomPendingMessages: ClientToServerMessage[] = [];

  private connectionState: ConnectionState = 'disconnected';
  private intentionallyClosed = false;
  private listeners: NetworkManagerListeners;

  private sessionId: string | null = null;
  private reconnectToken: string | null = null;
  private activeRoomId: string | null = null;
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

  public clearSessionCredentials(): void {
    this.sessionId = null;
    this.reconnectToken = null;
    try {
      if (typeof window !== 'undefined' && window.sessionStorage) {
        window.sessionStorage.removeItem(SESSION_ID_KEY);
        window.sessionStorage.removeItem(RECONNECT_TOKEN_KEY);
      }
    } catch {
      // Ignore
    }
  }

  public bindRoomSocket(roomId: string | null): void {
    const normalized = roomId?.trim() || null;
    if (this.activeRoomId === normalized) return;

    this.activeRoomId = normalized;
    this.closeRoomSocketOnly();

    if (!this.intentionallyClosed) {
      this.connectLobbySocket();
      if (normalized) {
        this.connectRoomSocket(normalized);
      }
    }
    this.recomputeConnectionState();
  }

  public retryConnect(): void {
    this.intentionallyClosed = false;
    this.lobbyReconnectAttempts = 0;
    this.roomReconnectAttempts = 0;
    this.closeLobbySocketOnly();
    this.closeRoomSocketOnly();
    this.connect();
  }

  public connect(): void {
    this.intentionallyClosed = false;
    this.connectLobbySocket();
    if (this.activeRoomId) {
      this.connectRoomSocket(this.activeRoomId);
    }
    this.recomputeConnectionState();
  }

  public disconnect(): void {
    this.intentionallyClosed = true;
    this.activeRoomId = null;
    this.lobbyPendingMessages = [];
    this.roomPendingMessages = [];
    this.closeLobbySocketOnly();
    this.closeRoomSocketOnly();
    this.lobbyState = 'disconnected';
    this.setConnectionState('disconnected');
  }

  public send(msg: ClientToServerMessage): boolean {
    if (isRoomScopedMessage(msg)) {
      if (
        msg.type === 'room:cancel' &&
        (!this.roomWs || this.roomWs.readyState !== WebSocket.OPEN || !this.roomHandshakeReady) &&
        this.lobbyWs &&
        this.lobbyWs.readyState === WebSocket.OPEN &&
        this.lobbyHandshakeReady
      ) {
        this.lobbyWs.send(JSON.stringify(msg));
        return true;
      }

      if (!this.roomWs || this.roomWs.readyState !== WebSocket.OPEN || !this.roomHandshakeReady) {
        if (!this.intentionallyClosed && this.activeRoomId) {
          if (this.roomPendingMessages.length >= 25) {
            this.roomPendingMessages.shift();
          }
          this.roomPendingMessages.push(msg);
        }
        return false;
      }
      this.roomWs.send(JSON.stringify(msg));
      return true;
    }

    if (!this.lobbyWs || this.lobbyWs.readyState !== WebSocket.OPEN || !this.lobbyHandshakeReady) {
      if (
        !this.intentionallyClosed &&
        msg.type !== 'ping' &&
        msg.type !== 'session:init' &&
        msg.type !== 'session:resume'
      ) {
        if (this.lobbyPendingMessages.length >= 25) {
          this.lobbyPendingMessages.shift();
        }
        this.lobbyPendingMessages.push(msg);
      }
      return false;
    }
    this.lobbyWs.send(JSON.stringify(msg));
    return true;
  }

  public simulateConnectionDropForDebug(): void {
    if (this.roomWs) {
      this.roomWs.close(4500, 'Simulated drop');
    } else if (this.lobbyWs) {
      this.lobbyWs.close(4500, 'Simulated drop');
    }
  }

  private connectLobbySocket(): void {
    if (
      this.lobbyWs &&
      (this.lobbyWs.readyState === WebSocket.OPEN ||
        this.lobbyWs.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.lobbyHandshakeReady = false;
    this.clearTimer(this.lobbyReconnectTimer);
    this.lobbyReconnectTimer = null;
    this.clearTimer(this.lobbyConnectTimeoutTimer);
    this.lobbyConnectTimeoutTimer = null;
    this.lobbyState = this.lobbyReconnectAttempts > 0 ? 'reconnecting' : 'connecting';
    this.recomputeConnectionState();

    const url = this.buildWebSocketUrl(null);
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.listeners.onConnectionError?.(
        `Invalid WebSocket server URL (${url}). Verify VITE_WS_URL configuration.`,
      );
      this.scheduleLobbyReconnect();
      return;
    }
    this.lobbyWs = socket;

    if (typeof window !== 'undefined') {
      this.lobbyConnectTimeoutTimer = window.setTimeout(() => {
        if (this.lobbyWs !== socket || this.lobbyHandshakeReady) return;
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
      if (this.lobbyWs !== socket) return;
      this.lobbyReconnectAttempts = 0;
      this.sendIdentityHandshake(socket);
    };

    socket.onmessage = (evt) => {
      if (this.lobbyWs !== socket) return;
      try {
        const msg = JSON.parse(String(evt.data)) as ServerToClientMessage;
        if (msg.type === 'pong') {
          const rtt = Math.max(1, Math.round(Date.now() - msg.clientTimeMs));
          this.lastLatencyMs = rtt;
          this.listeners.onLatencyUpdate(rtt);
          return;
        }
        if (msg.type === 'session:ready') {
          this.clearTimer(this.lobbyConnectTimeoutTimer);
          this.lobbyConnectTimeoutTimer = null;
          this.saveSessionCredentials(msg.sessionId, msg.reconnectToken);
          if (msg.playerId && msg.playerToken) {
            saveStoredPlayerIdentity({
              playerId: msg.playerId,
              playerToken: msg.playerToken,
            });
          }
          this.lobbyHandshakeReady = true;
          this.lobbyState = 'connected';
          if (!this.activeRoomId) {
            this.listeners.onMessage(msg);
          }
          this.recomputeConnectionState();
          this.flushLobbyPendingMessages();
          this.startLobbyPingLoop();
          return;
        }
        this.listeners.onMessage(msg);
      } catch {
        // Ignore malformed frames
      }
    };

    socket.onclose = (evt) => {
      if (this.lobbyWs !== socket) return;
      const failedBeforeHandshake = !this.lobbyHandshakeReady;
      this.lobbyWs = null;
      this.lobbyHandshakeReady = false;
      this.clearTimer(this.lobbyConnectTimeoutTimer);
      this.lobbyConnectTimeoutTimer = null;
      this.stopLobbyPingLoop();

      if (this.intentionallyClosed) {
        this.lobbyState = 'disconnected';
        this.recomputeConnectionState();
        return;
      }
      if (failedBeforeHandshake && evt.code !== 1000 && evt.code !== 4000 && evt.code !== 4001) {
        this.listeners.onConnectionError?.(
          `Unable to connect to multiplayer server (${url}). Verify the server is running and VITE_WS_URL is reachable.`,
        );
      }
      this.scheduleLobbyReconnect();
    };

    socket.onerror = () => {
      if (this.lobbyWs !== socket) return;
      if (!this.lobbyHandshakeReady && !this.activeRoomId) {
        this.listeners.onConnectionError?.(
          `WebSocket connection failed (${url}). Retrying connection...`,
        );
      }
    };
  }

  private connectRoomSocket(roomId: string): void {
    if (
      this.roomWs &&
      (this.roomWs.readyState === WebSocket.OPEN ||
        this.roomWs.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.roomHandshakeReady = false;
    this.clearTimer(this.roomReconnectTimer);
    this.roomReconnectTimer = null;
    this.clearTimer(this.roomConnectTimeoutTimer);
    this.roomConnectTimeoutTimer = null;
    this.recomputeConnectionState();

    const url = this.buildWebSocketUrl(roomId);
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.listeners.onConnectionError?.(`Invalid room WebSocket URL (${url}).`);
      this.scheduleRoomReconnect();
      return;
    }
    this.roomWs = socket;

    if (typeof window !== 'undefined') {
      this.roomConnectTimeoutTimer = window.setTimeout(() => {
        if (this.roomWs !== socket || this.roomHandshakeReady) return;
        this.listeners.onConnectionError?.(
          `Connection to game room timed out (${url}). Retrying...`,
        );
        try {
          socket.close(4000, 'Room timeout');
        } catch {
          // Ignore
        }
      }, CONNECT_TIMEOUT_MS);
    }

    socket.onopen = () => {
      if (this.roomWs !== socket) return;
      this.roomReconnectAttempts = 0;
      this.sendIdentityHandshake(socket);
    };

    socket.onmessage = (evt) => {
      if (this.roomWs !== socket) return;
      try {
        const msg = JSON.parse(String(evt.data)) as ServerToClientMessage;
        if (msg.type === 'pong') {
          const rtt = Math.max(1, Math.round(Date.now() - msg.clientTimeMs));
          this.lastLatencyMs = rtt;
          this.listeners.onLatencyUpdate(rtt);
          return;
        }
        if (msg.type === 'session:ready') {
          this.clearTimer(this.roomConnectTimeoutTimer);
          this.roomConnectTimeoutTimer = null;
          this.roomHandshakeReady = true;
          this.listeners.onMessage(msg);
          this.recomputeConnectionState();
          this.flushRoomPendingMessages();
          this.startRoomPingLoop();
          return;
        }
        this.listeners.onMessage(msg);
      } catch {
        // Ignore malformed frames
      }
    };

    socket.onclose = (evt) => {
      if (this.roomWs !== socket) return;
      const failedBeforeHandshake = !this.roomHandshakeReady;
      this.roomWs = null;
      this.roomHandshakeReady = false;
      this.clearTimer(this.roomConnectTimeoutTimer);
      this.roomConnectTimeoutTimer = null;
      this.stopRoomPingLoop();

      if (this.intentionallyClosed || !this.activeRoomId) {
        this.recomputeConnectionState();
        return;
      }
      if (failedBeforeHandshake && evt.code !== 1000 && evt.code !== 4000 && evt.code !== 4001) {
        this.listeners.onConnectionError?.(
          `Lost connection to match room (${url}). Reconnecting...`,
        );
      }
      this.scheduleRoomReconnect();
    };

    socket.onerror = () => {
      if (this.roomWs !== socket) return;
      if (!this.roomHandshakeReady) {
        this.listeners.onConnectionError?.(
          `Room WebSocket connection failed (${url}). Retrying...`,
        );
      }
    };
  }

  private sendIdentityHandshake(socket: WebSocket): void {
    const profile = this.profileProvider();
    const storedIdentity = getStoredPlayerIdentity();
    if (this.sessionId && this.reconnectToken) {
      this.sendRaw(socket, {
        type: 'session:resume',
        sessionId: this.sessionId,
        reconnectToken: this.reconnectToken,
        displayName: profile.displayName,
        avatarId: profile.avatarId,
        playerId: storedIdentity?.playerId,
        playerToken: storedIdentity?.playerToken,
      });
    } else {
      this.sendRaw(socket, {
        type: 'session:init',
        displayName: profile.displayName,
        avatarId: profile.avatarId,
        latencyMs: this.lastLatencyMs,
        playerId: storedIdentity?.playerId,
        playerToken: storedIdentity?.playerToken,
      });
    }
  }

  private closeLobbySocketOnly(): void {
    this.lobbyHandshakeReady = false;
    this.clearTimer(this.lobbyReconnectTimer);
    this.lobbyReconnectTimer = null;
    this.clearTimer(this.lobbyConnectTimeoutTimer);
    this.lobbyConnectTimeoutTimer = null;
    this.stopLobbyPingLoop();
    if (this.lobbyWs) {
      const old = this.lobbyWs;
      this.lobbyWs = null;
      try {
        old.close(1000, 'Closing lobby socket');
      } catch {
        // Ignore
      }
    }
  }

  private closeRoomSocketOnly(): void {
    this.roomHandshakeReady = false;
    this.roomPendingMessages = [];
    this.clearTimer(this.roomReconnectTimer);
    this.roomReconnectTimer = null;
    this.clearTimer(this.roomConnectTimeoutTimer);
    this.roomConnectTimeoutTimer = null;
    this.stopRoomPingLoop();
    if (this.roomWs) {
      const old = this.roomWs;
      this.roomWs = null;
      try {
        old.close(1000, 'Leaving room socket');
      } catch {
        // Ignore
      }
    }
  }

  private sendRaw(socket: WebSocket, msg: ClientToServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  }

  private flushLobbyPendingMessages(): void {
    if (!this.lobbyWs || this.lobbyWs.readyState !== WebSocket.OPEN || !this.lobbyHandshakeReady) {
      return;
    }
    const queued = this.lobbyPendingMessages.splice(0, this.lobbyPendingMessages.length);
    for (const msg of queued) {
      this.lobbyWs.send(JSON.stringify(msg));
    }
  }

  private flushRoomPendingMessages(): void {
    if (!this.roomWs || this.roomWs.readyState !== WebSocket.OPEN || !this.roomHandshakeReady) {
      return;
    }
    const queued = this.roomPendingMessages.splice(0, this.roomPendingMessages.length);
    for (const msg of queued) {
      this.roomWs.send(JSON.stringify(msg));
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

  private recomputeConnectionState(): void {
    if (this.intentionallyClosed) {
      this.setConnectionState('disconnected');
      return;
    }
    if (this.activeRoomId) {
      if (this.roomWs && this.roomWs.readyState === WebSocket.OPEN && this.roomHandshakeReady) {
        this.setConnectionState('connected');
      } else if (this.roomReconnectAttempts > 0) {
        this.setConnectionState('reconnecting');
      } else {
        this.setConnectionState('connecting');
      }
      return;
    }
    this.setConnectionState(this.lobbyState);
  }

  private setConnectionState(next: ConnectionState): void {
    if (this.connectionState === next) return;
    this.connectionState = next;
    this.listeners.onConnectionChange(next);
  }

  private startLobbyPingLoop(): void {
    this.stopLobbyPingLoop();
    const emitPing = () => {
      if (this.lobbyWs && this.lobbyWs.readyState === WebSocket.OPEN && this.lobbyHandshakeReady) {
        this.sendRaw(this.lobbyWs, {
          type: 'ping',
          clientTimeMs: Date.now(),
          latencyMs: this.lastLatencyMs,
        });
      }
    };
    emitPing();
    this.lobbyPingTimer = window.setInterval(emitPing, 5000);
  }

  private stopLobbyPingLoop(): void {
    if (this.lobbyPingTimer !== null) {
      window.clearInterval(this.lobbyPingTimer);
      this.lobbyPingTimer = null;
    }
  }

  private startRoomPingLoop(): void {
    this.stopRoomPingLoop();
    const emitPing = () => {
      if (this.roomWs && this.roomWs.readyState === WebSocket.OPEN && this.roomHandshakeReady) {
        this.sendRaw(this.roomWs, {
          type: 'ping',
          clientTimeMs: Date.now(),
          latencyMs: this.lastLatencyMs,
        });
      }
    };
    emitPing();
    this.roomPingTimer = window.setInterval(emitPing, 5000);
  }

  private stopRoomPingLoop(): void {
    if (this.roomPingTimer !== null) {
      window.clearInterval(this.roomPingTimer);
      this.roomPingTimer = null;
    }
  }

  private scheduleLobbyReconnect(): void {
    this.clearTimer(this.lobbyReconnectTimer);
    this.lobbyState = 'reconnecting';
    this.recomputeConnectionState();
    const delayMs = Math.min(8000, 600 * Math.pow(1.6, this.lobbyReconnectAttempts));
    this.lobbyReconnectAttempts++;
    this.lobbyReconnectTimer = window.setTimeout(() => {
      this.lobbyReconnectTimer = null;
      if (!this.intentionallyClosed) {
        this.connectLobbySocket();
      }
    }, delayMs);
  }

  private scheduleRoomReconnect(): void {
    this.clearTimer(this.roomReconnectTimer);
    this.recomputeConnectionState();
    const delayMs = Math.min(8000, 600 * Math.pow(1.6, this.roomReconnectAttempts));
    this.roomReconnectAttempts++;
    this.roomReconnectTimer = window.setTimeout(() => {
      this.roomReconnectTimer = null;
      if (!this.intentionallyClosed && this.activeRoomId) {
        this.connectRoomSocket(this.activeRoomId);
      }
    }, delayMs);
  }

  private clearTimer(timerId: number | null): void {
    if (timerId !== null) {
      window.clearTimeout(timerId);
    }
  }
}
