import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { WebSocket } from 'ws';
import { ensureServerRapierInitialized } from '../server/AuthoritativePhysicsManager';
import { loadServerConfig } from '../server/config';
import { SocketController } from '../server/SocketController';
import {
  generatePlayerId,
  hashPasswordPBKDF2,
  sanitizeAvatarId,
  sanitizeDisplayName,
  sha256Hex,
  validatePassword,
  validateUsername,
  verifyPasswordPBKDF2,
} from '../src/multiplayer/shared/authCrypto';
import {
  ACHIEVEMENTS_CATALOG,
  calculateEloUpdate,
  calculateLevelFromXp,
  computeBaseMatchXp,
  ELO_CONFIG,
  evaluateUnlockedAchievements,
  xpNeededForLevelStep,
} from '../src/multiplayer/shared/progression';
import type {
  ClientToServerMessage,
  ServerToClientMessage,
} from '../src/multiplayer/shared/protocol';

const CF_PORT = 8789;
const CF_STATE_DIR = '/tmp/cf-phase5-d1-test-state';

class TestWsClient {
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

  constructor(private readonly baseWsUrl: string, private readonly origin?: string) {}

  public async connect(urlOverride?: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(
        urlOverride ?? this.baseWsUrl,
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

  public send(msg: ClientToServerMessage): void {
    this.ws.send(JSON.stringify(msg));
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
    identity?: { playerId: string; playerToken: string },
  ): Promise<void> {
    this.send({
      type: 'session:init',
      displayName,
      avatarId: 'cue_gold',
      latencyMs: 25,
      playerId: identity?.playerId,
      playerToken: identity?.playerToken,
    });
    const ready = await this.waitFor<Extract<ServerToClientMessage, { type: 'session:ready' }>>(
      (m) => m.type === 'session:ready',
      6000,
      'session:ready',
    );
    this.sessionId = ready.sessionId;
    this.reconnectToken = ready.reconnectToken;
    this.playerId = ready.playerId ?? '';
    this.playerToken = ready.playerToken ?? '';
  }

  public async resumeInRoom(roomId: string): Promise<void> {
    await this.close();
    const roomUrl = `${this.baseWsUrl}?roomId=${encodeURIComponent(roomId)}`;
    await this.connect(roomUrl);
    this.send({
      type: 'session:resume',
      sessionId: this.sessionId,
      reconnectToken: this.reconnectToken,
      playerId: this.playerId,
      playerToken: this.playerToken,
    });
    await this.waitFor((m) => m.type === 'session:ready', 6000, 'room session:ready');
  }

  public async close(): Promise<void> {
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

async function runSuite1PureMath(): Promise<void> {
  // ELO symmetry & K-factor tiers
  const equal = calculateEloUpdate({
    player1Elo: 1200,
    player2Elo: 1200,
    player1Matches: 0,
    player2Matches: 0,
    winnerRole: 'player1',
  });
  assert.equal(equal.player1Delta, 20);
  assert.equal(equal.player2Delta, -20);
  assert.equal(equal.player1After, 1220);
  assert.equal(equal.player2After, 1180);

  // Master K-factor (>=2000 ELO and >=15 matches)
  const master = calculateEloUpdate({
    player1Elo: 2100,
    player2Elo: 2100,
    player1Matches: 30,
    player2Matches: 30,
    winnerRole: 'player1',
  });
  assert.equal(master.player1Delta, 8);
  assert.equal(master.player2Delta, -8);

  // Minimum ELO floor
  const floor = calculateEloUpdate({
    player1Elo: 1500,
    player2Elo: ELO_CONFIG.minElo,
    player1Matches: 20,
    player2Matches: 20,
    winnerRole: 'player1',
  });
  assert.equal(floor.player2After, ELO_CONFIG.minElo);

  // XP & Levels curve
  assert.equal(xpNeededForLevelStep(1), 120);
  assert.equal(xpNeededForLevelStep(2), 165);
  const lv1 = calculateLevelFromXp(0);
  assert.equal(lv1.level, 1);
  assert.equal(lv1.xpForNextLevel, 120);
  const lv2 = calculateLevelFromXp(120);
  assert.equal(lv2.level, 2);
  assert.equal(lv2.currentLevelXp, 0);
  const lv3 = calculateLevelFromXp(285);
  assert.equal(lv3.level, 3);

  const zeroXp = computeBaseMatchXp({
    won: true,
    shotsTaken: 0,
    successfulShots: 0,
    ballsPocketed: 0,
    fouls: 0,
    breaksAttempted: 0,
    breaksSuccessful: 0,
    legalEightBallWin: false,
    comebackWin: false,
    newWinStreak: 1,
    ruleProfileId: 'casual',
    validCompetitiveMatch: false,
  });
  assert.equal(zeroXp, 0);

  // All 10 achievements evaluation & duplicate guard
  const unlockedAll = evaluateUnlockedAchievements({
    totalMatches: 120,
    wins: 100,
    bestStreak: 7,
    ballsPocketed: 300,
    breaksSuccessful: 15,
    eightBallWins: 50,
    comebackWinInMatch: true,
    alreadyUnlockedIds: new Set<string>(),
  });
  assert.equal(unlockedAll.length, ACHIEVEMENTS_CATALOG.length);

  const unlockedNone = evaluateUnlockedAchievements({
    totalMatches: 120,
    wins: 100,
    bestStreak: 7,
    ballsPocketed: 300,
    breaksSuccessful: 15,
    eightBallWins: 50,
    comebackWinInMatch: true,
    alreadyUnlockedIds: new Set(ACHIEVEMENTS_CATALOG.map((a) => a.id)),
  });
  assert.equal(unlockedNone.length, 0);

  console.log('PASS [1] ELO, XP/Level curve, and all 10 Achievements evaluator verified');
}

async function runSuite2CryptoValidation(): Promise<void> {
  const pid = generatePlayerId();
  assert(pid.startsWith('ply_') && pid.length >= 16);

  const hash = await hashPasswordPBKDF2('PoolMaster2026!');
  assert(await verifyPasswordPBKDF2('PoolMaster2026!', hash));
  assert.equal(await verifyPasswordPBKDF2('WrongPass123!', hash), false);

  const tokenHex = await sha256Hex('secret-token-value');
  assert.equal(tokenHex.length, 64);

  assert.equal(validateUsername('ab').valid, false);
  assert.equal(validateUsername('Champ_01').valid, true);
  assert.equal(validatePassword('12345').valid, false);
  assert.equal(validatePassword('123456').valid, true);
  assert.equal(sanitizeDisplayName('  <Script>Ace  '), 'ScriptAce');
  assert.equal(sanitizeAvatarId('invalid_avatar'), 'cue_gold');
  assert.equal(sanitizeAvatarId('trophy_platinum'), 'trophy_platinum');

  console.log('PASS [2] WebCrypto PBKDF2-SHA256 & input validation/sanitization verified');
}

async function runSuite3LocalServerIntegration(): Promise<void> {
  await ensureServerRapierInitialized();
  const config = { ...loadServerConfig(), reconnectGraceMs: 2500 };

  const app = express();
  app.use(express.json({ limit: '64kb' }));
  const httpServer = createServer(app);
  const controller = new SocketController(httpServer, config);

  const extractBearer = (req: express.Request): string => {
    const auth = req.headers.authorization ?? '';
    if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
    if (req.body && typeof req.body.playerToken === 'string') return req.body.playerToken.trim();
    return '';
  };

  app.post('/api/players/session', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const token = extractBearer(req);
    const result = await controller.progressionStore.authenticateOrCreatePlayer({
      playerId: typeof body.playerId === 'string' ? body.playerId : null,
      playerToken: token || null,
      displayName: typeof body.displayName === 'string' ? body.displayName : null,
      avatarId: typeof body.avatarId === 'string' ? body.avatarId : null,
      forceNewGuest: Boolean(body.forceNewGuest),
    });
    res.json(result);
  });
  app.post('/api/players/profile', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const token = extractBearer(req);
    const result = await controller.progressionStore.updatePlayerProfile(
      String(body.playerId ?? ''),
      token,
      { displayName: body.displayName, avatarId: body.avatarId },
    );
    if (!result.ok) return res.status(result.status).json(result);
    res.json(result);
  });
  app.post('/api/players/register', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const token = extractBearer(req);
    const result = await controller.progressionStore.registerAccount(
      String(body.playerId ?? ''),
      token,
      {
        username: body.username,
        password: body.password,
        displayName: body.displayName,
        avatarId: body.avatarId,
      },
    );
    if (!result.ok) return res.status(result.status).json(result);
    res.json(result);
  });
  app.post('/api/players/login', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await controller.progressionStore.loginAccount({
      username: body.username,
      password: body.password,
    });
    if (!result.ok) return res.status(result.status).json(result);
    res.json(result);
  });
  app.get('/api/players/profile/:playerId', async (req, res) => {
    const profile = await controller.progressionStore.getPublicProfile(req.params.playerId);
    if (!profile) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json({ ok: true, profile });
  });
  app.get('/api/players/search', async (req, res) => {
    const players = await controller.progressionStore.searchPlayers(
      String(req.query.q ?? ''),
      Number(req.query.limit ?? 15),
    );
    res.json({ ok: true, players });
  });
  app.get('/api/leaderboard', async (req, res) => {
    const scope =
      req.query.scope === 'weekly' || req.query.scope === 'monthly' ? req.query.scope : 'global';
    const lb = await controller.progressionStore.getLeaderboard({
      scope,
      page: Number(req.query.page ?? 1),
      limit: Number(req.query.limit ?? 20),
      query: String(req.query.q ?? ''),
      currentPlayerId: typeof req.query.playerId === 'string' ? req.query.playerId : null,
    });
    res.json({ ok: true, ...lb });
  });
  app.get('/api/matches/history', async (req, res) => {
    const matches = await controller.progressionStore.getMatchHistory({
      playerId: typeof req.query.playerId === 'string' ? req.query.playerId : null,
      limit: Number(req.query.limit ?? 30),
    });
    res.json({ ok: true, matches });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const addr = httpServer.address() as { port: number };
  const baseHttp = `http://127.0.0.1:${addr.port}`;
  const baseWs = `ws://127.0.0.1:${addr.port}/ws`;

  try {
    // Guest session creation & impersonation protection
    const s1Res = await fetch(`${baseHttp}/api/players/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'SharkOne', avatarId: 'shark_sky' }),
    });
    const s1 = (await s1Res.json()) as {
      playerId: string;
      playerToken: string;
      profile: { displayName: string; isGuest: boolean; elo: number };
    };
    assert(s1.playerId.startsWith('ply_'));
    assert.equal(s1.profile.displayName, 'SharkOne');
    assert.equal(s1.profile.isGuest, true);
    assert.equal(s1.profile.elo, 1200);

    // Forged token trying to resume s1.playerId gets fresh separate identity instead
    const spoofRes = await fetch(`${baseHttp}/api/players/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer forged_token_1234567890' },
      body: JSON.stringify({ playerId: s1.playerId, displayName: 'Spoofer' }),
    });
    const spoof = (await spoofRes.json()) as { playerId: string };
    assert.notEqual(spoof.playerId, s1.playerId);

    // Unauthorized profile edit rejected (401)
    const badProf = await fetch(`${baseHttp}/api/players/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong_token_00000000' },
      body: JSON.stringify({ playerId: s1.playerId, displayName: 'Hacked' }),
    });
    assert.equal(badProf.status, 401);

    // Valid profile update
    const goodProf = await fetch(`${baseHttp}/api/players/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s1.playerToken}` },
      body: JSON.stringify({
        playerId: s1.playerId,
        displayName: 'SharkPrime',
        avatarId: 'trophy_platinum',
      }),
    });
    assert.equal(goodProf.status, 200);

    // Register account, test duplicate username rejection & login
    const regRes = await fetch(`${baseHttp}/api/players/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s1.playerToken}` },
      body: JSON.stringify({
        playerId: s1.playerId,
        username: 'SharkPrime',
        password: 'PoolPassword99!',
      }),
    });
    assert.equal(regRes.status, 200);
    const regJson = (await regRes.json()) as {
      playerId: string;
      playerToken: string;
      profile: { isGuest: boolean; username: string };
    };
    assert.equal(regJson.profile.isGuest, false);
    assert.equal(regJson.profile.username, 'SharkPrime');
    assert.notEqual(regJson.playerToken, s1.playerToken);

    // Second player attempts duplicate username -> 409
    const s2Res = await fetch(`${baseHttp}/api/players/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'ChallengerB', avatarId: 'crown_emerald' }),
    });
    const s2 = (await s2Res.json()) as { playerId: string; playerToken: string };

    const dupReg = await fetch(`${baseHttp}/api/players/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s2.playerToken}` },
      body: JSON.stringify({
        playerId: s2.playerId,
        username: 'sharkprime',
        password: 'AnotherPassword1!',
      }),
    });
    assert.equal(dupReg.status, 409);

    // Wrong login password -> 401, correct login -> 200
    const badLogin = await fetch(`${baseHttp}/api/players/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'SharkPrime', password: 'WrongPassword' }),
    });
    assert.equal(badLogin.status, 401);

    const okLogin = await fetch(`${baseHttp}/api/players/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'SharkPrime', password: 'PoolPassword99!' }),
    });
    assert.equal(okLogin.status, 200);
    const loggedIn = (await okLogin.json()) as { playerId: string; playerToken: string };
    assert.equal(loggedIn.playerId, s1.playerId);

    // Connect two WS players with persistent identities, play 0-shot abandon -> unranked
    const ws1 = new TestWsClient(baseWs);
    const ws2 = new TestWsClient(baseWs);
    await ws1.connect();
    await ws2.connect();
    await ws1.initSession('SharkPrime', {
      playerId: loggedIn.playerId,
      playerToken: loggedIn.playerToken,
    });
    await ws2.initSession('ChallengerB', {
      playerId: s2.playerId,
      playerToken: s2.playerToken,
    });

    ws1.send({
      type: 'room:create',
      isPrivate: true,
      ruleProfileId: 'casual',
      calledShotsEnabled: false,
    });
    const created1 = await ws1.waitFor<Extract<ServerToClientMessage, { type: 'room:created' }>>(
      (m) => m.type === 'room:created',
    );
    ws2.send({ type: 'room:join', roomCode: created1.room.roomCode });
    await ws2.waitFor((m) => m.type === 'room:updated');
    ws2.send({ type: 'room:ready', ready: true });
    await ws1.waitFor((m) => m.type === 'room:updated' && m.room.players.every((p) => p.ready));
    ws1.send({ type: 'room:start' });
    await ws1.waitFor((m) => m.type === 'match:started');
    await ws2.waitFor((m) => m.type === 'match:started');

    // 0-shot forfeit -> rankedApplied must be false!
    ws2.send({ type: 'game:forfeit' });
    const zeroOver = await ws1.waitFor<Extract<ServerToClientMessage, { type: 'match:over' }>>(
      (m) => m.type === 'match:over',
    );
    assert.equal(zeroOver.progression?.rankedApplied, false);
    assert.equal(zeroOver.progression?.players.player1.eloDelta, 0);
    assert.equal(zeroOver.progression?.players.player1.xpGained, 0);

    // Rematch -> execute a real shot -> forfeit -> rankedApplied = true!
    ws1.send({ type: 'room:rematch' });
    ws2.send({ type: 'room:rematch' });
    await ws1.waitFor((m) => m.type === 'match:rematch_started');
    await ws2.waitFor((m) => m.type === 'match:rematch_started');

    ws1.send({
      type: 'game:shoot',
      shotToken: 'p5_local_break_1',
      cueAngle: 0,
      power: 0.72,
      spinX: 0,
      spinY: 0,
      calledBall: null,
      calledPocket: null,
    });
    await ws1.waitFor((m) => m.type === 'match:settled', 12000, 'local match:settled');

    ws2.send({ type: 'game:forfeit' });
    const rankedOver = await ws1.waitFor<Extract<ServerToClientMessage, { type: 'match:over' }>>(
      (m) => m.type === 'match:over',
    );
    assert.equal(rankedOver.progression?.rankedApplied, true);
    assert(rankedOver.progression!.players.player1.eloDelta > 0);
    assert(rankedOver.progression!.players.player2.eloDelta < 0);
    assert(rankedOver.progression!.players.player1.xpGained > 0);
    assert(
      rankedOver.progression!.players.player1.unlockedAchievements.some(
        (a) => a.id === 'first_victory',
      ),
    );

    // Idempotency guard: re-recording the exact same matchId must return alreadyRecorded: true
    const dupRecord = await controller.progressionStore.recordCompletedMatch({
      matchId: rankedOver.match.matchId,
      roomId: rankedOver.room.roomId,
      roomCode: rankedOver.room.roomCode,
      ruleProfileId: 'casual',
      matchType: 'private',
      winnerRole: 'player1',
      reason: 'Duplicate test',
      totalShots: 1,
      endedAtMs: Date.now(),
      player1: { playerId: loggedIn.playerId, displayName: 'SharkPrime', avatarId: 'trophy_platinum' },
      player2: { playerId: s2.playerId, displayName: 'ChallengerB', avatarId: 'crown_emerald' },
      telemetry: {
        durationSec: 12,
        completionType: 'forfeit',
        rankedValid: true,
        player1: {
          shotsTaken: 1,
          successfulShots: 0,
          ballsPocketed: 0,
          fouls: 0,
          breaksAttempted: 1,
          breaksSuccessful: 0,
          legalEightBallWin: false,
          comebackWin: false,
        },
        player2: {
          shotsTaken: 0,
          successfulShots: 0,
          ballsPocketed: 0,
          fouls: 0,
          breaksAttempted: 0,
          breaksSuccessful: 0,
          legalEightBallWin: false,
          comebackWin: false,
        },
      },
    });
    assert.equal(dupRecord.alreadyRecorded, true);

    // Check Global/Weekly leaderboard, search, and match history
    const lbGlobalRes = await fetch(
      `${baseHttp}/api/leaderboard?scope=global&playerId=${encodeURIComponent(loggedIn.playerId)}`,
    );
    const lbGlobal = (await lbGlobalRes.json()) as {
      items: Array<{ playerId: string; elo: number; rank: number }>;
      currentPlayer: { playerId: string; rank: number };
    };
    assert.equal(lbGlobal.items[0].playerId, loggedIn.playerId);
    assert.equal(lbGlobal.currentPlayer.rank, 1);

    const lbWeeklyRes = await fetch(`${baseHttp}/api/leaderboard?scope=weekly`);
    const lbWeekly = (await lbWeeklyRes.json()) as {
      items: Array<{ playerId: string; periodDelta: number }>;
    };
    assert(lbWeekly.items.some((i) => i.playerId === loggedIn.playerId && i.periodDelta > 0));

    const searchRes = await fetch(`${baseHttp}/api/players/search?q=shark`);
    const searchJson = (await searchRes.json()) as { players: Array<{ playerId: string }> };
    assert(searchJson.players.some((p) => p.playerId === loggedIn.playerId));

    const histRes = await fetch(
      `${baseHttp}/api/matches/history?playerId=${encodeURIComponent(loggedIn.playerId)}`,
    );
    const histJson = (await histRes.json()) as { matches: Array<{ matchId: string }> };
    assert(histJson.matches.some((m) => m.matchId === rankedOver.match.matchId));

    await ws1.close();
    await ws2.close();
    console.log(
      'PASS [3] Local Node Server progression, auth, 0-shot guard, idempotency & leaderboards verified',
    );
  } finally {
    controller.dispose();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
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
  throw new Error('Timed out waiting for wrangler dev (Phase 5 D1 test)');
}

