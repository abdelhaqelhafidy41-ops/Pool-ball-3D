import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type {
  ClientToServerMessage,
  OnlineRoomInfo,
  ServerToClientMessage,
} from '../src/multiplayer/shared/protocol';
import {
  SOCIAL_LIMITS,
  type DirectMessageRecord,
  type MatchInvitationRecord,
  type SocialOverviewPayload,
  type SocialSearchPlayerItem,
} from '../src/multiplayer/shared/social';

const CF_PORT = 8791;
const CF_STATE_DIR = '/tmp/cf-phase7-social-state';
const ORIGIN = 'https://test-user.github.io';

class SocialWsClient {
  public ws!: WebSocket;
  public queue: ServerToClientMessage[] = [];
  public sessionId = '';
  public reconnectToken = '';
  public playerId = '';
  public playerToken = '';

  private waiters: Array<{
    predicate: (msg: ServerToClientMessage) => boolean;
    resolve: (msg: ServerToClientMessage) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(private readonly baseWsUrl: string, private readonly origin: string) {}

  public async connect(urlOverride?: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(urlOverride ?? this.baseWsUrl, {
        headers: { Origin: this.origin },
      });
      this.ws = ws;
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString('utf8')) as ServerToClientMessage;
        this.dispatch(msg);
      });
    });
  }

  private dispatch(msg: ServerToClientMessage): void {
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i];
      if (w.predicate(msg)) {
        clearTimeout(w.timer);
        this.waiters.splice(i, 1);
        w.resolve(msg);
        return;
      }
    }
    this.queue.push(msg);
  }

  public send(msg: ClientToServerMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  public clearQueue(): void {
    this.queue.length = 0;
  }

  public waitFor<T extends ServerToClientMessage = ServerToClientMessage>(
    predicate: (msg: ServerToClientMessage) => boolean,
    timeoutMs = 8000,
    label = 'message',
  ): Promise<T> {
    const idx = this.queue.findIndex(predicate);
    if (idx !== -1) {
      return Promise.resolve(this.queue.splice(idx, 1)[0] as T);
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const wIdx = this.waiters.findIndex((w) => w.timer === timer);
        if (wIdx !== -1) this.waiters.splice(wIdx, 1);
        const queuedTypes = this.queue.map((m) => m.type).join(', ') || '(empty)';
        reject(new Error(`Timed out waiting for ${label}; queued=[${queuedTypes}]`));
      }, timeoutMs);
      this.waiters.push({
        predicate,
        resolve: resolve as (msg: ServerToClientMessage) => void,
        reject,
        timer,
      });
    });
  }

  public async initSession(
    displayName: string,
    identity: { playerId: string; playerToken: string },
  ): Promise<void> {
    this.send({
      type: 'session:init',
      displayName,
      avatarId: 'cue_gold',
      latencyMs: 22,
      playerId: identity.playerId,
      playerToken: identity.playerToken,
    });
    const ready = await this.waitFor<Extract<ServerToClientMessage, { type: 'session:ready' }>>(
      (m) => m.type === 'session:ready',
      6000,
      'session:ready',
    );
    this.sessionId = ready.sessionId;
    this.reconnectToken = ready.reconnectToken;
    this.playerId = ready.playerId ?? identity.playerId;
    this.playerToken = ready.playerToken ?? identity.playerToken;
  }

  public async connectToRoom(roomId: string): Promise<void> {
    const roomClient = new SocialWsClient(this.baseWsUrl, this.origin);
    await roomClient.connect(`${this.baseWsUrl}?roomId=${encodeURIComponent(roomId)}`);
    roomClient.send({
      type: 'session:resume',
      sessionId: this.sessionId,
      reconnectToken: this.reconnectToken,
      playerId: this.playerId,
      playerToken: this.playerToken,
    });
    await roomClient.waitFor((m) => m.type === 'session:ready', 6000, 'room session:ready');
    // Swap active ws handle so close() cleans up cleanly if needed, returning roomClient for separate use
    await roomClient.close();
  }

  public async close(): Promise<void> {
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

async function waitForWrangler(baseHttp: string): Promise<void> {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseHttp}/health`);
      if (res.ok) return;
    } catch {
      // Wait for startup
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Timed out waiting for wrangler dev (Phase 7 Social test)');
}

async function apiJson<T = Record<string, unknown>>(
  baseHttp: string,
  path: string,
  options?: RequestInit & { token?: string },
): Promise<{ status: number; ok: boolean; body: T & { error?: string; message?: string } }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Origin: ORIGIN,
    ...(options?.token ? { Authorization: `Bearer ${options.token}` } : {}),
  };
  const res = await fetch(`${baseHttp}${path}`, {
    ...options,
    headers: {
      ...headers,
      ...((options?.headers as Record<string, string> | undefined) ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  return { status: res.status, ok: res.ok, body };
}

async function createPlayer(
  baseHttp: string,
  displayName: string,
  avatarId: string,
): Promise<{ playerId: string; playerToken: string }> {
  const res = await apiJson<{ playerId: string; playerToken: string }>(
    baseHttp,
    '/api/players/session',
    {
      method: 'POST',
      body: JSON.stringify({ displayName, avatarId }),
    },
  );
  assert.equal(res.status, 200);
  assert(res.body.playerId.startsWith('ply_'));
  return { playerId: res.body.playerId, playerToken: res.body.playerToken };
}

async function main() {
  rmSync(CF_STATE_DIR, { recursive: true, force: true });
  const wranglerBin = join(process.cwd(), 'node_modules', '.bin', 'wrangler');
  const baseHttp = `http://127.0.0.1:${CF_PORT}`;
  const baseWs = `ws://127.0.0.1:${CF_PORT}/ws`;

  const wrangler = spawn(
    wranglerBin,
    [
      'dev',
      '--config',
      'cloudflare/wrangler.jsonc',
      '--port',
      String(CF_PORT),
      '--ip',
      '127.0.0.1',
      '--var',
      `CORS_ORIGIN:${ORIGIN}`,
      '--var',
      'PRESENCE_TTL_MS:2000',
      '--var',
      'INVITE_TTL_MS:2000',
      '--persist-to',
      CF_STATE_DIR,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, CI: '1' },
    },
  );

  let logs = '';
  wrangler.stdout.on('data', (d) => {
    logs += d.toString();
  });
  wrangler.stderr.on('data', (d) => {
    logs += d.toString();
  });

  try {
    await waitForWrangler(baseHttp);

    // =========================================================================
    // [1] Identity Setup, Search, Friend Requests Lifecycle & Duplicate/Self Guards
    // =========================================================================
    const playerA = await createPlayer(baseHttp, 'SocialAlpha', 'cue_gold');
    const playerB = await createPlayer(baseHttp, 'SocialBravo', 'shark_sky');
    const playerC = await createPlayer(baseHttp, 'SocialCharlie', 'crown_emerald');

    // Unauthorized access guard
    const badOverview = await apiJson(
      baseHttp,
      `/api/social/overview?playerId=${encodeURIComponent(playerA.playerId)}`,
      { token: 'invalid_token_xyz' },
    );
    assert.equal(badOverview.status, 401);

    // Search by display name & by unique player ID
    const searchByName = await apiJson<{ players: SocialSearchPlayerItem[] }>(
      baseHttp,
      `/api/social/search?q=Bravo&playerId=${encodeURIComponent(playerA.playerId)}`,
      { token: playerA.playerToken },
    );
    assert.equal(searchByName.status, 200);
    assert(searchByName.body.players.some((p) => p.playerId === playerB.playerId));

    const searchById = await apiJson<{ players: SocialSearchPlayerItem[] }>(
      baseHttp,
      `/api/social/search?q=${encodeURIComponent(playerC.playerId)}&playerId=${encodeURIComponent(playerA.playerId)}`,
      { token: playerA.playerToken },
    );
    assert.equal(searchById.body.players.length, 1);
    assert.equal(searchById.body.players[0].playerId, playerC.playerId);

    // Self friend request forbidden
    const selfReq = await apiJson(baseHttp, '/api/social/friends/request', {
      method: 'POST',
      token: playerA.playerToken,
      body: JSON.stringify({ playerId: playerA.playerId, targetPlayerId: playerA.playerId }),
    });
    assert.equal(selfReq.status, 400);
    assert.equal(selfReq.body.error, 'SELF_ACTION_FORBIDDEN');

    // Connect A & B via WS to test real-time pushes
    const wsA = new SocialWsClient(baseWs, ORIGIN);
    const wsB = new SocialWsClient(baseWs, ORIGIN);
    await wsA.connect();
    await wsB.connect();
    await wsA.initSession('SocialAlpha', playerA);
    await wsB.initSession('SocialBravo', playerB);
    wsA.clearQueue();
    wsB.clearQueue();

    // A -> B friend request triggers real-time WS push on B
    const req1 = await apiJson<{ outcome: string }>(baseHttp, '/api/social/friends/request', {
      method: 'POST',
      token: playerA.playerToken,
      body: JSON.stringify({ playerId: playerA.playerId, targetPlayerId: playerB.playerId }),
    });
    assert.equal(req1.status, 200);
    assert.equal(req1.body.outcome, 'requested');

    const pushedReq = await wsB.waitFor<
      Extract<ServerToClientMessage, { type: 'social:friend_request_received' }>
    >((m) => m.type === 'social:friend_request_received', 4000, 'social:friend_request_received');
    assert.equal(pushedReq.request.playerId, playerA.playerId);

    // Duplicate friend request prevented
    const dupReq = await apiJson(baseHttp, '/api/social/friends/request', {
      method: 'POST',
      token: playerA.playerToken,
      body: JSON.stringify({ playerId: playerA.playerId, targetPlayerId: playerB.playerId }),
    });
    assert.equal(dupReq.status, 409);
    assert.equal(dupReq.body.error, 'DUPLICATE_REQUEST');

    // B rejects request -> resend -> A cancels -> resend -> B accepts
    const rejectRes = await apiJson(baseHttp, '/api/social/friends/respond', {
      method: 'POST',
      token: playerB.playerToken,
      body: JSON.stringify({
        playerId: playerB.playerId,
        targetPlayerId: playerA.playerId,
        action: 'reject',
      }),
    });
    assert.equal(rejectRes.status, 200);

    await apiJson(baseHttp, '/api/social/friends/request', {
      method: 'POST',
      token: playerA.playerToken,
      body: JSON.stringify({ playerId: playerA.playerId, targetPlayerId: playerB.playerId }),
    });
    const cancelRes = await apiJson(baseHttp, '/api/social/friends/respond', {
      method: 'POST',
      token: playerA.playerToken,
      body: JSON.stringify({
        playerId: playerA.playerId,
        targetPlayerId: playerB.playerId,
        action: 'cancel',
      }),
    });
    assert.equal(cancelRes.status, 200);

    await apiJson(baseHttp, '/api/social/friends/request', {
      method: 'POST',
      token: playerA.playerToken,
      body: JSON.stringify({ playerId: playerA.playerId, targetPlayerId: playerB.playerId }),
    });
    const acceptRes = await apiJson(baseHttp, '/api/social/friends/respond', {
      method: 'POST',
      token: playerB.playerToken,
      body: JSON.stringify({
        playerId: playerB.playerId,
        targetPlayerId: playerA.playerId,
        action: 'accept',
      }),
    });
    assert.equal(acceptRes.status, 200);

    const ovA = await apiJson<{ overview: SocialOverviewPayload }>(
      baseHttp,
      `/api/social/overview?playerId=${encodeURIComponent(playerA.playerId)}`,
      { token: playerA.playerToken },
    );
    assert(ovA.body.overview.friends.some((f) => f.playerId === playerB.playerId));

    // Already friends guard
    const alreadyFriendsRes = await apiJson(baseHttp, '/api/social/friends/request', {
      method: 'POST',
      token: playerA.playerToken,
      body: JSON.stringify({ playerId: playerA.playerId, targetPlayerId: playerB.playerId }),
    });
    assert.equal(alreadyFriendsRes.status, 409);
    assert.equal(alreadyFriendsRes.body.error, 'ALREADY_FRIENDS');

    // Remove friend & re-add via mutual request
    const removeRes = await apiJson(baseHttp, '/api/social/friends/remove', {
      method: 'POST',
      token: playerA.playerToken,
      body: JSON.stringify({ playerId: playerA.playerId, targetPlayerId: playerB.playerId }),
    });
    assert.equal(removeRes.status, 200);

    // Re-friend cleanly
    await apiJson(baseHttp, '/api/social/friends/request', {
      method: 'POST',
      token: playerA.playerToken,
      body: JSON.stringify({ playerId: playerA.playerId, targetPlayerId: playerB.playerId }),
    });
    const mutualAccept = await apiJson<{ outcome: string }>(
      baseHttp,
      '/api/social/friends/request',
      {
        method: 'POST',
        token: playerB.playerToken,
        body: JSON.stringify({ playerId: playerB.playerId, targetPlayerId: playerA.playerId }),
      },
    );
    assert.equal(mutualAccept.body.outcome, 'accepted');
    console.log('PASS [1] Search, friend request lifecycle (reject/cancel/accept/remove/mutual) & guards verified');

    // =========================================================================
    // [2] Presence Updates, Heartbeat Refresh & Automatic TTL Expiration
    // =========================================================================
    wsA.clearQueue();
    wsB.clearQueue();
    const busyRes = await apiJson<{ status: string }>(baseHttp, '/api/social/presence', {
      method: 'POST',
      token: playerA.playerToken,
      body: JSON.stringify({ playerId: playerA.playerId, status: 'busy' }),
    });
    assert.equal(busyRes.status, 200);
    assert.equal(busyRes.body.status, 'busy');

    const busyPush = await wsB.waitFor<
      Extract<ServerToClientMessage, { type: 'social:presence_changed' }>
    >(
      (m) =>
        m.type === 'social:presence_changed' &&
        m.playerId === playerA.playerId &&
        m.status === 'busy',
      4000,
      'presence busy push',
    );
    assert.equal(busyPush.status, 'busy');

    // Switch back to online, close C's socket after connecting & wait past PRESENCE_TTL_MS=2000 -> auto-expires to offline
    const wsC = new SocialWsClient(baseWs, ORIGIN);
    await wsC.connect();
    await wsC.initSession('SocialCharlie', playerC);
    // Friend A and C so A sees C's presence
    await apiJson(baseHttp, '/api/social/friends/request', {
      method: 'POST',
      token: playerA.playerToken,
      body: JSON.stringify({ playerId: playerA.playerId, targetPlayerId: playerC.playerId }),
    });
    await apiJson(baseHttp, '/api/social/friends/respond', {
      method: 'POST',
      token: playerC.playerToken,
      body: JSON.stringify({
        playerId: playerC.playerId,
        targetPlayerId: playerA.playerId,
        action: 'accept',
      }),
    });

    const ovBeforeExpire = await apiJson<{ overview: SocialOverviewPayload }>(
      baseHttp,
      `/api/social/overview?playerId=${encodeURIComponent(playerA.playerId)}`,
      { token: playerA.playerToken },
    );
    const cOnline = ovBeforeExpire.body.overview.friends.find((f) => f.playerId === playerC.playerId);
    assert.equal(cOnline?.presence, 'online');

    // Close C cleanly -> becomes offline immediately; also reconnect C & terminate socket abruptly to test TTL expiry
    await wsC.close();
    const wsCAbrupt = new SocialWsClient(baseWs, ORIGIN);
    await wsCAbrupt.connect();
    await wsCAbrupt.initSession('SocialCharlie', playerC);
    // Keep A & B alive with heartbeat during 2.4s wait, while C terminates abruptly
    wsCAbrupt.ws.terminate();
    await new Promise((r) => setTimeout(r, 1200));
    wsA.send({ type: 'presence:heartbeat' });
    wsB.send({ type: 'presence:heartbeat' });
    await new Promise((r) => setTimeout(r, 1200));
    wsA.send({ type: 'presence:heartbeat' });
    wsB.send({ type: 'presence:heartbeat' });

    const ovAfterExpire = await apiJson<{ overview: SocialOverviewPayload }>(
      baseHttp,
      `/api/social/overview?playerId=${encodeURIComponent(playerA.playerId)}`,
      { token: playerA.playerToken },
    );
    const cOffline = ovAfterExpire.body.overview.friends.find((f) => f.playerId === playerC.playerId);
    assert.equal(cOffline?.presence, 'offline');
    // A kept alive by heartbeat remains busy
    assert.equal(ovAfterExpire.body.overview.selfPresence, 'busy');

    await apiJson(baseHttp, '/api/social/presence', {
      method: 'POST',
      token: playerA.playerToken,
      body: JSON.stringify({ playerId: playerA.playerId, status: 'online' }),
    });
    console.log('PASS [2] Live presence updates (online/busy), heartbeat refresh & TTL expiration verified');

    // =========================================================================
    // [3] Block & Unblock Enforcement across Friends, Search, Invites, DMs & Reports
    // =========================================================================
    // A blocks C -> removes C from A's friends, prevents requests/invites/DMs, hides A from C's search
    const blockC = await apiJson(baseHttp, '/api/social/block', {
      method: 'POST',
      token: playerA.playerToken,
      body: JSON.stringify({ playerId: playerA.playerId, targetPlayerId: playerC.playerId }),
    });
    assert.equal(blockC.status, 200);

    const reqWhileBlocked = await apiJson(baseHttp, '/api/social/friends/request', {
      method: 'POST',
      token: playerC.playerToken,
      body: JSON.stringify({ playerId: playerC.playerId, targetPlayerId: playerA.playerId }),
    });
    assert.equal(reqWhileBlocked.status, 403);
    assert.equal(reqWhileBlocked.body.error, 'BLOCKED_PLAYER');

    const inviteWhileBlocked = await apiJson(baseHttp, '/api/social/invites', {
      method: 'POST',
      token: playerC.playerToken,
      body: JSON.stringify({
        playerId: playerC.playerId,
        targetPlayerId: playerA.playerId,
        ruleProfileId: 'casual',
        calledShotsEnabled: false,
      }),
    });
    assert.equal(inviteWhileBlocked.status, 403);
    assert.equal(inviteWhileBlocked.body.error, 'BLOCKED_PLAYER');

    const dmWhileBlocked = await apiJson(baseHttp, '/api/social/messages', {
      method: 'POST',
      token: playerC.playerToken,
      body: JSON.stringify({
        playerId: playerC.playerId,
        recipientId: playerA.playerId,
        body: 'Should be blocked',
      }),
    });
    assert.equal(dmWhileBlocked.status, 403);
    assert.equal(dmWhileBlocked.body.error, 'BLOCKED_PLAYER');

    // Search hides blocker A from C
    const cSearchA = await apiJson<{ players: SocialSearchPlayerItem[] }>(
      baseHttp,
      `/api/social/search?q=SocialAlpha&playerId=${encodeURIComponent(playerC.playerId)}`,
      { token: playerC.playerToken },
    );
    assert.equal(cSearchA.body.players.some((p) => p.playerId === playerA.playerId), false);

    // Unblock restores searchability
    const unblockC = await apiJson(baseHttp, '/api/social/unblock', {
      method: 'POST',
      token: playerA.playerToken,
      body: JSON.stringify({ playerId: playerA.playerId, targetPlayerId: playerC.playerId }),
    });
    assert.equal(unblockC.status, 200);
    console.log('PASS [3] Block/unblock enforcement verified across friends, search, invites & DMs');

    // =========================================================================
    // [4] Direct Match Invitations: Push, Duplicates, Cancel, Expiry, Offline, Live 1v1 Join
    // =========================================================================
    wsA.clearQueue();
    wsB.clearQueue();

    // Send invite A -> B via REST
    const inv1Res = await apiJson<{ invitation: MatchInvitationRecord }>(
      baseHttp,
      '/api/social/invites',
      {
        method: 'POST',
        token: playerA.playerToken,
        body: JSON.stringify({
          playerId: playerA.playerId,
          targetPlayerId: playerB.playerId,
          ruleProfileId: 'casual',
          calledShotsEnabled: false,
        }),
      },
    );
    assert.equal(inv1Res.status, 200);
    const inv1 = inv1Res.body.invitation;
    assert(inv1.inviteId.startsWith('inv_'));

    const receivedInv = await wsB.waitFor<
      Extract<ServerToClientMessage, { type: 'invite:received' }>
    >((m) => m.type === 'invite:received', 4000, 'invite:received');
    assert.equal(receivedInv.invitation.inviteId, inv1.inviteId);

    // Duplicate pending invitation blocked
    const dupInv = await apiJson(baseHttp, '/api/social/invites', {
      method: 'POST',
      token: playerA.playerToken,
      body: JSON.stringify({
        playerId: playerA.playerId,
        targetPlayerId: playerB.playerId,
        ruleProfileId: 'casual',
        calledShotsEnabled: false,
      }),
    });
    assert.equal(dupInv.status, 409);
    assert.equal(dupInv.body.error, 'INVITE_ALREADY_EXISTS');

    // Cancel pending invitation
    const cancelInv = await apiJson<{ invitation: MatchInvitationRecord }>(
      baseHttp,
      '/api/social/invites/respond',
      {
        method: 'POST',
        token: playerA.playerToken,
        body: JSON.stringify({
          playerId: playerA.playerId,
          inviteId: inv1.inviteId,
          action: 'cancel',
        }),
      },
    );
    assert.equal(cancelInv.status, 200);
    assert.equal(cancelInv.body.invitation.status, 'cancelled');

    // Test invite expiration (INVITE_TTL_MS=2000)
    const invExpRes = await apiJson<{ invitation: MatchInvitationRecord }>(
      baseHttp,
      '/api/social/invites',
      {
        method: 'POST',
        token: playerA.playerToken,
        body: JSON.stringify({
          playerId: playerA.playerId,
          targetPlayerId: playerB.playerId,
          ruleProfileId: 'casual',
          calledShotsEnabled: false,
        }),
      },
    );
    assert.equal(invExpRes.status, 200);
    await new Promise((r) => setTimeout(r, 2300));
    const acceptExpired = await apiJson(baseHttp, '/api/social/invites/respond', {
      method: 'POST',
      token: playerB.playerToken,
      body: JSON.stringify({
        playerId: playerB.playerId,
        inviteId: invExpRes.body.invitation.inviteId,
        action: 'accept',
      }),
    });
    assert.equal(acceptExpired.status, 410);
    assert.equal(acceptExpired.body.error, 'INVITE_EXPIRED');

    // Keep A's session fresh before offline test
    wsA.send({ type: 'presence:heartbeat' });
    wsB.send({ type: 'presence:heartbeat' });

    // Offline sender test: A sends invite then disconnects WS before B accepts -> PLAYER_OFFLINE
    const invOffRes = await apiJson<{ invitation: MatchInvitationRecord }>(
      baseHttp,
      '/api/social/invites',
      {
        method: 'POST',
        token: playerA.playerToken,
        body: JSON.stringify({
          playerId: playerA.playerId,
          targetPlayerId: playerB.playerId,
          ruleProfileId: 'casual',
          calledShotsEnabled: false,
        }),
      },
    );
    assert.equal(invOffRes.status, 200);
    await wsA.close();
    const acceptWhileSenderOffline = await apiJson(baseHttp, '/api/social/invites/respond', {
      method: 'POST',
      token: playerB.playerToken,
      body: JSON.stringify({
        playerId: playerB.playerId,
        inviteId: invOffRes.body.invitation.inviteId,
        action: 'accept',
      }),
    });
    assert.equal(acceptWhileSenderOffline.status, 409);
    assert.equal(acceptWhileSenderOffline.body.error, 'PLAYER_OFFLINE');

    // Reconnect A for live 1v1 acceptance & room chat
    await wsA.connect();
    await wsA.initSession('SocialAlpha', playerA);
    wsA.clearQueue();
    wsB.clearQueue();

    // Live invite A -> B (WPA strict) & B accepts -> both receive private room and enter match!
    const liveInvRes = await apiJson<{ invitation: MatchInvitationRecord }>(
      baseHttp,
      '/api/social/invites',
      {
        method: 'POST',
        token: playerA.playerToken,
        body: JSON.stringify({
          playerId: playerA.playerId,
          targetPlayerId: playerB.playerId,
          ruleProfileId: 'wpa',
          calledShotsEnabled: true,
        }),
      },
    );
    assert.equal(liveInvRes.status, 200);
    const liveInv = liveInvRes.body.invitation;

    const acceptLive = await apiJson<{
      invitation: MatchInvitationRecord;
      room: OnlineRoomInfo;
    }>(baseHttp, '/api/social/invites/respond', {
      method: 'POST',
      token: playerB.playerToken,
      body: JSON.stringify({
        playerId: playerB.playerId,
        inviteId: liveInv.inviteId,
        action: 'accept',
      }),
    });
    assert.equal(acceptLive.status, 200);
    assert.equal(acceptLive.body.invitation.status, 'accepted');
    const invitedRoom = acceptLive.body.room;
    assert(invitedRoom && invitedRoom.roomId.startsWith('room_'));
    assert.equal(invitedRoom.players.length, 2);
    assert.equal(invitedRoom.calledShotsEnabled, true);

    const aInviteUpdated = await wsA.waitFor<
      Extract<ServerToClientMessage, { type: 'invite:updated' }>
    >(
      (m) => m.type === 'invite:updated' && m.invitation.status === 'accepted',
      4000,
      'invite:updated accepted on A',
    );
    assert.equal(aInviteUpdated.room?.roomId, invitedRoom.roomId);
    console.log('PASS [4] Direct 1v1 invitations (push, duplicate, cancel, TTL expiry, offline guard & live accept) verified');

    // =========================================================================
    // [5] Real-Time Friend DMs (Read Receipts, XSS Safety, Length Limit & Anti-Spam)
    // =========================================================================
    wsA.clearQueue();
    wsB.clearQueue();

    // Oversized message (> 240 chars) rejected
    const tooLongDm = await apiJson(baseHttp, '/api/social/messages', {
      method: 'POST',
      token: playerA.playerToken,
      body: JSON.stringify({
        playerId: playerA.playerId,
        recipientId: playerB.playerId,
        body: 'X'.repeat(SOCIAL_LIMITS.chatMaxLength + 5),
      }),
    });
    assert.equal(tooLongDm.status, 400);
    assert.equal(tooLongDm.body.error, 'MESSAGE_TOO_LONG');

    // Send DM with XSS payload -> stored & broadcast verbatim (React renders safely as text)
    const xssPayload = `<script>alert("xss")</script> Hey Bravo!`;
    const dmRes = await apiJson<{ message: DirectMessageRecord }>(
      baseHttp,
      '/api/social/messages',
      {
        method: 'POST',
        token: playerA.playerToken,
        body: JSON.stringify({
          playerId: playerA.playerId,
          recipientId: playerB.playerId,
          body: xssPayload,
        }),
      },
    );
    assert.equal(dmRes.status, 200);
    assert.equal(dmRes.body.message.body, xssPayload);

    const dmPushB = await wsB.waitFor<
      Extract<ServerToClientMessage, { type: 'chat:dm_message' }>
    >((m) => m.type === 'chat:dm_message', 4000, 'chat:dm_message on B');
    assert.equal(dmPushB.message.body, xssPayload);

    // Rate-limit guard when sending immediately within chatMinIntervalMs (850ms)
    const spamDm = await apiJson(baseHttp, '/api/social/messages', {
      method: 'POST',
      token: playerA.playerToken,
      body: JSON.stringify({
        playerId: playerA.playerId,
        recipientId: playerB.playerId,
        body: 'Fast spam attempt',
      }),
    });
    assert.equal(spamDm.status, 429);
    assert.equal(spamDm.body.error, 'RATE_LIMITED');

    // Verify unread count on B then fetch thread -> marks read & notifies A
    const ovBBeforeRead = await apiJson<{ overview: SocialOverviewPayload }>(
      baseHttp,
      `/api/social/overview?playerId=${encodeURIComponent(playerB.playerId)}`,
      { token: playerB.playerToken },
    );
    assert(ovBBeforeRead.body.overview.totalUnreadDmCount >= 1);

    const threadB = await apiJson<{ messages: DirectMessageRecord[] }>(
      baseHttp,
      `/api/social/messages/${encodeURIComponent(playerA.playerId)}?playerId=${encodeURIComponent(playerB.playerId)}`,
      { token: playerB.playerToken },
    );
    assert.equal(threadB.status, 200);
    assert(threadB.body.messages.some((m) => m.body === xssPayload));

    await wsA.waitFor<Extract<ServerToClientMessage, { type: 'chat:dm_read' }>>(
      (m) => m.type === 'chat:dm_read' && m.readerId === playerB.playerId,
      4000,
      'chat:dm_read notification',
    );
    console.log('PASS [5] Friend DMs, unread tracking, read receipts, length/spam limits & XSS text safety verified');

    // =========================================================================
    // [6] In-Match Room Chat, Presence = 'in_match', Reconnect History & Reporting
    // =========================================================================
    const roomWsA = new SocialWsClient(baseWs, ORIGIN);
    const roomWsB = new SocialWsClient(baseWs, ORIGIN);
    await roomWsA.connect(`${baseWs}?roomId=${encodeURIComponent(invitedRoom.roomId)}`);
    await roomWsB.connect(`${baseWs}?roomId=${encodeURIComponent(invitedRoom.roomId)}`);

    roomWsA.send({
      type: 'session:resume',
      sessionId: wsA.sessionId,
      reconnectToken: wsA.reconnectToken,
      playerId: playerA.playerId,
      playerToken: playerA.playerToken,
    });
    roomWsB.send({
      type: 'session:resume',
      sessionId: wsB.sessionId,
      reconnectToken: wsB.reconnectToken,
      playerId: playerB.playerId,
      playerToken: playerB.playerToken,
    });
    await roomWsA.waitFor((m) => m.type === 'session:ready');
    await roomWsB.waitFor((m) => m.type === 'session:ready');

    // Ready & Start match -> verify presence transitions to 'in_match'
    roomWsB.send({ type: 'room:ready', ready: true });
    await roomWsA.waitFor(
      (m) => m.type === 'room:updated' && m.room.players.length === 2 && m.room.players.every((p) => p.ready),
    );
    roomWsA.send({ type: 'room:start' });
    await roomWsA.waitFor((m) => m.type === 'match:started');
    await roomWsB.waitFor((m) => m.type === 'match:started');

    const ovDuringMatch = await apiJson<{ overview: SocialOverviewPayload }>(
      baseHttp,
      `/api/social/overview?playerId=${encodeURIComponent(playerA.playerId)}`,
      { token: playerA.playerToken },
    );
    assert.equal(ovDuringMatch.body.overview.selfPresence, 'in_match');
    const bInMatch = ovDuringMatch.body.overview.friends.find((f) => f.playerId === playerB.playerId);
    assert.equal(bInMatch?.presence, 'in_match');

    // Room chat broadcast + anti-spam
    roomWsA.send({
      type: 'chat:room_send',
      body: 'Good luck & have fun!',
      clientMessageId: 'rc_test_1',
    });
    const rcB = await roomWsB.waitFor<Extract<ServerToClientMessage, { type: 'chat:room_message' }>>(
      (m) => m.type === 'chat:room_message',
      4000,
      'chat:room_message on B',
    );
    assert.equal(rcB.message.body, 'Good luck & have fun!');
    assert.equal(rcB.message.senderPlayerId, playerA.playerId);

    // Rapid room chat spam check
    roomWsA.send({
      type: 'chat:room_send',
      body: 'Flood 2',
      clientMessageId: 'rc_test_2',
    });
    const rcErr = await roomWsA.waitFor<Extract<ServerToClientMessage, { type: 'error' }>>(
      (m) => m.type === 'error' && m.code === 'RATE_LIMITED',
      4000,
      'room chat RATE_LIMITED',
    );
    assert.equal(rcErr.code, 'RATE_LIMITED');

    // Reconnect room socket B -> receives chat:room_history with previous message
    await roomWsB.close();
    const roomWsB2 = new SocialWsClient(baseWs, ORIGIN);
    await roomWsB2.connect(`${baseWs}?roomId=${encodeURIComponent(invitedRoom.roomId)}`);
    roomWsB2.send({
      type: 'session:resume',
      sessionId: wsB.sessionId,
      reconnectToken: wsB.reconnectToken,
      playerId: playerB.playerId,
      playerToken: playerB.playerToken,
    });
    const histMsg = await roomWsB2.waitFor<
      Extract<ServerToClientMessage, { type: 'chat:room_history' }>
    >((m) => m.type === 'chat:room_history', 5000, 'chat:room_history on reconnect');
    assert(histMsg.messages.some((m) => m.body === 'Good luck & have fun!'));

    // Report abusive player message
    const reportRes = await apiJson<{ ok: boolean; reportId: string }>(
      baseHttp,
      '/api/social/reports',
      {
        method: 'POST',
        token: playerB.playerToken,
        body: JSON.stringify({
          playerId: playerB.playerId,
          reportedId: playerA.playerId,
          contextType: 'room_chat',
          contextId: invitedRoom.roomId,
          reason: 'harassment',
          details: 'Automated verification report',
          excerpt: 'Good luck & have fun!',
        }),
      },
    );
    assert.equal(reportRes.status, 200);
    assert(reportRes.body.reportId.startsWith('rep_'));

    await roomWsA.close();
    await roomWsB2.close();
    await wsA.close();
    await wsB.close();
    console.log('PASS [6] In-match presence, room chat broadcast, rate limiting, reconnect history & reporting verified');
    console.log('\nPhase 7 Social, Invitations, Presence & Chat Verification: ALL 6 SUITES PASSED.');
  } catch (err) {
    console.error('\n--- Wrangler Social Logs ---\n', logs);
    throw err;
  } finally {
    if (wrangler.pid) {
      try {
        process.kill(-wrangler.pid, 'SIGTERM');
      } catch {
        wrangler.kill('SIGTERM');
      }
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 3000);
      wrangler.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    rmSync(CF_STATE_DIR, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
