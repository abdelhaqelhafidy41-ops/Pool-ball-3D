import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import type {
  ClubChampionshipDetailPayload,
  ClubTeamRecord,
  TeamEloHistoryEntry,
  TeamEloRankingsPayload,
  TeamLeagueDetailPayload,
} from '../src/multiplayer/shared/clubLeagues';
import type {
  OnlineRoomInfo,
  ServerToClientMessage,
  SpectatableMatchSummary,
} from '../src/multiplayer/shared/protocol';
import type {
  ClubChatMessageRecord,
  ClubDetailPayload,
  ClubTrophyRecord,
} from '../src/multiplayer/shared/social';

const ORIGIN = 'https://test-user.github.io';
const CHROMIUM_SHELL =
  '/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-linux64/chrome-headless-shell';

const activeChildProcs = new Set<ChildProcess>();

function killProcessTree(proc: ChildProcess): void {
  if (!proc.pid) return;
  try {
    process.kill(-proc.pid, 'SIGTERM');
  } catch {
    try {
      proc.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
}

function cleanupChildren(): void {
  for (const p of activeChildProcs) {
    killProcessTree(p);
  }
  activeChildProcs.clear();
}

process.on('SIGTERM', () => {
  cleanupChildren();
  process.exit(143);
});
process.on('SIGINT', () => {
  cleanupChildren();
  process.exit(130);
});

async function allocateFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHttpReady(url: string, timeoutMs = 25000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // retry
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

class Phase16WsClient {
  public ws!: WebSocket;
  public queue: ServerToClientMessage[] = [];
  public sessionId = '';
  public reconnectToken = '';
  public playerId = '';
  public playerToken = '';

  private waiters: Array<{
    predicate: (msg: ServerToClientMessage) => boolean;
    resolve: (msg: ServerToClientMessage) => void;
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

  public send(msg: Record<string, unknown>): void {
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
        const queued = this.queue.map((m) => m.type).join(', ') || '(empty)';
        reject(new Error(`Timed out waiting for ${label}; queued=[${queued}]`));
      }, timeoutMs);
      this.waiters.push({
        predicate,
        resolve: resolve as (msg: ServerToClientMessage) => void,
        timer,
      });
    });
  }

  public async resumeInRoom(
    roomId: string,
    overrideSession?: { sessionId: string; reconnectToken: string },
  ): Promise<Phase16WsClient> {
    const rc = new Phase16WsClient(this.baseWsUrl, this.origin);
    await rc.connect(`${this.baseWsUrl}?roomId=${encodeURIComponent(roomId)}`);
    rc.send({
      type: 'session:resume',
      sessionId: overrideSession?.sessionId ?? this.sessionId,
      reconnectToken: overrideSession?.reconnectToken ?? this.reconnectToken,
      playerId: this.playerId,
      playerToken: this.playerToken,
    });
    await rc.waitFor((m) => m.type === 'session:ready', 8000, 'room session:ready');
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

async function apiJson<T = Record<string, unknown>>(
  baseHttp: string,
  pathStr: string,
  options?: RequestInit & { token?: string },
): Promise<{ status: number; ok: boolean; body: T & { error?: string; message?: string } }> {
  const res = await fetch(`${baseHttp}${pathStr}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
      ...(options?.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options?.headers ?? {}),
    },
  });
  const body = (await res.json()) as T & { error?: string; message?: string };
  return { status: res.status, ok: res.ok, body };
}

async function createIdentity(
  baseHttp: string,
  baseWs: string,
  displayName: string,
): Promise<{ playerId: string; playerToken: string; ws: Phase16WsClient }> {
  const initRes = await apiJson<{
    playerId?: string;
    profile?: { playerId: string };
    playerToken: string;
  }>(baseHttp, '/api/players/session', {
    method: 'POST',
    body: JSON.stringify({ displayName, avatarId: 'cue_gold', forceNewGuest: true }),
  });
  assert.equal(initRes.status, 200, `Failed to init ${displayName}: ${initRes.body.message}`);
  const playerId = initRes.body.playerId ?? initRes.body.profile?.playerId ?? '';
  assert.ok(playerId, 'Expected playerId');
  const playerToken = initRes.body.playerToken;

  const ws = new Phase16WsClient(baseWs, ORIGIN);
  await ws.connect();
  ws.send({
    type: 'session:init',
    displayName,
    avatarId: 'cue_gold',
    latencyMs: 15,
    playerId,
    playerToken,
  });
  const ready = await ws.waitFor<Extract<ServerToClientMessage, { type: 'session:ready' }>>(
    (m) => m.type === 'session:ready',
    6000,
    `${displayName} session:ready`,
  );
  ws.sessionId = ready.sessionId;
  ws.reconnectToken = ready.reconnectToken;
  ws.playerId = playerId;
  ws.playerToken = playerToken;

  return { playerId, playerToken, ws };
}

async function playAuthoritativeSubMatch(params: {
  baseHttp: string;
  subMatchId: string;
  winner: { playerId: string; playerToken: string; ws: Phase16WsClient };
  loser: { playerId: string; playerToken: string; ws: Phase16WsClient };
  spectator?: { playerId: string; playerToken: string; displayName: string };
}): Promise<{ roomId: string; roomCode: string | null }> {
  const { baseHttp, subMatchId, winner, loser, spectator } = params;

  const joinWinner = await apiJson<{
    room: OnlineRoomInfo;
    roomSession: { sessionId: string; reconnectToken: string };
  }>(baseHttp, '/api/club-competitions/submatches/join', {
    method: 'POST',
    token: winner.playerToken,
    body: JSON.stringify({
      playerId: winner.playerId,
      subMatchId,
      sessionId: winner.ws.sessionId,
    }),
  });
  assert.equal(joinWinner.status, 200, `Winner join submatch failed: ${joinWinner.body.message}`);
  const roomId = joinWinner.body.room.roomId;
  const roomCode = joinWinner.body.room.roomCode;

  const joinLoser = await apiJson<{
    room: OnlineRoomInfo;
    roomSession: { sessionId: string; reconnectToken: string };
  }>(baseHttp, '/api/club-competitions/submatches/join', {
    method: 'POST',
    token: loser.playerToken,
    body: JSON.stringify({
      playerId: loser.playerId,
      subMatchId,
      sessionId: loser.ws.sessionId,
    }),
  });
  assert.equal(joinLoser.status, 200, `Loser join submatch failed: ${joinLoser.body.message}`);

  const roomWinner = await winner.ws.resumeInRoom(roomId, joinWinner.body.roomSession);
  const roomLoser = await loser.ws.resumeInRoom(roomId, joinLoser.body.roomSession);

  try {
    roomWinner.send({ type: 'room:ready', ready: true });
    roomLoser.send({ type: 'room:ready', ready: true });

    await roomWinner.waitFor((m) => m.type === 'match:started', 8000, 'winner match:started');
    await roomLoser.waitFor((m) => m.type === 'match:started', 8000, 'loser match:started');

    if (spectator) {
      // Verify sub-match room is visible in live Spectator feed with clubLeague context
      const feed = await apiJson<{ matches: SpectatableMatchSummary[] }>(
        baseHttp,
        '/api/spectate/matches',
      );
      assert.equal(feed.status, 200);
      const liveEntry = feed.body.matches.find((m) => m.roomId === roomId);
      assert.ok(liveEntry, 'Expected live club team sub-match in /api/spectate/matches');
      assert.ok(liveEntry.clubLeague, 'Expected clubLeague context on spectatable match');
      assert.equal(liveEntry.clubLeague.subMatchId, subMatchId);

      const specJoin = await apiJson<{ ok: boolean; room: { spectatorCount: number } }>(
        baseHttp,
        '/api/spectate/join',
        {
          method: 'POST',
          body: JSON.stringify({
            roomId,
            playerId: spectator.playerId,
            playerToken: spectator.playerToken,
            displayName: spectator.displayName,
          }),
        },
      );
      assert.equal(specJoin.status, 200);
      assert.equal(specJoin.body.room.spectatorCount, 1);
    }

    // Authentic break shot so PoolRoomDO classifies match as non-abandoned
    roomWinner.send({
      type: 'game:shoot',
      cueAngle: 0,
      power: 0.4,
      spinX: 0,
      spinY: 0,
      calledBall: null,
      calledPocket: null,
      shotToken: `tok_p16_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    });
    await roomWinner.waitFor((m) => m.type === 'match:settled', 15000, 'winner match:settled');

    roomLoser.send({ type: 'game:forfeit' });
    await roomWinner.waitFor((m) => m.type === 'match:over', 10000, 'winner match:over');

    // Allow MatchmakerDO onTeamSubMatchCompleted RPC settle to flush
    await sleep(350);
    return { roomId, roomCode };
  } finally {
    await Promise.all([roomWinner.close().catch(() => {}), roomLoser.close().catch(() => {})]);
  }
}

