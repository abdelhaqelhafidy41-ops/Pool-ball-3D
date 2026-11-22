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
import type { PublicPlayerProfile } from '../src/multiplayer/shared/progression';
import {
  DEFAULT_PRIVACY_SETTINGS,
  SOCIAL_LIMITS,
  type ClubChallengeRecord,
  type ClubDetailPayload,
  type ClubLeaderboardEntry,
  type ClubRecord,
  type DirectMessageRecord,
  type FriendRecord,
  type MatchInvitationRecord,
  type PrivacySettings,
  type SocialNotificationRecord,
  type SocialOverviewPayload,
  type SocialSearchPlayerItem,
} from '../src/multiplayer/shared/social';

const CF_PORT = 8796;
const CF_STATE_DIR = '/tmp/cf-phase15-community-state';
const ORIGIN = 'https://test-user.github.io';

class Phase15WsClient {
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
      latencyMs: 18,
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

  public async resumeInRoom(roomId: string): Promise<Phase15WsClient> {
    const rc = new Phase15WsClient(this.baseWsUrl, this.origin);
    await rc.connect(`${this.baseWsUrl}?roomId=${encodeURIComponent(roomId)}`);
    rc.send({
      type: 'session:resume',
      sessionId: this.sessionId,
      reconnectToken: this.reconnectToken,
      playerId: this.playerId,
      playerToken: this.playerToken,
    });
    await rc.waitFor((m) => m.type === 'session:ready', 6000, 'room session:ready');
    return rc;
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
  throw new Error('Timed out waiting for wrangler dev (Phase 15 Community test)');
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
  avatarId = 'cue_gold',
): Promise<{ playerId: string; playerToken: string; displayName: string }> {
  const res = await apiJson<{
    playerId?: string;
    playerToken: string;
    profile?: { playerId: string; displayName: string };
  }>(baseHttp, '/api/players/session', {
    method: 'POST',
    body: JSON.stringify({ displayName, avatarId, forceNewGuest: true }),
  });
  assert.equal(res.status, 200);
  const playerId = res.body.playerId ?? res.body.profile?.playerId ?? '';
  assert(playerId.startsWith('ply_'), `Expected valid playerId, got "${playerId}"`);
  return {
    playerId,
    playerToken: res.body.playerToken,
    displayName: res.body.profile?.displayName ?? displayName,
  };
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
      'PRESENCE_TTL_MS:2500',
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

  const socketsToClose: Phase15WsClient[] = [];

  try {
    await waitForWrangler(baseHttp);

    // =========================================================================
    // [1] Players Setup, Search, Friend Lifecycle, Pagination & Guards
    // =========================================================================
    const alpha = await createPlayer(baseHttp, 'ComAlpha', 'cue_gold');
    const bravo = await createPlayer(baseHttp, 'ComBravo', 'shark_sky');
    const charlie = await createPlayer(baseHttp, 'ComCharlie', 'crown_emerald');
    const delta = await createPlayer(baseHttp, 'ComDelta', 'diamond_crimson');
    const echo = await createPlayer(baseHttp, 'ComEcho', 'ace_violet');

    // Search by displayName & by playerId
    const searchName = await apiJson<{ players: SocialSearchPlayerItem[] }>(
      baseHttp,
      `/api/social/search?q=Bravo&playerId=${encodeURIComponent(alpha.playerId)}`,
      { token: alpha.playerToken },
    );
    assert.equal(searchName.status, 200);
    assert(searchName.body.players.some((p) => p.playerId === bravo.playerId));

    const searchId = await apiJson<{ players: SocialSearchPlayerItem[] }>(
      baseHttp,
      `/api/social/search?q=${encodeURIComponent(charlie.playerId)}&playerId=${encodeURIComponent(alpha.playerId)}`,
      { token: alpha.playerToken },
    );
    assert.equal(searchId.body.players.length, 1);
    assert.equal(searchId.body.players[0].playerId, charlie.playerId);

    // Self request & duplicate guard
    const selfReq = await apiJson(baseHttp, '/api/social/friends/request', {
      method: 'POST',
      token: alpha.playerToken,
      body: JSON.stringify({ playerId: alpha.playerId, targetPlayerId: alpha.playerId }),
    });
    assert.equal(selfReq.status, 400);
    assert.equal(selfReq.body.error, 'SELF_ACTION_FORBIDDEN');

    const wsAlpha = new Phase15WsClient(baseWs, ORIGIN);
    const wsBravo = new Phase15WsClient(baseWs, ORIGIN);
    const wsCharlie = new Phase15WsClient(baseWs, ORIGIN);
    const wsDelta = new Phase15WsClient(baseWs, ORIGIN);
    socketsToClose.push(wsAlpha, wsBravo, wsCharlie, wsDelta);

    await wsAlpha.connect();
    await wsBravo.connect();
    await wsCharlie.connect();
    await wsDelta.connect();
    await wsAlpha.initSession('ComAlpha', alpha);
    await wsBravo.initSession('ComBravo', bravo);
    await wsCharlie.initSession('ComCharlie', charlie);
    await wsDelta.initSession('ComDelta', delta);
    wsAlpha.clearQueue();
    wsBravo.clearQueue();
    wsCharlie.clearQueue();
    wsDelta.clearQueue();

    // Friend Bravo + Charlie + Delta with Alpha (plus mutual auto-accept test)
    const fr1 = await apiJson<{ outcome: string }>(baseHttp, '/api/social/friends/request', {
      method: 'POST',
      token: alpha.playerToken,
      body: JSON.stringify({ playerId: alpha.playerId, targetPlayerId: bravo.playerId }),
    });
    assert.equal(fr1.status, 200);
    assert.equal(fr1.body.outcome, 'requested');

    // Duplicate friend request blocked
    const dupFr = await apiJson(baseHttp, '/api/social/friends/request', {
      method: 'POST',
      token: alpha.playerToken,
      body: JSON.stringify({ playerId: alpha.playerId, targetPlayerId: bravo.playerId }),
    });
    assert.equal(dupFr.status, 409);
    assert.equal(dupFr.body.error, 'DUPLICATE_REQUEST');

    // Notification persisted & pushed for friend_request
    const reqNotif = await wsBravo.waitFor<
      Extract<ServerToClientMessage, { type: 'notification:new' }>
    >(
      (m) => m.type === 'notification:new' && m.notification.type === 'friend_request',
      5000,
      'friend_request notification',
    );
    assert.equal(reqNotif.notification.actorId, alpha.playerId);

    // Accept friend request & verify friend_response notification reaches Alpha
    const acceptFr = await apiJson(baseHttp, '/api/social/friends/respond', {
      method: 'POST',
      token: bravo.playerToken,
      body: JSON.stringify({
        playerId: bravo.playerId,
        targetPlayerId: alpha.playerId,
        action: 'accept',
      }),
    });
    assert.equal(acceptFr.status, 200);

    await wsAlpha.waitFor<Extract<ServerToClientMessage, { type: 'notification:new' }>>(
      (m) => m.type === 'notification:new' && m.notification.type === 'friend_response',
      5000,
      'friend_response notification on Alpha',
    );

    // Friend Charlie & Delta via mutual/respond so Alpha has 3 friends for pagination testing
    await apiJson(baseHttp, '/api/social/friends/request', {
      method: 'POST',
      token: alpha.playerToken,
      body: JSON.stringify({ playerId: alpha.playerId, targetPlayerId: charlie.playerId }),
    });
    const mutualCharlie = await apiJson<{ outcome: string }>(
      baseHttp,
      '/api/social/friends/request',
      {
        method: 'POST',
        token: charlie.playerToken,
        body: JSON.stringify({ playerId: charlie.playerId, targetPlayerId: alpha.playerId }),
      },
    );
    assert.equal(mutualCharlie.body.outcome, 'accepted');

    await apiJson(baseHttp, '/api/social/friends/request', {
      method: 'POST',
      token: alpha.playerToken,
      body: JSON.stringify({ playerId: alpha.playerId, targetPlayerId: delta.playerId }),
    });
    await apiJson(baseHttp, '/api/social/friends/respond', {
      method: 'POST',
      token: delta.playerToken,
      body: JSON.stringify({
        playerId: delta.playerId,
        targetPlayerId: alpha.playerId,
        action: 'accept',
      }),
    });

    // Paginated friends endpoint (limit=2, offset=0 then offset=2)
    const page1 = await apiJson<{
      ok: boolean;
      friends: FriendRecord[];
      total: number;
      hasMore: boolean;
    }>(
      baseHttp,
      `/api/social/friends?playerId=${encodeURIComponent(alpha.playerId)}&limit=2&offset=0`,
      { token: alpha.playerToken },
    );
    assert.equal(page1.status, 200);
    assert.equal(page1.body.total, 3);
    assert.equal(page1.body.friends.length, 2);
    assert.equal(page1.body.hasMore, true);

    const page2 = await apiJson<{
      ok: boolean;
      friends: FriendRecord[];
      total: number;
      hasMore: boolean;
    }>(
      baseHttp,
      `/api/social/friends?playerId=${encodeURIComponent(alpha.playerId)}&limit=2&offset=2`,
      { token: alpha.playerToken },
    );
    assert.equal(page2.status, 200);
    assert.equal(page2.body.friends.length, 1);
    assert.equal(page2.body.hasMore, false);
    console.log('PASS [1] Search, friend request lifecycle, notifications & paginated friends list verified');

    // =========================================================================
    // [2] Online Presence + Block / Unblock Enforcement
    // =========================================================================
    wsBravo.clearQueue();
    const busyRes = await apiJson<{ status: string }>(baseHttp, '/api/social/presence', {
      method: 'POST',
      token: alpha.playerToken,
      body: JSON.stringify({ playerId: alpha.playerId, status: 'busy' }),
    });
    assert.equal(busyRes.status, 200);
    assert.equal(busyRes.body.status, 'busy');

    const busyEvent = await wsBravo.waitFor<
      Extract<ServerToClientMessage, { type: 'social:presence_changed' }>
    >(
      (m) =>
        m.type === 'social:presence_changed' &&
        m.playerId === alpha.playerId &&
        m.status === 'busy',
      5000,
      'presence busy event',
    );
    assert.ok(typeof busyEvent.lastSeenAtMs === 'number' && busyEvent.lastSeenAtMs > 0);

    await apiJson(baseHttp, '/api/social/presence', {
      method: 'POST',
      token: alpha.playerToken,
      body: JSON.stringify({ playerId: alpha.playerId, status: 'online' }),
    });

    // Block Echo from Delta -> blocks requests/invites/DMs, unblock restores
    await apiJson(baseHttp, '/api/social/block', {
      method: 'POST',
      token: delta.playerToken,
      body: JSON.stringify({ playerId: delta.playerId, targetPlayerId: echo.playerId }),
    });
    const reqBlocked = await apiJson(baseHttp, '/api/social/friends/request', {
      method: 'POST',
      token: echo.playerToken,
      body: JSON.stringify({ playerId: echo.playerId, targetPlayerId: delta.playerId }),
    });
    assert.equal(reqBlocked.status, 403);
    assert.equal(reqBlocked.body.error, 'BLOCKED_PLAYER');

    await apiJson(baseHttp, '/api/social/unblock', {
      method: 'POST',
      token: delta.playerToken,
      body: JSON.stringify({ playerId: delta.playerId, targetPlayerId: echo.playerId }),
    });
    const reqAfterUnblock = await apiJson(baseHttp, '/api/social/friends/request', {
      method: 'POST',
      token: echo.playerToken,
      body: JSON.stringify({ playerId: echo.playerId, targetPlayerId: delta.playerId }),
    });
    assert.equal(reqAfterUnblock.status, 200);
    await apiJson(baseHttp, '/api/social/friends/respond', {
      method: 'POST',
      token: delta.playerToken,
      body: JSON.stringify({
        playerId: delta.playerId,
        targetPlayerId: echo.playerId,
        action: 'reject',
      }),
    });
    console.log('PASS [2] Online presence broadcasts & block/unblock enforcement verified');

    // =========================================================================
    // [3] Privacy Settings Persistence, Profile Redaction & Spoofed Viewer Guard
    // =========================================================================
    const defPriv = await apiJson<{ ok: boolean; privacy: PrivacySettings }>(
      baseHttp,
      `/api/social/privacy?playerId=${encodeURIComponent(alpha.playerId)}`,
      { token: alpha.playerToken },
    );
    assert.equal(defPriv.status, 200);
    assert.deepEqual(defPriv.body.privacy, DEFAULT_PRIVACY_SETTINGS);

    // Alpha restricts everything & hides online status and public stats
    const updPriv = await apiJson<{ ok: boolean; privacy: PrivacySettings }>(
      baseHttp,
      '/api/social/privacy',
      {
        method: 'POST',
        token: alpha.playerToken,
        body: JSON.stringify({
          playerId: alpha.playerId,
          allowFriendRequests: 'nobody',
          allowMatchInvites: 'nobody',
          allowDirectMessages: 'nobody',
          showOnlineStatus: false,
          showPublicStats: false,
        }),
      },
    );
    assert.equal(updPriv.status, 200);
    assert.equal(updPriv.body.privacy.allowFriendRequests, 'nobody');
    assert.equal(updPriv.body.privacy.showOnlineStatus, false);
    assert.equal(updPriv.body.privacy.showPublicStats, false);

    // Echo tries friend request -> PRIVACY_RESTRICTED
    const privFr = await apiJson(baseHttp, '/api/social/friends/request', {
      method: 'POST',
      token: echo.playerToken,
      body: JSON.stringify({ playerId: echo.playerId, targetPlayerId: alpha.playerId }),
    });
    assert.equal(privFr.status, 403);
    assert.equal(privFr.body.error, 'PRIVACY_RESTRICTED');

    // Bravo (even as friend) cannot DM or invite Alpha when set to 'nobody'
    const privDm = await apiJson(baseHttp, '/api/social/messages', {
      method: 'POST',
      token: bravo.playerToken,
      body: JSON.stringify({
        playerId: bravo.playerId,
        recipientId: alpha.playerId,
        body: 'Blocked by privacy',
      }),
    });
    assert.equal(privDm.status, 403);
    assert.equal(privDm.body.error, 'PRIVACY_RESTRICTED');

    const privInv = await apiJson(baseHttp, '/api/social/invites', {
      method: 'POST',
      token: bravo.playerToken,
      body: JSON.stringify({
        playerId: bravo.playerId,
        targetPlayerId: alpha.playerId,
        ruleProfileId: 'casual',
        calledShotsEnabled: false,
      }),
    });
    assert.equal(privInv.status, 403);
    assert.equal(privInv.body.error, 'PRIVACY_RESTRICTED');

    // Bravo sees Alpha as offline & lastSeenAtMs null in friends list
    const bravoOvHidden = await apiJson<{ overview: SocialOverviewPayload }>(
      baseHttp,
      `/api/social/overview?playerId=${encodeURIComponent(bravo.playerId)}`,
      { token: bravo.playerToken },
    );
    const alphaFromBravo = bravoOvHidden.body.overview.friends.find(
      (f) => f.playerId === alpha.playerId,
    );
    assert.equal(alphaFromBravo?.presence, 'offline');
    assert.equal(alphaFromBravo?.lastSeenAtMs, null);

    // Spoofed viewerId WITHOUT valid Bearer token must still receive redacted profile!
    const spoofedProf = await apiJson<{ profile: PublicPlayerProfile }>(
      baseHttp,
      `/api/players/profile/${encodeURIComponent(alpha.playerId)}?viewerId=${encodeURIComponent(alpha.playerId)}`,
      { token: bravo.playerToken },
    );
    assert.equal(spoofedProf.status, 200);
    assert.equal(spoofedProf.body.profile.privacyFiltered, true);
    assert.equal(spoofedProf.body.profile.presence, 'offline');
    assert.equal(spoofedProf.body.profile.lastSeenAtMs, null);
    assert.equal(spoofedProf.body.profile.rank, null);

    // Authenticated owner still sees full own profile + privacyFiltered falsy
    const selfProf = await apiJson<{ profile: PublicPlayerProfile }>(
      baseHttp,
      `/api/players/profile/${encodeURIComponent(alpha.playerId)}?viewerId=${encodeURIComponent(alpha.playerId)}`,
      { token: alpha.playerToken },
    );
    assert.equal(selfProf.status, 200);
    assert.ok(!selfProf.body.profile.privacyFiltered);
    assert.ok(selfProf.body.profile.equippedCosmetics);

    // Restore Alpha's privacy back to friend defaults
    const restorePriv = await apiJson(baseHttp, '/api/social/privacy', {
      method: 'POST',
      token: alpha.playerToken,
      body: JSON.stringify({ playerId: alpha.playerId, ...DEFAULT_PRIVACY_SETTINGS }),
    });
    assert.equal(restorePriv.status, 200);
    console.log('PASS [3] Privacy persistence, server enforcement, profile redaction & viewer token verification passed');

    // =========================================================================
    // [4] Friend DMs, Sanitization, Read Receipts & Moderation Report
    // =========================================================================
    wsAlpha.clearQueue();
    wsBravo.clearQueue();

    const dmBad = await apiJson(baseHttp, '/api/social/messages', {
      method: 'POST',
      token: alpha.playerToken,
      body: JSON.stringify({
        playerId: alpha.playerId,
        recipientId: bravo.playerId,
        body: 'Z'.repeat(SOCIAL_LIMITS.chatMaxLength + 10),
      }),
    });
    assert.equal(dmBad.status, 400);
    assert.equal(dmBad.body.error, 'MESSAGE_TOO_LONG');

    const dmBody = '<img src=x onerror=alert(1)> Ready for a rack?';
    const dmSend = await apiJson<{ message: DirectMessageRecord }>(
      baseHttp,
      '/api/social/messages',
      {
        method: 'POST',
        token: alpha.playerToken,
        body: JSON.stringify({
          playerId: alpha.playerId,
          recipientId: bravo.playerId,
          body: dmBody,
        }),
      },
    );
    assert.equal(dmSend.status, 200);
    assert.equal(dmSend.body.message.body, dmBody);

    await wsBravo.waitFor<Extract<ServerToClientMessage, { type: 'chat:dm_message' }>>(
      (m) => m.type === 'chat:dm_message' && m.message.body === dmBody,
      5000,
      'DM broadcast to Bravo',
    );
    await wsBravo.waitFor<Extract<ServerToClientMessage, { type: 'notification:new' }>>(
      (m) => m.type === 'notification:new' && m.notification.type === 'private_message',
      5000,
      'private_message notification',
    );

    // Mark read by fetching thread -> Alpha receives chat:dm_read
    const thread = await apiJson<{ messages: DirectMessageRecord[] }>(
      baseHttp,
      `/api/social/messages/${encodeURIComponent(alpha.playerId)}?playerId=${encodeURIComponent(bravo.playerId)}`,
      { token: bravo.playerToken },
    );
    assert.equal(thread.status, 200);
    assert(thread.body.messages.some((m) => m.body === dmBody));
    await wsAlpha.waitFor<Extract<ServerToClientMessage, { type: 'chat:dm_read' }>>(
      (m) => m.type === 'chat:dm_read' && m.readerId === bravo.playerId,
      5000,
      'chat:dm_read receipt',
    );

    const reportRes = await apiJson<{ ok: boolean; reportId: string }>(
      baseHttp,
      '/api/social/reports',
      {
        method: 'POST',
        token: bravo.playerToken,
        body: JSON.stringify({
          playerId: bravo.playerId,
          reportedId: alpha.playerId,
          contextType: 'dm',
          reason: 'spam',
          details: 'Phase 15 moderation verification',
          excerpt: dmBody,
        }),
      },
    );
    assert.equal(reportRes.status, 200);
    assert(reportRes.body.reportId.startsWith('rep_'));
    console.log('PASS [4] Friend DMs, unread/read receipts, text safety & moderation reporting verified');

    // =========================================================================
    // [5] Quick-Join Friend Open Room + Spectate Match Invitations
    // =========================================================================
    wsAlpha.clearQueue();
    wsBravo.clearQueue();
    wsCharlie.clearQueue();

    // Non-friend Echo cannot quick-join Alpha's room (NOT_FRIENDS)
    wsAlpha.send({
      type: 'room:create',
      isPrivate: false,
      ruleProfileId: 'casual',
      calledShotsEnabled: false,
    });
    const roomCreated = await wsAlpha.waitFor<Extract<ServerToClientMessage, { type: 'room:created' }>>(
      (m) => m.type === 'room:created',
      6000,
      'alpha room:created',
    );
    const friendRoomId = roomCreated.room.roomId;

    // Bravo sees Alpha's joinable room in overview!
    const ovBravoRoom = await apiJson<{ overview: SocialOverviewPayload }>(
      baseHttp,
      `/api/social/overview?playerId=${encodeURIComponent(bravo.playerId)}`,
      { token: bravo.playerToken },
    );
    const alphaFriend = ovBravoRoom.body.overview.friends.find((f) => f.playerId === alpha.playerId);
    assert.equal(alphaFriend?.activeRoom?.roomId, friendRoomId);
    assert.equal(alphaFriend?.activeRoom?.joinable, true);

    // Non-friend rejected
    const wsEcho = new Phase15WsClient(baseWs, ORIGIN);
    socketsToClose.push(wsEcho);
    await wsEcho.connect();
    await wsEcho.initSession('ComEcho', echo);
    const nonFriendJoin = await apiJson(baseHttp, '/api/social/rooms/join-friend', {
      method: 'POST',
      token: echo.playerToken,
      body: JSON.stringify({
        playerId: echo.playerId,
        friendPlayerId: alpha.playerId,
        sessionId: wsEcho.sessionId,
      }),
    });
    assert.equal(nonFriendJoin.status, 403);
    assert.equal(nonFriendJoin.body.error, 'NOT_FRIENDS');

    // Friend Bravo quick-joins Alpha's waiting room!
    const bravoJoinFriend = await apiJson<{ ok: boolean; room: OnlineRoomInfo }>(
      baseHttp,
      '/api/social/rooms/join-friend',
      {
        method: 'POST',
        token: bravo.playerToken,
        body: JSON.stringify({
          playerId: bravo.playerId,
          friendPlayerId: alpha.playerId,
          sessionId: wsBravo.sessionId,
        }),
      },
    );
    assert.equal(bravoJoinFriend.status, 200);
    assert.equal(bravoJoinFriend.body.room.roomId, friendRoomId);
    assert.equal(bravoJoinFriend.body.room.players.length, 2);

    // Connect Alpha & Bravo into the room and start match (public room allows spectators!)
    const roomAlpha = await wsAlpha.resumeInRoom(friendRoomId);
    const roomBravo = await wsBravo.resumeInRoom(friendRoomId);
    socketsToClose.push(roomAlpha, roomBravo);
    roomBravo.send({ type: 'room:ready', ready: true });
    await roomAlpha.waitFor(
      (m) => m.type === 'room:updated' && m.room.players.length === 2 && m.room.players.every((p) => p.ready),
      6000,
      'both players ready',
    );
    roomAlpha.send({ type: 'room:start' });
    await roomAlpha.waitFor((m) => m.type === 'match:started', 6000, 'alpha match:started');
    await roomBravo.waitFor((m) => m.type === 'match:started', 6000, 'bravo match:started');

    // Alpha sends a SPECTATE invite to friend Charlie!
    const specInvRes = await apiJson<{ invitation: MatchInvitationRecord }>(
      baseHttp,
      '/api/social/invites',
      {
        method: 'POST',
        token: alpha.playerToken,
        body: JSON.stringify({
          playerId: alpha.playerId,
          targetPlayerId: charlie.playerId,
          inviteKind: 'spectate',
          roomId: friendRoomId,
          ruleProfileId: 'casual',
          calledShotsEnabled: false,
        }),
      },
    );
    assert.equal(specInvRes.status, 200);
    assert.equal(specInvRes.body.invitation.inviteKind, 'spectate');

    const specInvPush = await wsCharlie.waitFor<
      Extract<ServerToClientMessage, { type: 'invite:received' }>
    >((m) => m.type === 'invite:received', 5000, 'charlie spectate invite');
    assert.equal(specInvPush.invitation.inviteKind, 'spectate');

    // Charlie accepts spectate invite -> returns spectateTarget WITHOUT joining player slots!
    const specAccept = await apiJson<{
      invitation: MatchInvitationRecord;
      room?: OnlineRoomInfo;
      spectateTarget?: { roomId: string; roomCode: string | null };
    }>(baseHttp, '/api/social/invites/respond', {
      method: 'POST',
      token: charlie.playerToken,
      body: JSON.stringify({
        playerId: charlie.playerId,
        inviteId: specInvRes.body.invitation.inviteId,
        action: 'accept',
      }),
    });
    assert.equal(specAccept.status, 200);
    assert.equal(specAccept.body.room, undefined);
    assert.equal(specAccept.body.spectateTarget?.roomId, friendRoomId);

    // Charlie joins via /api/spectate/join as a spectator
    const charlieSpecJoin = await apiJson<{
      ok: boolean;
      spectatorSessionId: string;
      spectatorReconnectToken: string;
      room: { roomId: string; players: unknown[]; spectatorCount: number };
    }>(baseHttp, '/api/spectate/join', {
      method: 'POST',
      body: JSON.stringify({
        roomId: friendRoomId,
        playerId: charlie.playerId,
        playerToken: charlie.playerToken,
        displayName: 'ComCharlie',
      }),
    });
    assert.equal(charlieSpecJoin.status, 200);
    assert.equal(charlieSpecJoin.body.room.players.length, 2);
    assert.equal(charlieSpecJoin.body.room.spectatorCount, 1);

    // Spectate invite to a private room with spectators disabled must be rejected
    roomAlpha.send({ type: 'room:set_spectators', allowSpectators: false });
    await roomAlpha.waitFor(
      (m) => m.type === 'room:updated' && m.room.allowSpectators === false,
      5000,
      'allowSpectators false',
    );
    const deniedSpecInv = await apiJson(baseHttp, '/api/social/invites', {
      method: 'POST',
      token: alpha.playerToken,
      body: JSON.stringify({
        playerId: alpha.playerId,
        targetPlayerId: delta.playerId,
        inviteKind: 'spectate',
        roomId: friendRoomId,
      }),
    });
    assert.equal(deniedSpecInv.status, 403);
    assert.equal(deniedSpecInv.body.error, 'SPECTATE_UNAVAILABLE');
    console.log('PASS [5] Friend quick-join open room & spectate invitations verified');

    // =========================================================================
    // [6] Clubs Creation, Validation, Public vs Approval Join, Invites & Roles
    // =========================================================================
    // Invalid tag rejected
    const badTagClub = await apiJson(baseHttp, '/api/clubs', {
      method: 'POST',
      token: alpha.playerToken,
      body: JSON.stringify({
        playerId: alpha.playerId,
        name: 'Bad Tag Club',
        tag: 'X',
      }),
    });
    assert.equal(badTagClub.status, 400);

    // Alpha creates Approval-only Club [APEX]
    const clubApexRes = await apiJson<{ ok: boolean; detail: ClubDetailPayload }>(
      baseHttp,
      '/api/clubs',
      {
        method: 'POST',
        token: alpha.playerToken,
        body: JSON.stringify({
          playerId: alpha.playerId,
          name: 'Apex Cue Masters',
          tag: 'APEX',
          description: 'Competitive 8-ball division',
          emblemColor: '#f59e0b',
          emblemIcon: 'crown',
          joinMode: 'approval',
        }),
      },
    );
    assert.equal(clubApexRes.status, 200);
    const apexClubId = clubApexRes.body.detail.club.clubId;
    assert.equal(clubApexRes.body.detail.club.tag, 'APEX');
    assert.equal(clubApexRes.body.detail.viewerRole, 'owner');

    // Duplicate tag/name rejected
    const dupClub = await apiJson(baseHttp, '/api/clubs', {
      method: 'POST',
      token: bravo.playerToken,
      body: JSON.stringify({
        playerId: bravo.playerId,
        name: 'Another Name',
        tag: 'apex',
      }),
    });
    assert.equal(dupClub.status, 409);

    // Bravo creates Public Club [SHRK]
    const clubShrkRes = await apiJson<{ ok: boolean; detail: ClubDetailPayload }>(
      baseHttp,
      '/api/clubs',
      {
        method: 'POST',
        token: bravo.playerToken,
        body: JSON.stringify({
          playerId: bravo.playerId,
          name: 'Shark Syndicate',
          tag: 'SHRK',
          description: 'Public shark club',
          emblemColor: '#38bdf8',
          emblemIcon: 'swords',
          joinMode: 'public',
        }),
      },
    );
    assert.equal(clubShrkRes.status, 200);
    const shrkClubId = clubShrkRes.body.detail.club.clubId;

    // Charlie requests to join Approval club APEX
    wsAlpha.clearQueue();
    const joinReqCharlie = await apiJson<{ outcome: string; requestId?: string }>(
      baseHttp,
      `/api/clubs/${encodeURIComponent(apexClubId)}/join`,
      {
        method: 'POST',
        token: charlie.playerToken,
        body: JSON.stringify({ playerId: charlie.playerId, message: 'Let me in!' }),
      },
    );
    assert.equal(joinReqCharlie.status, 200);
    assert.equal(joinReqCharlie.body.outcome, 'requested');

    await wsAlpha.waitFor<Extract<ServerToClientMessage, { type: 'notification:new' }>>(
      (m) => m.type === 'notification:new' && m.notification.type === 'club_join_request',
      5000,
      'club_join_request notification on Alpha',
    );

    // Alpha approves Charlie
    const reqId = joinReqCharlie.body.requestId!;
    assert.ok(reqId);
    const approveCharlie = await apiJson<{ detail: ClubDetailPayload }>(
      baseHttp,
      `/api/clubs/${encodeURIComponent(apexClubId)}/requests/respond`,
      {
        method: 'POST',
        token: alpha.playerToken,
        body: JSON.stringify({
          playerId: alpha.playerId,
          requestId: reqId,
          action: 'accept',
        }),
      },
    );
    assert.equal(approveCharlie.status, 200);
    assert.equal(approveCharlie.body.detail.members.length, 2);

    // Alpha invites Delta to APEX -> Delta accepts invite
    wsDelta.clearQueue();
    const inviteDelta = await apiJson(
      baseHttp,
      `/api/clubs/${encodeURIComponent(apexClubId)}/invite`,
      {
        method: 'POST',
        token: alpha.playerToken,
        body: JSON.stringify({ playerId: alpha.playerId, targetPlayerId: delta.playerId }),
      },
    );
    assert.equal(inviteDelta.status, 200);

    await wsDelta.waitFor<Extract<ServerToClientMessage, { type: 'notification:new' }>>(
      (m) => m.type === 'notification:new' && m.notification.type === 'club_invite',
      5000,
      'club_invite notification on Delta',
    );

    const deltaOv = await apiJson<{ overview: SocialOverviewPayload }>(
      baseHttp,
      `/api/social/overview?playerId=${encodeURIComponent(delta.playerId)}`,
      { token: delta.playerToken },
    );
    const clubInv = deltaOv.body.overview.incomingClubInvitations?.find(
      (i) => i.clubId === apexClubId,
    );
    assert.ok(clubInv, 'Delta should have incoming club invitation in overview');

    const acceptClubInv = await apiJson(baseHttp, '/api/clubs/invites/respond', {
      method: 'POST',
      token: delta.playerToken,
      body: JSON.stringify({
        playerId: delta.playerId,
        inviteId: clubInv!.inviteId,
        action: 'accept',
      }),
    });
    assert.equal(acceptClubInv.status, 200);

    // Echo joins Public club SHRK immediately
    const joinPublicEcho = await apiJson<{ outcome: string; detail: ClubDetailPayload }>(
      baseHttp,
      `/api/clubs/${encodeURIComponent(shrkClubId)}/join`,
      {
        method: 'POST',
        token: echo.playerToken,
        body: JSON.stringify({ playerId: echo.playerId }),
      },
    );
    assert.equal(joinPublicEcho.status, 200);
    assert.equal(joinPublicEcho.body.outcome, 'joined');
    assert.equal(joinPublicEcho.body.detail.members.length, 2);

    // Enriched friend & profile responses show club [TAG] badge!
    const enrichedProf = await apiJson<{ profile: PublicPlayerProfile }>(
      baseHttp,
      `/api/players/profile/${encodeURIComponent(charlie.playerId)}`,
    );
    assert.equal(enrichedProf.body.profile.club?.tag, 'APEX');

    // Role governance: promote Charlie -> admin, transfer ownership -> Charlie, reject unauthorized kick, kick Delta, transfer ownership back -> Alpha
    const promoteCharlie = await apiJson(
      baseHttp,
      `/api/clubs/${encodeURIComponent(apexClubId)}/members/role`,
      {
        method: 'POST',
        token: alpha.playerToken,
        body: JSON.stringify({
          playerId: alpha.playerId,
          targetPlayerId: charlie.playerId,
          role: 'admin',
        }),
      },
    );
    assert.equal(promoteCharlie.status, 200);

    // Admin Charlie tries to kick Owner Alpha -> 403 UNAUTHORIZED
    const kickOwnerFail = await apiJson(
      baseHttp,
      `/api/clubs/${encodeURIComponent(apexClubId)}/members/kick`,
      {
        method: 'POST',
        token: charlie.playerToken,
        body: JSON.stringify({ playerId: charlie.playerId, targetPlayerId: alpha.playerId }),
      },
    );
    assert.equal(kickOwnerFail.status, 403);

    // Non-officer Delta cannot update club settings -> 403
    const nonOfficerUpdate = await apiJson(
      baseHttp,
      `/api/clubs/${encodeURIComponent(apexClubId)}/update`,
      {
        method: 'POST',
        token: delta.playerToken,
        body: JSON.stringify({ playerId: delta.playerId, description: 'Hacked' }),
      },
    );
    assert.equal(nonOfficerUpdate.status, 403);

    // Admin Charlie kicks Member Delta -> allowed
    const kickDelta = await apiJson(
      baseHttp,
      `/api/clubs/${encodeURIComponent(apexClubId)}/members/kick`,
      {
        method: 'POST',
        token: charlie.playerToken,
        body: JSON.stringify({ playerId: charlie.playerId, targetPlayerId: delta.playerId }),
      },
    );
    assert.equal(kickDelta.status, 200);

    // Owner Alpha transfers ownership to Charlie -> Charlie transfers back to Alpha -> verifies owner cannot leave while other members exist
    await apiJson(baseHttp, `/api/clubs/${encodeURIComponent(apexClubId)}/members/role`, {
      method: 'POST',
      token: alpha.playerToken,
      body: JSON.stringify({
        playerId: alpha.playerId,
        targetPlayerId: charlie.playerId,
        role: 'owner',
      }),
    });
    const charlieOwnerLeaveFail = await apiJson(
      baseHttp,
      `/api/clubs/${encodeURIComponent(apexClubId)}/leave`,
      {
        method: 'POST',
        token: charlie.playerToken,
        body: JSON.stringify({ playerId: charlie.playerId }),
      },
    );
    assert.equal(charlieOwnerLeaveFail.status, 409);

    await apiJson(baseHttp, `/api/clubs/${encodeURIComponent(apexClubId)}/members/role`, {
      method: 'POST',
      token: charlie.playerToken,
      body: JSON.stringify({
        playerId: charlie.playerId,
        targetPlayerId: alpha.playerId,
        role: 'owner',
      }),
    });

    // Club directory search
    const clubSearch = await apiJson<{ clubs: ClubRecord[] }>(baseHttp, '/api/clubs?q=APEX');
    assert.equal(clubSearch.status, 200);
    assert(clubSearch.body.clubs.some((c) => c.clubId === apexClubId));
    console.log('PASS [6] Clubs CRUD, public/approval join, invites, role governance, kick & badges verified');

    // =========================================================================
    // [7] Club Challenges + Live Verified Match Auto-Scoring + Club Leaderboards
    // =========================================================================
    wsBravo.clearQueue();
    const chalCreate = await apiJson<{ challenge: ClubChallengeRecord }>(
      baseHttp,
      '/api/clubs/challenges',
      {
        method: 'POST',
        token: alpha.playerToken,
        body: JSON.stringify({
          playerId: alpha.playerId,
          challengerClubId: apexClubId,
          targetClubId: shrkClubId,
          ruleProfileId: 'casual',
          calledShotsEnabled: false,
          targetWins: 1,
          notes: 'First to 1 win showdown',
        }),
      },
    );
    assert.equal(chalCreate.status, 200);
    const challengeId = chalCreate.body.challenge.challengeId;
    assert.equal(chalCreate.body.challenge.status, 'pending');

    await wsBravo.waitFor<Extract<ServerToClientMessage, { type: 'notification:new' }>>(
      (m) => m.type === 'notification:new' && m.notification.type === 'club_challenge',
      5000,
      'club_challenge notification on Bravo',
    );

    // Non-officer Echo cannot accept challenge for SHRK
    const unauthAcceptChal = await apiJson(
      baseHttp,
      `/api/clubs/challenges/${encodeURIComponent(challengeId)}/respond`,
      {
        method: 'POST',
        token: echo.playerToken,
        body: JSON.stringify({ playerId: echo.playerId, action: 'accept' }),
      },
    );
    assert.equal(unauthAcceptChal.status, 403);

    // Owner Bravo accepts challenge
    const acceptChal = await apiJson<{ challenge: ClubChallengeRecord }>(
      baseHttp,
      `/api/clubs/challenges/${encodeURIComponent(challengeId)}/respond`,
      {
        method: 'POST',
        token: bravo.playerToken,
        body: JSON.stringify({ playerId: bravo.playerId, action: 'accept' }),
      },
    );
    assert.equal(acceptChal.status, 200);
    assert.equal(acceptChal.body.challenge.status, 'accepted');

    // Finish the live online match between Alpha (APEX) and Bravo (SHRK) by taking a real shot then Bravo forfeiting!
    // Zero-shot forfeits are classified as 'abandoned' and rejected by anti-boost club challenge validation.
    // PoolRoomDO persists match -> progression -> recordMatchHistory -> autoLinkMatchToActiveChallenge!
    roomAlpha.send({
      type: 'game:shoot',
      cueAngle: 0,
      power: 0.35,
      spinX: 0,
      spinY: 0,
      calledBall: null,
      calledPocket: null,
      shotToken: `tok_cchal_${Date.now()}`,
    });
    await roomAlpha.waitFor((m) => m.type === 'match:settled', 14000, 'alpha match:settled');

    wsAlpha.clearQueue();
    roomBravo.send({ type: 'game:forfeit' });
    await roomAlpha.waitFor((m) => m.type === 'match:over', 8000, 'alpha match:over');

    const chalAfterMatchPush = await wsAlpha.waitFor<
      Extract<ServerToClientMessage, { type: 'club:challenge_updated' }>
    >(
      (m) =>
        m.type === 'club:challenge_updated' &&
        m.challenge.challengeId === challengeId &&
        m.challenge.status === 'completed',
      8000,
      'club:challenge_updated completed',
    );
    assert.equal(chalAfterMatchPush.challenge.winnerClubId, apexClubId);
    assert.equal(chalAfterMatchPush.challenge.challengerScore, 1);
    assert.equal(chalAfterMatchPush.challenge.targetScore, 0);
    assert.equal(chalAfterMatchPush.challenge.linkedMatchIds.length, 1);

    // Check global, weekly, seasonal Club Leaderboards!
    for (const scope of ['global', 'weekly', 'seasonal'] as const) {
      const lb = await apiJson<{ ok: boolean; scope: string; entries: ClubLeaderboardEntry[] }>(
        baseHttp,
        `/api/clubs/leaderboard?scope=${scope}`,
      );
      assert.equal(lb.status, 200);
      assert.equal(lb.body.scope, scope);
      assert(lb.body.entries.length >= 2);
      const apexEntry = lb.body.entries.find((e) => e.clubId === apexClubId);
      assert.ok(apexEntry);
      assert.equal(apexEntry.challengeWins, 1);
    }

    // Recent match history shows up on enriched profile!
    const alphaProfileAfter = await apiJson<{ profile: PublicPlayerProfile }>(
      baseHttp,
      `/api/players/profile/${encodeURIComponent(alpha.playerId)}?viewerId=${encodeURIComponent(alpha.playerId)}`,
      { token: alpha.playerToken },
    );
    assert((alphaProfileAfter.body.profile.recentMatches?.length ?? 0) >= 1);
    console.log('PASS [7] Club challenges, authentic match auto-completion, club leaderboards & profile match history verified');

    // =========================================================================
    // [8] Notifications Center: List, Mark Read (Single & All), Dismiss & Clear
    // =========================================================================
    const bravoNotifs = await apiJson<{
      ok: boolean;
      notifications: SocialNotificationRecord[];
      unreadCount: number;
    }>(
      baseHttp,
      `/api/social/notifications?playerId=${encodeURIComponent(bravo.playerId)}`,
      { token: bravo.playerToken },
    );
    assert.equal(bravoNotifs.status, 200);
    assert(bravoNotifs.body.notifications.length >= 2);
    assert(bravoNotifs.body.unreadCount >= 2);

    const firstId = bravoNotifs.body.notifications[0].notificationId;
    const markOne = await apiJson<{
      ok: boolean;
      notifications: SocialNotificationRecord[];
      unreadCount: number;
    }>(baseHttp, '/api/social/notifications/read', {
      method: 'POST',
      token: bravo.playerToken,
      body: JSON.stringify({ playerId: bravo.playerId, notificationId: firstId }),
    });
    assert.equal(markOne.status, 200);
    assert.ok(markOne.body.notifications.find((n) => n.notificationId === firstId)?.readAtMs);

    const markAll = await apiJson<{
      ok: boolean;
      notifications: SocialNotificationRecord[];
      unreadCount: number;
    }>(baseHttp, '/api/social/notifications/read', {
      method: 'POST',
      token: bravo.playerToken,
      body: JSON.stringify({ playerId: bravo.playerId }),
    });
    assert.equal(markAll.status, 200);
    assert.equal(markAll.body.unreadCount, 0);

    const clearOne = await apiJson<{
      ok: boolean;
      notifications: SocialNotificationRecord[];
      unreadCount: number;
    }>(baseHttp, '/api/social/notifications/clear', {
      method: 'POST',
      token: bravo.playerToken,
      body: JSON.stringify({ playerId: bravo.playerId, notificationId: firstId }),
    });
    assert.equal(clearOne.status, 200);
    assert.equal(
      clearOne.body.notifications.some((n) => n.notificationId === firstId),
      false,
    );

    const clearAll = await apiJson<{
      ok: boolean;
      notifications: SocialNotificationRecord[];
      unreadCount: number;
    }>(baseHttp, '/api/social/notifications/clear', {
      method: 'POST',
      token: bravo.playerToken,
      body: JSON.stringify({ playerId: bravo.playerId }),
    });
    assert.equal(clearAll.status, 200);
    assert.equal(clearAll.body.notifications.length, 0);
    assert.equal(clearAll.body.unreadCount, 0);
    console.log('PASS [8] Notifications center (list, read one/all, clear one/all) verified');

    console.log('\nPhase 15 Social Network, Clubs, Privacy & Notifications: ALL 8 SUITES PASSED.');
  } catch (err) {
    console.error('\n--- Wrangler Phase 15 Logs ---\n', logs.slice(-4000));
    throw err;
  } finally {
    await Promise.all(socketsToClose.map((s) => s.close().catch(() => {})));
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
