import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import {
  calculateEloUpdate,
  ELO_CONFIG,
} from '../src/multiplayer/shared/progression';
import {
  calculateSoftResetElo,
  computeAllowedRankedEloSpread,
  detectRankTransition,
  getRankForElo,
  getRankProgress,
  RANK_TIERS_CONFIG,
  SEASON_CONFIG,
  type CompetitiveSeasonRecord,
  type PlayerModerationStatus,
  type PlayerSeasonStanding,
} from '../src/multiplayer/shared/ranked';
import type {
  ClientToServerMessage,
  MatchHistoryRecord,
  ServerToClientMessage,
} from '../src/multiplayer/shared/protocol';

const CF_PORT = 8795;
const CF_STATE_DIR = '/tmp/cf-phase10-ranked-state';
const ORIGIN = 'https://test-user.github.io';
const ADMIN_SECRET = 'phase10_test_admin_secret_2026';

class RankedWsClient {
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

  public async resumeRoom(roomId: string): Promise<RankedWsClient> {
    const roomClient = new RankedWsClient(this.baseWsUrl, this.origin);
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
      // Waiting for startup
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Timed out waiting for wrangler dev (Phase 10 Ranked test)');
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

function createInMemoryMockSqlDb() {
  const tables = new Map<string, Array<Record<string, unknown>>>();

  const getRows = (name: string) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  };

  return {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) {
          args = values;
          return stmt;
        },
        async run() {
          const norm = sql.trim().replace(/\s+/g, ' ');
          if (norm.startsWith('INSERT INTO anticheat_flags')) {
            getRows('anticheat_flags').push({
              flag_id: args[0],
              player_id: args[1],
              match_id: args[2],
              category: args[3],
              severity: args[4],
              action_recommended: args[5],
              evidence_summary: args[6],
              metadata_json: args[7],
              status: 'open',
              created_at_ms: args[8],
            });
          } else if (norm.startsWith('INSERT OR IGNORE INTO match_integrity_audit')) {
            const rows = getRows('match_integrity_audit');
            if (!rows.some((r) => r.match_id === args[0])) {
              rows.push({
                match_id: args[0],
                room_id: args[1],
                match_mode: args[2],
                player1_id: args[3],
                player2_id: args[4],
                winner_id: args[5],
                completion_type: args[6],
                total_shots: args[7],
                duration_sec: args[8],
                p1_rejected_inputs: args[9],
                p2_rejected_inputs: args[10],
                min_shot_interval_ms: args[11],
                flagged: args[12],
                flag_reasons_json: args[13],
                audited_at_ms: args[14],
              });
            }
          } else if (norm.startsWith('INSERT INTO player_penalties')) {
            getRows('player_penalties').push({
              penalty_id: args[0],
              player_id: args[1],
              penalty_type: args[2],
              reason: args[3],
              issued_by: args[4],
              issued_at_ms: args[5],
              expires_at_ms: args[6],
              revoked_at_ms: null,
              revoked_by: null,
            });
          }
          return { meta: { changes: 1 } };
        },
        async first<T = Record<string, unknown>>() {
          const norm = sql.trim().replace(/\s+/g, ' ');
          if (norm.includes('FROM match_integrity_audit WHERE match_id =')) {
            return (getRows('match_integrity_audit').find((r) => r.match_id === args[0]) as T) ?? null;
          }
          if (norm.includes('SELECT COUNT(*) AS cnt FROM match_integrity_audit')) {
            return { cnt: 0 } as T;
          }
          if (norm.includes('SUM(CASE WHEN winner_id')) {
            return { cnt: 0, p1_wins: 0, p2_wins: 0 } as T;
          }
          return null;
        },
        async all<T = Record<string, unknown>>() {
          const norm = sql.trim().replace(/\s+/g, ' ');
          if (norm.includes('FROM anticheat_flags')) {
            return { results: getRows('anticheat_flags') as T[] };
          }
          if (norm.includes('FROM player_penalties')) {
            const pid = args[0];
            const filtered = pid
              ? getRows('player_penalties').filter((r) => r.player_id === pid)
              : getRows('player_penalties');
            return { results: filtered as T[] };
          }
          return { results: [] };
        },
      };
      return stmt;
    },
  };
}

