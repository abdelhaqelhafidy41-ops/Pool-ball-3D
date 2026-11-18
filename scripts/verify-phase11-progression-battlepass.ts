import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { WebSocket } from 'ws';
import {
  BATTLE_PASS_CONFIG,
  BATTLE_PASS_TIERS,
  calculateBattlePassLevelFromXp,
  getUtcDayWindow,
  getUtcWeekWindow,
  type AiMatchProgressResponse,
  type BattlePassOverview,
  type ClaimRewardResponse,
  type UnlockPremiumResponse,
} from '../src/multiplayer/shared/battlePass';
import type {
  ClientToServerMessage,
  ServerToClientMessage,
} from '../src/multiplayer/shared/protocol';

const CF_PORT = 8796;
const CF_STATE_DIR = '/tmp/cf-phase11-bp-state';
const ORIGIN = 'https://test-user.github.io';
const ADMIN_SECRET = 'phase11_test_admin_secret_2026';

function toSqlInput(value: unknown): SQLInputValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'bigint') {
    return value;
  }
  if (value instanceof Uint8Array) return value;
  return String(value);
}

function createNodeSqliteDb(): {
  raw: DatabaseSync;
  db: {
    prepare: (sql: string) => {
      bind: (...values: unknown[]) => unknown;
      run: () => Promise<{ meta?: { changes?: number } }>;
      first: <T = Record<string, unknown>>() => Promise<T | null>;
      all: <T = Record<string, unknown>>() => Promise<{ results?: T[] }>;
    };
  };
} {
  const raw = new DatabaseSync(':memory:');
  const buildStmt = (sql: string, boundArgs: SQLInputValue[] = []) => ({
    bind(...values: unknown[]) {
      return buildStmt(
        sql,
        values.map((v) => toSqlInput(v)),
      );
    },
    async run() {
      const stmt = raw.prepare(sql);
      const res = stmt.run(...boundArgs);
      return { meta: { changes: Number(res.changes ?? 0) } };
    },
    async first<T = Record<string, unknown>>() {
      const stmt = raw.prepare(sql);
      const row = stmt.get(...boundArgs) as T | undefined;
      return row ?? null;
    },
    async all<T = Record<string, unknown>>() {
      const stmt = raw.prepare(sql);
      const rows = stmt.all(...boundArgs) as T[];
      return { results: rows };
    },
  });

  return {
    raw,
    db: {
      prepare(sql: string) {
        return buildStmt(sql);
      },
    },
  };
}

class WsTestClient {
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
    timeoutMs = 12000,
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
      latencyMs: 20,
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

