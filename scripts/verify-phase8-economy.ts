import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import {
  BALL_SPECS,
  CLOTH_PHYSICS,
  POCKET_POSITIONS,
  TABLE_DIMENSIONS,
} from '../src/game/utils/constants';
import {
  COSMETIC_CATALOG,
  DAILY_LOGIN_SCHEDULE,
  DEFAULT_EQUIPPED_COSMETICS,
  ECONOMY_CONFIG,
  STARTER_COSMETIC_IDS,
  type AiMatchRewardResponse,
  type CoinTransactionRecord,
  type CosmeticItemDef,
  type DailyClaimResponse,
  type EquipCosmeticResponse,
  type EquippedCosmetics,
  type PlayerCosmeticSnapshot,
  type PurchaseItemResponse,
} from '../src/multiplayer/shared/economy';
import type {
  ClientToServerMessage,
  OnlineRoomInfo,
  ServerToClientMessage,
} from '../src/multiplayer/shared/protocol';

const CF_PORT = 8793;
const CF_STATE_DIR = '/tmp/cf-phase8-economy-state';
const ORIGIN = 'https://test-user.github.io';

class EconomyWsClient {
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
    timeoutMs = 10000,
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

  public async resumeRoom(roomId: string): Promise<EconomyWsClient> {
    const roomClient = new EconomyWsClient(this.baseWsUrl, this.origin);
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
      // Wait for startup
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Timed out waiting for wrangler dev (Phase 8 Economy test)');
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
  // =========================================================================
  // [1] Physics Constants Integrity & Strictly Cosmetic Catalog Audit
  // =========================================================================
  assert.equal(TABLE_DIMENSIONS.playLength, 2.54);
  assert.equal(TABLE_DIMENSIONS.playWidth, 1.27);
  assert.equal(BALL_SPECS.radius, 0.028575);
  assert.equal(POCKET_POSITIONS.length, 6);
  assert.equal(CLOTH_PHYSICS.slideMu, 0.21);
  assert.equal(CLOTH_PHYSICS.rollMu, 0.014);
  assert(COSMETIC_CATALOG.length >= 25);

  const categoriesSeen = new Set(COSMETIC_CATALOG.map((item) => item.category));
  for (const requiredCat of [
    'cue',
    'ball',
    'table',
    'avatar',
    'nameplate',
    'badge',
    'victory',
    'decoration',
  ] as const) {
    assert(categoriesSeen.has(requiredCat), `Missing catalog category: ${requiredCat}`);
  }
  for (const item of COSMETIC_CATALOG) {
    assert.equal('powerBoost' in (item as unknown as Record<string, unknown>), false);
    assert.equal('aimAssist' in (item as unknown as Record<string, unknown>), false);
    assert.equal('spinBonus' in (item as unknown as Record<string, unknown>), false);
    assert(item.price >= 0 && Number.isInteger(item.price));
  }
  console.log('PASS [1] Physics constants intact & catalog verified strictly cosmetic across all 8 categories');

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
    // [2] Store Catalog, Auth Guards & Starter Wallet Bootstrap
    // =========================================================================
    const catalogRes = await apiJson<{
      ok: boolean;
      currencyName: string;
      catalog: CosmeticItemDef[];
      dailySchedule: typeof DAILY_LOGIN_SCHEDULE;
    }>(baseHttp, '/api/store/catalog');
    assert.equal(catalogRes.status, 200);
    assert.equal(catalogRes.body.currencyName, ECONOMY_CONFIG.currencyName);
    assert.equal(catalogRes.body.catalog.length, COSMETIC_CATALOG.length);
    assert.equal(catalogRes.body.dailySchedule.length, 7);

    const playerA = await createPlayer(baseHttp, 'EconAlpha', 'cue_gold');
    const playerB = await createPlayer(baseHttp, 'EconBravo', 'shark_sky');
    const playerC = await createPlayer(baseHttp, 'EconCharlie', 'eight_obsidian');

    // Unauthorized access guard
    const unauthWallet = await apiJson(
      baseHttp,
      `/api/economy/wallet?playerId=${encodeURIComponent(playerA.playerId)}`,
      { token: 'bad_token_123' },
    );
    assert.equal(unauthWallet.status, 401);

    const walletA0 = await apiJson<PlayerCosmeticSnapshot>(
      baseHttp,
      `/api/economy/wallet?playerId=${encodeURIComponent(playerA.playerId)}`,
      { token: playerA.playerToken },
    );
    assert.equal(walletA0.status, 200);
    assert.equal(walletA0.body.wallet.balance, ECONOMY_CONFIG.startingBalance);
    assert.equal(walletA0.body.wallet.totalEarned, ECONOMY_CONFIG.startingBalance);
    assert.equal(walletA0.body.wallet.totalSpent, 0);
    for (const starterId of STARTER_COSMETIC_IDS) {
      assert(walletA0.body.inventoryIds.includes(starterId), `Missing starter ${starterId}`);
    }
    assert.equal(walletA0.body.equipped.cueId, DEFAULT_EQUIPPED_COSMETICS.cueId);
    assert.equal(walletA0.body.equipped.tableId, DEFAULT_EQUIPPED_COSMETICS.tableId);
    console.log('PASS [2] Store catalog, auth guards & starter wallet bootstrap verified');

    // =========================================================================
    // [3] Daily Login Rewards & Duplicate Same-Day Prevention
    // =========================================================================
    const daily1 = await apiJson<DailyClaimResponse>(baseHttp, '/api/economy/daily-claim', {
      method: 'POST',
      token: playerA.playerToken,
      body: JSON.stringify({ playerId: playerA.playerId }),
    });
    assert.equal(daily1.status, 200);
    assert.equal(daily1.body.claimedAmount, DAILY_LOGIN_SCHEDULE[0].coins);
    assert.equal(daily1.body.streak, 1);
    assert.equal(
      daily1.body.wallet.balance,
      ECONOMY_CONFIG.startingBalance + DAILY_LOGIN_SCHEDULE[0].coins,
    );
    assert.equal(daily1.body.dailyReward.canClaim, false);
    assert.equal(daily1.body.dailyReward.claimedToday, true);
    assert(daily1.body.dailyReward.nextClaimAtMs > Date.now());

    // Duplicate claim on same UTC day must be blocked
    const dailyDup = await apiJson<{ error: string; nextClaimAtMs?: number }>(
      baseHttp,
      '/api/economy/daily-claim',
      {
        method: 'POST',
        token: playerA.playerToken,
        body: JSON.stringify({ playerId: playerA.playerId }),
      },
    );
    assert.equal(dailyDup.status, 409);
    assert.equal(dailyDup.body.error, 'ALREADY_CLAIMED');
    console.log('PASS [3] Daily login streak claim (+50 coins) & same-day duplicate guard verified');

    // =========================================================================
    // [4] AI Match Rewards & Anti-Abuse Validation
    // =========================================================================
    // Reject loss
    const aiLoss = await apiJson(baseHttp, '/api/economy/ai-reward', {
      method: 'POST',
      token: playerA.playerToken,
      body: JSON.stringify({
        playerId: playerA.playerId,
        clientMatchId: 'ai_match_loss_1',
        difficulty: 'legend',
        won: false,
        totalShots: 12,
        ballsPocketed: 7,
        durationSec: 60,
      }),
    });
    assert.equal(aiLoss.status, 400);
    assert.equal(aiLoss.body.error, 'MATCH_NOT_WON');

    // Reject too-short / anti-farm match
    const aiShort = await apiJson(baseHttp, '/api/economy/ai-reward', {
      method: 'POST',
      token: playerA.playerToken,
      body: JSON.stringify({
        playerId: playerA.playerId,
        clientMatchId: 'ai_match_short_1',
        difficulty: 'pro',
        won: true,
        totalShots: 1,
        ballsPocketed: 1,
        durationSec: 2,
      }),
    });
    assert.equal(aiShort.status, 400);
    assert.equal(aiShort.body.error, 'INVALID_MATCH_SUMMARY');

    // Valid Legend AI victory awards exact server-configured coins (110 -> balance = 260)
    const aiWin = await apiJson<AiMatchRewardResponse>(baseHttp, '/api/economy/ai-reward', {
      method: 'POST',
      token: playerA.playerToken,
      body: JSON.stringify({
        playerId: playerA.playerId,
        clientMatchId: 'ai_match_legend_1',
        difficulty: 'legend',
        won: true,
        totalShots: 14,
        ballsPocketed: 8,
        durationSec: 85,
      }),
    });
    assert.equal(aiWin.status, 200);
    assert.equal(aiWin.body.coinsAwarded, ECONOMY_CONFIG.aiMatch.rewardsByDifficulty.legend);
    assert.equal(aiWin.body.alreadyClaimed, false);
    assert.equal(aiWin.body.wallet.balance, 260);

    // Duplicate clientMatchId returns alreadyClaimed=true and does NOT add coins
    const aiDup = await apiJson<AiMatchRewardResponse>(baseHttp, '/api/economy/ai-reward', {
      method: 'POST',
      token: playerA.playerToken,
      body: JSON.stringify({
        playerId: playerA.playerId,
        clientMatchId: 'ai_match_legend_1',
        difficulty: 'legend',
        won: true,
        totalShots: 14,
        ballsPocketed: 8,
        durationSec: 85,
      }),
    });
    assert.equal(aiDup.status, 200);
    assert.equal(aiDup.body.alreadyClaimed, true);
    assert.equal(aiDup.body.wallet.balance, 260);

    // Immediate different AI claim triggers cooldown protection
    const aiCooldown = await apiJson(baseHttp, '/api/economy/ai-reward', {
      method: 'POST',
      token: playerA.playerToken,
      body: JSON.stringify({
        playerId: playerA.playerId,
        clientMatchId: 'ai_match_legend_2',
        difficulty: 'legend',
        won: true,
        totalShots: 10,
        ballsPocketed: 8,
        durationSec: 45,
      }),
    });
    assert.equal(aiCooldown.status, 429);
    assert.equal(aiCooldown.body.error, 'COOLDOWN_ACTIVE');
    console.log('PASS [4] AI victory rewards, duplicate claim idempotency, min-match & cooldown anti-abuse verified');

    // =========================================================================
    // [5] Store Purchase, Unowned/Balance Guards & Concurrency Race Safety
    // =========================================================================
    // Cannot equip unowned item
    const equipUnowned = await apiJson(baseHttp, '/api/economy/equip', {
      method: 'POST',
      token: playerA.playerToken,
      body: JSON.stringify({
        playerId: playerA.playerId,
        category: 'table',
        itemId: 'table_neon_arena',
      }),
    });
    assert.equal(equipUnowned.status, 403);
    assert.equal(equipUnowned.body.error, 'NOT_OWNED');

    // Insufficient funds guard
    const tooExpensive = await apiJson(baseHttp, '/api/economy/purchase', {
      method: 'POST',
      token: playerA.playerToken,
      body: JSON.stringify({
        playerId: playerA.playerId,
        itemId: 'table_neon_arena', // 3400 coins > 260
      }),
    });
    assert.equal(tooExpensive.status, 402);
    assert.equal(tooExpensive.body.error, 'INSUFFICIENT_FUNDS');

    // Concurrent same-item purchase race check on Player A (balance 260, item 220)
    const [raceA1, raceA2] = await Promise.all([
      apiJson<PurchaseItemResponse>(baseHttp, '/api/economy/purchase', {
        method: 'POST',
        token: playerA.playerToken,
        body: JSON.stringify({ playerId: playerA.playerId, itemId: 'nameplate_emerald_felt' }),
      }),
      apiJson<PurchaseItemResponse>(baseHttp, '/api/economy/purchase', {
        method: 'POST',
        token: playerA.playerToken,
        body: JSON.stringify({ playerId: playerA.playerId, itemId: 'nameplate_emerald_felt' }),
      }),
    ]);
    const raceSuccesses = [raceA1, raceA2].filter((r) => r.status === 200);
    const raceFailures = [raceA1, raceA2].filter((r) => r.status !== 200);
    assert.equal(raceSuccesses.length, 1);
    assert.equal(raceFailures.length, 1);
    assert.equal(raceSuccesses[0].body.wallet.balance, 40);
    assert(raceSuccesses[0].body.inventoryIds.includes('nameplate_emerald_felt'));

    // Duplicate purchase after ownership returns 409 ALREADY_OWNED
    const dupPurchase = await apiJson(baseHttp, '/api/economy/purchase', {
      method: 'POST',
      token: playerA.playerToken,
      body: JSON.stringify({ playerId: playerA.playerId, itemId: 'nameplate_emerald_felt' }),
    });
    assert.equal(dupPurchase.status, 409);
    assert.equal(dupPurchase.body.error, 'ALREADY_OWNED');

    // Concurrent distinct-item overspend race test on Player C (balance 260, items 220 + 180 = 400 > 260)
    await apiJson(baseHttp, '/api/economy/daily-claim', {
      method: 'POST',
      token: playerC.playerToken,
      body: JSON.stringify({ playerId: playerC.playerId }),
    });
    await apiJson(baseHttp, '/api/economy/ai-reward', {
      method: 'POST',
      token: playerC.playerToken,
      body: JSON.stringify({
        playerId: playerC.playerId,
        clientMatchId: 'ai_charlie_race_1',
        difficulty: 'legend',
        won: true,
        totalShots: 11,
        ballsPocketed: 8,
        durationSec: 50,
      }),
    });
    const [raceC1, raceC2] = await Promise.all([
      apiJson<PurchaseItemResponse>(baseHttp, '/api/economy/purchase', {
        method: 'POST',
        token: playerC.playerToken,
        body: JSON.stringify({ playerId: playerC.playerId, itemId: 'nameplate_emerald_felt' }),
      }),
      apiJson<PurchaseItemResponse>(baseHttp, '/api/economy/purchase', {
        method: 'POST',
        token: playerC.playerToken,
        body: JSON.stringify({ playerId: playerC.playerId, itemId: 'badge_rack_breaker' }),
      }),
    ]);
    const cSuccesses = [raceC1, raceC2].filter((r) => r.status === 200);
    const cFailures = [raceC1, raceC2].filter((r) => r.status !== 200);
    assert.equal(cSuccesses.length, 1);
    assert.equal(cFailures.length, 1);
    assert.equal(cFailures[0].body.error, 'INSUFFICIENT_FUNDS');
    assert(cSuccesses[0].body.wallet.balance >= 40);
    console.log('PASS [5] Purchase validation, duplicate/balance guards & atomic concurrency race safety verified');

    // =========================================================================
    // [6] Equip / Unequip Persistence & Online Room Cosmetic Sync
    // =========================================================================
    const eqRes = await apiJson<EquipCosmeticResponse>(baseHttp, '/api/economy/equip', {
      method: 'POST',
      token: playerA.playerToken,
      body: JSON.stringify({
        playerId: playerA.playerId,
        category: 'nameplate',
        itemId: 'nameplate_emerald_felt',
      }),
    });
    assert.equal(eqRes.status, 200);
    assert.equal(eqRes.body.equipped.nameplateId, 'nameplate_emerald_felt');

    // Unequip (null) reverts to starter default
    const uneqRes = await apiJson<EquipCosmeticResponse>(baseHttp, '/api/economy/equip', {
      method: 'POST',
      token: playerA.playerToken,
      body: JSON.stringify({
        playerId: playerA.playerId,
        category: 'nameplate',
        itemId: null,
      }),
    });
    assert.equal(uneqRes.status, 200);
    assert.equal(uneqRes.body.equipped.nameplateId, DEFAULT_EQUIPPED_COSMETICS.nameplateId);

    // Re-equip nameplate_emerald_felt before joining WS room
    await apiJson(baseHttp, '/api/economy/equip', {
      method: 'POST',
      token: playerA.playerToken,
      body: JSON.stringify({
        playerId: playerA.playerId,
        category: 'nameplate',
        itemId: 'nameplate_emerald_felt',
      }),
    });

    const wsA = new EconomyWsClient(baseWs, ORIGIN);
    const wsB = new EconomyWsClient(baseWs, ORIGIN);
    await wsA.connect();
    await wsB.connect();
    await wsA.initSession('EconAlpha', playerA);
    await wsB.initSession('EconBravo', playerB);

    wsA.send({
      type: 'room:create',
      isPrivate: true,
      ruleProfileId: 'wpa',
      calledShotsEnabled: true,
    });
    const created = await wsA.waitFor<Extract<ServerToClientMessage, { type: 'room:created' }>>(
      (m) => m.type === 'room:created',
    );
    const hostProfile = created.room.players.find((p) => p.playerId === playerA.playerId);
    assert.equal(hostProfile?.equippedCosmetics?.nameplateId, 'nameplate_emerald_felt');

    const roomWsA = await wsA.resumeRoom(created.room.roomId);
    wsB.send({ type: 'room:join', roomCode: created.room.roomCode });
    await wsB.waitFor((m) => m.type === 'room:updated');
    const roomWsB = await wsB.resumeRoom(created.room.roomId);

    // Mid-lobby equip broadcasts live room:updated with updated equippedCosmetics
    roomWsB.clearQueue();
    await apiJson(baseHttp, '/api/economy/equip', {
      method: 'POST',
      token: playerA.playerToken,
      body: JSON.stringify({
        playerId: playerA.playerId,
        category: 'nameplate',
        itemId: 'nameplate_standard',
      }),
    });
    const syncedUpdate = await roomWsB.waitFor<
      Extract<ServerToClientMessage, { type: 'room:updated' }>
    >(
      (m) =>
        m.type === 'room:updated' &&
        m.room.players.some(
          (p) =>
            p.playerId === playerA.playerId &&
            p.equippedCosmetics?.nameplateId === 'nameplate_standard',
        ),
      5000,
      'cosmetic sync room:updated',
    );
    assert(syncedUpdate.room.players.length === 2);
    console.log('PASS [6] Equip/unequip defaults & live room cosmetic synchronization verified');

    // =========================================================================
    // [7] Online Match Completion & Achievement Coin Rewards (+ 0-shot guard)
    // =========================================================================
    roomWsB.send({ type: 'room:ready', ready: true });
    await roomWsA.waitFor(
      (m) =>
        m.type === 'room:updated' &&
        m.room.players.length === 2 &&
        m.room.players.every((p) => p.ready),
    );
    roomWsA.send({ type: 'room:start' });
    await roomWsA.waitFor((m) => m.type === 'match:started');
    await roomWsB.waitFor((m) => m.type === 'match:started');

    // 0-shot forfeit -> 0 coins awarded
    roomWsB.send({ type: 'game:forfeit' });
    const zeroOver = await roomWsA.waitFor<Extract<ServerToClientMessage, { type: 'match:over' }>>(
      (m) => m.type === 'match:over',
    );
    assert.equal(zeroOver.progression?.rankedApplied, false);
    assert.equal(zeroOver.progression?.players.player1.coinsEarned ?? 0, 0);

    // Rematch -> 1 legal shot -> forfeit -> awards online match + WPA + achievement coins
    roomWsA.send({ type: 'room:rematch' });
    roomWsB.send({ type: 'room:rematch' });
    await roomWsA.waitFor((m) => m.type === 'match:rematch_started');
    await roomWsB.waitFor((m) => m.type === 'match:rematch_started');

    roomWsA.send({
      type: 'game:shoot',
      shotToken: 'phase8_break_shot_1',
      cueAngle: 0,
      power: 0.78,
      spinX: 0,
      spinY: 0,
      calledBall: null,
      calledPocket: null,
    });
    await roomWsA.waitFor((m) => m.type === 'match:settled', 15000, 'phase8 match:settled');

    roomWsB.send({ type: 'game:forfeit' });
    const rankedOver = await roomWsA.waitFor<Extract<ServerToClientMessage, { type: 'match:over' }>>(
      (m) => m.type === 'match:over',
      8000,
      'phase8 match:over',
    );
    assert.equal(rankedOver.progression?.rankedApplied, true);
    const p1Prog = rankedOver.progression!.players.player1;
    const p2Prog = rankedOver.progression!.players.player2;
    assert(p1Prog.coinsEarned && p1Prog.coinsEarned >= 150, 'Expected WPA online victory coins');
    assert.equal(p2Prog.coinsEarned, ECONOMY_CONFIG.onlineMatch.lossParticipationCoins);

    // Verify D1/DO persisted wallet balances match server progression awards
    const walletAAfter = await apiJson<PlayerCosmeticSnapshot>(
      baseHttp,
      `/api/economy/wallet?playerId=${encodeURIComponent(playerA.playerId)}`,
      { token: playerA.playerToken },
    );
    const walletBAfter = await apiJson<PlayerCosmeticSnapshot>(
      baseHttp,
      `/api/economy/wallet?playerId=${encodeURIComponent(playerB.playerId)}`,
      { token: playerB.playerToken },
    );
    assert.equal(walletAAfter.body.wallet.balance, 40 + (p1Prog.coinsEarned ?? 0));
    assert.equal(
      walletBAfter.body.wallet.balance,
      ECONOMY_CONFIG.startingBalance + (p2Prog.coinsEarned ?? 0),
    );
    console.log('PASS [7] Online match completion, WPA bonus, achievement coins & 0-shot guard verified');

    // =========================================================================
    // [8] Transaction Ledger Integrity & Chronological Ordering
    // =========================================================================
    const txRes = await apiJson<{ ok: boolean; transactions: CoinTransactionRecord[] }>(
      baseHttp,
      `/api/economy/transactions?playerId=${encodeURIComponent(playerA.playerId)}&limit=30`,
      { token: playerA.playerToken },
    );
    assert.equal(txRes.status, 200);
    const txs = txRes.body.transactions;
    assert(txs.length >= 5);

    const reasons = new Set(txs.map((t) => t.reason));
    assert(reasons.has('daily_login'));
    assert(reasons.has('ai_match_win'));
    assert(reasons.has('store_purchase'));
    assert(reasons.has('online_match_win'));

    for (let i = 1; i < txs.length; i++) {
      assert(
        txs[i - 1].createdAtMs >= txs[i].createdAtMs,
        'Transactions must be ordered newest first',
      );
    }
    const netSum = txs.reduce((acc, t) => acc + t.amount, 0);
    assert.equal(netSum, walletAAfter.body.wallet.balance);

    await roomWsA.close();
    await roomWsB.close();
    await wsA.close();
    await wsB.close();
    console.log('PASS [8] Coin transaction ledger balance reconciliation & ordering verified');
    console.log('\nPhase 8 In-Game Store, Currency & Cosmetic Inventory Verification: ALL 8 SUITES PASSED.');
  } catch (err) {
    console.error('\n--- Wrangler Economy Logs ---\n', logs);
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