async function runSuite1PureMathAndPolicy(): Promise<void> {
  // 1. Expected-score ELO math & K-factors
  const equal = calculateEloUpdate({
    player1Elo: 1200,
    player2Elo: 1200,
    player1Matches: 0,
    player2Matches: 0,
    winnerRole: 'player1',
  });
  assert.equal(equal.expected1, 0.5);
  assert.equal(equal.expected2, 0.5);
  assert.equal(equal.k1, ELO_CONFIG.kProvisional);
  assert.equal(equal.player1Delta, 20);
  assert.equal(equal.player2Delta, -20);

  const upset = calculateEloUpdate({
    player1Elo: 1200,
    player2Elo: 1600,
    player1Matches: 20,
    player2Matches: 20,
    winnerRole: 'player1',
  });
  assert(Math.abs(upset.expected1 - 1 / (1 + Math.pow(10, 400 / 400))) < 1e-6);
  assert.equal(upset.k1, ELO_CONFIG.kStandard);
  assert.equal(upset.player1Delta, 22);

  const master = calculateEloUpdate({
    player1Elo: 2150,
    player2Elo: 2150,
    player1Matches: 25,
    player2Matches: 25,
    winnerRole: 'player1',
  });
  assert.equal(master.k1, ELO_CONFIG.kMaster);
  assert.equal(master.player1Delta, 8);

  // 2. All 7 Rank Tiers & Transitions
  assert.equal(RANK_TIERS_CONFIG.length, 7);
  assert.equal(getRankForElo(900).id, 'bronze');
  assert.equal(getRankForElo(1050).id, 'silver');
  assert.equal(getRankForElo(1250).id, 'gold');
  assert.equal(getRankForElo(1450).id, 'platinum');
  assert.equal(getRankForElo(1650).id, 'diamond');
  assert.equal(getRankForElo(1900).id, 'master');
  assert.equal(getRankForElo(2150).id, 'grandmaster');

  const promo = detectRankTransition(1240, 1260);
  assert.equal(promo.direction, 'promoted');
  assert.equal(promo.fromTier.id, 'silver');
  assert.equal(promo.toTier.id, 'gold');

  const demo = detectRankTransition(1255, 1235);
  assert.equal(demo.direction, 'demoted');
  assert.equal(demo.fromTier.id, 'gold');
  assert.equal(demo.toTier.id, 'silver');

  const gmProg = getRankProgress(2300);
  assert.equal(gmProg.next, null);
  assert.equal(gmProg.progressRatio, 1);

  // 3. Progressive ELO spread & Soft Reset
  assert.equal(computeAllowedRankedEloSpread(0), 75);
  assert.equal(computeAllowedRankedEloSpread(4), 125);
  assert.equal(computeAllowedRankedEloSpread(8), 175);
  assert.equal(computeAllowedRankedEloSpread(999), 500);

  assert.equal(calculateSoftResetElo(2150), 1675);
  assert.equal(calculateSoftResetElo(800), 1000);
  assert.equal(calculateSoftResetElo(0), 600);
  assert.equal(calculateSoftResetElo(-1500), SEASON_CONFIG.minElo);

  // 4. Statistical high-streak anomaly NEVER auto-bans & requires admin for suspensions
  const acModPath = ['..', 'cloudflare', 'src', 'AntiCheatService'].join('/');
  const { AntiCheatService } = (await import(acModPath)) as {
    AntiCheatService: new (db: unknown) => {
      inspectCompletedMatch: (input: Record<string, unknown>) => Promise<{
        flagged: boolean;
        reasons: string[];
      }>;
      getPlayerRestriction: (playerId: string) => Promise<{
        blockedFromOnline: boolean;
        blockedFromRanked: boolean;
        activePenalties: unknown[];
      }>;
      issuePenalty: (params: Record<string, unknown>) => Promise<
        | { ok: true }
        | { ok: false; code: string }
      >;
    };
  };
  const mockDb = createInMemoryMockSqlDb();
  const ac = new AntiCheatService(mockDb);
  const auditRes = await ac.inspectCompletedMatch({
    matchId: 'm_streak_only_1',
    roomId: 'room_streak_1',
    matchMode: 'ranked',
    player1Id: 'ply_streak_ace',
    player2Id: 'ply_opponent',
    winnerRole: 'player1',
    winnerId: 'ply_streak_ace',
    completionType: 'legal_8ball',
    totalShots: 14,
    durationSec: 180,
    p1RejectedInputs: 0,
    p2RejectedInputs: 0,
    minShotIntervalMs: 4200,
    p1WinStreakAfter: 14,
    p2WinStreakAfter: 0,
    endedAtMs: Date.now(),
  });
  assert.equal(auditRes.flagged, true);
  assert(auditRes.reasons.includes('statistical_win_streak:ply_streak_ace'));

  const restrictionAfterStreak = await ac.getPlayerRestriction('ply_streak_ace');
  assert.equal(restrictionAfterStreak.blockedFromOnline, false);
  assert.equal(restrictionAfterStreak.blockedFromRanked, false);
  assert.equal(restrictionAfterStreak.activePenalties.length, 0);

  const nonAdminPermBan = await ac.issuePenalty({
    playerId: 'ply_streak_ace',
    penaltyType: 'permanent_suspension',
    reason: 'Attempted automated ban',
    issuedBy: 'anticheat_system',
    isAdmin: false,
  });
  assert.equal(nonAdminPermBan.ok, false);
  if (!nonAdminPermBan.ok) {
    assert.equal(nonAdminPermBan.code, 'ADMIN_REQUIRED');
  }

  console.log('PASS [1] ELO math, 7 rank tiers, spread expansion, soft-reset & zero auto-ban policy verified');
}

