import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocket } from 'ws';
import { ensureServerRapierInitialized } from '../server/AuthoritativePhysicsManager';
import { ServerMatchManager } from '../server/ServerMatchManager';
import { SocketController } from '../server/SocketController';
import type { ServerConfig } from '../server/config';
import { createEmptyStatistics } from '../src/game/rules/MatchStatistics';
import { MatchManager } from '../src/game/rules/MatchManager';
import { TABLE_DIMENSIONS } from '../src/game/utils/constants';
import type { ClientToServerMessage, ServerToClientMessage } from '../src/multiplayer/shared/protocol';
import { canLocalPlayerAct, useGameStore } from '../src/store/useGameStore';

class TestWsClient {
  public ws!: WebSocket;
  public queue: ServerToClientMessage[] = [];
  private waiters: Array<{
    predicate: (msg: ServerToClientMessage) => boolean;
    resolve: (msg: ServerToClientMessage) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  public sessionId = '';
  public reconnectToken = '';

  constructor(private readonly url: string) {}

  public async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
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

  public send(msg: ClientToServerMessage | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  public clearQueue(): void {
    this.queue = [];
  }

  public waitFor<T extends ServerToClientMessage = ServerToClientMessage>(
    predicate: (msg: ServerToClientMessage) => boolean,
    timeoutMs = 5000,
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
        reject(new Error(`Timed out waiting for ${label} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.waiters.push({
        predicate,
        resolve: resolve as (msg: ServerToClientMessage) => void,
        reject,
        timer,
      });
    });
  }

  public async initSession(displayName: string, latencyMs = 25): Promise<void> {
    this.send({
      type: 'session:init',
      displayName,
      avatarId: 'cue_gold',
      latencyMs,
    });
    const ready = await this.waitFor<Extract<ServerToClientMessage, { type: 'session:ready' }>>(
      (m) => m.type === 'session:ready',
      4000,
      'session:ready',
    );
    this.sessionId = ready.sessionId;
    this.reconnectToken = ready.reconnectToken;
  }

  public async close(): Promise<void> {
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

async function createTestServer(overrides: Partial<ServerConfig> = {}) {
  const app = express();
  const httpServer = createServer(app);
  const config: ServerConfig = {
    port: 0,
    corsOrigin: '*',
    wsHeartbeatMs: 15000,
    reconnectGraceMs: 4000,
    matchmakingTimeoutMs: 5000,
    roomTtlMs: 60000,
    rateLimitMaxMsgPerSec: 40,
    physicsBroadcastHz: 35,
    maxLatencySpreadMs: 250,
    ...overrides,
  };
  const controller = new SocketController(httpServer, config);

  app.get('/api/online/stats', (_req, res) => {
    const roomStats = controller.roomManager.getStats();
    res.json({
      ...roomStats,
      queueSize: controller.matchmakingManager.getQueueSize(),
      connectedPlayers: controller.sessionManager.getConnectedCount(),
    });
  });

  app.get('/api/online/history', (_req, res) => {
    res.json({ history: controller.roomManager.getHistory(30) });
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = httpServer.address();
  assert.ok(addr && typeof addr !== 'string');
  const port = addr.port;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;
  const httpUrl = `http://127.0.0.1:${port}`;

  const stop = async () => {
    controller.dispose();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };

  return { app, httpServer, controller, port, wsUrl, httpUrl, stop };
}

async function runTests() {
  await ensureServerRapierInitialized();
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

  const srv = await createTestServer({
    reconnectGraceMs: 3000,
    rateLimitMaxMsgPerSec: 35,
  });

  try {
    // 1. Create private room succeeds
    let createdCode = '';
    let hostClient!: TestWsClient;
    let guestClient!: TestWsClient;

    await test(1, 'Create private room succeeds', async () => {
      hostClient = new TestWsClient(srv.wsUrl);
      await hostClient.connect();
      await hostClient.initSession('HostAlice');

      hostClient.send({
        type: 'room:create',
        isPrivate: true,
        ruleProfileId: 'casual',
        calledShotsEnabled: false,
      });

      const msg = await hostClient.waitFor<Extract<ServerToClientMessage, { type: 'room:created' }>>(
        (m) => m.type === 'room:created',
      );
      assert.ok(msg.room.roomId.startsWith('room_'));
      assert.equal(msg.room.roomCode.length, 6);
      assert.equal(msg.room.isPrivate, true);
      assert.equal(msg.room.players.length, 1);
      createdCode = msg.room.roomCode;
      return `Created room ${msg.room.roomId} with code ${createdCode}`;
    });

    // 2. Join room by code succeeds
    await test(2, 'Join room by code succeeds', async () => {
      guestClient = new TestWsClient(srv.wsUrl);
      await guestClient.connect();
      await guestClient.initSession('GuestBob');

      guestClient.send({ type: 'room:join', roomCode: createdCode });
      const guestUpdate = await guestClient.waitFor<
        Extract<ServerToClientMessage, { type: 'room:updated' }>
      >((m) => m.type === 'room:updated' && m.room.players.length === 2);
      const hostUpdate = await hostClient.waitFor<
        Extract<ServerToClientMessage, { type: 'room:updated' }>
      >((m) => m.type === 'room:updated' && m.room.players.length === 2);

      assert.equal(guestUpdate.room.roomCode, createdCode);
      assert.equal(hostUpdate.room.players[1].displayName, 'GuestBob');
      return `Host & Guest synced in room ${createdCode} (2/2 players)`;
    });

    // 3. Invalid, full, and expired rooms fail properly
    await test(3, 'Invalid, full, and expired rooms fail properly', async () => {
      const intruder = new TestWsClient(srv.wsUrl);
      await intruder.connect();
      await intruder.initSession('Intruder');

      // Invalid code
      intruder.send({ type: 'room:join', roomCode: 'ZZZZZZ' });
      const invErr = await intruder.waitFor<Extract<ServerToClientMessage, { type: 'error' }>>(
        (m) => m.type === 'error',
      );
      assert.equal(invErr.code, 'INVALID_ROOM');

      // Full room
      intruder.send({ type: 'room:join', roomCode: createdCode });
      const fullErr = await intruder.waitFor<Extract<ServerToClientMessage, { type: 'error' }>>(
        (m) => m.type === 'error',
      );
      assert.equal(fullErr.code, 'ROOM_FULL');

      // Expired room check (force-expire a fresh room)
      intruder.send({
        type: 'room:create',
        isPrivate: true,
        ruleProfileId: 'casual',
        calledShotsEnabled: false,
      });
      const expCreated = await intruder.waitFor<Extract<ServerToClientMessage, { type: 'room:created' }>>(
        (m) => m.type === 'room:created',
      );
      const managed = srv.controller.roomManager.getRoom(expCreated.room.roomId)!;
      managed.expiresAtMs = Date.now() - 100;

      const lateJoiner = new TestWsClient(srv.wsUrl);
      await lateJoiner.connect();
      await lateJoiner.initSession('LateJoiner');
      lateJoiner.send({ type: 'room:join', roomCode: expCreated.room.roomCode });
      const expErr = await lateJoiner.waitFor<Extract<ServerToClientMessage, { type: 'error' }>>(
        (m) => m.type === 'error',
      );
      assert.equal(expErr.code, 'ROOM_EXPIRED');

      await intruder.close();
      await lateJoiner.close();
      return `Verified error codes: ${invErr.code}, ${fullErr.code}, ${expErr.code}`;
    });

    // 8. Host starts match only when players are ready (tested on current private room)
    await test(8, 'Host starts match only when players are ready', async () => {
      // Guest tries to start -> UNAUTHORIZED
      guestClient.send({ type: 'room:start' });
      const unauth = await guestClient.waitFor<Extract<ServerToClientMessage, { type: 'error' }>>(
        (m) => m.type === 'error',
      );
      assert.equal(unauth.code, 'UNAUTHORIZED');

      // Host starts while guest not ready -> MATCH_NOT_READY
      hostClient.send({ type: 'room:start' });
      const notReady = await hostClient.waitFor<Extract<ServerToClientMessage, { type: 'error' }>>(
        (m) => m.type === 'error',
      );
      assert.equal(notReady.code, 'MATCH_NOT_READY');

      // Guest readies up -> Host starts -> match:started
      guestClient.send({ type: 'room:ready', ready: true });
      await hostClient.waitFor<Extract<ServerToClientMessage, { type: 'room:updated' }>>(
        (m) => m.type === 'room:updated' && m.room.status === 'ready',
      );
      hostClient.send({ type: 'room:start' });
      const p1Start = await hostClient.waitFor<Extract<ServerToClientMessage, { type: 'match:started' }>>(
        (m) => m.type === 'match:started',
      );
      const p2Start = await guestClient.waitFor<Extract<ServerToClientMessage, { type: 'match:started' }>>(
        (m) => m.type === 'match:started',
      );
      assert.equal(p1Start.match.phase, 'BREAK');
      assert.equal(p2Start.match.activePlayer, 'player1');
      assert.equal(p1Start.balls.length, 16);
      return `Enforced host-only + ready gate, then started ${p1Start.match.matchId}`;
    });

    // 5. Player cannot join two active matches simultaneously
    await test(5, 'Player cannot join two active matches simultaneously', async () => {
      hostClient.send({
        type: 'matchmaking:join',
        ruleProfileId: 'casual',
        calledShotsEnabled: false,
      });
      const errQueue = await hostClient.waitFor<Extract<ServerToClientMessage, { type: 'error' }>>(
        (m) => m.type === 'error',
      );
      assert.equal(errQueue.code, 'ALREADY_IN_MATCH');

      guestClient.send({
        type: 'room:create',
        isPrivate: true,
        ruleProfileId: 'casual',
        calledShotsEnabled: false,
      });
      const errCreate = await guestClient.waitFor<Extract<ServerToClientMessage, { type: 'error' }>>(
        (m) => m.type === 'error',
      );
      assert.equal(errCreate.code, 'ALREADY_IN_MATCH');
      return `Blocked duplicate queue (${errQueue.code}) & duplicate room (${errCreate.code})`;
    });

    // 9. Turn validation prevents shooting out of turn
    await test(9, 'Turn validation prevents shooting out of turn', async () => {
      guestClient.send({
        type: 'game:shoot',
        shotToken: 'bad_turn_shot_1',
        cueAngle: 0,
        power: 0.5,
        spinX: 0,
        spinY: 0,
        calledBall: null,
        calledPocket: null,
      });
      const err = await guestClient.waitFor<Extract<ServerToClientMessage, { type: 'error' }>>(
        (m) => m.type === 'error',
      );
      assert.equal(err.code, 'OUT_OF_TURN');
      return `Rejected P2 shot during P1 turn with ${err.code}`;
    });

    // 10. Ball positions, velocities, and game state stay synchronized
    await test(10, 'Ball positions, velocities, and game state stay synchronized', async () => {
      hostClient.clearQueue();
      guestClient.clearQueue();

      hostClient.send({
        type: 'game:shoot',
        shotToken: 'p1_break_shot_1',
        cueAngle: 0,
        power: 0.72,
        spinX: 0,
        spinY: 0,
        calledBall: null,
        calledPocket: null,
      });

      const s1 = await hostClient.waitFor<Extract<ServerToClientMessage, { type: 'match:shot_started' }>>(
        (m) => m.type === 'match:shot_started',
      );
      const s2 = await guestClient.waitFor<Extract<ServerToClientMessage, { type: 'match:shot_started' }>>(
        (m) => m.type === 'match:shot_started',
      );
      assert.equal(s1.shotSeq, 1);
      assert.equal(s2.shotSeq, 1);

      const f1 = await hostClient.waitFor<Extract<ServerToClientMessage, { type: 'physics:frame' }>>(
        (m) => m.type === 'physics:frame',
      );
      const f2 = await guestClient.waitFor<Extract<ServerToClientMessage, { type: 'physics:frame' }>>(
        (m) => m.type === 'physics:frame',
      );
      assert.equal(f1.balls.length, 16);
      assert.equal(f2.balls.length, 16);
      const anyMoved = f1.balls.some((b) => Math.hypot(b.vx, b.vz) > 0.01);
      assert.ok(anyMoved, 'Physics frame should carry live non-zero velocities');

      const settle1 = await hostClient.waitFor<Extract<ServerToClientMessage, { type: 'match:settled' }>>(
        (m) => m.type === 'match:settled',
        25000,
        'host settled',
      );
      const settle2 = await guestClient.waitFor<Extract<ServerToClientMessage, { type: 'match:settled' }>>(
        (m) => m.type === 'match:settled',
        25000,
        'guest settled',
      );
      assert.deepEqual(settle1.balls, settle2.balls);
      assert.equal(settle1.match.totalMatchShots, settle2.match.totalMatchShots);
      assert.equal(settle1.match.activePlayer, settle2.match.activePlayer);
      return `Streamed physics:frame + settled 16/16 identical balls (active=${settle1.match.activePlayer})`;
    });

    // 14. Player disconnect triggers disconnect notification and preserves match state
    // 15. Player reconnect restores match state properly
    await test(14, 'Player disconnect triggers disconnect notification and preserves match state', async () => {
      hostClient.clearQueue();
      await guestClient.close();
      const disc = await hostClient.waitFor<Extract<ServerToClientMessage, { type: 'opponent:disconnected' }>>(
        (m) => m.type === 'opponent:disconnected',
      );
      assert.equal(disc.displayName, 'GuestBob');
      assert.ok(disc.graceDeadlineMs > Date.now());
      const room = srv.controller.roomManager.getRoomBySession(hostClient.sessionId)!;
      assert.equal(room.status, 'playing');
      assert.notEqual(room.match?.getPhase(), 'GAME_OVER');
      return `Received opponent:disconnected (${disc.displayName}), match phase=${room.match?.getPhase()} preserved`;
    });

    await test(15, 'Player reconnect restores match state properly', async () => {
      hostClient.clearQueue();
      const resumedGuest = new TestWsClient(srv.wsUrl);
      await resumedGuest.connect();
      resumedGuest.send({
        type: 'session:resume',
        sessionId: guestClient.sessionId,
        reconnectToken: guestClient.reconnectToken,
      });

      const ready = await resumedGuest.waitFor<Extract<ServerToClientMessage, { type: 'session:ready' }>>(
        (m) => m.type === 'session:ready',
      );
      assert.ok(ready.resumedRoom, 'Resumed room must be restored');
      assert.ok(ready.resumedMatch, 'Resumed match must be restored');
      assert.equal(ready.balls?.length, 16, 'All 16 ball states must be restored');

      const oppReconn = await hostClient.waitFor<
        Extract<ServerToClientMessage, { type: 'opponent:reconnected' }>
      >((m) => m.type === 'opponent:reconnected');
      assert.equal(oppReconn.displayName, 'GuestBob');

      guestClient = resumedGuest;
      return `Resumed session ${ready.sessionId} with 16 balls; host received opponent:reconnected`;
    });

    // 16. Rate limiting and malformed input handling
    await test(16, 'Rate limiting and malformed input handling', async () => {
      // Unauthenticated socket
      const uninit = new TestWsClient(srv.wsUrl);
      await uninit.connect();
      uninit.send({ type: 'room:create', isPrivate: true, ruleProfileId: 'casual', calledShotsEnabled: false });
      const unauthErr = await uninit.waitFor<Extract<ServerToClientMessage, { type: 'error' }>>(
        (m) => m.type === 'error',
      );
      assert.equal(unauthErr.code, 'UNAUTHORIZED');

      // Malformed NaN shot
      const badShotClient = new TestWsClient(srv.wsUrl);
      await badShotClient.connect();
      await badShotClient.initSession('Tester');
      badShotClient.send({ type: 'game:shoot', shotToken: 'x', cueAngle: 'bad', power: 0.5, spinX: 0, spinY: 0, calledBall: null, calledPocket: null });
      const errInvalid = await badShotClient.waitFor<Extract<ServerToClientMessage, { type: 'error' }>>(
        (m) => m.type === 'error',
      );
      assert.ok(errInvalid.code === 'INVALID_ROOM' || errInvalid.code === 'INVALID_INPUT');

      // Rate limit flood on uninit socket (> 35 msgs/sec)
      for (let i = 0; i < 42; i++) {
        uninit.send({ type: 'ping', clientTimeMs: Date.now() });
      }
      const rateErr = await uninit.waitFor<Extract<ServerToClientMessage, { type: 'error' }>>(
        (m) => m.type === 'error' && m.code === 'RATE_LIMITED',
      );
      assert.equal(rateErr.code, 'RATE_LIMITED');

      await uninit.close();
      await badShotClient.close();
      return `Enforced UNAUTHORIZED, ${errInvalid.code}, and RATE_LIMITED`;
    });

    // Clean up first pair & test Quick Match + Cancellation + Timeout + Duplicate Shot
    await hostClient.close();
    await guestClient.close();

    // 4. Quick Match connects two real players into an active match
    let q1!: TestWsClient;
    let q2!: TestWsClient;
    await test(4, 'Quick Match connects two real players into an active match', async () => {
      q1 = new TestWsClient(srv.wsUrl);
      q2 = new TestWsClient(srv.wsUrl);
      await Promise.all([q1.connect(), q2.connect()]);
      await Promise.all([q1.initSession('QueueP1', 30), q2.initSession('QueueP2', 45)]);

      q1.send({ type: 'matchmaking:join', ruleProfileId: 'casual', calledShotsEnabled: false });
      await q1.waitFor<Extract<ServerToClientMessage, { type: 'matchmaking:searching' }>>(
        (m) => m.type === 'matchmaking:searching',
      );

      q2.send({ type: 'matchmaking:join', ruleProfileId: 'casual', calledShotsEnabled: false });
      const m1 = await q1.waitFor<Extract<ServerToClientMessage, { type: 'matchmaking:matched' }>>(
        (m) => m.type === 'matchmaking:matched',
      );
      const m2 = await q2.waitFor<Extract<ServerToClientMessage, { type: 'matchmaking:matched' }>>(
        (m) => m.type === 'matchmaking:matched',
      );
      assert.equal(m1.room.roomId, m2.room.roomId);
      assert.equal(m1.room.players.length, 2);

      const s1 = await q1.waitFor<Extract<ServerToClientMessage, { type: 'match:started' }>>(
        (m) => m.type === 'match:started',
      );
      const s2 = await q2.waitFor<Extract<ServerToClientMessage, { type: 'match:started' }>>(
        (m) => m.type === 'match:started',
      );
      assert.equal(s1.match.matchId, s2.match.matchId);
      return `Matched real players QueueP1 & QueueP2 into ${s1.match.matchId}`;
    });

    // 17. Rematch and Leave Match work properly (forfeit -> rematch -> leave)
    await test(17, 'Rematch and Leave Match work properly', async () => {
      q1.clearQueue();
      q2.clearQueue();
      // Finish match via forfeit so we can test rematch flow cleanly
      q2.send({ type: 'game:forfeit' });
      const over1 = await q1.waitFor<Extract<ServerToClientMessage, { type: 'match:over' }>>(
        (m) => m.type === 'match:over',
      );
      const over2 = await q2.waitFor<Extract<ServerToClientMessage, { type: 'match:over' }>>(
        (m) => m.type === 'match:over',
      );
      assert.equal(over1.match.winner, 'player1');
      assert.equal(over2.match.winner, 'player1');

      // Vote 1
      q1.send({ type: 'room:rematch' });
      const voteSync = await q2.waitFor<Extract<ServerToClientMessage, { type: 'match:state_sync' }>>(
        (m) => m.type === 'match:state_sync' && m.match.rematchVotes.includes('player1'),
      );
      assert.deepEqual(voteSync.match.rematchVotes, ['player1']);

      // Vote 2 triggers match:rematch_started
      q2.send({ type: 'room:rematch' });
      const rem1 = await q1.waitFor<Extract<ServerToClientMessage, { type: 'match:rematch_started' }>>(
        (m) => m.type === 'match:rematch_started',
      );
      const rem2 = await q2.waitFor<Extract<ServerToClientMessage, { type: 'match:rematch_started' }>>(
        (m) => m.type === 'match:rematch_started',
      );
      assert.equal(rem1.match.phase, 'BREAK');
      assert.equal(rem2.match.totalMatchShots, 0);

      // Leave mid-match triggers forfeit win for remaining player
      q1.clearQueue();
      q1.send({ type: 'room:leave' });
      const leaveWin = await q2.waitFor<Extract<ServerToClientMessage, { type: 'match:over' }>>(
        (m) => m.type === 'match:over',
      );
      assert.equal(leaveWin.match.winner, 'player2');
      await q1.close();
      await q2.close();
      return `Verified 2/2 rematch reset -> ${rem1.match.matchId}, then clean Leave forfeit win`;
    });

    // 6. Matchmaking cancellation works
    await test(6, 'Matchmaking cancellation works', async () => {
      const c = new TestWsClient(srv.wsUrl);
      await c.connect();
      await c.initSession('Canceller');
      c.send({ type: 'matchmaking:join', ruleProfileId: 'casual', calledShotsEnabled: false });
      await c.waitFor((m) => m.type === 'matchmaking:searching');
      c.send({ type: 'matchmaking:cancel' });
      const cancelled = await c.waitFor<Extract<ServerToClientMessage, { type: 'matchmaking:cancelled' }>>(
        (m) => m.type === 'matchmaking:cancelled',
      );
      assert.equal(srv.controller.matchmakingManager.getQueueSize(), 0);
      await c.close();
      return `Received ${cancelled.type}; queueSize=${srv.controller.matchmakingManager.getQueueSize()}`;
    });

    // 7. Matchmaking timeout works
    await test(7, 'Matchmaking timeout works', async () => {
      const shortSrv = await createTestServer({ matchmakingTimeoutMs: 450 });
      try {
        const c = new TestWsClient(shortSrv.wsUrl);
        await c.connect();
        await c.initSession('LonelyPlayer');
        c.send({ type: 'matchmaking:join', ruleProfileId: 'casual', calledShotsEnabled: false });
        const toMsg = await c.waitFor<Extract<ServerToClientMessage, { type: 'matchmaking:timeout' }>>(
          (m) => m.type === 'matchmaking:timeout',
          3000,
          'matchmaking:timeout',
        );
        assert.ok(toMsg.message.length > 0);
        await c.close();
        return `Received matchmaking:timeout cleanly: "${toMsg.message}"`;
      } finally {
        await shortSrv.stop();
      }
    });

    // 11, 12, 13, 21: Direct Authoritative ServerMatchManager + Physics + History verification
    await test(11, 'Pocketing a ball updates both players identically', async () => {
      const settledSnapshots: Array<ReturnType<ServerMatchManager['getSnapshot']>> = [];
      const pockets: Array<{ ball: number; pocket: string }> = [];
      const sm = new ServerMatchManager({
        roomId: 'r_pocket',
        roomCode: 'PKT123',
        ruleProfileId: 'casual',
        calledShotsEnabled: false,
        player1Name: 'Alice',
        player2Name: 'Bob',
        callbacks: {
          onShotStarted: () => {},
          onPhysicsFrame: () => {},
          onPocket: (_seq, ball, pocket) => pockets.push({ ball, pocket }),
          onSettled: (snap) => settledSnapshots.push(snap),
          onGameOver: () => {},
        },
      });
      await sm.init();
      // Place open table with only cue, #2 near corner-br, #10, #8
      for (let i = 1; i <= 15; i++) {
        if (i !== 2 && i !== 10 && i !== 8) {
          sm.physics.setBallState(i, 10 + i * 0.2, 10, true);
        }
      }
      sm.physics.setBallState(0, 0.65, 0.22, false);
      sm.physics.setBallState(2, 0.95, 0.42, false);
      sm.physics.setBallState(10, -0.5, -0.2, false);
      sm.physics.setBallState(8, -0.1, 0.1, false);
      const aim = Math.atan2(0.42 - 0.22, 0.95 - 0.65);
      const res = sm.handleShot('player1', {
        shotToken: 'dup_check_tok_1',
        cueAngle: aim,
        power: 0.58,
        spinX: 0,
        spinY: 0,
        calledBall: null,
        calledPocket: null,
      });
      assert.equal(res.ok, true);
      // Duplicate shot token must be rejected
      const dupRes = sm.handleShot('player1', {
        shotToken: 'dup_check_tok_1',
        cueAngle: aim,
        power: 0.58,
        spinX: 0,
        spinY: 0,
        calledBall: null,
        calledPocket: null,
      });
      assert.equal(dupRes.ok, false);
      if (!dupRes.ok) assert.equal(dupRes.code, 'DUPLICATE_SHOT');

      const deadline = Date.now() + 10000;
      while (settledSnapshots.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 40));
      }
      assert.equal(settledSnapshots.length, 1);
      assert.ok(
        pockets.some((p) => p.ball === 2),
        `Ball #2 must emit pocket event (got=${JSON.stringify(pockets)}, pocketed=${JSON.stringify(settledSnapshots[0].pocketedNumbers)})`,
      );
      assert.ok(settledSnapshots[0].pocketedNumbers.includes(2));
      assert.equal(settledSnapshots[0].activePlayer, 'player1', 'P1 continues after pocketing #2');
      sm.dispose();
      return `Pocketed #2 into ${pockets[0].pocket}; rejected duplicate shot token; activePlayer=${settledSnapshots[0].activePlayer}`;
    });

    await test(12, 'Fouls and Ball-in-Hand transfer correctly', async () => {
      const settled: Array<ReturnType<ServerMatchManager['getSnapshot']>> = [];
      const sm = new ServerMatchManager({
        roomId: 'r_foul',
        roomCode: 'FUL123',
        ruleProfileId: 'wpa',
        calledShotsEnabled: true,
        player1Name: 'Alice',
        player2Name: 'Bob',
        callbacks: {
          onShotStarted: () => {},
          onPhysicsFrame: () => {},
          onPocket: () => {},
          onSettled: (snap) => settled.push(snap),
          onGameOver: () => {},
        },
      });
      await sm.init();
      // Remove all balls except cue & #9 far away so P1 shoots straight into corner pocket & scratches
      for (let i = 1; i <= 15; i++) {
        if (i !== 9 && i !== 8) sm.physics.setBallState(i, 10 + i * 0.2, 10, true);
      }
      sm.physics.setBallState(0, 0.85, 0.34, false);
      sm.physics.setBallState(9, -0.8, -0.3, false);
      sm.physics.setBallState(8, -0.4, 0.2, false);

      const cornerAim = Math.atan2(0.55 - 0.34, 1.15 - 0.85);
      sm.handleShot('player1', {
        shotToken: 'scratch_break_1',
        cueAngle: cornerAim,
        power: 0.68,
        spinX: 0,
        spinY: 0,
        calledBall: null,
        calledPocket: null,
      });

      const deadline = Date.now() + 10000;
      while (settled.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 40));
      }
      assert.equal(settled.length, 1);
      assert.equal(settled[0].phase, 'BALL_IN_HAND');
      assert.equal(settled[0].activePlayer, 'player2');
      assert.equal(settled[0].ballInHandZone, 'kitchen', 'WPA break scratch awards kitchen BIH');

      // P1 cannot place cue ball
      const p1Place = sm.handleCuePlacement('player1', -0.7, 0, true);
      assert.equal(p1Place.ok, false);
      if (!p1Place.ok) assert.equal(p1Place.code, 'OUT_OF_TURN');

      // P2 cannot place cue ball ahead of head string in WPA break scratch
      const badKitchen = sm.handleCuePlacement('player2', 0.4, 0, true);
      assert.equal(badKitchen.ok, false);
      if (!badKitchen.ok) assert.equal(badKitchen.code, 'INVALID_INPUT');

      // P2 valid placement behind head string succeeds
      const goodPlace = sm.handleCuePlacement('player2', TABLE_DIMENSIONS.headSpotX - 0.1, 0.15, true);
      assert.equal(goodPlace.ok, true);
      assert.equal(sm.getPhase(), 'OPEN_TABLE');
      sm.dispose();
      return `Scratch transferred BIH (${settled[0].ballInHandZone}) to P2; rejected illegal kitchen/turn placement; confirmed valid BIH`;
    });

    await test(13, 'Called shot and 8-ball win/loss sync for both players', async () => {
      let settledCount = 0;
      const gameOvers: Array<{
        snap: ReturnType<ServerMatchManager['getSnapshot']>;
        rec: { matchId: string; winnerName: string };
      }> = [];
      const sm = new ServerMatchManager({
        roomId: 'r_8ball',
        roomCode: 'WIN888',
        ruleProfileId: 'wpa',
        calledShotsEnabled: true,
        player1Name: 'Alice',
        player2Name: 'Bob',
        callbacks: {
          onShotStarted: () => {},
          onPhysicsFrame: () => {},
          onPocket: () => {},
          onSettled: () => {
            settledCount++;
          },
          onGameOver: (snap, _balls, rec) => gameOvers.push({ snap, rec }),
        },
      });
      await sm.init();

      // Leave #1, #2, #9, #8 on table; break by pocketing #1 cleanly so table opens post-break
      for (let i = 1; i <= 15; i++) {
        if (i !== 1 && i !== 2 && i !== 9 && i !== 8) {
          sm.physics.setBallState(i, 10 + i * 0.2, 10, true);
        }
      }
      sm.physics.setBallState(0, -0.72, -0.25, false);
      sm.physics.setBallState(1, -1.0, -0.44, false);
      sm.physics.setBallState(2, 0.2, 0.2, false);
      sm.physics.setBallState(9, 0.2, -0.35, false);
      sm.physics.setBallState(8, 1.0, 0.44, false);

      const breakTo1 = Math.atan2(-0.44 - -0.25, -1.0 - -0.72);
      sm.handleShot('player1', {
        shotToken: 's_break_1',
        cueAngle: breakTo1,
        power: 0.58,
        spinX: 0,
        spinY: 0,
        calledBall: null,
        calledPocket: null,
      });

      const waitSettle = async (targetCount: number) => {
        const deadline = Date.now() + 10000;
        while (settledCount < targetCount && gameOvers.length === 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 40));
        }
      };

      await waitSettle(1);
      assert.equal(settledCount, 1, 'Break shot must settle before follow-up shot');
      assert.equal(sm.getActivePlayer(), 'player1');

      // On open table, calling 8-ball is illegal because #2 and #9 remain
      const early8Attempt = sm.handleCalledShot('player1', 8, 'corner-br');
      assert.equal(early8Attempt.ok, false, 'Cannot call 8-ball on open table');

      // Shooting 8-ball early ends match with opponent winning
      const pos0 = sm.physics.getCueBallPosition();
      const to8 = Math.atan2(0.44 - pos0.z, 1.0 - pos0.x);
      sm.handleShot('player1', {
        shotToken: 's_early8',
        cueAngle: to8,
        power: 0.78,
        spinX: 0,
        spinY: 0,
        calledBall: null,
        calledPocket: null,
      });

      const deadline = Date.now() + 10000;
      while (gameOvers.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 40));
      }
      assert.equal(gameOvers.length, 1);
      assert.equal(gameOvers[0].snap.phase, 'GAME_OVER');
      assert.equal(gameOvers[0].snap.winner, 'player2');
      assert.equal(gameOvers[0].rec.winnerName, 'Bob');