async function runSuite4CloudflareD1Integration(): Promise<void> {
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
      'CORS_ORIGIN:https://test-user.github.io',
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

    const originHeader = { Origin: 'https://test-user.github.io' };
    const healthRes = await fetch(`${baseHttp}/health`, { headers: originHeader });
    assert.equal(healthRes.status, 200);
    const health = (await healthRes.json()) as {
      ok: boolean;
      d1Configured: boolean;
      progressionBackend: string;
      progressionReady: boolean;
    };
    assert.equal(health.progressionReady, true);
    assert.equal(health.progressionBackend, 'durable-object-sqlite');

    // Create two players in D1
    const p1Session = await fetch(`${baseHttp}/api/players/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...originHeader },
      body: JSON.stringify({ displayName: 'D1Winner', avatarId: 'break_amber' }),
    });
    const p1 = (await p1Session.json()) as { playerId: string; playerToken: string };

    const p2Session = await fetch(`${baseHttp}/api/players/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...originHeader },
      body: JSON.stringify({ displayName: 'D1Rival', avatarId: 'eight_obsidian' }),
    });
    const p2 = (await p2Session.json()) as { playerId: string; playerToken: string };

    // Upgrade p1 to registered account in D1
    const p1RegRes = await fetch(`${baseHttp}/api/players/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${p1.playerToken}`,
        ...originHeader,
      },
      body: JSON.stringify({
        playerId: p1.playerId,
        username: 'D1Champion',
        password: 'D1StrongPassword!',
      }),
    });
    assert.equal(p1RegRes.status, 200);
    const p1Reg = (await p1RegRes.json()) as { playerId: string; playerToken: string };

    // Play a live match in Cloudflare Durable Objects + record to D1
    const c1 = new TestWsClient(baseWs, 'https://test-user.github.io');
    const c2 = new TestWsClient(baseWs, 'https://test-user.github.io');
    await c1.connect();
    await c2.connect();
    await c1.initSession('D1Winner', { playerId: p1Reg.playerId, playerToken: p1Reg.playerToken });
    await c2.initSession('D1Rival', { playerId: p2.playerId, playerToken: p2.playerToken });

    c1.send({
      type: 'room:create',
      isPrivate: true,
      ruleProfileId: 'wpa',
      calledShotsEnabled: true,
    });
    const created = await c1.waitFor<Extract<ServerToClientMessage, { type: 'room:created' }>>(
      (m) => m.type === 'room:created',
    );
    await c1.resumeInRoom(created.room.roomId);

    c2.send({ type: 'room:join', roomCode: created.room.roomCode });
    await c2.waitFor((m) => m.type === 'room:updated');
    await c2.resumeInRoom(created.room.roomId);

    c2.send({ type: 'room:ready', ready: true });
    await c1.waitFor((m) => m.type === 'room:updated' && m.room.players.every((p) => p.ready));
    c1.send({ type: 'room:start' });
    await c1.waitFor((m) => m.type === 'match:started');
    await c2.waitFor((m) => m.type === 'match:started');

    c1.send({
      type: 'game:shoot',
      shotToken: 'cf_d1_break_shot_1',
      cueAngle: 0,
      power: 0.78,
      spinX: 0,
      spinY: 0,
      calledBall: null,
      calledPocket: null,
    });
    await c1.waitFor((m) => m.type === 'match:settled', 15000, 'cf match:settled');

    c2.send({ type: 'game:forfeit' });
    const over = await c1.waitFor<Extract<ServerToClientMessage, { type: 'match:over' }>>(
      (m) => m.type === 'match:over',
      8000,
      'cf match:over',
    );
    assert.equal(over.progression?.rankedApplied, true);
    assert(over.progression!.players.player1.eloDelta > 0);
    assert(
      over.progression!.players.player1.unlockedAchievements.some(
        (a) => a.id === 'first_victory',
      ),
    );

    // Query D1 public profile, global/weekly/monthly leaderboards, and match history
    const profRes = await fetch(
      `${baseHttp}/api/players/profile/${encodeURIComponent(p1Reg.playerId)}`,
      { headers: originHeader },
    );
    assert.equal(profRes.status, 200);
    const profJson = (await profRes.json()) as {
      profile: {
        elo: number;
        rank: number;
        stats: {
          wins: number;
          totalMatches: number;
          byMatchType: {
            wpa: { matches: number; wins: number };
            private: { matches: number; wins: number };
          };
        };
      };
    };
    assert(profJson.profile.elo > 1200);
    assert.equal(profJson.profile.rank, 1);
    assert.equal(profJson.profile.stats.wins, 1);
    assert.equal(profJson.profile.stats.byMatchType.wpa.wins, 1);
    assert.equal(profJson.profile.stats.byMatchType.private.wins, 1);

    const lbRes = await fetch(
      `${baseHttp}/api/leaderboard?scope=monthly&page=1&limit=10&q=D1`,
      { headers: originHeader },
    );
    const lbJson = (await lbRes.json()) as {
      items: Array<{ playerId: string; periodDelta: number }>;
    };
    assert(lbJson.items.some((x) => x.playerId === p1Reg.playerId && x.periodDelta > 0));

    const histRes = await fetch(
      `${baseHttp}/api/matches/history?playerId=${encodeURIComponent(p1Reg.playerId)}`,
      { headers: originHeader },
    );
    const histJson = (await histRes.json()) as { matches: Array<{ matchId: string }> };
    assert(histJson.matches.some((m) => m.matchId === over.match.matchId));

    await c1.close();
    await c2.close();
    console.log(
      'PASS [4] Cloudflare Worker + D1 SQLite migrations, DO match progression, auth & leaderboards verified',
    );
  } catch (err) {
    console.error('\n--- Wrangler D1 Logs ---\n', logs);
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

async function main() {
  await runSuite1PureMath();
  await runSuite2CryptoValidation();
  await runSuite3LocalServerIntegration();
  await runSuite4CloudflareD1Integration();
  console.log('\nPhase 5 Competitive Progression Verification: ALL 4 SUITES PASSED.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