  public async resumeRoom(roomId: string): Promise<WsTestClient> {
    const roomClient = new WsTestClient(this.baseWsUrl, this.origin);
    await roomClient.connect(`${this.baseWsUrl}?roomId=${encodeURIComponent(roomId)}`);
    roomClient.sessionId = this.sessionId;
    roomClient.reconnectToken = this.reconnectToken;
    roomClient.playerId = this.playerId;
    roomClient.playerToken = this.playerToken;
    roomClient.send({
      type: 'session:resume',
      sessionId: this.sessionId,
      reconnectToken: this.reconnectToken,
      playerId: this.playerId,
      playerToken: this.playerToken,
    });
    await roomClient.waitFor((m) => m.type === 'session:ready', 6000, 'room session:ready');
    return roomClient;
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
      // Starting up
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Timed out waiting for wrangler dev (Phase 11 test)');
}

async function apiJson<T = Record<string, unknown>>(
  baseHttp: string,
  path: string,
  options?: RequestInit & { token?: string; adminKey?: string },
): Promise<{ status: number; ok: boolean; body: T & { error?: string; message?: string } }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Origin: ORIGIN,
    ...(options?.token ? { Authorization: `Bearer ${options.token}` } : {}),
    ...(options?.adminKey ? { 'X-Admin-Key': options.adminKey } : {}),
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

async function runSuite1DeterministicServices(): Promise<void> {
  const { raw, db } = createNodeSqliteDb();
  const d1ModPath = ['..', 'cloudflare', 'src', 'D1ProgressionService'].join('/');
  const econModPath = ['..', 'cloudflare', 'src', 'EconomyService'].join('/');
  const bpModPath = ['..', 'cloudflare', 'src', 'BattlePassService'].join('/');
  const { D1ProgressionService } = (await import(d1ModPath)) as {
    D1ProgressionService: new (db: unknown) => {
      authenticateOrCreatePlayer: (input: Record<string, unknown>) => Promise<
        | { ok: true; playerId: string; playerToken: string }
        | { ok: false; code: string; message: string }
      >;
      recordCompletedMatch: (input: Record<string, unknown>) => Promise<{
        alreadyRecorded: boolean;
      }>;
      getPublicProfile: (playerId: string) => Promise<{
        elo: number;
        xp: number;
        level: number;
        stats: { wins: number; losses: number };
      } | null>;
    };
  };
  const { EconomyService } = (await import(econModPath)) as {
    EconomyService: new (db: unknown) => {
      getOverview: (
        playerId: string,
        nowMs?: number,
      ) => Promise<{
        wallet: { balance: number };
        inventoryIds: string[];
        equipped: { cueId: string; avatarId: string };
      }>;
      creditCoinsWithIdempotency: (params: Record<string, unknown>) => Promise<unknown>;
      equipItem: (
        playerId: string,
        category: string,
        itemId: string,
      ) => Promise<
        | { ok: true; equipped: { cueId: string; avatarId: string } }
        | { ok: false; code: string }
      >;
    };
  };
  const { BattlePassService } = (await import(bpModPath)) as {
    BattlePassService: new (db: unknown) => {
      getOverview: (playerId: string, nowMs?: number) => Promise<BattlePassOverview>;
      recordTournamentFinish: (params: {
        tournamentId: string;
        playerId: string;
        placement: 'champion' | 'runner_up' | 'third_place' | 'participant';
        nowMs?: number;
      }) => Promise<{ alreadyRecorded: boolean; xpAwarded: number }>;
      recordAiMatchProgress: (
        playerId: string,
        req: Record<string, unknown>,
        nowMs?: number,
      ) => Promise<AiMatchProgressResponse | { ok: false; status: number; code: string; message: string }>;
      claimMission: (
        playerId: string,
        input: { missionId: string; cadence?: 'daily' | 'weekly'; periodKey?: string },
        nowMs?: number,
      ) => Promise<ClaimRewardResponse | { ok: false; status: number; code: string; message: string }>;
      unlockPremium: (
        playerId: string,
        nowMs?: number,
      ) => Promise<UnlockPremiumResponse | { ok: false; status: number; code: string; message: string }>;
      claimTierReward: (
        playerId: string,
        input: { level: number; track: 'free' | 'premium' },
        nowMs?: number,
      ) => Promise<ClaimRewardResponse | { ok: false; status: number; code: string; message: string }>;
      claimAllAvailable: (playerId: string, nowMs?: number) => Promise<ClaimRewardResponse>;
    };
  };

  const progression = new D1ProgressionService(db);
  const economy = new EconomyService(db);
  const battlePass = new BattlePassService(db);

  // Wednesday Nov 18, 2026 14:00:00 UTC
  const DAY_1 = Date.UTC(2026, 10, 18, 14, 0, 0, 0);
  const DAY_2 = DAY_1 + 24 * 60 * 60 * 1000;
  const NEXT_WEEK = getUtcWeekWindow(DAY_1).expiresAtMs + 60_000;

  // Create players via D1ProgressionService
  const aliceAuth = await progression.authenticateOrCreatePlayer({
    displayName: 'AliceCue',
    avatarId: 'cue_gold',
  });
  const bobAuth = await progression.authenticateOrCreatePlayer({
    displayName: 'BobMaster',
    avatarId: 'shark_sky',
  });
  const charlieAuth = await progression.authenticateOrCreatePlayer({
    displayName: 'CharlieRookie',
    avatarId: 'eight_obsidian',
  });
  assert.equal(aliceAuth.ok, true);
  assert.equal(bobAuth.ok, true);
  assert.equal(charlieAuth.ok, true);
  if (!aliceAuth.ok || !bobAuth.ok || !charlieAuth.ok) throw new Error('Player creation failed');

  const aliceId = aliceAuth.playerId;
  const bobId = bobAuth.playerId;
  const charlieId = charlieAuth.playerId;

  // 1. Bootstrap Season I, Daily Missions (4) & Weekly Challenges (6)
  const initialOverview = await battlePass.getOverview(aliceId, DAY_1);
  assert.equal(initialOverview.season.seasonNumber, 1);
  assert.equal(initialOverview.season.status, 'active');
  assert.equal(initialOverview.season.premiumPriceCoins, 1200);
  assert.equal(initialOverview.tiers.length, 30);
  assert.equal(initialOverview.dailyMissions.length, BATTLE_PASS_CONFIG.dailyMissionsCount);
  assert.equal(initialOverview.weeklyChallenges.length, BATTLE_PASS_CONFIG.weeklyChallengesCount);
  assert.equal(initialOverview.dailyResetAtMs, getUtcDayWindow(DAY_1).expiresAtMs);
  assert.equal(initialOverview.weeklyResetAtMs, getUtcWeekWindow(DAY_1).expiresAtMs);
  assert.equal(initialOverview.playerState.seasonXp, 0);
  assert.equal(initialOverview.playerState.seasonLevel, 0);
  assert.equal(initialOverview.playerState.premiumUnlocked, false);

  // Give Bob higher ELO so Alice beating Bob triggers 'weekly_upset_higher_elo'
  raw.prepare('UPDATE players SET elo = 1450 WHERE player_id = ?').run(bobId);

  // 2. Record 3 valid Ranked Online Matches (Alice wins all 3 cleanly with legal 8-ball sinks)
  for (let i = 1; i <= 3; i++) {
    const tMatch = DAY_1 + i * 120_000;
    const matchRes = await progression.recordCompletedMatch({
      matchId: `m_p11_online_${i}`,
      roomId: `rm_p11_${i}`,
      roomCode: `P11_${i}`,
      ruleProfileId: 'wpa',
      matchType: 'ranked',
      winnerRole: 'player1',
      reason: 'Legal 8-Ball Pocket',
      totalShots: 12,
      endedAtMs: tMatch,
      player1: { playerId: aliceId, displayName: 'AliceCue', avatarId: 'cue_gold' },
      player2: { playerId: bobId, displayName: 'BobMaster', avatarId: 'shark_sky' },
      telemetry: {
        completionType: 'legal_8ball',
        durationSec: 120,
        rankedValid: true,
        player1: {
          shotsTaken: 7,
          successfulShots: 5,
          ballsPocketed: i === 1 ? 5 : 4,
          fouls: 0,
          breaksAttempted: 1,
          breaksSuccessful: 1,
          legalEightBallWin: true,
          comebackWin: false,
        },
        player2: {
          shotsTaken: 5,
          successfulShots: 2,
          ballsPocketed: 2,
          fouls: 1,
          breaksAttempted: 0,
          breaksSuccessful: 0,
          legalEightBallWin: false,
          comebackWin: false,
        },
      },
    });
    assert.equal(matchRes.alreadyRecorded, false);
  }

  // Duplicate match replay guard
  const dupMatch = await progression.recordCompletedMatch({
    matchId: 'm_p11_online_1',
    roomId: 'rm_p11_1',
    roomCode: 'P11_1',
    ruleProfileId: 'wpa',
    matchType: 'ranked',
    winnerRole: 'player1',
    reason: 'Legal 8-Ball Pocket',
    totalShots: 12,
    endedAtMs: DAY_1 + 120_000,
    player1: { playerId: aliceId, displayName: 'AliceCue', avatarId: 'cue_gold' },
    player2: { playerId: bobId, displayName: 'BobMaster', avatarId: 'shark_sky' },
    telemetry: {
      completionType: 'legal_8ball',
      durationSec: 120,
      rankedValid: true,
      player1: {
        shotsTaken: 7,
        successfulShots: 5,
        ballsPocketed: 5,
        fouls: 0,
        breaksAttempted: 1,
        breaksSuccessful: 1,
        legalEightBallWin: true,
        comebackWin: false,
      },
      player2: {
        shotsTaken: 5,
        successfulShots: 2,
        ballsPocketed: 2,
        fouls: 1,
        breaksAttempted: 0,
        breaksSuccessful: 0,
        legalEightBallWin: false,
        comebackWin: false,
      },
    },
  });
  assert.equal(dupMatch.alreadyRecorded, true);

  // Record 4th match where Alice loses -> currentWinStreak resets to 0, bestWinStreak stays 3, weekly_streak_3 stays completed!
  await progression.recordCompletedMatch({
    matchId: 'm_p11_online_4_loss',
    roomId: 'rm_p11_4',
    roomCode: 'P11_4',
    ruleProfileId: 'wpa',
    matchType: 'ranked',
    winnerRole: 'player2',
    reason: 'Legal 8-Ball Pocket',
    totalShots: 10,
    endedAtMs: DAY_1 + 600_000,
    player1: { playerId: aliceId, displayName: 'AliceCue', avatarId: 'cue_gold' },
    player2: { playerId: bobId, displayName: 'BobMaster', avatarId: 'shark_sky' },
    telemetry: {
      completionType: 'legal_8ball',
      durationSec: 95,
      rankedValid: true,
      player1: {
        shotsTaken: 4,
        successfulShots: 2,
        ballsPocketed: 2,
        fouls: 1,
        breaksAttempted: 1,
        breaksSuccessful: 0,
        legalEightBallWin: false,
        comebackWin: false,
      },
      player2: {
        shotsTaken: 6,
        successfulShots: 5,
        ballsPocketed: 5,
        fouls: 0,
        breaksAttempted: 0,
        breaksSuccessful: 0,
        legalEightBallWin: true,
        comebackWin: false,
      },
    },
  });

  const afterOnlineOverview = await battlePass.getOverview(aliceId, DAY_1 + 610_000);
  // 3 ranked wins (3*140 = 420) + 1 ranked loss (60) = 480 Season XP
  assert.equal(afterOnlineOverview.playerState.seasonXp, 480);
  assert.equal(afterOnlineOverview.playerState.seasonLevel, calculateBattlePassLevelFromXp(480).level);
  assert.equal(afterOnlineOverview.playerState.matchesPlayed, 4);
  assert.equal(afterOnlineOverview.playerState.wins, 3);
  assert.equal(afterOnlineOverview.playerState.losses, 1);
  assert.equal(afterOnlineOverview.playerState.ballsPocketed, 15);
  assert.equal(afterOnlineOverview.playerState.currentWinStreak, 0);
  assert.equal(afterOnlineOverview.playerState.bestWinStreak, 3);

  const weeklyStreak = afterOnlineOverview.weeklyChallenges.find(
    (w) => w.missionId === 'weekly_streak_3',
  );
  const weeklyUpset = afterOnlineOverview.weeklyChallenges.find(
    (w) => w.missionId === 'weekly_upset_higher_elo',
  );
  const weeklyBalls = afterOnlineOverview.weeklyChallenges.find(
    (w) => w.missionId === 'weekly_pocket_50',
  );
  assert(weeklyStreak && weeklyStreak.completed && weeklyStreak.progress === 3);
  assert(weeklyUpset && weeklyUpset.completed && weeklyUpset.progress === 1);
  assert(weeklyBalls && weeklyBalls.progress === 15 && !weeklyBalls.completed);

  // Verify every daily mission matches expected progress from those 4 online matches
  for (const dm of afterOnlineOverview.dailyMissions) {
    if (dm.metric === 'matches_played') assert.equal(dm.completed, true);
    if (dm.metric === 'matches_won') assert.equal(dm.completed, true);
    if (dm.metric === 'balls_pocketed') assert.equal(dm.completed, true);
    if (dm.metric === 'balls_3_in_match') assert.equal(dm.completed, true);
    if (dm.metric === 'online_wins') assert.equal(dm.completed, true);
    if (dm.metric === 'clean_match') assert.equal(dm.completed, true);
    if (dm.metric === 'legal_eight_ball_win') assert.equal(dm.completed, true);
    if (dm.metric === 'ai_wins') assert.equal(dm.progress, 0);
  }

  // 3. Tournament Finish Bonus XP + Idempotency
  const tFinish1 = await battlePass.recordTournamentFinish({
    tournamentId: 'trn_p11_cup_1',
    playerId: aliceId,
    placement: 'champion',
    nowMs: DAY_1 + 700_000,
  });
  const tFinishDup = await battlePass.recordTournamentFinish({
    tournamentId: 'trn_p11_cup_1',
    playerId: aliceId,
    placement: 'champion',
    nowMs: DAY_1 + 705_000,
  });
  assert.equal(tFinish1.alreadyRecorded, false);
  assert.equal(tFinish1.xpAwarded, 350);
  assert.equal(tFinishDup.alreadyRecorded, true);
  assert.equal(tFinishDup.xpAwarded, 0);

  // 4. AI Match Anti-Abuse, Cooldown, Idempotency & Daily AI XP Cap (500/day)
  let tAi = DAY_1 + 800_000;
  const aiTooFewShots = await battlePass.recordAiMatchProgress(
    aliceId,
    {
      clientMatchId: 'ai_abort_shots_1',
      difficulty: 'pro',
      won: true,
      totalShots: 1,
      ballsPocketed: 1,
      foulsCommitted: 0,
      legalEightBallWin: true,
      durationSec: 25,
    },
    tAi,
  );
  assert.equal(aiTooFewShots.ok, true);
  if (aiTooFewShots.ok) {
    assert.equal(aiTooFewShots.seasonXpAwarded, 0);
    assert.notEqual(aiTooFewShots.rejectedReason, null);
  }

  const aiTooFast = await battlePass.recordAiMatchProgress(
    aliceId,
    {
      clientMatchId: 'ai_abort_fast_1',
      difficulty: 'pro',
      won: true,
      totalShots: 5,
      ballsPocketed: 3,
      foulsCommitted: 0,
      legalEightBallWin: true,
      durationSec: 2,
    },
    tAi,
  );
  assert.equal(aiTooFast.ok, true);
  if (aiTooFast.ok) {
    assert.equal(aiTooFast.seasonXpAwarded, 0);
    assert.notEqual(aiTooFast.rejectedReason, null);
  }

  // Valid AI loss -> +20 XP
  const aiLoss = await battlePass.recordAiMatchProgress(
    aliceId,
    {
      clientMatchId: 'ai_valid_loss_1',
      difficulty: 'pro',
      won: false,
      totalShots: 6,
      ballsPocketed: 3,
      foulsCommitted: 0,
      legalEightBallWin: false,
      durationSec: 45,
    },
    tAi,
  );
  assert.equal(aiLoss.ok, true);
  if (aiLoss.ok) {
    assert.equal(aiLoss.seasonXpAwarded, BATTLE_PASS_CONFIG.xpRewards.aiMatchLoss);
    assert.equal(aiLoss.rejectedReason, null);
  }

  // Rapid call within 25s cooldown -> rejected
  const aiCooldownHit = await battlePass.recordAiMatchProgress(
    aliceId,
    {
      clientMatchId: 'ai_cooldown_spam_1',
      difficulty: 'legend',
      won: true,
      totalShots: 8,
      ballsPocketed: 8,
      foulsCommitted: 0,
      legalEightBallWin: true,
      durationSec: 60,
    },
    tAi + 10_000,
  );
  assert.equal(aiCooldownHit.ok, true);
  if (aiCooldownHit.ok) {
    assert.equal(aiCooldownHit.seasonXpAwarded, 0);
    assert.notEqual(aiCooldownHit.rejectedReason, null);
  }

  // Valid AI win after cooldown (+26s) -> +95 XP (legend)
  tAi += 30_000;
  const aiWin = await battlePass.recordAiMatchProgress(
    aliceId,
    {
      clientMatchId: 'ai_valid_win_1',
      difficulty: 'legend',
      won: true,
      totalShots: 9,
      ballsPocketed: 8,
      foulsCommitted: 0,
      legalEightBallWin: true,
      durationSec: 95,
    },
    tAi,
  );
  assert.equal(aiWin.ok, true);
  if (aiWin.ok) {
    assert.equal(aiWin.seasonXpAwarded, 95);
    assert.equal(aiWin.alreadyRecorded, false);
  }

  // Replay duplicate clientMatchId
  const aiDup = await battlePass.recordAiMatchProgress(
    aliceId,
    {
      clientMatchId: 'ai_valid_win_1',
      difficulty: 'legend',
      won: true,
      totalShots: 9,
      ballsPocketed: 8,
      foulsCommitted: 0,
      legalEightBallWin: true,
      durationSec: 95,
    },
    tAi + 35_000,
  );
  assert.equal(aiDup.ok, true);
  if (aiDup.ok) {
    assert.equal(aiDup.alreadyRecorded, true);
    assert.equal(aiDup.seasonXpAwarded, 0);
  }

  // Pump AI wins until 500/day cap is reached (currently 20 + 95 = 115 earned)
  let aiRun = 2;
  let sawAiCap = false;
  while (aiRun <= 8) {
    tAi += 30_000;
    const step = await battlePass.recordAiMatchProgress(
      aliceId,
      {
        clientMatchId: `ai_cap_test_${aiRun}`,
        difficulty: 'legend',
        won: true,
        totalShots: 8,
        ballsPocketed: 7,
        foulsCommitted: 0,
        legalEightBallWin: true,
        durationSec: 80,
      },
      tAi,
    );
    assert.equal(step.ok, true);
    if (step.ok && step.capReached) {
      sawAiCap = true;
      assert.equal(
        step.overview.playerState.dailyAiXpEarned,
        BATTLE_PASS_CONFIG.dailyAiMatchXpCap,
      );
      break;
    }
    aiRun += 1;
  }
  assert.equal(sawAiCap, true, 'Expected daily AI XP cap (500) to engage');

  const postAiOverview = await battlePass.getOverview(aliceId, tAi);
  assert.equal(postAiOverview.playerState.dailyAiXpEarned, 500);
  assert.equal(postAiOverview.playerState.tournamentsPlayed, 1);

  // 5. Concurrent Claim Race Serialization on Completed Mission
  const claimCalls = await Promise.all([
    battlePass.claimMission(aliceId, { missionId: 'weekly_streak_3', cadence: 'weekly' }, tAi + 1000),
    battlePass.claimMission(aliceId, { missionId: 'weekly_streak_3', cadence: 'weekly' }, tAi + 1000),
    battlePass.claimMission(aliceId, { missionId: 'weekly_streak_3', cadence: 'weekly' }, tAi + 1000),
  ]);
  const freshClaims = claimCalls.filter((r) => r.ok && !r.alreadyClaimed);
  const dupClaims = claimCalls.filter((r) => r.ok && r.alreadyClaimed);
  assert.equal(freshClaims.length, 1);
  assert.equal(dupClaims.length, 2);
  if (freshClaims[0].ok) {
    assert.equal(freshClaims[0].coinsAwarded, 500);
    assert.equal(freshClaims[0].seasonXpAwarded, 750);
  }
  const streakTxCount = raw
    .prepare(
      `SELECT COUNT(*) AS cnt FROM coin_transactions
       WHERE player_id = ? AND reason = 'weekly_challenge_reward' AND reference_id LIKE '%weekly_streak_3'`,
    )
    .get(aliceId) as { cnt: number };
  assert.equal(Number(streakTxCount.cnt), 1);

  // 6. Premium Unlock via POOL COINS + Concurrent Tier Claim + Exclusive Cosmetics Equipping
  const premBlockedBeforeUnlock = await battlePass.claimTierReward(
    aliceId,
    { level: 1, track: 'premium' },
    tAi + 2000,
  );
  assert.equal(premBlockedBeforeUnlock.ok, false);
  if (!premBlockedBeforeUnlock.ok) {
    assert.equal(premBlockedBeforeUnlock.status, 403);
    assert.equal(premBlockedBeforeUnlock.code, 'PREMIUM_REQUIRED');
  }

  // Charlie has only starting 100 coins -> insufficient funds (402)
  const charliePremFail = await battlePass.unlockPremium(charlieId, tAi + 2000);
  assert.equal(charliePremFail.ok, false);
  if (!charliePremFail.ok) {
    assert.equal(charliePremFail.status, 402);
    assert.equal(charliePremFail.code, 'INSUFFICIENT_FUNDS');
  }

  // Fund Alice cleanly if needed so she can afford 1200 POOL COINS Premium Pass
  const walletBeforeUnlock = (await economy.getOverview(aliceId, tAi + 2000)).wallet.balance;
  if (walletBeforeUnlock < 1200) {
    await economy.creditCoinsWithIdempotency({
      playerId: aliceId,
      amount: 1200 - walletBeforeUnlock + 200,
      reason: 'tournament_reward',
      referenceType: 'test_grant',
      referenceId: 'p11_fund_alice',
      idempotencyKey: 'p11_test_fund_alice',
      nowMs: tAi + 2000,
    });
  }
  const balReady = (await economy.getOverview(aliceId, tAi + 2000)).wallet.balance;
  const unlockRes = await battlePass.unlockPremium(aliceId, tAi + 2500);
  assert.equal(unlockRes.ok, true);
  if (unlockRes.ok) {
    assert.equal(unlockRes.alreadyUnlocked, false);
    assert.equal(unlockRes.pricePaid, 1200);
    assert.equal(unlockRes.wallet.balance, balReady - 1200);
    assert.equal(unlockRes.overview.playerState.premiumUnlocked, true);
  }
  const unlockIdemp = await battlePass.unlockPremium(aliceId, tAi + 2600);
  assert.equal(unlockIdemp.ok, true);
  if (unlockIdemp.ok) {
    assert.equal(unlockIdemp.alreadyUnlocked, true);
    assert.equal(unlockIdemp.pricePaid, 0);
  }

  // Claim Tier 1 Premium concurrently -> grants avatar_solar_sovereign + 50 coins strictly once
  const tierRace = await Promise.all([
    battlePass.claimTierReward(aliceId, { level: 1, track: 'premium' }, tAi + 3000),
    battlePass.claimTierReward(aliceId, { level: 1, track: 'premium' }, tAi + 3000),
  ]);
  const tierWins = tierRace.filter((r) => r.ok && !r.alreadyClaimed);
  assert.equal(tierWins.length, 1);
  if (tierWins[0].ok) {
    assert.equal(tierWins[0].coinsAwarded, 50);
    assert.deepEqual(tierWins[0].grantedItemIds, ['avatar_solar_sovereign']);
    assert(tierWins[0].inventoryIds.includes('avatar_solar_sovereign'));
  }

  // Equip Battle Pass cosmetic & verify high locked tier returns TIER_LOCKED
  const equipAvatar = await economy.equipItem(aliceId, 'avatar', 'avatar_solar_sovereign');
  assert.equal(equipAvatar.ok, true);
  if (equipAvatar.ok) {
    assert.equal(equipAvatar.equipped.avatarId, 'avatar_solar_sovereign');
  }

  const lockedTier = await battlePass.claimTierReward(
    aliceId,
    { level: 30, track: 'premium' },
    tAi + 3500,
  );
  assert.equal(lockedTier.ok, false);
  if (!lockedTier.ok) {
    assert.equal(lockedTier.code, 'TIER_LOCKED');
  }

  // Also test Claim All claims remaining completed missions + unlocked Free/Premium tiers
  const claimAllRes = await battlePass.claimAllAvailable(aliceId, tAi + 4000);
  assert.equal(claimAllRes.ok, true);
  assert(claimAllRes.coinsAwarded > 0);
  assert.equal(claimAllRes.overview.claimableCounts.total, 0);

  // Reach Tier 10 & claim Level 10 Premium (`cue_season1_eclipse`) via claimAllAvailable if needed
  const curLevel = claimAllRes.overview.playerState.seasonLevel;
  assert(curLevel >= 10, `Expected Alice to be >= Level 10 after online+AI+tournament+missions, got ${curLevel}`);
  assert(
    claimAllRes.inventoryIds.includes('cue_season1_eclipse'),
    'Expected Tier 10 Premium exclusive cue_season1_eclipse in inventory',
  );
  const equipCue = await economy.equipItem(aliceId, 'cue', 'cue_season1_eclipse');
  assert.equal(equipCue.ok, true);

  // 7. UTC Daily Reset & UTC Weekly Reset Verification
  const day2Overview = await battlePass.getOverview(aliceId, DAY_2);
  assert.equal(day2Overview.playerState.dailyMatchXpEarned, 0);
  assert.equal(day2Overview.playerState.dailyAiXpEarned, 0);
  assert.equal(day2Overview.dailyResetAtMs, getUtcDayWindow(DAY_2).expiresAtMs);
  // Daily missions reset to 0/N for the new UTC day
  for (const dm of day2Overview.dailyMissions) {
    assert.equal(dm.periodKey, getUtcDayWindow(DAY_2).dayKey);
    assert.equal(dm.progress, 0);
    assert.equal(dm.completed, false);
  }
  // Same ISO week still retains weekly progress!
  const day2WeeklyBalls = day2Overview.weeklyChallenges.find((w) => w.metric === 'balls_pocketed');
  assert(day2WeeklyBalls && day2WeeklyBalls.progress > 0);

  // Next ISO week resets weekly challenges to 0/N while preserving seasonXp
  const nextWeekOverview = await battlePass.getOverview(aliceId, NEXT_WEEK);
  assert.equal(nextWeekOverview.playerState.seasonXp, day2Overview.playerState.seasonXp);
  for (const wc of nextWeekOverview.weeklyChallenges) {
    assert.equal(wc.periodKey, getUtcWeekWindow(NEXT_WEEK).weekKey);
    assert.equal(wc.progress, 0);
    assert.equal(wc.completed, false);
  }

  // 8. Automatic Season Expiration Rollover & Lifetime Preservation
  const profileBeforeRollover = await progression.getPublicProfile(aliceId);
  const econBeforeRollover = await economy.getOverview(aliceId, NEXT_WEEK);
  assert(profileBeforeRollover && profileBeforeRollover.stats.wins >= 3);

  const expiredAt = nextWeekOverview.season.endsAtMs + 60_000;
  const season2Overview = await battlePass.getOverview(aliceId, expiredAt);
  assert.equal(season2Overview.season.seasonNumber, 2);
  assert.equal(season2Overview.season.status, 'active');
  assert.equal(season2Overview.playerState.seasonXp, 0);
  assert.equal(season2Overview.playerState.seasonLevel, 0);
  assert.equal(season2Overview.playerState.premiumUnlocked, false);
  assert.equal(season2Overview.pastSeasons.length, 1);
  assert.equal(season2Overview.pastSeasons[0].season.seasonNumber, 1);
  assert.equal(season2Overview.pastSeasons[0].seasonXp, nextWeekOverview.playerState.seasonXp);
  assert.equal(season2Overview.pastSeasons[0].premiumUnlocked, true);

  // Lifetime profile stats, achievements, wallet & cosmetic inventory preserved 100%!
  const profileAfterRollover = await progression.getPublicProfile(aliceId);
  const econAfterRollover = await economy.getOverview(aliceId, expiredAt);
  assert(profileAfterRollover);
  assert.equal(profileAfterRollover.elo, profileBeforeRollover.elo);
  assert.equal(profileAfterRollover.xp, profileBeforeRollover.xp);
  assert.equal(profileAfterRollover.level, profileBeforeRollover.level);
  assert.equal(profileAfterRollover.stats.wins, profileBeforeRollover.stats.wins);
  assert.equal(profileAfterRollover.stats.losses, profileBeforeRollover.stats.losses);
  assert.equal(econAfterRollover.wallet.balance, econBeforeRollover.wallet.balance);
  assert.deepEqual(
    [...econAfterRollover.inventoryIds].sort(),
    [...econBeforeRollover.inventoryIds].sort(),
  );
  assert.equal(econAfterRollover.equipped.cueId, 'cue_season1_eclipse');

  raw.close();
  console.log(
    'PASS [1] Deterministic SQLite: Daily/Weekly UTC resets, anti-abuse AI caps, concurrent claim locks, coin-only Premium unlock, exclusive cosmetics, and non-destructive Season Rollover verified',
  );
}

async function main() {
  await runSuite1DeterministicServices();

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
      `TOURNAMENT_ADMIN_SECRET:${ADMIN_SECRET}`,
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

    const p1 = await createPlayer(baseHttp, 'SeasonP1', 'cue_gold');
    const p2 = await createPlayer(baseHttp, 'SeasonP2', 'shark_sky');

    // [2] Overview auth & initial structure
    const unauthOverview = await apiJson(
      baseHttp,
      `/api/battle-pass/overview?playerId=${encodeURIComponent(p1.playerId)}`,
    );
    assert.equal(unauthOverview.status, 401);

    const ov1Res = await apiJson<{ ok: boolean; overview: BattlePassOverview }>(
      baseHttp,
      `/api/battle-pass/overview?playerId=${encodeURIComponent(p1.playerId)}`,
      { token: p1.playerToken },
    );
    assert.equal(ov1Res.status, 200);
    assert.equal(ov1Res.body.overview.season.seasonNumber, 1);
    assert.equal(ov1Res.body.overview.tiers.length, 30);
    assert.equal(ov1Res.body.overview.dailyMissions.length, 4);
    assert.equal(ov1Res.body.overview.weeklyChallenges.length, 6);

    // [3] Live WebSocket Online Quick Match updates Battle Pass XP & Online Missions automatically
    const ws1 = new WsTestClient(baseWs, ORIGIN);
    const ws2 = new WsTestClient(baseWs, ORIGIN);
    await Promise.all([ws1.connect(), ws2.connect()]);
    await Promise.all([ws1.initSession('SeasonP1', p1), ws2.initSession('SeasonP2', p2)]);

    ws1.send({
      type: 'matchmaking:join',
      mode: 'quick',
      ruleProfileId: 'wpa',
      calledShotsEnabled: true,
    });
    ws2.send({
      type: 'matchmaking:join',
      mode: 'quick',
      ruleProfileId: 'wpa',
      calledShotsEnabled: true,
    });

    const [m1, m2] = await Promise.all([
      ws1.waitFor<Extract<ServerToClientMessage, { type: 'matchmaking:matched' }>>(
        (m) => m.type === 'matchmaking:matched',
      ),
      ws2.waitFor<Extract<ServerToClientMessage, { type: 'matchmaking:matched' }>>(
        (m) => m.type === 'matchmaking:matched',
      ),
    ]);
    assert.equal(m1.room.roomId, m2.room.roomId);

    const roomWs1 = await ws1.resumeRoom(m1.room.roomId);
    const roomWs2 = await ws2.resumeRoom(m1.room.roomId);
    roomWs1.clearQueue();
    roomWs2.clearQueue();

    // Player 1 takes a real break shot, then waits a few seconds for durationSec >= 3, then Player 2 forfeits
    const shotStart = Date.now();
    roomWs1.send({
      type: 'game:shoot',
      shotToken: 'p11_ws_break_1',
      cueAngle: 0,
      power: 0.78,
      spinX: 0,
      spinY: 0,
      calledBall: null,
      calledPocket: null,
    });
    await roomWs1.waitFor((m) => m.type === 'match:settled', 15000, 'p11 break match:settled');
    const elapsed = Date.now() - shotStart;
    if (elapsed < 3400) {
      await new Promise((r) => setTimeout(r, 3400 - elapsed));
    }
    roomWs2.send({ type: 'game:forfeit' });
    await Promise.all([
      roomWs1.waitFor((m) => m.type === 'match:over', 10000),
      roomWs2.waitFor((m) => m.type === 'match:over', 10000),
    ]);
    await roomWs1.close();
    await roomWs2.close();
    await ws1.close();
    await ws2.close();

    const ovAfterWs = await apiJson<{ ok: boolean; overview: BattlePassOverview }>(
      baseHttp,
      `/api/battle-pass/overview?playerId=${encodeURIComponent(p1.playerId)}`,
      { token: p1.playerToken },
    );
    assert.equal(ovAfterWs.status, 200);
    assert.equal(ovAfterWs.body.overview.playerState.matchesPlayed, 1);
    assert.equal(ovAfterWs.body.overview.playerState.wins, 1);
    assert.equal(
      ovAfterWs.body.overview.playerState.seasonXp,
      BATTLE_PASS_CONFIG.xpRewards.onlineMatchWin.quick,
    );

    const ovP2AfterWs = await apiJson<{ ok: boolean; overview: BattlePassOverview }>(
      baseHttp,
      `/api/battle-pass/overview?playerId=${encodeURIComponent(p2.playerId)}`,
      { token: p2.playerToken },
    );
    assert.equal(ovP2AfterWs.body.overview.playerState.matchesPlayed, 1);
    assert.equal(ovP2AfterWs.body.overview.playerState.losses, 1);
    assert.equal(
      ovP2AfterWs.body.overview.playerState.seasonXp,
      BATTLE_PASS_CONFIG.xpRewards.onlineMatchLoss.quick,
    );

    // [4] Live AI Match Endpoint (/api/battle-pass/ai-match) + Anti-Abuse + Mission Claim + Tier Claim
    const aiInvalidRes = await apiJson<AiMatchProgressResponse>(
      baseHttp,
      '/api/battle-pass/ai-match',
      {
        method: 'POST',
        token: p1.playerToken,
        body: JSON.stringify({
          playerId: p1.playerId,
          clientMatchId: 'ai_live_bad_shots_1',
          difficulty: 'pro',
          won: true,
          totalShots: 1,
          ballsPocketed: 1,
          foulsCommitted: 0,
          legalEightBallWin: true,
          durationSec: 20,
        }),
      },
    );
    assert.equal(aiInvalidRes.status, 200);
    assert.equal(aiInvalidRes.body.seasonXpAwarded, 0);
    assert.notEqual(aiInvalidRes.body.rejectedReason, null);

    const aiValidRes = await apiJson<AiMatchProgressResponse>(
      baseHttp,
      '/api/battle-pass/ai-match',
      {
        method: 'POST',
        token: p1.playerToken,
        body: JSON.stringify({
          playerId: p1.playerId,
          clientMatchId: 'ai_live_legit_1',
          difficulty: 'legend',
          won: true,
          totalShots: 8,
          ballsPocketed: 7,
          foulsCommitted: 0,
          legalEightBallWin: true,
          durationSec: 75,
        }),
      },
    );
    assert.equal(aiValidRes.status, 200);
    assert.equal(aiValidRes.body.seasonXpAwarded, 95);
    assert.equal(aiValidRes.body.overview.playerState.seasonXp, 115 + 95);
    assert(aiValidRes.body.overview.playerState.seasonLevel >= 1);

    // Check daily mission completion after 1 online + 1 legend AI clean 8-ball win
    const completedMission = aiValidRes.body.overview.dailyMissions.find(
      (m) => m.completed && !m.claimed,
    );
    assert(completedMission, 'Expected at least one completed daily mission on live Wrangler');

    const claimMissionRes = await apiJson<ClaimRewardResponse>(
      baseHttp,
      '/api/battle-pass/missions/claim',
      {
        method: 'POST',
        token: p1.playerToken,
        body: JSON.stringify({
          playerId: p1.playerId,
          missionId: completedMission.missionId,
          cadence: completedMission.cadence,
        }),
      },
    );
    assert.equal(claimMissionRes.status, 200);
    assert.equal(claimMissionRes.body.coinsAwarded, completedMission.rewardCoins);
    assert.equal(claimMissionRes.body.seasonXpAwarded, completedMission.rewardSeasonXp);

    // Verify Free Tier 1 claim works and Premium Tier 1 fails with 403 PREMIUM_REQUIRED before unlock
    const lockedPremHttp = await apiJson(baseHttp, '/api/battle-pass/tiers/claim', {
      method: 'POST',
      token: p1.playerToken,
      body: JSON.stringify({ playerId: p1.playerId, level: 1, track: 'premium' }),
    });
    assert.equal(lockedPremHttp.status, 403);
    assert.equal(lockedPremHttp.body.error, 'PREMIUM_REQUIRED');

    const freeTierClaim = await apiJson<ClaimRewardResponse>(
      baseHttp,
      '/api/battle-pass/tiers/claim',
      {
        method: 'POST',
        token: p1.playerToken,
        body: JSON.stringify({ playerId: p1.playerId, level: 1, track: 'free' }),
      },
    );
    assert.equal(freeTierClaim.status, 200);
    assert.equal(freeTierClaim.body.coinsAwarded, BATTLE_PASS_TIERS[0].free.coins);

    // Claim All should clear any remaining completed missions/free tiers
    const claimAllHttp = await apiJson<ClaimRewardResponse>(
      baseHttp,
      '/api/battle-pass/claim-all',
      {
        method: 'POST',
        token: p1.playerToken,
        body: JSON.stringify({ playerId: p1.playerId }),
      },
    );
    assert.equal(claimAllHttp.status, 200);
    assert.equal(claimAllHttp.body.overview.claimableCounts.total, 0);

    // Unlock Premium without enough coins returns 402 INSUFFICIENT_FUNDS (server-authoritative)
    const unlockP2Fail = await apiJson<UnlockPremiumResponse>(
      baseHttp,
      '/api/battle-pass/premium/unlock',
      {
        method: 'POST',
        token: p2.playerToken,
        body: JSON.stringify({ playerId: p2.playerId }),
      },
    );
    assert.equal(unlockP2Fail.status, 402);

    // Verify coin transactions ledger logged mission_reward + battle_pass_reward
    const txRes = await apiJson<{ transactions: Array<{ reason: string; amount: number }> }>(
      baseHttp,
      `/api/economy/transactions?playerId=${encodeURIComponent(p1.playerId)}`,
      { token: p1.playerToken },
    );
    assert.equal(txRes.status, 200);
    assert(txRes.body.transactions.some((t) => t.reason === 'mission_reward'));
    assert(txRes.body.transactions.some((t) => t.reason === 'battle_pass_reward'));

    // [5] Admin Season Rollover + Archive + Profile & Wallet Preservation
    const profilePre = await apiJson<{
      profile: { elo: number; xp: number; stats: { wins: number } };
    }>(baseHttp, `/api/players/profile/${encodeURIComponent(p1.playerId)}`);
    const walletPre = await apiJson<{ wallet: { balance: number } }>(
      baseHttp,
      `/api/economy/wallet?playerId=${encodeURIComponent(p1.playerId)}`,
      { token: p1.playerToken },
    );

    const unauthRollover = await apiJson(baseHttp, '/api/admin/battle-pass/rollover', {
      method: 'POST',
      body: JSON.stringify({ newSeasonName: 'Blocked' }),
    });
    assert.equal(unauthRollover.status, 403);

    const adminRollover = await apiJson<{
      ok: boolean;
      closedSeason: { seasonNumber: number; status: string };
      newSeason: { seasonNumber: number; status: string; name: string };
    }>(baseHttp, '/api/admin/battle-pass/rollover', {
      method: 'POST',
      adminKey: ADMIN_SECRET,
      body: JSON.stringify({ newSeasonName: 'Season II: Neon Velocity' }),
    });
    assert.equal(adminRollover.status, 200);
    assert.equal(adminRollover.body.closedSeason.seasonNumber, 1);
    assert.equal(adminRollover.body.closedSeason.status, 'completed');
    assert.equal(adminRollover.body.newSeason.seasonNumber, 2);
    assert.equal(adminRollover.body.newSeason.status, 'active');

    const ovSeason2 = await apiJson<{ ok: boolean; overview: BattlePassOverview }>(
      baseHttp,
      `/api/battle-pass/overview?playerId=${encodeURIComponent(p1.playerId)}`,
      { token: p1.playerToken },
    );
    assert.equal(ovSeason2.body.overview.season.seasonNumber, 2);
    assert.equal(ovSeason2.body.overview.playerState.seasonXp, 0);
    assert.equal(ovSeason2.body.overview.pastSeasons.length, 1);
    assert.equal(ovSeason2.body.overview.pastSeasons[0].season.seasonNumber, 1);
    assert(ovSeason2.body.overview.pastSeasons[0].seasonXp >= 210);

    const profilePost = await apiJson<{
      profile: { elo: number; xp: number; stats: { wins: number } };
    }>(baseHttp, `/api/players/profile/${encodeURIComponent(p1.playerId)}`);
    const walletPost = await apiJson<{ wallet: { balance: number } }>(
      baseHttp,
      `/api/economy/wallet?playerId=${encodeURIComponent(p1.playerId)}`,
      { token: p1.playerToken },
    );
    assert.equal(profilePost.body.profile.elo, profilePre.body.profile.elo);
    assert.equal(profilePost.body.profile.xp, profilePre.body.profile.xp);
    assert.equal(profilePost.body.profile.stats.wins, profilePre.body.profile.stats.wins);
    assert.equal(walletPost.body.wallet.balance, walletPre.body.wallet.balance);

    console.log(
      'PASS [2] Live Wrangler HTTP + WebSocket: Online match progression, AI validation, mission/tier claims, coin ledger, and admin rollover verified',
    );
    console.log('\nPhase 11 Daily Missions, Weekly Challenges & Battle Pass: ALL SUITES PASSED.');
  } catch (err) {
    console.error('\n--- Wrangler Phase 11 Logs ---\n', logs);
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