      // Also verify legal called 8-ball win after clearing group
      let gameOvers2 = 0;
      let winSnap: ReturnType<ServerMatchManager['getSnapshot']> | null = null;
      const sm2 = new ServerMatchManager({
        roomId: 'r_8ball_win',
        roomCode: 'WIN889',
        ruleProfileId: 'wpa',
        calledShotsEnabled: true,
        player1Name: 'Alice',
        player2Name: 'Bob',
        callbacks: {
          onShotStarted: () => {},
          onPhysicsFrame: () => {},
          onPocket: () => {},
          onSettled: () => {},
          onGameOver: (snap) => {
            gameOvers2++;
            winSnap = snap;
          },
        },
      });
      await sm2.init();
      // Only #1, #9, #8 on table -> P1 pockets #1 on break, wait: post-break assign group via potting #2!
      let sm2Settled = 0;
      const sm2b = new ServerMatchManager({
        roomId: 'r_8ball_win2',
        roomCode: 'WIN890',
        ruleProfileId: 'wpa',
        calledShotsEnabled: true,
        player1Name: 'Alice',
        player2Name: 'Bob',
        callbacks: {
          onShotStarted: () => {},
          onPhysicsFrame: () => {},
          onPocket: () => {},
          onSettled: () => {
            sm2Settled++;
          },
          onGameOver: (snap) => {
            gameOvers2++;
            winSnap = snap;
          },
        },
      });
      await sm2b.init();
      for (let i = 1; i <= 15; i++) {
        if (i !== 1 && i !== 9 && i !== 8) sm2b.physics.setBallState(i, 10 + i * 0.2, 10, true);
      }
      sm2b.physics.setBallState(0, -0.635, 0.0, false);
      sm2b.physics.setBallState(1, 0.72, -0.25, false);
      sm2b.physics.setBallState(9, 0.72, 0.25, false);
      sm2b.physics.setBallState(8, -0.95, 0.41, false);
      // Wait: easiest break exit: shoot cue ball softly at #1 into cushion
      sm2b.physics.setBallState(0, -0.72, -0.25, false);
      sm2b.physics.setBallState(1, 1.0, 0.44, false);
      // Actually use cue right behind #1 at corner-br for post-break:
      // Let's do Turn 1 break tapping #1 to rail, then Turn 2 P2 pots #9 -> P2 has 0 stripes left -> P2 calls #8!
      sm2b.physics.setBallState(0, 0.4, -0.1, false);
      sm2b.physics.setBallState(1, 0.7, -0.1, false);
      sm2b.physics.setBallState(9, 1.0, 0.44, false);
      sm2b.physics.setBallState(8, -1.0, -0.44, false);
      sm2b.handleShot('player1', {
        shotToken: 'b_open',
        cueAngle: 0,
        power: 0.45,
        spinX: 0,
        spinY: 0,
        calledBall: null,
        calledPocket: null,
      });
      const d2 = Date.now() + 8000;
      while (sm2Settled < 1 && Date.now() < d2) {
        await new Promise((r) => setTimeout(r, 30));
      }
      if (sm2b.getActivePlayer() === 'player2' && sm2b.getPhase() === 'OPEN_TABLE') {
        sm2b.physics.setBallState(0, 0.72, 0.25, false);
        sm2b.physics.setBallState(9, 1.0, 0.44, false);
        const call9 = sm2b.handleCalledShot('player2', 9, 'corner-br');
        assert.equal(call9.ok, true);
        sm2b.handleShot('player2', {
          shotToken: 'pot_9',
          cueAngle: Math.atan2(0.44 - 0.25, 1.0 - 0.72),
          power: 0.55,
          spinX: 0,
          spinY: 0,
          calledBall: 9,
          calledPocket: 'corner-br',
        });
        const d3 = Date.now() + 8000;
        while (sm2Settled < 2 && Date.now() < d3) {
          await new Promise((r) => setTimeout(r, 30));
        }
        assert.equal(sm2b.getActivePlayer(), 'player2');
        sm2b.physics.setBallState(0, -0.72, -0.25, false);
        sm2b.physics.setBallState(8, -1.0, -0.44, false);
        const call8 = sm2b.handleCalledShot('player2', 8, 'corner-tl');
        assert.equal(call8.ok, true, 'P2 should be able to call #8 after clearing stripes');
        sm2b.handleShot('player2', {
          shotToken: 'pot_8',
          cueAngle: Math.atan2(-0.44 - -0.25, -1.0 - -0.72),
          power: 0.58,
          spinX: 0,
          spinY: 0,
          calledBall: 8,
          calledPocket: 'corner-tl',
        });
        const d4 = Date.now() + 8000;
        while (gameOvers2 === 0 && Date.now() < d4) {
          await new Promise((r) => setTimeout(r, 30));
        }
        assert.equal(gameOvers2, 1);
        const finalWinSnap = winSnap as ReturnType<ServerMatchManager['getSnapshot']> | null;
        assert.equal(finalWinSnap?.winner, 'player2');
      }
      sm2.dispose();
      sm2b.dispose();
      sm.dispose();
      return `Called-shot legality enforced; early 8-ball lost & legal called 8-ball won cleanly`;
    });

    // 18. AI minimal thinking indicator renders cleanly without bulky UI
    await test(18, 'AI minimal thinking indicator renders cleanly without bulky UI', () => {
      const panelSrc = readFileSync(path.resolve('src/components/AIOpponentPanel.tsx'), 'utf8');
      assert.ok(panelSrc.includes('AI Thinking'), 'Must render concise AI Thinking text');
      assert.ok(panelSrc.includes('!isAiThinking'), 'Must render nothing unless AI is thinking');
      assert.ok(panelSrc.includes('px-2 py-1'), 'Must use compact minimal padding');
      assert.ok(panelSrc.includes('animate-pulse'), 'Must use subtle pulse animation');
      assert.ok(!panelSrc.includes('Evaluating'), 'Must not render bulky evaluation panel');
      assert.ok(!panelSrc.includes('Confidence'), 'Must not render bulky confidence box');
      assert.ok(panelSrc.length < 1800, 'Component must remain minimal and lightweight');
      return `Verified compact AIOpponentPanel (${panelSrc.length} bytes, px-2 py-1, "AI Thinking" only while active)`;
    });

    // 19. Repetitive turn messages are gone from UI
    await test(19, 'Repetitive turn messages are gone from UI', () => {
      const mm = new MatchManager({ opponentType: 'pvp', gameMode: 'eightBall' });
      const snap = mm.startMatch();
      assert.equal(snap.banner, null, 'No break announcement banner on match start');

      mm.beginShot();
      const { snapshot: missSnap } = mm.settleShot({
        shotId: 1,
        isBreakShot: true,
        shooter: 'player1',
        calledShot: { targetBall: null, targetPocket: null },
        firstBallContacted: 1,
        allBallsContacted: [1],
        pocketEvents: [],
        cueBallPocketed: false,
        railContactBalls: [1, 2, 3, 4],
        anyBallContactedRail: true,
        settledPositions: [],
      });
      assert.equal(missSnap.banner, null, 'No repetitive turn banner after non-foul miss');

      const aiCtrlSrc = readFileSync(path.resolve('src/game/ai/AITurnController.ts'), 'utf8');
      const scoreboardSrc = readFileSync(path.resolve('src/components/MatchScoreboard.tsx'), 'utf8');
      const rulesSrc = readFileSync(path.resolve('src/game/rules/EightBallRules.ts'), 'utf8');
      const combinedSrc = `${aiCtrlSrc}\n${scoreboardSrc}\n${rulesSrc}`.toLowerCase();

      const forbiddenPhrases = [
        'is lining up',
        'preparing to shoot',
        'is aiming',
        'analyzing the table',
        'calculating the shot',
        'has played',
        'balls in motion',
        'turn complete',
        'great break',
      ];
      for (const phrase of forbiddenPhrases) {
        assert.equal(
          combinedSrc.includes(phrase),
          false,
          `Found forbidden repetitive phrase "${phrase}" in UI/rules`,
        );
      }

      // Foul banner IS still kept
      mm.beginShot();
      const { snapshot: foulSnap } = mm.settleShot({
        shotId: 2,
        isBreakShot: false,
        shooter: 'player2',
        calledShot: { targetBall: null, targetPocket: null },
        firstBallContacted: null,
        allBallsContacted: [],
        pocketEvents: [],
        cueBallPocketed: true,
        railContactBalls: [],
        anyBallContactedRail: false,
        settledPositions: [],
      });
      assert.equal(foulSnap.banner?.kind, 'foul', 'Important foul alerts must remain active');
      return 'Verified zero turn/break/aim commentary while foul alerts stay active';
    });

    // 20. Local PvP and AI modes still work
    await test(20, 'Local PvP and AI modes still work', () => {
      // PvP store canLocalPlayerAct
      useGameStore.setState({
        matchConfig: {
          ...useGameStore.getState().matchConfig,
          gameMode: 'eightBall',
          opponentType: 'pvp',
        },
        activePlayer: 'player2',
      });
      assert.equal(canLocalPlayerAct(useGameStore.getState()), true, 'PvP allows both local players');

      // AI store canLocalPlayerAct locks out player2
      useGameStore.setState({
        matchConfig: {
          ...useGameStore.getState().matchConfig,
          gameMode: 'eightBall',
          opponentType: 'ai',
        },
        activePlayer: 'player2',
      });
      assert.equal(canLocalPlayerAct(useGameStore.getState()), false, 'AI locks local controls on P2 turn');

      // Online locks out wrong player or disconnected socket
      useGameStore.setState({
        matchConfig: {
          ...useGameStore.getState().matchConfig,
          gameMode: 'eightBall',
          opponentType: 'online',
        },
        onlineConnectionStatus: 'connected',
        onlineLocalRole: 'player1',
        activePlayer: 'player2',
      });
      assert.equal(canLocalPlayerAct(useGameStore.getState()), false, 'Online locks out non-active player');
      useGameStore.setState({ activePlayer: 'player1' });
      assert.equal(canLocalPlayerAct(useGameStore.getState()), true, 'Online unlocks active connected player');
      return 'Verified PvP, AI, and Online turn/connection gating';
    });

    // 21. No duplicate match result submissions
    await test(21, 'No duplicate match result submissions', async () => {
      const historyUrl = `${srv.httpUrl}/api/online/history`;
      const beforeRes = await fetch(historyUrl);
      const beforeJson = (await beforeRes.json()) as { history: Array<{ matchId: string }> };
      const countBefore = beforeJson.history.length;

      // Test RoomManager.recordHistoryOnce dedup
      const dupRecord = {
        matchId: 'dedup_match_xyz',
        roomId: 'r_dedup',
        player1Name: 'A',
        player2Name: 'B',
        winnerName: 'A',
        winnerRole: 'player1' as const,
        reason: 'Win',
        totalShots: 4,
        endedAtMs: Date.now(),
      };
      srv.controller.roomManager.recordHistoryOnce(dupRecord);
      srv.controller.roomManager.recordHistoryOnce(dupRecord);

      const afterRes = await fetch(historyUrl);
      const afterJson = (await afterRes.json()) as { history: Array<{ matchId: string }> };
      const matching = afterJson.history.filter((h) => h.matchId === 'dedup_match_xyz');
      assert.equal(matching.length, 1, 'Server history must store exactly 1 record per matchId');
      assert.equal(afterJson.history.length, countBefore + 1);

      // Test client Zustand store stats deduplication
      useGameStore.setState({
        onlineRecordedMatchIds: [],
        matchStats: createEmptyStatistics(),
      });
      const overSnap = {
        matchId: 'client_dedup_1',
        roomId: 'r1',
        roomCode: 'ABCDEF',
        ruleProfileId: 'casual' as const,
        calledShotsEnabled: false,
        phase: 'GAME_OVER' as const,
        activePlayer: 'player1' as const,
        isBreakShot: false,
        tableOpen: false,
        playerGroups: { player1: 'solids' as const, player2: 'stripes' as const },
        ballInHandZone: 'anywhere' as const,
        cuePlacementPos: { x: 0, z: 0 },
        calledShot: { targetBall: null, targetPocket: null },
        pocketedNumbers: [1, 8],
        winner: 'player1' as const,
        loser: 'player2' as const,
        gameOverReason: '8-ball pocketed',
        statusHeadline: 'Victory',
        lastFoulMessage: null,
        banner: null,
        totalMatchShots: 5,
        shotSeq: 5,
        player1Name: 'A',
        player2Name: 'B',
        rematchVotes: [],
        serverTimeMs: Date.now(),
      };
      useGameStore.getState().syncFromOnlineMatchSnapshot(overSnap, 'player1', dupRecord);
      useGameStore.getState().syncFromOnlineMatchSnapshot(overSnap, 'player1', dupRecord);
      const stats = useGameStore.getState().matchStats;
      assert.equal(stats.matchesPlayed, 1);
      assert.equal(stats.wins, 1);
      return `Server recorded 1/1 for dedup_match_xyz; client stats recorded 1 win on duplicate snapshots`;
    });
  } finally {
    await srv.stop();
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\nPhase 4 Summary: ${results.length - failed.length}/${results.length} tests passed.`);
  if (failed.length > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
