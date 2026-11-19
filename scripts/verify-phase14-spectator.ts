import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { WebSocket } from 'ws';
import { CameraController } from '../src/game/camera/CameraController';
import { ShotRecorder } from '../src/game/replay/ShotRecorder';
import type {
  ClientToServerMessage,
  OnlineBallFrame,
  ServerToClientMessage,
  SpectatableMatchSummary,
  SpectatorCameraMode,
} from '../src/multiplayer/shared/protocol';
import { canLocalPlayerAct, useGameStore } from '../src/store/useGameStore';

const CF_PORT = 8794;
const CF_STATE_DIR = '/tmp/cf-phase14-spectator-state';
const ORIGIN = 'https://test-user.github.io';
const ADMIN_SECRET = 'phase14-admin-secret';

class SpecWsClient {
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
    timeoutMs = 9000,
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
  throw new Error('Timed out waiting for wrangler dev (Phase 14 Spectator test)');
}

async function apiJson<T>(
  baseHttp: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; data: T }> {
  const res = await fetch(`${baseHttp}${path}`, {
    ...init,
    headers: {
      Origin: ORIGIN,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const data = (await res.json()) as T;
  return { status: res.status, data };
}

async function createPlayerIdentity(baseHttp: string, displayName: string) {
  const res = await apiJson<{
    ok: boolean;
    profile: { playerId: string; displayName: string };
    playerToken: string;
  }>(baseHttp, '/api/players/session', {
    method: 'POST',
    body: JSON.stringify({ displayName, forceNewGuest: true }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
  return {
    playerId: res.data.profile.playerId,
    playerToken: res.data.playerToken,
    displayName: res.data.profile.displayName,
  };
}

async function connectPlayerToRoom(
  baseWs: string,
  roomId: string,
  lobbyClient: SpecWsClient,
): Promise<{
  roomClient: SpecWsClient;
  snapshot: NonNullable<Extract<ServerToClientMessage, { type: 'session:ready' }>['resumedMatch']>;
  balls: NonNullable<Extract<ServerToClientMessage, { type: 'session:ready' }>['balls']>;
}> {
  const roomClient = new SpecWsClient(baseWs, ORIGIN);
  await roomClient.connect(`${baseWs}?roomId=${encodeURIComponent(roomId)}`);
  roomClient.send({
    type: 'session:resume',
    sessionId: lobbyClient.sessionId,
    reconnectToken: lobbyClient.reconnectToken,
    playerId: lobbyClient.playerId,
    playerToken: lobbyClient.playerToken,
  });
  const ready = await roomClient.waitFor<Extract<ServerToClientMessage, { type: 'session:ready' }>>(
    (m) => m.type === 'session:ready',
    6000,
    'player room session:ready',
  );
  assert.equal(ready.isSpectator ?? false, false);
  assert.ok(ready.resumedMatch, 'session:ready should carry resumedMatch');
  assert.ok(ready.balls && ready.balls.length >= 16, 'session:ready should carry balls');

  return {
    roomClient,
    snapshot: ready.resumedMatch,
    balls: ready.balls,
  };
}

async function runTests() {
  rmSync(CF_STATE_DIR, { recursive: true, force: true });

  const wranglerBin = join(process.cwd(), 'node_modules', '.bin', 'wrangler');
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
      `TOURNAMENT_ADMIN_SECRET:${ADMIN_SECRET}`,
      '--var',
      'MAX_SPECTATORS_PER_ROOM:2',
      '--var',
      'SPECTATOR_RECONNECT_LIMIT:3',
      '--var',
      'SPECTATOR_RECONNECT_GRACE_MS:2500',
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
  wrangler.stdout?.on('data', (chunk) => {
    logs += chunk.toString('utf8');
  });
  wrangler.stderr?.on('data', (chunk) => {
    logs += chunk.toString('utf8');
  });

  const baseHttp = `http://127.0.0.1:${CF_PORT}`;
  const baseWs = `ws://127.0.0.1:${CF_PORT}/ws`;
  const results: Array<{ id: number; name: string; passed: boolean; detail: string }> = [];

  const test = async (id: number, name: string, fn: () => Promise<string> | string) => {
    try {
      const detail = await fn();
      results.push({ id, name, passed: true, detail });
      console.log(`PASS [${id}] ${name}: ${detail}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ id, name, passed: false, detail: msg });
      console.error(`FAIL [${id}] ${name}: ${msg}`);
    }
  };

  try {
    await waitForWrangler(baseHttp);

    const p1 = await createPlayerIdentity(baseHttp, 'SpecAlpha');
    const p2 = await createPlayerIdentity(baseHttp, 'SpecBravo');
    const specUser1 = await createPlayerIdentity(baseHttp, 'SpecViewerOne');
    const specUser2 = await createPlayerIdentity(baseHttp, 'SpecViewerTwo');
    const specUser3 = await createPlayerIdentity(baseHttp, 'SpecViewerThree');

    const lobbyA = new SpecWsClient(baseWs, ORIGIN);
    const lobbyB = new SpecWsClient(baseWs, ORIGIN);
    await lobbyA.connect();
    await lobbyB.connect();
    await lobbyA.initSession('SpecAlpha', p1);
    await lobbyB.initSession('SpecBravo', p2);

    let quickRoomId = '';
    let quickRoomClientA!: SpecWsClient;
    let quickRoomClientB!: SpecWsClient;
    let quickHostClient!: SpecWsClient;
    let quickClientByRole!: Record<'player1' | 'player2', SpecWsClient>;
    let specRoomClient!: SpecWsClient;

    // 1. Public match discovery + live physics/turn synchronization for spectator
    await test(1, 'Public match discovery + live physics & state sync for spectator', async () => {
      lobbyA.send({
        type: 'matchmaking:join',
        mode: 'quick',
        ruleProfileId: 'casual',
        calledShotsEnabled: false,
        region: 'GLOBAL',
      });
      lobbyB.send({
        type: 'matchmaking:join',
        mode: 'quick',
        ruleProfileId: 'casual',
        calledShotsEnabled: false,
        region: 'GLOBAL',
      });

      const matchedA = await lobbyA.waitFor<Extract<ServerToClientMessage, { type: 'matchmaking:matched' }>>(
        (m) => m.type === 'matchmaking:matched',
        10000,
        'lobbyA matchmaking:matched',
      );
      await lobbyB.waitFor<Extract<ServerToClientMessage, { type: 'matchmaking:matched' }>>(
        (m) => m.type === 'matchmaking:matched',
        10000,
        'lobbyB matchmaking:matched',
      );
      quickRoomId = matchedA.room.roomId;

      const connA = await connectPlayerToRoom(baseWs, quickRoomId, lobbyA);
      const connB = await connectPlayerToRoom(baseWs, quickRoomId, lobbyB);
      quickRoomClientA = connA.roomClient;
      quickRoomClientB = connB.roomClient;

      const roleA =
        matchedA.room.players.find((p) => p.sessionId === lobbyA.sessionId)?.role ?? 'player1';
      const roleB = roleA === 'player1' ? 'player2' : 'player1';
      quickClientByRole = {
        [roleA]: quickRoomClientA,
        [roleB]: quickRoomClientB,
      } as Record<'player1' | 'player2', SpecWsClient>;
      quickHostClient =
        matchedA.room.hostSessionId === lobbyA.sessionId ? quickRoomClientA : quickRoomClientB;

      // Verify GET /api/spectate/matches lists the quick match
      const listRes = await apiJson<{ ok: boolean; matches: SpectatableMatchSummary[] }>(
        baseHttp,
        '/api/spectate/matches?matchType=quick',
      );
      assert.equal(listRes.status, 200);
      const listed = listRes.data.matches.find((m) => m.roomId === quickRoomId);
      assert.ok(listed, 'Public quick match should appear in /api/spectate/matches');
      assert.equal(listed.spectatorCount, 0);
      assert.equal(listed.players.length, 2);

      // Join via POST /api/spectate/join
      const joinRes = await apiJson<{
        ok: boolean;
        spectatorSessionId: string;
        spectatorReconnectToken: string;
        room: { roomId: string; spectatorCount: number; players: Array<{ playerId?: string }> };
      }>(baseHttp, '/api/spectate/join', {
        method: 'POST',
        body: JSON.stringify({
          roomId: quickRoomId,
          playerId: specUser1.playerId,
          playerToken: specUser1.playerToken,
          displayName: 'SpecViewerOne',
        }),
      });
      assert.equal(joinRes.status, 200);
      assert.equal(joinRes.data.ok, true);
      assert.equal(joinRes.data.room.players.length, 2);
      assert.ok(
        !joinRes.data.room.players.some((p) => p.playerId === specUser1.playerId),
        'Spectator must never occupy a player slot',
      );

      // Connect spectator WebSocket using spectator session/token
      specRoomClient = new SpecWsClient(baseWs, ORIGIN);
      await specRoomClient.connect(`${baseWs}?roomId=${encodeURIComponent(quickRoomId)}`);
      specRoomClient.send({
        type: 'session:resume',
        sessionId: joinRes.data.spectatorSessionId,
        reconnectToken: joinRes.data.spectatorReconnectToken,
        playerId: specUser1.playerId,
        playerToken: specUser1.playerToken,
      });

      const specReady = await specRoomClient.waitFor<Extract<ServerToClientMessage, { type: 'session:ready' }>>(
        (m) => m.type === 'session:ready',
        6000,
        'spectator session:ready',
      );
      assert.equal(specReady.isSpectator, true);
      assert.ok(specReady.resumedMatch, 'spectator session:ready should carry resumedMatch');
      assert.ok(specReady.balls && specReady.balls.length >= 16, 'spectator session:ready should carry balls');
      assert.equal(specReady.resumedMatch.roomId, quickRoomId);

      // Active player executes break shot -> spectator observes live physics & settle
      const shooterClient = quickClientByRole[specReady.resumedMatch.activePlayer];
      shooterClient.send({
        type: 'game:shoot',
        cueAngle: 0,
        power: 0.72,
        spinX: 0,
        spinY: 0,
        calledBall: null,
        calledPocket: null,
        shotToken: `tok_spec_${Date.now()}`,
      });

      const shotStarted = await specRoomClient.waitFor<
        Extract<ServerToClientMessage, { type: 'match:shot_started' }>
      >((m) => m.type === 'match:shot_started', 6000, 'spectator match:shot_started');
      const frame = await specRoomClient.waitFor<
        Extract<ServerToClientMessage, { type: 'physics:frame' }>
      >((m) => m.type === 'physics:frame', 6000, 'spectator physics:frame');
      const settled = await specRoomClient.waitFor<
        Extract<ServerToClientMessage, { type: 'match:settled' }>
      >((m) => m.type === 'match:settled', 14000, 'spectator match:settled');

      assert.equal(shotStarted.roomId, quickRoomId);
      assert.ok(shotStarted.shotSeq >= 1);
      assert.ok(frame.balls.length >= 16);
      assert.ok(settled.match.totalMatchShots >= 1);

      return `Spectator synced room=${quickRoomId}, shotSeq=${shotStarted.shotSeq}, settled total=${settled.match.totalMatchShots}`;
    });

    // 2. Strict read-only security enforcement for spectators
    await test(2, 'Spectator gameplay & mutation actions are rejected without disturbing match', async () => {
      specRoomClient.clearQueue();
      const forbidden: ClientToServerMessage[] = [
        { type: 'game:aim', cueAngle: 0.5 },
        { type: 'game:spin', x: 0.2, y: 0.1 },
        {
          type: 'game:shoot',
          cueAngle: 0,
          power: 0.5,
          spinX: 0,
          spinY: 0,
          calledBall: null,
          calledPocket: null,
          shotToken: 'spec_illegal_shot',
        },
        { type: 'game:place_cue', x: -0.5, z: 0, confirm: true },
        { type: 'game:called_shot', targetBall: 1, targetPocket: 'corner-tr' },
        { type: 'game:forfeit' },
        { type: 'room:ready', ready: true },
        { type: 'room:start' },
        { type: 'room:set_spectators', allowSpectators: false },
        { type: 'session:update_profile', displayName: 'Hacker', avatarId: 'cue_gold' },
      ];

      for (const msg of forbidden) {
        specRoomClient.send(msg);
        const err = await specRoomClient.waitFor<Extract<ServerToClientMessage, { type: 'error' }>>(
          (m) => m.type === 'error',
          4000,
          `UNAUTHORIZED error for ${msg.type}`,
        );
        assert.equal(err.code, 'UNAUTHORIZED', `Expected UNAUTHORIZED for ${msg.type}, got ${err.code}`);
      }

      return `All ${forbidden.length} forbidden spectator mutations returned UNAUTHORIZED cleanly`;
    });

    // 3. Separated chat channels + Host disable spectator chat
    await test(3, 'Match vs Spectator chat separation & host allowSpectatorChat toggle', async () => {
      specRoomClient.clearQueue();
      quickHostClient.clearQueue();

      quickClientByRole.player1.send({
        type: 'chat:room_send',
        body: 'Good break!',
        clientMessageId: `m_${Date.now()}`,
      });
      const matchChatOnSpec = await specRoomClient.waitFor<
        Extract<ServerToClientMessage, { type: 'chat:room_message' }>
      >((m) => m.type === 'chat:room_message' && m.message.body === 'Good break!', 6000);
      assert.equal(matchChatOnSpec.message.channel, 'match');
      assert.equal(matchChatOnSpec.message.senderRole, 'player1');

      specRoomClient.send({
        type: 'chat:room_send',
        body: 'Great table spread!',
        clientMessageId: `s_${Date.now()}`,
      });
      const specChatOnPlayer = await quickHostClient.waitFor<
        Extract<ServerToClientMessage, { type: 'chat:room_message' }>
      >((m) => m.type === 'chat:room_message' && m.message.body === 'Great table spread!', 6000);
      assert.equal(specChatOnPlayer.message.channel, 'spectator');
      assert.equal(specChatOnPlayer.message.senderRole, 'spectator');

      // Host disables spectator chat
      quickHostClient.send({
        type: 'room:set_spectators',
        allowSpectators: true,
        allowSpectatorChat: false,
      });
      await specRoomClient.waitFor<Extract<ServerToClientMessage, { type: 'room:updated' }>>(
        (m) => m.type === 'room:updated' && m.room.allowSpectatorChat === false,
        6000,
        'allowSpectatorChat=false broadcast',
      );

      specRoomClient.send({
        type: 'chat:room_send',
        body: 'Should fail now',
        clientMessageId: `s2_${Date.now()}`,
      });
      const disabledErr = await specRoomClient.waitFor<
        Extract<ServerToClientMessage, { type: 'error' }>
      >((m) => m.type === 'error', 5000, 'SPECTATOR_CHAT_DISABLED');
      assert.equal(disabledErr.code, 'SPECTATOR_CHAT_DISABLED');

      return 'Match & spectator channels isolated; allowSpectatorChat toggle enforced server-side';
    });

    await specRoomClient?.close();
    await quickRoomClientA?.close();
    await quickRoomClientB?.close();

    // 4. Private room privacy, share tokens, capacity limit, reconnect cap, eviction, and block check
    await test(4, 'Private room privacy, share token, spectator cap, reconnects, eviction & block list', async () => {
      const host = new SpecWsClient(baseWs, ORIGIN);
      const guest = new SpecWsClient(baseWs, ORIGIN);
      await host.connect();
      await guest.connect();
      const hostId = await createPlayerIdentity(baseHttp, 'PrivHost');
      const guestId = await createPlayerIdentity(baseHttp, 'PrivGuest');
      await host.initSession('PrivHost', hostId);
      await guest.initSession('PrivGuest', guestId);

      host.send({
        type: 'room:create',
        isPrivate: true,
        ruleProfileId: 'casual',
        calledShotsEnabled: false,
      });
      const created = await host.waitFor<Extract<ServerToClientMessage, { type: 'room:created' }>>(
        (m) => m.type === 'room:created',
      );
      const privRoomId = created.room.roomId;
      const privCode = created.room.roomCode;
      assert.equal(created.room.allowSpectators, false);

      guest.send({ type: 'room:join', roomCode: privCode });
      await guest.waitFor(
        (m) => m.type === 'room:updated' && m.room.players.length === 2,
        6000,
        'guest room:updated 2/2 players',
      );

      // Private room with allowSpectators=false must reject spectate and stay hidden from discovery
      const listBefore = await apiJson<{ ok: boolean; matches: SpectatableMatchSummary[] }>(
        baseHttp,
        '/api/spectate/matches',
      );
      assert.ok(!listBefore.data.matches.some((m) => m.roomId === privRoomId));

      const deniedJoin = await apiJson<{ error: string }>(baseHttp, '/api/spectate/join', {
        method: 'POST',
        body: JSON.stringify({
          roomCode: privCode,
          playerId: specUser1.playerId,
          playerToken: specUser1.playerToken,
          displayName: 'SpecViewerOne',
        }),
      });
      assert.equal(deniedJoin.status, 403);
      assert.equal(deniedJoin.data.error, 'SPECTATE_UNAVAILABLE');

      // Connect host & guest to room and start match
      const hRoom = new SpecWsClient(baseWs, ORIGIN);
      const gRoom = new SpecWsClient(baseWs, ORIGIN);
      await hRoom.connect(`${baseWs}?roomId=${encodeURIComponent(privRoomId)}`);
      await gRoom.connect(`${baseWs}?roomId=${encodeURIComponent(privRoomId)}`);
      hRoom.send({
        type: 'session:resume',
        sessionId: host.sessionId,
        reconnectToken: host.reconnectToken,
        playerId: host.playerId,
        playerToken: host.playerToken,
      });
      gRoom.send({
        type: 'session:resume',
        sessionId: guest.sessionId,
        reconnectToken: guest.reconnectToken,
        playerId: guest.playerId,
        playerToken: guest.playerToken,
      });
      await hRoom.waitFor((m) => m.type === 'session:ready');
      await gRoom.waitFor((m) => m.type === 'session:ready');
      gRoom.send({ type: 'room:ready', ready: true });
      await hRoom.waitFor(
        (m) => m.type === 'room:updated' && m.room.players.every((p) => p.ready),
        6000,
        'private room guest ready',
      );
      hRoom.send({ type: 'room:start' });
      await hRoom.waitFor((m) => m.type === 'match:started' || m.type === 'match:state_sync');
      await gRoom.waitFor((m) => m.type === 'match:started' || m.type === 'match:state_sync');

      // Host enables spectators -> receives spectatorShareToken (guest must NOT receive shareToken)
      hRoom.send({ type: 'room:set_spectators', allowSpectators: true, allowSpectatorChat: true });
      const hostUpdated = await hRoom.waitFor<Extract<ServerToClientMessage, { type: 'room:updated' }>>(
        (m) => m.type === 'room:updated' && m.room.allowSpectators === true,
      );
      const guestUpdated = await gRoom.waitFor<Extract<ServerToClientMessage, { type: 'room:updated' }>>(
        (m) => m.type === 'room:updated' && m.room.allowSpectators === true,
      );
      const shareToken = hostUpdated.room.spectatorShareToken;
      assert.ok(shareToken && shareToken.length > 4);
      assert.equal(guestUpdated.room.spectatorShareToken, undefined);

      // Joining private room via wrong share token fails
      const badTokenJoin = await apiJson<{ error: string }>(baseHttp, '/api/spectate/join', {
        method: 'POST',
        body: JSON.stringify({
          roomId: privRoomId,
          shareToken: 'wrong_token',
          playerId: specUser1.playerId,
          playerToken: specUser1.playerToken,
        }),
      });
      assert.equal(badTokenJoin.status, 403);

      // Two spectators join using share token -> hits MAX_SPECTATORS_PER_ROOM=2
      const s1Join = await apiJson<{
        ok: boolean;
        spectatorSessionId: string;
        spectatorReconnectToken: string;
      }>(baseHttp, '/api/spectate/join', {
        method: 'POST',
        body: JSON.stringify({
          roomId: privRoomId,
          shareToken,
          playerId: specUser1.playerId,
          playerToken: specUser1.playerToken,
          displayName: 'SpecViewerOne',
        }),
      });
      assert.equal(s1Join.status, 200);

      const s2Join = await apiJson<{
        ok: boolean;
        spectatorSessionId: string;
        spectatorReconnectToken: string;
      }>(baseHttp, '/api/spectate/join', {
        method: 'POST',
        body: JSON.stringify({
          roomCode: privCode,
          playerId: specUser2.playerId,
          playerToken: specUser2.playerToken,
          displayName: 'SpecViewerTwo',
        }),
      });
      assert.equal(s2Join.status, 200);

      // 3rd spectator exceeds MAX_SPECTATORS_PER_ROOM=2 -> ROOM_FULL
      const s3Join = await apiJson<{ error: string }>(baseHttp, '/api/spectate/join', {
        method: 'POST',
        body: JSON.stringify({
          roomId: privRoomId,
          shareToken,
          playerId: specUser3.playerId,
          playerToken: specUser3.playerToken,
          displayName: 'SpecViewerThree',
        }),
      });
      assert.equal(s3Join.status, 409);
      assert.equal(s3Join.data.error, 'ROOM_FULL');

      // Reconnect test up to SPECTATOR_RECONNECT_LIMIT=3 on SpecViewerOne
      for (let attempt = 1; attempt <= 3; attempt++) {
        const sc = new SpecWsClient(baseWs, ORIGIN);
        await sc.connect(`${baseWs}?roomId=${encodeURIComponent(privRoomId)}`);
        sc.send({
          type: 'session:resume',
          sessionId: s1Join.data.spectatorSessionId,
          reconnectToken: s1Join.data.spectatorReconnectToken,
          playerId: specUser1.playerId,
          playerToken: specUser1.playerToken,
        });
        await sc.waitFor((m) => m.type === 'session:ready');
        await sc.close();
      }
      // 4th attempt hits SPECTATOR_RECONNECT_LIMIT=3 (count starts at 0, increments on 2nd/3rd... check error on overflow)
      const overflowClient = new SpecWsClient(baseWs, ORIGIN);
      await overflowClient.connect(`${baseWs}?roomId=${encodeURIComponent(privRoomId)}`);
      overflowClient.send({
        type: 'session:resume',
        sessionId: s1Join.data.spectatorSessionId,
        reconnectToken: s1Join.data.spectatorReconnectToken,
        playerId: specUser1.playerId,
        playerToken: specUser1.playerToken,
      });
      const overflowMsg = await overflowClient.waitFor(
        (m) => m.type === 'session:ready' || m.type === 'error',
      );
      if (overflowMsg.type === 'session:ready') {
        // One more reconnect guarantees overflow beyond limit=3
        await overflowClient.close();
        const over2 = new SpecWsClient(baseWs, ORIGIN);
        await over2.connect(`${baseWs}?roomId=${encodeURIComponent(privRoomId)}`);
        over2.send({
          type: 'session:resume',
          sessionId: s1Join.data.spectatorSessionId,
          reconnectToken: s1Join.data.spectatorReconnectToken,
          playerId: specUser1.playerId,
          playerToken: specUser1.playerToken,
        });
        const err2 = await over2.waitFor<Extract<ServerToClientMessage, { type: 'error' }>>(
          (m) => m.type === 'error',
        );
        assert.equal(err2.code, 'RATE_LIMITED');
        await over2.close();
      } else {
        assert.equal(overflowMsg.type, 'error');
        await overflowClient.close();
      }

      // Connect SpecViewerTwo and verify host disabling spectators evicts them
      const s2Ws = new SpecWsClient(baseWs, ORIGIN);
      await s2Ws.connect(`${baseWs}?roomId=${encodeURIComponent(privRoomId)}`);
      s2Ws.send({
        type: 'session:resume',
        sessionId: s2Join.data.spectatorSessionId,
        reconnectToken: s2Join.data.spectatorReconnectToken,
        playerId: specUser2.playerId,
        playerToken: specUser2.playerToken,
      });
      await s2Ws.waitFor((m) => m.type === 'session:ready');

      hRoom.send({ type: 'room:set_spectators', allowSpectators: false });
      const evicted = await s2Ws.waitFor<Extract<ServerToClientMessage, { type: 'room:closed' }>>(
        (m) => m.type === 'room:closed',
        6000,
        'spectator eviction room:closed',
      );
      assert.ok(evicted.reason.toLowerCase().includes('disabled'));
      await s2Ws.close();

      // Block check: host blocks specUser3 -> enabling spectators still blocks specUser3
      const blockRes = await apiJson<{ ok: boolean }>(baseHttp, '/api/social/block', {
        method: 'POST',
        body: JSON.stringify({
          playerId: hostId.playerId,
          playerToken: hostId.playerToken,
          targetPlayerId: specUser3.playerId,
        }),
      });
      assert.equal(blockRes.status, 200);

      hRoom.send({ type: 'room:set_spectators', allowSpectators: true });
      await hRoom.waitFor((m) => m.type === 'room:updated' && m.room.allowSpectators === true);

      const blockedJoin = await apiJson<{ error: string }>(baseHttp, '/api/spectate/join', {
        method: 'POST',
        body: JSON.stringify({
          roomCode: privCode,
          playerId: specUser3.playerId,
          playerToken: specUser3.playerToken,
          displayName: 'SpecViewerThree',
        }),
      });
      assert.equal(blockedJoin.status, 403);
      assert.equal(blockedJoin.data.error, 'BLOCKED_PLAYER');

      await hRoom.close();
      await gRoom.close();
      await host.close();
      await guest.close();
      return 'Private privacy, token check, cap (2), reconnect limit, host eviction, and block rejection verified';
    });

    // 5. Tournament live match spectating
    await test(5, 'Tournament live match discovery & spectate flow', async () => {
      const tp1 = await createPlayerIdentity(baseHttp, 'TourneyOne');
      const tp2 = await createPlayerIdentity(baseHttp, 'TourneyTwo');
      const tourneySpec = await createPlayerIdentity(baseHttp, 'TourneyWatcher');

      const createT = await apiJson<{
        ok: boolean;
        tournament: { tournamentId: string; title: string };
      }>(baseHttp, '/api/admin/tournaments', {
        method: 'POST',
        headers: { 'X-Admin-Key': ADMIN_SECRET },
        body: JSON.stringify({
          title: 'Phase 14 Live Open',
          type: 'daily',
          ruleProfileId: 'casual',
          maxPlayers: 4,
          entryFeeCoins: 0,
          checkInWindowMs: 120000,
          matchTimeoutMs: 600000,
        }),
      });
      assert.equal(createT.status, 200);
      const tournamentId = createT.data.tournament.tournamentId;

      for (const tp of [tp1, tp2]) {
        const reg = await apiJson<{ ok: boolean }>(
          baseHttp,
          `/api/tournaments/${encodeURIComponent(tournamentId)}/register`,
          {
            method: 'POST',
            body: JSON.stringify({ playerId: tp.playerId, playerToken: tp.playerToken }),
          },
        );
        assert.equal(reg.status, 200);
      }

      const startT = await apiJson<{ ok: boolean }>(
        baseHttp,
        `/api/admin/tournaments/${encodeURIComponent(tournamentId)}/start`,
        {
          method: 'POST',
          headers: { 'X-Admin-Key': ADMIN_SECRET },
        },
      );
      assert.equal(startT.status, 200);

      const detail = await apiJson<{
        ok: boolean;
        matches: Array<{
          bracketMatchId: string;
          roundLabel: string;
          status: string;
          player1Id: string | null;
          player2Id: string | null;
        }>;
      }>(baseHttp, `/api/tournaments/${encodeURIComponent(tournamentId)}`);
      assert.equal(detail.status, 200);
      const tMatch = detail.data.matches.find((m) => m.player1Id && m.player2Id);
      assert.ok(tMatch, 'Bracket match must exist');

      const tLobby1 = new SpecWsClient(baseWs, ORIGIN);
      const tLobby2 = new SpecWsClient(baseWs, ORIGIN);
      await tLobby1.connect();
      await tLobby2.connect();
      await tLobby1.initSession('TourneyOne', tp1);
      await tLobby2.initSession('TourneyTwo', tp2);

      const j1 = await apiJson<{ ok: boolean; room?: { roomId: string } }>(
        baseHttp,
        `/api/tournaments/${encodeURIComponent(tournamentId)}/matches/${encodeURIComponent(tMatch.bracketMatchId)}/join`,
        {
          method: 'POST',
          body: JSON.stringify({
            playerId: tp1.playerId,
            playerToken: tp1.playerToken,
            sessionId: tLobby1.sessionId,
          }),
        },
      );
      assert.equal(j1.status, 200);

      const j2 = await apiJson<{ ok: boolean; room?: { roomId: string } }>(
        baseHttp,
        `/api/tournaments/${encodeURIComponent(tournamentId)}/matches/${encodeURIComponent(tMatch.bracketMatchId)}/join`,
        {
          method: 'POST',
          body: JSON.stringify({
            playerId: tp2.playerId,
            playerToken: tp2.playerToken,
            sessionId: tLobby2.sessionId,
          }),
        },
      );
      assert.equal(j2.status, 200);
      const tourneyRoomId = j2.data.room?.roomId ?? j1.data.room?.roomId;
      assert.ok(tourneyRoomId, 'Tournament room should be created once both players join');

      // Connect both tournament competitors to the room & ready up so match status transitions to in_progress
      const tRoom1 = new SpecWsClient(baseWs, ORIGIN);
      const tRoom2 = new SpecWsClient(baseWs, ORIGIN);
      await tRoom1.connect(`${baseWs}?roomId=${encodeURIComponent(tourneyRoomId)}`);
      await tRoom2.connect(`${baseWs}?roomId=${encodeURIComponent(tourneyRoomId)}`);
      tRoom1.send({
        type: 'session:resume',
        sessionId: tLobby1.sessionId,
        reconnectToken: tLobby1.reconnectToken,
        playerId: tLobby1.playerId,
        playerToken: tLobby1.playerToken,
      });
      tRoom2.send({
        type: 'session:resume',
        sessionId: tLobby2.sessionId,
        reconnectToken: tLobby2.reconnectToken,
        playerId: tLobby2.playerId,
        playerToken: tLobby2.playerToken,
      });
      await tRoom1.waitFor((m) => m.type === 'session:ready');
      await tRoom2.waitFor((m) => m.type === 'session:ready');
      tRoom1.send({ type: 'room:ready', ready: true });
      tRoom2.send({ type: 'room:ready', ready: true });
      await tRoom1.waitFor((m) => m.type === 'match:started', 8000, 'tournament tRoom1 match:started');
      await tRoom2.waitFor((m) => m.type === 'match:started', 8000, 'tournament tRoom2 match:started');

      const tList = await apiJson<{ ok: boolean; matches: SpectatableMatchSummary[] }>(
        baseHttp,
        '/api/spectate/matches?matchType=tournament',
      );
      assert.equal(tList.status, 200);
      const foundT = tList.data.matches.find((m) => m.roomId === tourneyRoomId);
      assert.ok(foundT, 'Tournament match must be listed in spectatable matches');
      assert.equal(foundT.tournament?.tournamentId, tournamentId);

      const tSpecJoin = await apiJson<{
        ok: boolean;
        spectatorSessionId: string;
        spectatorReconnectToken: string;
        room: { tournament?: { tournamentId: string } | null };
      }>(baseHttp, '/api/spectate/join', {
        method: 'POST',
        body: JSON.stringify({
          roomId: tourneyRoomId,
          playerId: tourneySpec.playerId,
          playerToken: tourneySpec.playerToken,
          displayName: 'TourneyWatcher',
        }),
      });
      assert.equal(tSpecJoin.status, 200);
      assert.equal(tSpecJoin.data.room.tournament?.tournamentId, tournamentId);

      const tSpecWs = new SpecWsClient(baseWs, ORIGIN);
      await tSpecWs.connect(`${baseWs}?roomId=${encodeURIComponent(tourneyRoomId)}`);
      tSpecWs.send({
        type: 'session:resume',
        sessionId: tSpecJoin.data.spectatorSessionId,
        reconnectToken: tSpecJoin.data.spectatorReconnectToken,
        playerId: tourneySpec.playerId,
        playerToken: tourneySpec.playerToken,
      });
      const ready = await tSpecWs.waitFor<Extract<ServerToClientMessage, { type: 'session:ready' }>>(
        (m) => m.type === 'session:ready',
      );
      assert.equal(ready.isSpectator, true);
      assert.ok(ready.resumedMatch, 'tournament spectator should receive resumedMatch');
      assert.ok(ready.balls && ready.balls.length >= 16);

      await tSpecWs.close();
      await tRoom1.close();
      await tRoom2.close();
      await tLobby1.close();
      await tLobby2.close();
      assert.ok(foundT.tournament?.tournamentTitle);
      return `Tournament match ${tourneyRoomId} (${foundT.tournament?.tournamentTitle}) spectated live`;
    });

    await lobbyA.close();
    await lobbyB.close();

    // 6. Client Unit Tests (useGameStore, ShotRecorder, CameraController)
    await test(6, 'Client unit checks: useGameStore spectator lock, ShotRecorder mid-match join, CameraController 6 modes', async () => {
      // 6a: useGameStore lock & controls
      useGameStore.getState().clearOnlineMatchSession();
      useGameStore.getState().setOnlineSpectating(true, 'spec_unit_1');
      assert.equal(useGameStore.getState().onlineSpectating, true);
      assert.equal(useGameStore.getState().spectatorSessionId, 'spec_unit_1');
      assert.equal(canLocalPlayerAct(useGameStore.getState()), false);

      useGameStore.getState().adjustSpectatorZoom(2.0);
      assert.equal(useGameStore.getState().spectatorZoomOffset, 0.75);
      useGameStore.getState().adjustSpectatorZoom(-5.0);
      assert.equal(useGameStore.getState().spectatorZoomOffset, -0.45);
      useGameStore.getState().resetSpectatorZoom();
      assert.equal(useGameStore.getState().spectatorZoomOffset, 0);

      useGameStore.getState().toggleMuteSpectatorChatUser('plr_bad');
      assert.deepEqual(useGameStore.getState().spectatorMutedPlayerIds, ['plr_bad']);
      useGameStore.getState().toggleMuteSpectatorChatUser('plr_bad');
      assert.deepEqual(useGameStore.getState().spectatorMutedPlayerIds, []);

      useGameStore.getState().clearOnlineMatchSession();
      assert.equal(useGameStore.getState().onlineSpectating, false);
      assert.equal(useGameStore.getState().spectatorSessionId, null);

      // 6b: ShotRecorder mid-match spectator recording
      const recorder = new ShotRecorder();
      recorder.beginMatch({
        matchId: 'match_spec_unit',
        createdAtMs: Date.now(),
        matchType: 'online',
        onlineSubType: 'ranked',
        gameMode: 'eightBall',
        ruleProfileId: 'casual',
        calledShotsEnabled: false,
        authoritative: true,
        player1Name: 'Alpha',
        player2Name: 'Bravo',
      });
      recorder.beginShot({
        shotNumber: 5,
        mode: 'online',
        shooter: 'player1',
        shooterName: 'Alpha',
        isBreakShot: false,
        cueAngle: 0.25,
        power: 0.6,
        spin: { x: 0, y: 0 },
        calledShot: { targetBall: null, targetPocket: null },
      });

      const mkFrame = (dx: number): OnlineBallFrame[] =>
        Array.from({ length: 16 }, (_, idx) => ({
          number: idx,
          x: idx === 0 ? -0.4 + dx : 0.2 + idx * 0.04,
          y: 0.0285,
          z: 0,
          qx: 0,
          qy: 0,
          qz: 0,
          qw: 1,
          vx: idx === 0 ? 1.2 : 0,
          vy: 0,
          vz: 0,
          pocketed: false,
        }));

      recorder.pushOnlineSample(mkFrame(0));
      await new Promise((r) => setTimeout(r, 40));
      recorder.pushOnlineSample(mkFrame(0.08));
      await new Promise((r) => setTimeout(r, 40));
      recorder.pushOnlineSample(mkFrame(0.16));

      const recorded = recorder.finalizeShot({
        resultLabel: 'Legal Shot',
        isFoul: false,
        foulReason: null,
        finalOnlineBalls: mkFrame(0.22),
      });
      assert.ok(recorded, 'ShotRecorder should produce a valid shot when spectating mid-match');
      const replay = recorder.buildMatchReplayRecord({
        winner: 'player1',
        loser: 'player2',
        finalResult: 'Alpha won by legal 8-Ball pocket',
        playerGroups: { player1: 'solids', player2: 'stripes' },
        pocketedNumbers: [1, 2, 8],
        authoritative: true,
      });
      assert.ok(replay && replay.authoritative && replay.shots.length === 1);

      // 6c: CameraController 6 spectator modes + save/restore
      const mockElement = {
        style: {},
        clientWidth: 1280,
        clientHeight: 720,
        ownerDocument: {
          addEventListener: () => {},
          removeEventListener: () => {},
        },
        addEventListener: () => {},
        removeEventListener: () => {},
        setPointerCapture: () => {},
        releasePointerCapture: () => {},
      } as unknown as HTMLElement;
      const camCtrl = new CameraController(mockElement, 16 / 9, true);
      camCtrl.saveBeforeSpectate();

      const modes: SpectatorCameraMode[] = [
        'overview',
        'topDown',
        'ballFollow',
        'activeShot',
        'cinematic',
        'free',
      ];
      for (const mode of modes) {
        camCtrl.updateSpectatorCamera(
          mode,
          {
            cueBallPos: new THREE.Vector3(-0.3, 0.0285, 0.1),
            focusBallPos: new THREE.Vector3(0.4, 0.0285, -0.1),
            cueAngle: 0.4,
            elapsedSec: 1.5,
            zoomOffset: 0.15,
          },
          0.016,
        );
        assert.ok(
          Number.isFinite(camCtrl.camera.position.x) &&
            Number.isFinite(camCtrl.camera.position.y) &&
            Number.isFinite(camCtrl.camera.position.z),
          `Spectator camera position must be finite for mode=${mode}`,
        );
      }
      camCtrl.restoreAfterSpectate();
      camCtrl.dispose();

      return 'Store spectator lock, ShotRecorder mid-match replay record, and all 6 CameraController modes verified';
    });
  } finally {
    try {
      if (wrangler.pid) {
        process.kill(-wrangler.pid, 'SIGTERM');
      }
    } catch {
      // ignore if exited
    }
    rmSync(CF_STATE_DIR, { recursive: true, force: true });
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  console.log(`\nPhase 14 Spectator Summary: ${passed}/${results.length} passed, ${failed} failed.`);
  if (failed > 0) {
    console.error('Wrangler tail logs:\n', logs.slice(-2000));
    process.exitCode = 1;
  }
}

void runTests();