async function main() {
  await runSuite1PureMathAndPolicy();

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

    const player1 = await createPlayer(baseHttp, 'RankedAlpha', 'cue_gold');
    const player2 = await createPlayer(baseHttp, 'RankedBravo', 'shark_sky');
    const player3 = await createPlayer(baseHttp, 'QuickGamma', 'eight_obsidian');

    // =========================================================================
    // [2] Queue Isolation, Same-Account Self-Match Guard, Disconnect Cleanup & Ranked Pair
    // =========================================================================
    const ws1 = new RankedWsClient(baseWs, ORIGIN);
    const ws1Dup = new RankedWsClient(baseWs, ORIGIN);
    const ws2 = new RankedWsClient(baseWs, ORIGIN);
    const ws3 = new RankedWsClient(baseWs, ORIGIN);

    await Promise.all([ws1.connect(), ws1Dup.connect(), ws2.connect(), ws3.connect()]);
    await Promise.all([
      ws1.initSession('RankedAlpha', player1),
      ws1Dup.initSession('RankedAlpha', player1),
      ws2.initSession('RankedBravo', player2),
      ws3.initSession('QuickGamma', player3),
    ]);

    // Quick player joins first -> Ranked player joins -> MUST NOT match across queues!
    ws3.send({
      type: 'matchmaking:join',
      mode: 'quick',
      ruleProfileId: 'wpa',
      calledShotsEnabled: true,
    });
    const quickSearching = await ws3.waitFor<Extract<ServerToClientMessage, { type: 'matchmaking:searching' }>>(
      (m) => m.type === 'matchmaking:searching',
    );
    assert.equal(quickSearching.mode, 'quick');

    ws1.send({
      type: 'matchmaking:join',
      mode: 'ranked',
      ruleProfileId: 'wpa',
      calledShotsEnabled: true,
    });
    const rankedSearching1 = await ws1.waitFor<Extract<ServerToClientMessage, { type: 'matchmaking:searching' }>>(
      (m) => m.type === 'matchmaking:searching',
    );
    assert.equal(rankedSearching1.mode, 'ranked');
    assert.equal(rankedSearching1.elo, 1200);
    assert.equal(rankedSearching1.eloSpread, 75);

    // Same-account second socket trying to queue -> ALREADY_IN_MATCH
    ws1Dup.send({
      type: 'matchmaking:join',
      mode: 'ranked',
      ruleProfileId: 'wpa',
      calledShotsEnabled: true,
    });
    const dupErr = await ws1Dup.waitFor<Extract<ServerToClientMessage, { type: 'error' }>>(
      (m) => m.type === 'error',
    );
    assert.equal(dupErr.code, 'ALREADY_IN_MATCH');
    await ws1Dup.close();

    // Wait 350ms to assert ws1 and ws3 remain isolated
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(
      ws1.queue.some((m) => m.type === 'matchmaking:matched'),
      false,
      'Ranked player must never match with Quick queue player',
    );

    // Disconnect quick player -> removed from queue
    await ws3.close();

    // Player 2 joins ranked -> matches Player 1!
    ws2.send({
      type: 'matchmaking:join',
      mode: 'ranked',
      ruleProfileId: 'wpa',
      calledShotsEnabled: true,
    });
    const [found1, found2] = await Promise.all([
      ws1.waitFor<Extract<ServerToClientMessage, { type: 'matchmaking:matched' }>>(
        (m) => m.type === 'matchmaking:matched',
      ),
      ws2.waitFor<Extract<ServerToClientMessage, { type: 'matchmaking:matched' }>>(
        (m) => m.type === 'matchmaking:matched',
      ),
    ]);
    assert.equal(found1.room.roomId, found2.room.roomId);
    assert.equal(found1.room.matchType, 'ranked');
    assert.equal(found1.room.ruleProfileId, 'wpa');
    console.log('PASS [2] Ranked/Quick isolation, same-account guard, disconnect cleanup & ranked pairing verified');

    // =========================================================================
    // [3] Live Ranked Match, CHEAT_REJECTED Bounds Validation, ELO/Season Updates & Filtering
    // =========================================================================
    const roomWs1 = await ws1.resumeRoom(found1.room.roomId);
    const roomWs2 = await ws2.resumeRoom(found1.room.roomId);
    roomWs1.clearQueue();
    roomWs2.clearQueue();
    assert.equal(found1.room.status, 'playing');

    // Anti-cheat payload rejection tests (active player 1)
    roomWs1.send({
      type: 'game:shoot',
      shotToken: 'cheat_power_1',
      cueAngle: 0,
      power: 1.5,
      spinX: 0,
      spinY: 0,
      calledBall: null,
      calledPocket: null,
    });
    const errPower = await roomWs1.waitFor<Extract<ServerToClientMessage, { type: 'error' }>>(
      (m) => m.type === 'error',
    );
    assert.equal(errPower.code, 'CHEAT_REJECTED');

    roomWs1.send({
      type: 'game:shoot',
      shotToken: 'cheat_spin_1',
      cueAngle: 0,
      power: 0.5,
      spinX: 0.99,
      spinY: 0.99,
      calledBall: null,
      calledPocket: null,
    });
    const errSpin = await roomWs1.waitFor<Extract<ServerToClientMessage, { type: 'error' }>>(
      (m) => m.type === 'error',
    );
    assert.equal(errSpin.code, 'CHEAT_REJECTED');

    roomWs1.send({
      type: 'game:aim',
      cueAngle: 50000,
    });
    const errAim = await roomWs1.waitFor<Extract<ServerToClientMessage, { type: 'error' }>>(
      (m) => m.type === 'error',
    );
    assert.equal(errAim.code, 'CHEAT_REJECTED');

    roomWs1.send({
      type: 'game:spin',
      x: 2.0,
      y: 2.0,
    });
    const errSpinPreview = await roomWs1.waitFor<Extract<ServerToClientMessage, { type: 'error' }>>(
      (m) => m.type === 'error',
    );
    assert.equal(errSpinPreview.code, 'CHEAT_REJECTED');

    // Execute legal break shot so match qualifies for full ELO + Season rewards
    roomWs1.send({
      type: 'game:shoot',
      shotToken: 'p10_ranked_break_1',
      cueAngle: 0,
      power: 0.8,
      spinX: 0,
      spinY: 0,
      calledBall: null,
      calledPocket: null,
    });
    await roomWs1.waitFor((m) => m.type === 'match:settled', 15000, 'ranked match:settled');

    roomWs2.send({ type: 'game:forfeit' });
    const rankedOver = await roomWs1.waitFor<Extract<ServerToClientMessage, { type: 'match:over' }>>(
      (m) => m.type === 'match:over',
      10000,
      'ranked match:over',
    );
    assert.equal(rankedOver.room.matchType, 'ranked');
    assert.equal(rankedOver.progression?.rankedApplied, true);
    assert.equal(rankedOver.progression?.matchType, 'ranked');
    assert.equal(rankedOver.progression?.seasonId, 'season_1');
    const p1Delta = rankedOver.progression!.players.player1;
    const p2Delta = rankedOver.progression!.players.player2;
    assert.equal(p1Delta.eloBefore, 1200);
    assert.equal(p1Delta.eloAfter, 1220);
    assert.equal(p1Delta.eloDelta, 20);
    assert.equal(p1Delta.seasonEloBefore, 1200);
    assert.equal(p1Delta.seasonEloAfter, 1220);
    assert.equal(p1Delta.seasonEloDelta, 20);
    assert.equal(p1Delta.expectedScore, 0.5);
    assert.equal(p1Delta.kFactor, 40);
    assert.equal(p2Delta.eloAfter, 1180);

    // Check seasons, standings, season leaderboard & filtered history
    const seasonsRes = await apiJson<{
      ok: boolean;
      activeSeason: CompetitiveSeasonRecord;
      seasons: CompetitiveSeasonRecord[];
    }>(baseHttp, '/api/ranked/seasons');
    assert.equal(seasonsRes.status, 200);
    assert.equal(seasonsRes.body.activeSeason.seasonId, 'season_1');
    assert.equal(seasonsRes.body.activeSeason.status, 'active');

    const standingRes = await apiJson<{ ok: boolean; standing: PlayerSeasonStanding }>(
      baseHttp,
      `/api/ranked/standing/${encodeURIComponent(player1.playerId)}`,
    );
    assert.equal(standingRes.status, 200);
    assert.equal(standingRes.body.standing.seasonElo, 1220);
    assert.equal(standingRes.body.standing.wins, 1);

    const seasonLbRes = await apiJson<{
      items: Array<{ playerId: string; elo: number; rankTier?: { id: string } }>;
      season?: CompetitiveSeasonRecord;
    }>(baseHttp, '/api/leaderboard?scope=season&seasonId=season_1');
    assert.equal(seasonLbRes.status, 200);
    assert.equal(seasonLbRes.body.items[0].playerId, player1.playerId);
    assert.equal(seasonLbRes.body.items[0].elo, 1220);
    assert.equal(seasonLbRes.body.items[0].rankTier?.id, 'silver');

    const histRankedRes = await apiJson<{ matches: MatchHistoryRecord[] }>(
      baseHttp,
      `/api/matches/history?playerId=${encodeURIComponent(player1.playerId)}&matchType=ranked`,
    );
    assert.equal(histRankedRes.status, 200);
    assert.equal(histRankedRes.body.matches.length, 1);
    assert.equal(histRankedRes.body.matches[0].matchId, rankedOver.match.matchId);
    assert.equal(histRankedRes.body.matches[0].p1EloAfter, 1220);

    const histPrivateEmptyRes = await apiJson<{ matches: MatchHistoryRecord[] }>(
      baseHttp,
      `/api/matches/history?playerId=${encodeURIComponent(player1.playerId)}&matchType=private`,
    );
    assert.equal(histPrivateEmptyRes.body.matches.length, 0);

    console.log('PASS [3] Ranked match telemetry, CHEAT_REJECTED guards, season ELO & matchType filtering verified');

    // =========================================================================
    // [4] Admin Auth Guards + Rapid Forfeit Pattern -> manual_review Only (Zero Auto-Ban)
    // =========================================================================
    const unauthFlags = await apiJson(baseHttp, '/api/admin/moderation/flags');
    assert.equal(unauthFlags.status, 403);
    const badSecretPenalty = await apiJson(baseHttp, '/api/admin/moderation/penalties', {
      method: 'POST',
      adminKey: 'wrong_secret_xyz',
      body: JSON.stringify({
        playerId: player2.playerId,
        penaltyType: 'ranked_restriction',
        reason: 'Unauthorized attempt',
      }),
    });
    assert.equal(badSecretPenalty.status, 403);

    // Note: Ranked match #1 above also rejected 4 tampered inputs by player1 (above warn threshold 3 -> manual_review)
    // Now trigger 3 rapid <=1-shot forfeits via rematches by player2 -> triggers rapid_forfeit_pattern flag
    for (let i = 1; i <= 3; i++) {
      roomWs1.send({ type: 'room:rematch' });
      roomWs2.send({ type: 'room:rematch' });
      await Promise.all([
        roomWs1.waitFor((m) => m.type === 'match:rematch_started'),
        roomWs2.waitFor((m) => m.type === 'match:rematch_started'),
      ]);
      roomWs2.send({ type: 'game:forfeit' });
      await Promise.all([
        roomWs1.waitFor((m) => m.type === 'match:over'),
        roomWs2.waitFor((m) => m.type === 'match:over'),
      ]);
    }

    const adminFlagsRes = await apiJson<{
      flags: Array<{ category: string; player_id: string; action_recommended: string }>;
    }>(baseHttp, '/api/admin/moderation/flags', { adminKey: ADMIN_SECRET });
    assert.equal(adminFlagsRes.status, 200);
    assert(
      adminFlagsRes.body.flags.some(
        (f) =>
          f.player_id === player2.playerId &&
          f.category === 'rapid_forfeit_pattern' &&
          f.action_recommended === 'manual_review',
      ),
      'Expected rapid_forfeit_pattern manual_review flag for player2',
    );
    assert(
      adminFlagsRes.body.flags.some(
        (f) =>
          f.player_id === player1.playerId &&
          f.category === 'tampered_input_burst',
      ),
      'Expected tampered_input_burst flag for rejected cheat inputs in match 1',
    );

    // Player 2 must NOT be auto-banned from statistical/rapid-forfeit flags
    const modStatus2Clean = await apiJson<{ moderation: PlayerModerationStatus }>(
      baseHttp,
      `/api/moderation/status?playerId=${encodeURIComponent(player2.playerId)}`,
      { token: player2.playerToken },
    );
    assert.equal(modStatus2Clean.status, 200);
    assert.equal(modStatus2Clean.body.moderation.canPlayOnline, true);
    assert.equal(modStatus2Clean.body.moderation.canPlayRanked, true);
    const modJsonRaw = JSON.stringify(modStatus2Clean.body);
    assert.equal(modJsonRaw.includes('tamperInputWarnThreshold'), false);
    assert.equal(modJsonRaw.includes('rapidForfeitBurstCount'), false);

    roomWs1.send({ type: 'room:leave' });
    roomWs2.send({ type: 'room:leave' });
    await new Promise((r) => setTimeout(r, 150));
    await roomWs1.close();
    await roomWs2.close();
    console.log('PASS [4] Admin secret guards, rapid-forfeit manual_review flagging & threshold sanitization verified');

    // =========================================================================
    // [5] Moderation Penalty Enforcement (RANKED_RESTRICTED & SUSPENDED) + Appeals Lifecycle
    // =========================================================================
    const issuePenaltyRes = await apiJson<{ penalty: { penaltyId: string; penaltyType: string } }>(
      baseHttp,
      '/api/admin/moderation/penalties',
      {
        method: 'POST',
        adminKey: ADMIN_SECRET,
        body: JSON.stringify({
          playerId: player2.playerId,
          penaltyType: 'ranked_restriction',
          reason: 'Ranked queue unsporting forfeit pattern.',
          durationMs: 3600000,
        }),
      },
    );
    assert.equal(issuePenaltyRes.status, 200);
    const penaltyId = issuePenaltyRes.body.penalty.penaltyId;

    // Player 2 tries to enter Ranked queue -> rejected with RANKED_RESTRICTED
    ws2.clearQueue();
    ws2.send({
      type: 'matchmaking:join',
      mode: 'ranked',
      ruleProfileId: 'wpa',
      calledShotsEnabled: true,
    });
    const rankedRestrictedErr = await ws2.waitFor<Extract<ServerToClientMessage, { type: 'error' }>>(
      (m) => m.type === 'error',
    );
    assert.equal(rankedRestrictedErr.code, 'RANKED_RESTRICTED');

    // Player 2 can still create a Private room while Ranked-restricted
    ws2.send({
      type: 'room:create',
      isPrivate: true,
      ruleProfileId: 'casual',
      calledShotsEnabled: false,
    });
    const privCreated = await ws2.waitFor<Extract<ServerToClientMessage, { type: 'room:created' }>>(
      (m) => m.type === 'room:created',
    );
    assert.equal(privCreated.room.isPrivate, true);
    const privRoomWs2 = await ws2.resumeRoom(privCreated.room.roomId);
    privRoomWs2.send({ type: 'room:cancel' });
    await privRoomWs2.waitFor((m) => m.type === 'room:closed');
    await privRoomWs2.close();

    // Player 2 submits appeal
    const appealRes = await apiJson<{ appeal: { appealId: string; status: string } }>(
      baseHttp,
      '/api/moderation/appeals',
      {
        method: 'POST',
        token: player2.playerToken,
        body: JSON.stringify({
          playerId: player2.playerId,
          penaltyId,
          message: 'My connection dropped during rematch warmups. Requesting ranked access review.',
        }),
      },
    );
    assert.equal(appealRes.status, 200);
    assert.equal(appealRes.body.appeal.status, 'pending');

    // Duplicate pending appeal blocked (409)
    const dupAppeal = await apiJson(baseHttp, '/api/moderation/appeals', {
      method: 'POST',
      token: player2.playerToken,
      body: JSON.stringify({
        playerId: player2.playerId,
        penaltyId,
        message: 'Second duplicate appeal attempt.',
      }),
    });
    assert.equal(dupAppeal.status, 409);

    // Admin approves appeal -> automatically revokes penalty
    const reviewRes = await apiJson<{ appeal: { status: string } }>(
      baseHttp,
      `/api/admin/moderation/appeals/${encodeURIComponent(appealRes.body.appeal.appealId)}/review`,
      {
        method: 'POST',
        adminKey: ADMIN_SECRET,
        body: JSON.stringify({
          decision: 'approved',
          adminNotes: 'Verified first incident; penalty lifted.',
        }),
      },
    );
    assert.equal(reviewRes.status, 200);
    assert.equal(reviewRes.body.appeal.status, 'approved');

    // Player 2 can now join Ranked queue again
    ws2.clearQueue();
    ws2.send({
      type: 'matchmaking:join',
      mode: 'ranked',
      ruleProfileId: 'wpa',
      calledShotsEnabled: true,
    });
    const restoredSearching = await ws2.waitFor<Extract<ServerToClientMessage, { type: 'matchmaking:searching' }>>(
      (m) => m.type === 'matchmaking:searching',
    );
    assert.equal(restoredSearching.mode, 'ranked');
    ws2.send({ type: 'matchmaking:cancel' });
    await ws2.waitFor((m) => m.type === 'matchmaking:cancelled');

    // Verify temp_suspension blocks room:create with SUSPENDED, then revoke it
    const suspRes = await apiJson<{ penalty: { penaltyId: string } }>(
      baseHttp,
      '/api/admin/moderation/penalties',
      {
        method: 'POST',
        adminKey: ADMIN_SECRET,
        body: JSON.stringify({
          playerId: player2.playerId,
          penaltyType: 'temp_suspension',
          reason: 'Temporary online verification test.',
          durationMs: 600000,
        }),
      },
    );
    assert.equal(suspRes.status, 200);
    ws2.send({
      type: 'room:create',
      isPrivate: true,
      ruleProfileId: 'casual',
      calledShotsEnabled: false,
    });
    const suspErr = await ws2.waitFor<Extract<ServerToClientMessage, { type: 'error' }>>(
      (m) => m.type === 'error',
    );
    assert.equal(suspErr.code, 'SUSPENDED');

    await apiJson(
      baseHttp,
      `/api/admin/moderation/penalties/${encodeURIComponent(suspRes.body.penalty.penaltyId)}/revoke`,
      {
        method: 'POST',
        adminKey: ADMIN_SECRET,
        body: JSON.stringify({ notes: 'Test completed' }),
      },
    );
    console.log('PASS [5] Ranked restriction, online suspension, appeal submission & admin approval revocation verified');

    // =========================================================================
    // [6] Season Rollover, Rewards Ledger Idempotency & Lifetime ELO Preservation
    // =========================================================================
    const profBeforeRes = await apiJson<{
      profile: { elo: number; stats: { wins: number } };
    }>(baseHttp, `/api/players/profile/${encodeURIComponent(player1.playerId)}`);
    const walletBeforeRes = await apiJson<{ wallet: { balance: number } }>(
      baseHttp,
      `/api/economy/wallet?playerId=${encodeURIComponent(player1.playerId)}`,
      { token: player1.playerToken },
    );

    const rolloverRes = await apiJson<{
      previousSeason: CompetitiveSeasonRecord;
      newSeason: CompetitiveSeasonRecord;
      rewardsDistributedCount: number;
      playersResetCount: number;
    }>(baseHttp, '/api/admin/seasons/rollover', {
      method: 'POST',
      adminKey: ADMIN_SECRET,
      body: JSON.stringify({ newSeasonName: 'Season 2 — Diamond Circuit' }),
    });
    assert.equal(rolloverRes.status, 200);
    assert.equal(rolloverRes.body.previousSeason.seasonId, 'season_1');
    assert.equal(rolloverRes.body.previousSeason.status, 'completed');
    assert.equal(rolloverRes.body.newSeason.seasonId, 'season_2');
    assert.equal(rolloverRes.body.newSeason.status, 'active');
    assert(rolloverRes.body.rewardsDistributedCount >= 2);
    assert(rolloverRes.body.playersResetCount >= 2);

    // Check wallet received Season 1 silver reward (+150 POOL COINS) & ledger recorded season_reward
    const walletAfterRes = await apiJson<{ wallet: { balance: number } }>(
      baseHttp,
      `/api/economy/wallet?playerId=${encodeURIComponent(player1.playerId)}`,
      { token: player1.playerToken },
    );
    assert.equal(
      walletAfterRes.body.wallet.balance,
      walletBeforeRes.body.wallet.balance + SEASON_CONFIG.rewardsByTier.silver.coins,
    );

    const txAfterRes = await apiJson<{ transactions: Array<{ reason: string; amount: number }> }>(
      baseHttp,
      `/api/economy/transactions?playerId=${encodeURIComponent(player1.playerId)}`,
      { token: player1.playerToken },
    );
    assert(
      txAfterRes.body.transactions.some(
        (tx) => tx.reason === 'season_reward' && tx.amount === SEASON_CONFIG.rewardsByTier.silver.coins,
      ),
    );

    // Lifetime career ELO & wins preserved; Season 2 ELO soft-reset
    const profAfterRes = await apiJson<{
      profile: {
        elo: number;
        stats: { wins: number };
        seasonStanding: PlayerSeasonStanding | null;
      };
    }>(baseHttp, `/api/players/profile/${encodeURIComponent(player1.playerId)}`);
    assert.equal(profAfterRes.body.profile.elo, profBeforeRes.body.profile.elo);
    assert.equal(profAfterRes.body.profile.stats.wins, profBeforeRes.body.profile.stats.wins);
    assert.equal(profAfterRes.body.profile.seasonStanding?.seasonId, 'season_2');
    assert.equal(
      profAfterRes.body.profile.seasonStanding?.seasonElo,
      calculateSoftResetElo(1220),
    );

    // Season 1 historical leaderboard still queryable
    const season1HistLb = await apiJson<{
      season?: CompetitiveSeasonRecord;
      items: Array<{ playerId: string; elo: number }>;
    }>(baseHttp, '/api/leaderboard?scope=season&seasonId=season_1');
    assert.equal(season1HistLb.body.season?.seasonId, 'season_1');
    assert.equal(season1HistLb.body.items[0].playerId, player1.playerId);
    assert.equal(season1HistLb.body.items[0].elo, 1220);

    await ws1.close();
    await ws2.close();
    console.log('PASS [6] Season rollover, POOL COINS reward ledger & lifetime ELO preservation verified');
    console.log('\nPhase 10 Global ELO Ranking, Ranked Matchmaking & Anti-Cheat: ALL 6 SUITES PASSED.');
  } catch (err) {
    console.error('\n--- Wrangler Phase 10 Logs ---\n', logs);
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