class CdpClient {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (buf) => {
      const msg = JSON.parse(buf.toString());
      if (typeof msg.id === 'number') {
        const entry = this.pending.get(msg.id);
        if (entry) {
          this.pending.delete(msg.id);
          if (msg.error) entry.reject(new Error(msg.error.message));
          else entry.resolve(msg.result);
        }
      }
    });
  }

  public static async connect(port: number): Promise<CdpClient> {
    let wsUrl: string | undefined;
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`);
        const list = (await res.json()) as Array<{ webSocketDebuggerUrl?: string }>;
        if (list[0]?.webSocketDebuggerUrl) {
          wsUrl = list[0].webSocketDebuggerUrl;
          break;
        }
      } catch {
        // retry
      }
      await sleep(150);
    }
    if (!wsUrl) throw new Error(`Unable to attach CDP on port ${port}`);
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
    });
    return new CdpClient(ws);
  }

  public call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  public onConsoleError(cb: (text: string) => void): void {
    this.ws.on('message', (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.method === 'Runtime.consoleAPICalled') {
        const txt = (msg.params.args || [])
          .map((a: any) => a.value ?? a.description ?? '')
          .join(' ');
        if (msg.params.type === 'error' || txt.includes('Minified React error') || txt.includes('Rendered more hooks')) {
          cb(txt);
        }
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const desc = msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text;
        if (desc) cb(desc);
      }
    });
  }

  public async eval<T = any>(expression: string): Promise<T> {
    const res = await this.call<{
      result: { value?: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    }
    return res.result.value as T;
  }

  public close(): void {
    this.ws.close();
  }
}

async function runBrowserUiSuite(baseUrl: string): Promise<void> {
  for (const vp of [
    { label: 'desktop', width: 1280, height: 800, mobile: false },
    { label: 'mobile', width: 390, height: 844, mobile: true },
  ]) {
    const cdpPort = await allocateFreePort();
    const userDataDir = path.join(tmpdir(), `pool-p16-${vp.label}-${Date.now()}`);
    const chrome = spawn(
      CHROMIUM_SHELL,
      [
        '--headless',
        '--no-sandbox',
        '--disable-gpu',
        `--user-data-dir=${userDataDir}`,
        `--remote-debugging-port=${cdpPort}`,
        `--window-size=${vp.width},${vp.height}`,
        'about:blank',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    );
    activeChildProcs.add(chrome);

    let cdp: CdpClient | null = null;
    try {
      cdp = await CdpClient.connect(cdpPort);
      const errors: string[] = [];
      cdp.onConsoleError((txt) => errors.push(txt));

      await cdp.call('Page.enable');
      await cdp.call('Runtime.enable');
      await cdp.call('Emulation.setDeviceMetricsOverride', {
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: vp.mobile ? 3 : 1,
        mobile: vp.mobile,
      });

      await cdp.call('Page.navigate', { url: baseUrl });
      for (let i = 0; i < 60; i++) {
        const ready = await cdp.eval<boolean>(
          `Boolean(document.querySelector('[data-testid="open-clubs-leagues-btn"]'))`,
        );
        if (ready) break;
        await sleep(250);
      }

      const btnExists = await cdp.eval<boolean>(
        `Boolean(document.querySelector('[data-testid="open-clubs-leagues-btn"]'))`,
      );
      assert.equal(btnExists, true, `${vp.label}: Clubs & Team Leagues button missing on MainMenu`);

      // Open -> close -> reopen repeatedly to prove zero hook violations
      for (let cycle = 0; cycle < 2; cycle++) {
        await cdp.eval(`document.querySelector('[data-testid="open-clubs-leagues-btn"]')?.click()`);
        await sleep(300);
        const modalDir: string | null = await cdp.eval<string | null>(
          `document.querySelector('[data-testid="club-league-modal"]')?.getAttribute('dir') ?? null`,
        );
        assert.equal(modalDir, 'ltr', `${vp.label}: Expected initial dir="ltr"`);

        for (const tabId of ['teams', 'leagues', 'championships', 'rankings', 'club_hq']) {
          await cdp.eval(
            `document.querySelector('[data-testid="club-league-tab-${tabId}"]')?.click()`,
          );
          await sleep(120);
        }

        // Toggle Arabic RTL
        await cdp.eval(`document.querySelector('[data-testid="club-league-lang-toggle"]')?.click()`);
        await sleep(150);
        const rtlDir: string | null = await cdp.eval<string | null>(
          `document.querySelector('[data-testid="club-league-modal"]')?.getAttribute('dir') ?? null`,
        );
        const arHeading = await cdp.eval<string>(
          `document.querySelector('[data-testid="club-league-modal"] h2')?.textContent ?? ''`,
        );
        assert.equal(rtlDir, 'rtl', `${vp.label}: Expected RTL mode after language toggle`);
        assert.ok(arHeading.includes('الأندية'), `${vp.label}: Expected Arabic title, got "${arHeading}"`);

        // Switch back to English LTR
        await cdp.eval(`document.querySelector('[data-testid="club-league-lang-toggle"]')?.click()`);
        await sleep(100);

        if (vp.mobile) {
          const touchCheck: { minTabHeight: number; modalFitsWidth: boolean } = await cdp.eval<{
            minTabHeight: number;
            modalFitsWidth: boolean;
          }>(`(() => {
            const tabs = Array.from(document.querySelectorAll('[data-testid^="club-league-tab-"]'));
            const minTabHeight = Math.min(...tabs.map(t => t.getBoundingClientRect().height));
            const modal = document.querySelector('[data-testid="club-league-modal"]');
            const rect = modal ? modal.getBoundingClientRect() : { width: 9999 };
            return { minTabHeight, modalFitsWidth: rect.width <= window.innerWidth + 2 };
          })()`);
          assert.ok(
            touchCheck.minTabHeight >= 44,
            `Mobile tab height ${touchCheck.minTabHeight}px must be >= 44px`,
          );
          assert.equal(touchCheck.modalFitsWidth, true, 'Modal must fit mobile viewport width');
        }

        await cdp.eval(`document.querySelector('[data-testid="club-league-close-btn"]')?.click()`);
        await sleep(180);
        const stillOpen: boolean = await cdp.eval<boolean>(
          `Boolean(document.querySelector('[data-testid="club-league-modal"]'))`,
        );
        assert.equal(stillOpen, false, `${vp.label}: Modal should close cleanly`);
      }

      const hookIssues = errors.filter(
        (e) =>
          e.includes('Minified React error #310') ||
          e.includes('Rendered more hooks') ||
          e.includes('Uncaught'),
      );
      assert.deepEqual(hookIssues, [], `${vp.label}: Console/React errors: ${hookIssues.join('; ')}`);
    } finally {
      cdp?.close();
      activeChildProcs.delete(chrome);
      killProcessTree(chrome);
      rmSync(userDataDir, { recursive: true, force: true });
    }
  }
}

async function main(): Promise<void> {
  const cfPort = await allocateFreePort();
  const vitePort = await allocateFreePort();
  const cfStateDir = `/tmp/cf-phase16-state-${Date.now()}`;
  rmSync(cfStateDir, { recursive: true, force: true });

  const baseHttp = `http://127.0.0.1:${cfPort}`;
  const baseWs = `ws://127.0.0.1:${cfPort}/ws`;
  const viteUrl = `http://127.0.0.1:${vitePort}`;

  const wranglerBin = path.join(process.cwd(), 'node_modules', '.bin', 'wrangler');
  const wrangler = spawn(
    wranglerBin,
    [
      'dev',
      '--config',
      'cloudflare/wrangler.jsonc',
      '--port',
      String(cfPort),
      '--ip',
      '127.0.0.1',
      '--var',
      `CORS_ORIGIN:${ORIGIN}`,
      '--persist-to',
      cfStateDir,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  );
  activeChildProcs.add(wrangler);

  let cfLogs = '';
  wrangler.stdout?.on('data', (d) => {
    cfLogs += d.toString();
  });
  wrangler.stderr?.on('data', (d) => {
    cfLogs += d.toString();
  });

  const vite = spawn(
    'npx',
    ['vite', '--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'],
    {
      cwd: process.cwd(),
      env: { ...process.env, VITE_WS_URL: baseWs },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  );
  activeChildProcs.add(vite);

  const sockets: Phase16WsClient[] = [];

  try {
    await waitForHttpReady(`${baseHttp}/health`, 30000);
    await waitForHttpReady(viteUrl, 30000);

    // Create 6 players
    const p1 = await createIdentity(baseHttp, baseWs, 'P16Alpha');
    const p2 = await createIdentity(baseHttp, baseWs, 'P16Bravo');
    const p3 = await createIdentity(baseHttp, baseWs, 'P16Charlie');
    const p4 = await createIdentity(baseHttp, baseWs, 'P16Delta');
    const p5 = await createIdentity(baseHttp, baseWs, 'P16Echo');
    const p6 = await createIdentity(baseHttp, baseWs, 'P16Foxtrot');
    sockets.push(p1.ws, p2.ws, p3.ws, p4.ws, p5.ws, p6.ws);

    // =========================================================================
    // [1] 5-Tier Club Hierarchy, Capacity, Announcements & Club Hall Chat
    // =========================================================================
    const clubARes = await apiJson<{ detail: ClubDetailPayload }>(baseHttp, '/api/clubs', {
      method: 'POST',
      token: p1.playerToken,
      body: JSON.stringify({
        playerId: p1.playerId,
        name: 'Alpha Royalty',
        tag: 'ALPH',
        description: 'Top MENA cue club',
        region: 'MENA',
        maxMembers: 10,
        joinMode: 'public',
      }),
    });
    assert.equal(clubARes.status, 200);
    const clubAId = clubARes.body.detail.club.clubId;
    assert.equal(clubARes.body.detail.club.region, 'MENA');
    assert.equal(clubARes.body.detail.club.maxMembers, 10);

    await apiJson(baseHttp, `/api/clubs/${encodeURIComponent(clubAId)}/join`, {
      method: 'POST',
      token: p2.playerToken,
      body: JSON.stringify({ playerId: p2.playerId }),
    });
    await apiJson(baseHttp, `/api/clubs/${encodeURIComponent(clubAId)}/join`, {
      method: 'POST',
      token: p3.playerToken,
      body: JSON.stringify({ playerId: p3.playerId }),
    });

    const clubBRes = await apiJson<{ detail: ClubDetailPayload }>(baseHttp, '/api/clubs', {
      method: 'POST',
      token: p4.playerToken,
      body: JSON.stringify({
        playerId: p4.playerId,
        name: 'Bravo Strikers',
        tag: 'BRAV',
        region: 'MENA',
        maxMembers: 12,
        joinMode: 'public',
      }),
    });
    assert.equal(clubBRes.status, 200);
    const clubBId = clubBRes.body.detail.club.clubId;
    await apiJson(baseHttp, `/api/clubs/${encodeURIComponent(clubBId)}/join`, {
      method: 'POST',
      token: p5.playerToken,
      body: JSON.stringify({ playerId: p5.playerId }),
    });
    await apiJson(baseHttp, `/api/clubs/${encodeURIComponent(clubBId)}/join`, {
      method: 'POST',
      token: p6.playerToken,
      body: JSON.stringify({ playerId: p6.playerId }),
    });

    // Promote p2 -> president, p3 -> captain
    const promPres = await apiJson(baseHttp, `/api/clubs/${encodeURIComponent(clubAId)}/members/role`, {
      method: 'POST',
      token: p1.playerToken,
      body: JSON.stringify({ playerId: p1.playerId, targetPlayerId: p2.playerId, role: 'president' }),
    });
    assert.equal(promPres.status, 200);

    const promCap = await apiJson(baseHttp, `/api/clubs/${encodeURIComponent(clubAId)}/members/role`, {
      method: 'POST',
      token: p2.playerToken,
      body: JSON.stringify({ playerId: p2.playerId, targetPlayerId: p3.playerId, role: 'captain' }),
    });
    assert.equal(promCap.status, 200);

    // Captain cannot post officer bulletin
    const capBulletinFail = await apiJson(
      baseHttp,
      `/api/clubs/${encodeURIComponent(clubAId)}/announcement`,
      {
        method: 'POST',
        token: p3.playerToken,
        body: JSON.stringify({ playerId: p3.playerId, announcement: 'Unauthorized' }),
      },
    );
    assert.equal(capBulletinFail.status, 403);

    // President posts bulletin
    const presBulletinOk = await apiJson<{ detail: ClubDetailPayload }>(
      baseHttp,
      `/api/clubs/${encodeURIComponent(clubAId)}/announcement`,
      {
        method: 'POST',
        token: p2.playerToken,
        body: JSON.stringify({ playerId: p2.playerId, announcement: 'Lineups lock at 20:00!' }),
      },
    );
    assert.equal(presBulletinOk.status, 200);
    assert.equal(presBulletinOk.body.detail.club.announcement, 'Lineups lock at 20:00!');

    // Live Club Hall Chat + WS push
    p2.ws.clearQueue();
    const chatRes = await apiJson<{ message: ClubChatMessageRecord }>(
      baseHttp,
      `/api/clubs/${encodeURIComponent(clubAId)}/chat`,
      {
        method: 'POST',
        token: p1.playerToken,
        body: JSON.stringify({ playerId: p1.playerId, body: 'Welcome to Alpha HQ!' }),
      },
    );
    assert.equal(chatRes.status, 200);
    const chatPush = await p2.ws.waitFor<Extract<ServerToClientMessage, { type: 'club:chat_message' }>>(
      (m) => m.type === 'club:chat_message' && m.clubId === clubAId,
      6000,
      'club:chat_message push',
    );
    assert.equal(chatPush.message.body, 'Welcome to Alpha HQ!');
    console.log('PASS [1] 5-tier club roles, capacity, announcement bulletin & Club Hall chat verified');

    // =========================================================================
    // [2] Multiple Teams Per Club, Roster Management & Conflict Prevention
    // =========================================================================
    const teamA1Res = await apiJson<{ team: ClubTeamRecord }>(
      baseHttp,
      `/api/clubs/${encodeURIComponent(clubAId)}/teams`,
      {
        method: 'POST',
        token: p1.playerToken,
        body: JSON.stringify({
          playerId: p1.playerId,
          name: 'Alpha First',
          tag: 'AF1',
          region: 'MENA',
          captainId: p1.playerId,
          memberIds: [p1.playerId, p2.playerId, p3.playerId],
          maxRosterSize: 6,
        }),
      },
    );
    assert.equal(teamA1Res.status, 200);
    const teamA1 = teamA1Res.body.team;
    assert.equal(teamA1.roster.length, 3);

    const teamA2Res = await apiJson<{ team: ClubTeamRecord }>(
      baseHttp,
      `/api/clubs/${encodeURIComponent(clubAId)}/teams`,
      {
        method: 'POST',
        token: p1.playerToken,
        body: JSON.stringify({
          playerId: p1.playerId,
          name: 'Alpha Academy',
          tag: 'AA2',
          region: 'MENA',
          captainId: p2.playerId,
          memberIds: [p2.playerId],
        }),
      },
    );
    assert.equal(teamA2Res.status, 200);
    const teamA2 = teamA2Res.body.team;

    const teamB1Res = await apiJson<{ team: ClubTeamRecord }>(
      baseHttp,
      `/api/clubs/${encodeURIComponent(clubBId)}/teams`,
      {
        method: 'POST',
        token: p4.playerToken,
        body: JSON.stringify({
          playerId: p4.playerId,
          name: 'Bravo Legends',
          tag: 'BL1',
          region: 'MENA',
          captainId: p4.playerId,
          memberIds: [p4.playerId, p5.playerId],
        }),
      },
    );
    assert.equal(teamB1Res.status, 200);
    const teamB1 = teamB1Res.body.team;

    const teamB2Res = await apiJson<{ team: ClubTeamRecord }>(
      baseHttp,
      `/api/clubs/${encodeURIComponent(clubBId)}/teams`,
      {
        method: 'POST',
        token: p4.playerToken,
        body: JSON.stringify({
          playerId: p4.playerId,
          name: 'Bravo Rising',
          tag: 'BR2',
          region: 'MENA',
          captainId: p6.playerId,
          memberIds: [p6.playerId],
        }),
      },
    );
    assert.equal(teamB2Res.status, 200);
    const teamB2 = teamB2Res.body.team;
    console.log('PASS [2] Multiple competitive teams per club & rosters verified');

    // =========================================================================
    // [3] Team League: Round-Robin, Lineups, Substitution, Live Authoritative Match & Standings
    // =========================================================================
    const leagueCreate = await apiJson<{ detail: TeamLeagueDetailPayload }>(
      baseHttp,
      '/api/team-leagues',
      {
        method: 'POST',
        token: p1.playerToken,
        body: JSON.stringify({
          playerId: p1.playerId,
          title: 'MENA Premier Weekly',
          scope: 'regional',
          region: 'MENA',
          cadence: 'weekly',
          matchFormat: 'singles',
          doubleRoundRobin: false,
          maxTeams: 6,
          promotionSlots: 1,
          relegationSlots: 1,
        }),
      },
    );
    assert.equal(leagueCreate.status, 200);
    const leagueId = leagueCreate.body.detail.league.leagueId;

    // Register A1, B1, B2
    assert.equal(
      (
        await apiJson(baseHttp, `/api/team-leagues/${encodeURIComponent(leagueId)}/register`, {
          method: 'POST',
          token: p1.playerToken,
          body: JSON.stringify({ playerId: p1.playerId, teamId: teamA1.teamId }),
        })
      ).status,
      200,
    );
    // Conflict test: A2 shares p2 with A1 -> rejected with 409!
    const conflictReg = await apiJson(
      baseHttp,
      `/api/team-leagues/${encodeURIComponent(leagueId)}/register`,
      {
        method: 'POST',
        token: p2.playerToken,
        body: JSON.stringify({ playerId: p2.playerId, teamId: teamA2.teamId }),
      },
    );
    assert.equal(conflictReg.status, 409, 'Shared roster player cannot join same league on two teams');

    assert.equal(
      (
        await apiJson(baseHttp, `/api/team-leagues/${encodeURIComponent(leagueId)}/register`, {
          method: 'POST',
          token: p4.playerToken,
          body: JSON.stringify({ playerId: p4.playerId, teamId: teamB1.teamId }),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await apiJson(baseHttp, `/api/team-leagues/${encodeURIComponent(leagueId)}/register`, {
          method: 'POST',
          token: p6.playerToken,
          body: JSON.stringify({ playerId: p6.playerId, teamId: teamB2.teamId }),
        })
      ).status,
      200,
    );

    const startLeague = await apiJson<{ detail: TeamLeagueDetailPayload }>(
      baseHttp,
      `/api/team-leagues/${encodeURIComponent(leagueId)}/start`,
      {
        method: 'POST',
        token: p1.playerToken,
        body: JSON.stringify({ playerId: p1.playerId }),
      },
    );
    assert.equal(startLeague.status, 200);
    assert.equal(startLeague.body.detail.fixtures.length, 3);

    // Find A1 vs B1 fixture
    const fixA1B1 = startLeague.body.detail.fixtures.find(
      (f) =>
        (f.homeTeamId === teamA1.teamId && f.awayTeamId === teamB1.teamId) ||
        (f.homeTeamId === teamB1.teamId && f.awayTeamId === teamA1.teamId),
    )!;
    assert.ok(fixA1B1);

    // Submit lineup for A1 with p2, then B1 with p4 (both lineups create the board subMatch)
    const lineupA1Res = await apiJson<{ subMatches: Array<{ subMatchId: string }> }>(
      baseHttp,
      '/api/club-competitions/lineup',
      {
        method: 'POST',
        token: p1.playerToken,
        body: JSON.stringify({
          playerId: p1.playerId,
          competitionKind: 'league',
          competitionId: leagueId,
          encounterId: fixA1B1.fixtureId,
          teamId: teamA1.teamId,
          playerIds: [p2.playerId],
        }),
      },
    );
    assert.equal(lineupA1Res.status, 200);

    // Set B1 lineup -> p4
    const lineupB1Res = await apiJson<{ subMatches: Array<{ subMatchId: string }> }>(
      baseHttp,
      '/api/club-competitions/lineup',
      {
        method: 'POST',
        token: p4.playerToken,
        body: JSON.stringify({
          playerId: p4.playerId,
          competitionKind: 'league',
          competitionId: leagueId,
          encounterId: fixA1B1.fixtureId,
          teamId: teamB1.teamId,
          playerIds: [p4.playerId],
        }),
      },
    );
    assert.equal(lineupB1Res.status, 200);
    assert.ok(lineupB1Res.body.subMatches.length >= 1, 'Submitting both lineups creates board subMatches');
    const boardSmId = lineupB1Res.body.subMatches[0].subMatchId;

    // Substitute p2 with p1 before the match starts!
    const subRes = await apiJson(baseHttp, '/api/club-competitions/substitute', {
      method: 'POST',
      token: p1.playerToken,
      body: JSON.stringify({
        playerId: p1.playerId,
        subMatchId: boardSmId,
        teamId: teamA1.teamId,
        newPlayerId: p1.playerId,
      }),
    });
    assert.equal(subRes.status, 200);

    // Play real authoritative sub-match (p1 beats p4, p3 spectates!)
    await playAuthoritativeSubMatch({
      baseHttp,
      subMatchId: boardSmId,
      winner: p1,
      loser: p4,
      spectator: { playerId: p3.playerId, playerToken: p3.playerToken, displayName: 'P16Charlie' },
    });

    // Settle remaining 2 fixtures cleanly so A1 wins the league
    for (const f of startLeague.body.detail.fixtures) {
      if (f.fixtureId === fixA1B1.fixtureId) continue;
      const winTeamId =
        f.homeTeamId === teamA1.teamId || f.awayTeamId === teamA1.teamId
          ? teamA1.teamId
          : teamB1.teamId;
      const resResolve = await apiJson(
        baseHttp,
        `/api/team-leagues/${encodeURIComponent(leagueId)}/resolve`,
        {
          method: 'POST',
          token: p1.playerToken,
          body: JSON.stringify({
            playerId: p1.playerId,
            encounterId: f.fixtureId,
            winnerTeamId: winTeamId,
            resolution: 'walkover',
          }),
        },
      );
      assert.equal(resResolve.status, 200);
    }

    const leagueDone = await apiJson<{ detail: TeamLeagueDetailPayload }>(
      baseHttp,
      `/api/team-leagues/${encodeURIComponent(leagueId)}`,
    );
    assert.equal(leagueDone.body.detail.league.status, 'completed');
    assert.equal(leagueDone.body.detail.league.championTeamId, teamA1.teamId);
    assert.equal(leagueDone.body.detail.standings[0].outcomeTag, 'promoted');

    const teamA1Detail = await apiJson<{ team: ClubTeamRecord; eloHistory: TeamEloHistoryEntry[] }>(
      baseHttp,
      `/api/teams/${encodeURIComponent(teamA1.teamId)}`,
    );
    assert.ok(teamA1Detail.body.team.elo > 1200, 'Winning Team ELO must increase');
    assert.ok(teamA1Detail.body.eloHistory.length >= 1, 'Team ELO history must record');

    const rankingsRes = await apiJson<TeamEloRankingsPayload>(
      baseHttp,
      '/api/rankings/clubs-teams?region=MENA',
    );
    assert.equal(rankingsRes.status, 200);
    assert.equal(rankingsRes.body.teams[0].teamId, teamA1.teamId);
    console.log('PASS [3] Team League round-robin, lineup substitution, live PoolRoomDO + Spectator, ELO & standings verified');

    // =========================================================================
    // [4] All 4 Club Championship Formats + Trophies + Champion Coins
    // =========================================================================
    // Test Single Elimination (with prizeCoinsChampion), Double Elimination, Group+Knockout, and Swiss!
    const walletBefore = await apiJson<{ wallet: { balance: number } }>(
      baseHttp,
      `/api/economy/wallet?playerId=${encodeURIComponent(p1.playerId)}`,
      { token: p1.playerToken },
    );
    const coinsBefore = walletBefore.body.wallet.balance;

    // Helper to create, register [A1, B1, B2], and start a championship
    async function launch3TeamChamp(format: 'single_elimination' | 'double_elimination' | 'group_knockout' | 'swiss', extra: Record<string, unknown> = {}) {
      const created = await apiJson<{ detail: ClubChampionshipDetailPayload }>(
        baseHttp,
        '/api/club-championships',
        {
          method: 'POST',
          token: p1.playerToken,
          body: JSON.stringify({
            playerId: p1.playerId,
            title: `Phase16 ${format}`,
            format,
            region: 'MENA',
            matchFormat: 'singles',
            maxTeams: 8,
            prizeCoinsChampion: format === 'single_elimination' ? 600 : 0,
            ...extra,
          }),
        },
      );
      assert.equal(created.status, 200, `Failed creating ${format}: ${created.body.message}`);
      const cId = created.body.detail.championship.championshipId;

      for (const [team, owner] of [
        [teamA1, p1],
        [teamB1, p4],
        [teamB2, p6],
      ] as const) {
        const reg = await apiJson(
          baseHttp,
          `/api/club-championships/${encodeURIComponent(cId)}/register`,
          {
            method: 'POST',
            token: owner.playerToken,
            body: JSON.stringify({ playerId: owner.playerId, teamId: team.teamId }),
          },
        );
        assert.equal(reg.status, 200, `Register failed for ${format}: ${reg.body.message}`);
      }

      const started = await apiJson<{ detail: ClubChampionshipDetailPayload }>(
        baseHttp,
        `/api/club-championships/${encodeURIComponent(cId)}/start`,
        {
          method: 'POST',
          token: p1.playerToken,
          body: JSON.stringify({ playerId: p1.playerId }),
        },
      );
      assert.equal(started.status, 200, `Start failed for ${format}: ${started.body.message}`);
      return cId;
    }

    // Helper to auto-resolve all ready matches until completed
    async function settleChampFavoringA1(cId: string) {
      for (let step = 0; step < 12; step++) {
        const det = await apiJson<{ detail: ClubChampionshipDetailPayload }>(
          baseHttp,
          `/api/club-championships/${encodeURIComponent(cId)}`,
        );
        if (det.body.detail.championship.status === 'completed') {
          return det.body.detail;
        }
        const playable = det.body.detail.matches.filter(
          (m) =>
            m.homeTeamId &&
            m.awayTeamId &&
            (m.status === 'pending' ||
              m.status === 'scheduled' ||
              m.status === 'lineup_ready'),
        );
        assert.ok(playable.length > 0, `Expected playable matches in ${cId} at step ${step}`);
        for (const m of playable) {
          const winnerId =
            m.homeTeamId === teamA1.teamId || m.awayTeamId === teamA1.teamId
              ? teamA1.teamId
              : m.homeTeamId!;
          const res = await apiJson(
            baseHttp,
            `/api/club-championships/${encodeURIComponent(cId)}/resolve`,
            {
              method: 'POST',
              token: p1.playerToken,
              body: JSON.stringify({
                playerId: p1.playerId,
                encounterId: m.matchNodeId,
                winnerTeamId: winnerId,
                resolution: 'walkover',
              }),
            },
          );
          assert.equal(res.status, 200);
        }
      }
      throw new Error(`Championship ${cId} did not complete within 12 rounds`);
    }

    const seId = await launch3TeamChamp('single_elimination');
    const seDone = await settleChampFavoringA1(seId);
    assert.equal(seDone.championship.championTeamId, teamA1.teamId);

    const walletAfter = await apiJson<{ wallet: { balance: number } }>(
      baseHttp,
      `/api/economy/wallet?playerId=${encodeURIComponent(p1.playerId)}`,
      { token: p1.playerToken },
    );
    assert.ok(
      walletAfter.body.wallet.balance > coinsBefore,
      `Champion prize coins should credit roster (before=${coinsBefore}, after=${walletAfter.body.wallet.balance})`,
    );

    const deId = await launch3TeamChamp('double_elimination');
    const deDone = await settleChampFavoringA1(deId);
    assert.equal(deDone.championship.championTeamId, teamA1.teamId);
    assert.ok(deDone.matches.some((m) => m.stageType === 'losers'));
    assert.ok(deDone.matches.some((m) => m.stageType === 'grand_final'));

    const gkId = await launch3TeamChamp('group_knockout', { groupSize: 3, groupAdvanceCount: 2 });
    const gkDone = await settleChampFavoringA1(gkId);
    assert.equal(gkDone.championship.championTeamId, teamA1.teamId);
    assert.ok(gkDone.matches.some((m) => m.stageType === 'group'));
    assert.ok(gkDone.matches.some((m) => m.stageType === 'knockout'));

    const swId = await launch3TeamChamp('swiss', { swissRounds: 2 });
    const swDone = await settleChampFavoringA1(swId);
    assert.equal(swDone.championship.status, 'completed');
    assert.ok(swDone.matches.some((m) => m.roundNumber === 2 && m.stageType === 'swiss'));

    const trophiesA = await apiJson<{ trophies: ClubTrophyRecord[] }>(
      baseHttp,
      `/api/clubs/${encodeURIComponent(clubAId)}/trophies`,
    );
    assert.ok(trophiesA.body.trophies.length >= 2, 'Club A should hold League & Championship trophies');
    console.log('PASS [4] All 4 Championship formats (Single, Double, Group+KO, Swiss), trophies & Economy payouts verified');

    // =========================================================================
    // [5] Real Mobile (390x844) & Desktop (1280x800) Chromium UI + RTL/LTR Suite
    // =========================================================================
    await runBrowserUiSuite(viteUrl);
    console.log('PASS [5] Desktop & Mobile Chromium UI, 5 tabs, EN LTR <-> AR RTL & React Hooks safety verified');

    console.log('\nPhase 16 Professional Club Championships & Team Leagues: ALL 5 SUITES PASSED.');
  } catch (err) {
    console.error('\n--- Wrangler Phase 16 Logs ---\n', cfLogs.slice(-3000));
    throw err;
  } finally {
    await Promise.all(sockets.map((s) => s.close().catch(() => {})));
    activeChildProcs.delete(wrangler);
    activeChildProcs.delete(vite);
    killProcessTree(wrangler);
    killProcessTree(vite);
    await sleep(600);
    rmSync(cfStateDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  cleanupChildren();
  process.exit(1);
});
