import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type {
  ClientToServerMessage,
  ServerToClientMessage,
} from '../src/multiplayer/shared/protocol';

const PORT = 8788;
const STATE_DIR = '/tmp/cf-wrangler-test-state';
const BASE_HTTP = `http://127.0.0.1:${PORT}`;
const BASE_WS = `ws://127.0.0.1:${PORT}/ws`;

class CfWsClient {
  public ws!: WebSocket;
  public queue: ServerToClientMessage[] = [];
  public sessionId = '';
  public reconnectToken = '';

  private waiters: Array<{
    predicate: (msg: ServerToClientMessage) => boolean;
    resolve: (msg: ServerToClientMessage) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(private readonly url: string, private readonly origin?: string) {}

  public async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(
        this.url,
        this.origin ? { headers: { Origin: this.origin } } : undefined,
      );
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
        reject(new Error(`Timed out waiting for ${label} (${timeoutMs}ms); queued=[${queuedTypes}]`));
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
      6000,
      'session:ready',
    );
    this.sessionId = ready.sessionId;
    this.reconnectToken = ready.reconnectToken;
  }

  public async resumeInRoom(
    roomId: string,
    sessionId: string,
    reconnectToken: string,
    displayName?: string,
  ): Promise<Extract<ServerToClientMessage, { type: 'session:ready' }>> {
    await this.close();
    const roomUrl = `${BASE_WS}?roomId=${encodeURIComponent(roomId)}`;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(
        roomUrl,
        this.origin ? { headers: { Origin: this.origin } } : undefined,
      );
      this.ws = ws;
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString('utf8')) as ServerToClientMessage;
        this.dispatch(msg);
      });
    });
    this.sessionId = sessionId;
    this.reconnectToken = reconnectToken;
    this.send({
      type: 'session:resume',
      sessionId,
      reconnectToken,
      displayName,
    });
    return this.waitFor<Extract<ServerToClientMessage, { type: 'session:ready' }>>(
      (m) => m.type === 'session:ready',
      6000,
      'room session:ready',
    );
  }

  public async close(): Promise<void> {
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

async function waitForWranglerReady(): Promise<void> {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_HTTP}/health`);
      if (res.ok) return;
    } catch {
      // Retry until ready
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('wrangler dev did not become ready within 25s');
}

async function run(): Promise<void> {
  rmSync(STATE_DIR, { recursive: true, force: true });
  const wranglerBin = join(process.cwd(), 'node_modules', '.bin', 'wrangler');
  const wrangler = spawn(
    wranglerBin,
    [
      'dev',
      '--config',
      'cloudflare/wrangler.jsonc',
      '--port',
      String(PORT),
      '--ip',
      '127.0.0.1',
      '--var',
      'CORS_ORIGIN:https://test-user.github.io',
      'RECONNECT_GRACE_MS:2500',
      '--persist-to',
      STATE_DIR,
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
    await waitForWranglerReady();

    // 1. Health, CORS, and WebSocket upgrade enforcement
    const healthRes = await fetch(`${BASE_HTTP}/health`, {
      headers: { Origin: 'https://test-user.github.io' },
    });
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.headers.get('access-control-allow-origin'), 'https://test-user.github.io');
    const healthJson = (await healthRes.json()) as { ok: boolean; runtime: string };
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.runtime, 'cloudflare-workers');

    const badOriginRes = await fetch(`${BASE_HTTP}/health`, {
      headers: { Origin: 'https://evil.example.com' },
    });
    assert.equal(badOriginRes.status, 403);

    const nonUpgradeWs = await fetch(`${BASE_HTTP}/ws`);
    assert.equal(nonUpgradeWs.status, 426);

    await new Promise<void>((resolve, reject) => {
      const badWs = new WebSocket(BASE_WS, { headers: { Origin: 'https://evil.example.com' } });
      badWs.once('open', () => {
        badWs.close();
        reject(new Error('Disallowed WS origin should be rejected'));
      });
      badWs.once('error', () => resolve());
    });
    console.log('PASS [1] Health, CORS origin validation, and WS upgrade security');

    // 2. Two clients create & join private room, start match, and sync a real Rapier3D shot
    const c1 = new CfWsClient(BASE_WS, 'https://test-user.github.io');
    const c2 = new CfWsClient(BASE_WS, 'https://test-user.github.io');
    await c1.connect();
    await c2.connect();
    await c1.initSession('CF_Host');
    await c2.initSession('CF_Guest');

    // Invalid JSON & unauthorized room action checks
    c1.ws.send('{bad-json');
    const errMalformed = await c1.waitFor<Extract<ServerToClientMessage, { type: 'error' }>>(
      (m) => m.type === 'error' && m.code === 'INVALID_INPUT',
      4000,
      'INVALID_INPUT',
    );
    assert.equal(errMalformed.code, 'INVALID_INPUT');

    c1.send({
      type: 'room:create',
      isPrivate: true,
      ruleProfileId: 'casual',
      calledShotsEnabled: false,
    });
    const created = await c1.waitFor<Extract<ServerToClientMessage, { type: 'room:created' }>>(
      (m) => m.type === 'room:created',
      5000,
      'room:created',
    );
    const roomId = created.room.roomId;
    const roomCode = created.room.roomCode;

    // Move c1 to room DO WebSocket
    const r1Ready = await c1.resumeInRoom(roomId, c1.sessionId, c1.reconnectToken, 'CF_Host');
    assert.equal(r1Ready.resumedRoom?.roomId, roomId);

    // c2 joins by code on lobby socket, then moves to room DO WebSocket
    c2.send({ type: 'room:join', roomCode });
    const joined = await c2.waitFor<Extract<ServerToClientMessage, { type: 'room:updated' }>>(
      (m) => m.type === 'room:updated' && m.room.players.length === 2,
      5000,
      'guest room:updated',
    );
    assert.equal(joined.room.roomId, roomId);

    const r2Ready = await c2.resumeInRoom(roomId, c2.sessionId, c2.reconnectToken, 'CF_Guest');
    assert.equal(r2Ready.resumedRoom?.players.length, 2);

    // Ready + Start match
    c1.clearQueue();
    c2.clearQueue();
    c2.send({ type: 'room:ready', ready: true });
    await c1.waitFor((m) => m.type === 'room:updated' && m.room.status === 'ready', 5000, 'room ready');

    c1.send({ type: 'room:start' });
    const started1 = await c1.waitFor<Extract<ServerToClientMessage, { type: 'match:started' }>>(
      (m) => m.type === 'match:started',
      8000,
      'match:started p1',
    );
    const started2 = await c2.waitFor<Extract<ServerToClientMessage, { type: 'match:started' }>>(
      (m) => m.type === 'match:started',
      8000,
      'match:started p2',
    );
    assert.equal(started1.balls.length, 16);
    assert.equal(started2.balls.length, 16);
    console.log(`PASS [2] Private room creation, join (${roomCode}), and match start synced 16/16 balls`);

    // 3. Turn validation, duplicate shot protection, and Rapier3D physics simulation in DO
    c2.send({
      type: 'game:shoot',
      shotToken: 'out-of-turn-tok',
      cueAngle: 0,
      power: 0.5,
      spinX: 0,
      spinY: 0,
      calledBall: null,
      calledPocket: null,
    });
    const outOfTurn = await c2.waitFor<Extract<ServerToClientMessage, { type: 'error' }>>(
      (m) => m.type === 'error' && m.code === 'OUT_OF_TURN',
      4000,
      'OUT_OF_TURN',
    );
    assert.equal(outOfTurn.code, 'OUT_OF_TURN');

    c1.clearQueue();
    c2.clearQueue();
    c1.send({
      type: 'game:shoot',
      shotToken: 'cf-break-shot-001',
      cueAngle: 0,
      power: 0.85,
      spinX: 0,
      spinY: 0.01,
      calledBall: null,
      calledPocket: null,
    });

    const shotStart1 = await c1.waitFor<Extract<ServerToClientMessage, { type: 'match:shot_started' }>>(
      (m) => m.type === 'match:shot_started',
      5000,
      'shot_started p1',
    );
    const shotStart2 = await c2.waitFor<Extract<ServerToClientMessage, { type: 'match:shot_started' }>>(
      (m) => m.type === 'match:shot_started',
      5000,
      'shot_started p2',
    );
    assert.equal(shotStart1.shotSeq, 1);
    assert.equal(shotStart2.shotSeq, 1);

    const frame2 = await c2.waitFor<Extract<ServerToClientMessage, { type: 'physics:frame' }>>(
      (m) => m.type === 'physics:frame',
      5000,
      'physics:frame p2',
    );
    assert.equal(frame2.balls.length, 16);

    const settled1 = await c1.waitFor<Extract<ServerToClientMessage, { type: 'match:settled' }>>(
      (m) => m.type === 'match:settled',
      20000,
      'match:settled p1',
    );
    const settled2 = await c2.waitFor<Extract<ServerToClientMessage, { type: 'match:settled' }>>(
      (m) => m.type === 'match:settled',
      20000,
      'match:settled p2',
    );
    assert.equal(settled1.match.totalMatchShots, 1);
    assert.equal(settled2.match.totalMatchShots, 1);

    // Duplicate shot token rejection
    c1.send({
      type: 'game:shoot',
      shotToken: 'cf-break-shot-001',
      cueAngle: 0,
      power: 0.3,
      spinX: 0,
      spinY: 0,
      calledBall: null,
      calledPocket: null,
    });
    const dupErr = await c1.waitFor<Extract<ServerToClientMessage, { type: 'error' }>>(
      (m) => m.type === 'error' && (m.code === 'DUPLICATE_SHOT' || m.code === 'OUT_OF_TURN'),
      4000,
      'DUPLICATE_SHOT',
    );
    assert.equal(dupErr.code, 'DUPLICATE_SHOT');
    console.log('PASS [3] Authoritative Rapier3D shot simulation, physics streaming, and duplicate/turn checks');

    // 4. Unauthorized spoof resume & real disconnect/reconnect recovery
    const rogue = new CfWsClient(`${BASE_WS}?roomId=${encodeURIComponent(roomId)}`);
    await rogue.connect();
    rogue.send({
      type: 'session:resume',
      sessionId: c2.sessionId,
      reconnectToken: 'wrong-token-123456',
    });
    const unauthErr = await rogue.waitFor<Extract<ServerToClientMessage, { type: 'error' }>>(
      (m) => m.type === 'error' && m.code === 'UNAUTHORIZED',
      4000,
      'UNAUTHORIZED',
    );
    assert.equal(unauthErr.code, 'UNAUTHORIZED');
    await rogue.close();

    c1.clearQueue();
    await c2.close();
    const discNotice = await c1.waitFor<Extract<ServerToClientMessage, { type: 'opponent:disconnected' }>>(
      (m) => m.type === 'opponent:disconnected',
      5000,
      'opponent:disconnected',
    );
    assert.equal(discNotice.sessionId, c2.sessionId);

    const resumed = await c2.resumeInRoom(roomId, c2.sessionId, c2.reconnectToken, 'CF_Guest');
    assert.equal(resumed.resumedMatch?.totalMatchShots, 1);
    assert.equal(resumed.balls?.length, 16);

    const reconNotice = await c1.waitFor<Extract<ServerToClientMessage, { type: 'opponent:reconnected' }>>(
      (m) => m.type === 'opponent:reconnected',
      5000,
      'opponent:reconnected',
    );
    assert.equal(reconNotice.sessionId, c2.sessionId);
    console.log('PASS [4] Unauthorized resume rejected; disconnect & SQLite reconnect recovery verified');

    // Heartbeat auto-response & JSON ping check
    c1.send({ type: 'ping', clientTimeMs: Date.now(), latencyMs: 22 });
    const pongMsg = await c1.waitFor<Extract<ServerToClientMessage, { type: 'pong' }>>(
      (m) => m.type === 'pong',
      4000,
      'pong',
    );
    assert(typeof pongMsg.serverTimeMs === 'number');

    // 5. Forfeit, Rematch, & match history persistence in Matchmaker DO SQLite
    c2.send({ type: 'game:forfeit' });
    const over1 = await c1.waitFor<Extract<ServerToClientMessage, { type: 'match:over' }>>(
      (m) => m.type === 'match:over',
      5000,
      'match:over',
    );
    assert.equal(over1.match.winner, 'player1');

    // Rematch flow in PoolRoom DO
    c1.clearQueue();
    c2.clearQueue();
    c1.send({ type: 'room:rematch' });
    c2.send({ type: 'room:rematch' });
    const rematch1 = await c1.waitFor<Extract<ServerToClientMessage, { type: 'match:rematch_started' }>>(
      (m) => m.type === 'match:rematch_started',
      5000,
      'match:rematch_started p1',
    );
    assert.equal(rematch1.match.phase, 'BREAK');
    assert.equal(rematch1.balls.length, 16);

    // Give waitUntil a brief moment to record history
    await new Promise((r) => setTimeout(r, 250));
    const histRes = await fetch(`${BASE_HTTP}/api/online/history`);
    assert.equal(histRes.status, 200);
    const histJson = (await histRes.json()) as { history: Array<{ matchId: string }> };
    assert(histJson.history.some((h) => h.matchId === over1.match.matchId), 'Matchmaker SQLite should record match history');

    await c1.close();
    await c2.close();
    console.log('PASS [5] Heartbeat, forfeit, rematch & SQLite match history persistence verified');

    // 6. Quick Matchmaking & DO Alarm disconnect grace forfeit
    const q1 = new CfWsClient(BASE_WS, 'https://test-user.github.io');
    const q2 = new CfWsClient(BASE_WS, 'https://test-user.github.io');
    await q1.connect();
    await q2.connect();
    await q1.initSession('QueueAlpha', 30);
    await q2.initSession('QueueBeta', 40);

    q1.send({ type: 'matchmaking:join', ruleProfileId: 'casual', calledShotsEnabled: false });
    await q1.waitFor((m) => m.type === 'matchmaking:searching', 4000, 'matchmaking:searching');

    q2.send({ type: 'matchmaking:join', ruleProfileId: 'casual', calledShotsEnabled: false });
    const matched1 = await q1.waitFor<Extract<ServerToClientMessage, { type: 'matchmaking:matched' }>>(
      (m) => m.type === 'matchmaking:matched',
      5000,
      'matched q1',
    );
    const matched2 = await q2.waitFor<Extract<ServerToClientMessage, { type: 'matchmaking:matched' }>>(
      (m) => m.type === 'matchmaking:matched',
      5000,
      'matched q2',
    );
    assert.equal(matched1.room.roomId, matched2.room.roomId);

    const q1RoomReady = await q1.resumeInRoom(matched1.room.roomId, q1.sessionId, q1.reconnectToken);
    const q2RoomReady = await q2.resumeInRoom(matched2.room.roomId, q2.sessionId, q2.reconnectToken);
    assert.equal(q1RoomReady.resumedMatch?.phase, 'BREAK');
    assert.equal(q2RoomReady.resumedMatch?.phase, 'BREAK');

    // Disconnect q2 and verify DO Alarm forfeits q2 after RECONNECT_GRACE_MS (2500ms)
    q1.clearQueue();
    await q2.close();
    await q1.waitFor(
      (m) => m.type === 'opponent:disconnected',
      4000,
      'q1 opponent:disconnected',
    );
    const alarmForfeit = await q1.waitFor<Extract<ServerToClientMessage, { type: 'match:over' }>>(
      (m) => m.type === 'match:over',
      8000,
      'DO alarm disconnect grace match:over',
    );
    assert.equal(alarmForfeit.match.winner, 'player1');

    await q1.close();
    console.log('PASS [6] Quick Matchmaking & Durable Object Alarm grace forfeit verified');

    console.log('\nCloudflare Worker + SQLite Durable Objects verification: ALL 6 SUITES PASSED.');
  } catch (err) {
    console.error('\n--- Wrangler Logs ---\n', logs);
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
    rmSync(STATE_DIR, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
