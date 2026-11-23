import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const CHROMIUM_SHELL =
  '/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-linux64/chrome-headless-shell';

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

async function waitForHttpReady(url: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // retry
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for server at ${url}`);
}

class CdpClient {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  private eventHandlers: Array<(method: string, params: any) => void> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (buf) => {
      const msg = JSON.parse(buf.toString());
      if (typeof msg.id === 'number') {
        const entry = this.pending.get(msg.id);
        if (entry) {
          this.pending.delete(msg.id);
          if (msg.error) {
            entry.reject(new Error(msg.error.message));
          } else {
            entry.resolve(msg.result);
          }
        }
      } else if (msg.method) {
        for (const h of this.eventHandlers) {
          h(msg.method, msg.params);
        }
      }
    });
  }

  public static async connect(port: number): Promise<CdpClient> {
    let wsUrl: string | undefined;
    for (let i = 0; i < 50; i++) {
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
    if (!wsUrl) {
      throw new Error(`Unable to attach CDP on port ${port}`);
    }
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
    });
    return new CdpClient(ws);
  }

  public onEvent(fn: (method: string, params: any) => void): void {
    this.eventHandlers.push(fn);
  }

  public call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  public async eval<T = any>(expression: string): Promise<T> {
    const res = await this.call<{
      result: { value?: T; description?: string };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description || res.exceptionDetails.text,
      );
    }
    return res.result.value as T;
  }

  public close(): void {
    this.ws.close();
  }
}

type ScenarioMode = 'populated' | 'empty' | 'network_error' | 'malformed' | 'missing_detail';

const activeChildProcs = new Set<ChildProcess>();

function cleanupAllChildren(): void {
  for (const proc of activeChildProcs) {
    killProcessTree(proc);
  }
  activeChildProcs.clear();
}

process.on('SIGTERM', () => {
  cleanupAllChildren();
  process.exit(143);
});
process.on('SIGINT', () => {
  cleanupAllChildren();
  process.exit(130);
});

async function runBrowserSuite(opts: {
  label: string;
  url: string;
  cdpPort: number;
  viewport: { width: number; height: number; mobile: boolean };
}): Promise<void> {
  const startedAt = Date.now();
  const userDataDir = path.join(tmpdir(), `pool-cdp-${opts.cdpPort}-${Date.now()}`);
  const chrome: ChildProcess = spawn(
    CHROMIUM_SHELL,
    [
      '--headless',
      '--no-sandbox',
      '--disable-gpu',
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${opts.cdpPort}`,
      `--window-size=${opts.viewport.width},${opts.viewport.height}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  activeChildProcs.add(chrome);

  let cdp: CdpClient | null = null;
  try {
    cdp = await CdpClient.connect(opts.cdpPort);

    let scenario: ScenarioMode = 'populated';
    let listRequestCount = 0;

    const reactHookErrors: string[] = [];
    const pageExceptions: string[] = [];

    cdp.onEvent((method, params) => {
      if (method === 'Runtime.consoleAPICalled') {
        const txt = (params.args || [])
          .map((a: any) => a.value ?? a.description ?? '')
          .join(' ');
        if (
          txt.includes('Minified React error #310') ||
          txt.includes('Minified React error #300') ||
          txt.includes('Rendered more hooks') ||
          txt.includes('Rendered fewer hooks') ||
          txt.includes('change in the order of Hooks') ||
          txt.includes('ULTIMATE POOL 3D — Recovery')
        ) {
          reactHookErrors.push(txt);
        }
      } else if (method === 'Runtime.exceptionThrown') {
        const desc = params.exceptionDetails?.exception?.description || params.exceptionDetails?.text;
        if (desc) pageExceptions.push(desc);
      } else if (method === 'Fetch.requestPaused') {
        const reqId = params.requestId as string;
        const reqUrl = params.request.url as string;

        const respondJson = async (status: number, body: unknown) => {
          const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64');
          await cdp!.call('Fetch.fulfillRequest', {
            requestId: reqId,
            responseCode: status,
            responseHeaders: [
              { name: 'Content-Type', value: 'application/json' },
              { name: 'Access-Control-Allow-Origin', value: '*' },
            ],
            body: encoded,
          });
        };

        void (async () => {
          if (reqUrl.includes('/api/tournaments/leaderboard')) {
            if (scenario === 'network_error') {
              await cdp!.call('Fetch.failRequest', {
                requestId: reqId,
                errorReason: 'Failed',
              });
              return;
            }
            await respondJson(200, {
              entries:
                scenario === 'empty'
                  ? []
                  : [
                      {
                        rank: 1,
                        playerId: 'p_alpha',
                        displayName: 'AlphaCue',
                        avatarId: 'cue_gold',
                        elo: 1420,
                        championships: 3,
                        finalsAppearances: 5,
                        matchesWon: 14,
                        matchesLost: 3,
                        winRate: 82.4,
                        totalCoinsWon: 2400,
                      },
                    ],
            });
            return;
          }

          if (reqUrl.includes('/api/tournaments/stats/')) {
            if (scenario === 'network_error') {
              await cdp!.call('Fetch.failRequest', {
                requestId: reqId,
                errorReason: 'Failed',
              });
              return;
            }
            await respondJson(200, {
              stats: {
                playerId: 'p_test',
                championships: 1,
                finalsAppearances: 2,
                thirdPlaceFinishes: 0,
                tournamentsEntered: 4,
                matchesWon: 6,
                matchesLost: 3,
                winRate: 66.7,
                totalCoinsWon: 900,
                trophies: [],
                recentTournaments: [],
              },
            });
            return;
          }

          if (/\/api\/tournaments\/t_[^/?]+/.test(reqUrl)) {
            if (scenario === 'missing_detail') {
              await respondJson(404, {
                error: 'NOT_FOUND',
                message: 'Tournament detail missing.',
              });
              return;
            }
            if (scenario === 'network_error') {
              await cdp!.call('Fetch.failRequest', {
                requestId: reqId,
                errorReason: 'Failed',
              });
              return;
            }
            const now = Date.now();
            await respondJson(200, {
              tournament: {
                tournamentId: 't_reg_01',
                title: 'Masters Bracket Cup',
                description: 'Regression test championship bracket',
                type: 'daily',
                status: 'in_progress',
                ruleProfileId: 'casual',
                calledShotsEnabled: false,
                isPrivate: false,
                inviteCode: null,
                createdByPlayerId: 'p_host',
                seasonKey: '2026-S4',
                maxPlayers: 8,
                minPlayers: 2,
                bracketSize: 4,
                participantCount: 4,
                currentRound: 1,
                totalRounds: 2,
                entryFeeCoins: 50,
                minElo: 0,
                prizes: {
                  championCoins: 800,
                  runnerUpCoins: 300,
                  thirdPlaceCoins: 150,
                  participationCoins: 25,
                },
                registrationOpensAtMs: now - 3600_000,
                registrationClosesAtMs: now - 600_000,
                startsAtMs: now - 600_000,
                endedAtMs: null,
                championPlayerId: null,
                championDisplayName: null,
                runnerUpPlayerId: null,
                runnerUpDisplayName: null,
                thirdPlacePlayerId: null,
                thirdPlaceDisplayName: null,
              },
              participants: [
                {
                  playerId: 'p_alpha',
                  displayName: 'AlphaCue',
                  avatarId: 'cue_gold',
                  elo: 1420,
                  seed: 1,
                  status: 'active',
                  placement: null,
                },
                {
                  playerId: 'p_bravo',
                  displayName: 'BravoEight',
                  avatarId: 'eight_obsidian',
                  elo: 1380,
                  seed: 2,
                  status: 'active',
                  placement: null,
                },
              ],
              matches: [
                {
                  bracketMatchId: 'bm_sf_1',
                  tournamentId: 't_reg_01',
                  roundNumber: 1,
                  roundLabel: 'Semifinal',
                  slotIndex: 0,
                  isThirdPlaceMatch: false,
                  status: 'in_progress',
                  player1Id: 'p_alpha',
                  player1Name: 'AlphaCue',
                  player1Avatar: 'cue_gold',
                  player1Seed: 1,
                  player1Joined: true,
                  player2Id: 'p_bravo',
                  player2Name: 'BravoEight',
                  player2Avatar: 'eight_obsidian',
                  player2Seed: 2,
                  player2Joined: true,
                  winnerId: null,
                  roomId: 'room_live_test',
                  readyDeadlineMs: null,
                },
              ],
              payouts: [],
              events: [
                {
                  eventId: 'ev_1',
                  summary: 'Semifinal bracket pairings locked.',
                  createdAtMs: now - 120_000,
                },
              ],
              viewerStatus: { isRegistered: false, participant: null, activeMatch: null },
            });
            return;
          }

          if (reqUrl.includes('/api/tournaments')) {
            listRequestCount++;
            if (scenario === 'network_error') {
              await cdp!.call('Fetch.failRequest', {
                requestId: reqId,
                errorReason: 'Failed',
              });
              return;
            }
            if (scenario === 'malformed') {
              await respondJson(200, {
                tournaments: [
                  null,
                  { broken: true },
                  {
                    tournamentId: 't_partial',
                    title: 'Partial Safe Event',
                    status: 'registration_open',
                    type: 'quick',
                    prizes: null,
                  },
                ],
              });
              return;
            }
            if (scenario === 'empty') {
              await respondJson(200, { tournaments: [] });
              return;
            }
            const now = Date.now();
            await respondJson(200, {
              tournaments: [
                {
                  tournamentId: 't_reg_01',
                  title: 'Masters Bracket Cup',
                  description: 'Regression test championship bracket',
                  type: 'daily',
                  status: 'in_progress',
                  ruleProfileId: 'casual',
                  calledShotsEnabled: false,
                  isPrivate: false,
                  inviteCode: null,
                  createdByPlayerId: 'p_host',
                  seasonKey: '2026-S4',
                  maxPlayers: 8,
                  minPlayers: 2,
                  bracketSize: 4,
                  participantCount: 4,
                  currentRound: 1,
                  totalRounds: 2,
                  entryFeeCoins: 50,
                  minElo: 0,
                  prizes: {
                    championCoins: 800,
                    runnerUpCoins: 300,
                    thirdPlaceCoins: 150,
                    participationCoins: 25,
                  },
                  registrationOpensAtMs: now - 3600_000,
                  registrationClosesAtMs: now + 3600_000,
                  startsAtMs: now + 3600_000,
                  endedAtMs: null,
                  viewerRegistered: false,
                },
              ],
            });
            return;
          }

          await cdp!.call('Fetch.continueRequest', { requestId: reqId });
        })().catch(() => {});
      }
    });

    await cdp.call('Runtime.enable');
    await cdp.call('Page.enable');
    await cdp.call('Fetch.enable', {
      patterns: [{ urlPattern: '*api/tournaments*', requestStage: 'Request' }],
    });
    await cdp.call('Emulation.setDeviceMetricsOverride', {
      width: opts.viewport.width,
      height: opts.viewport.height,
      deviceScaleFactor: opts.viewport.mobile ? 2 : 1,
      mobile: opts.viewport.mobile,
    });

    const waitForSelector = async (sel: string, timeoutMs = 10000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = await cdp!.eval<boolean>(`Boolean(document.querySelector(${JSON.stringify(sel)}))`);
        if (found) return;
        await sleep(100);
      }
      throw new Error(`[${opts.label}] Selector timed out: ${sel}`);
    };

    const waitForText = async (needle: string, timeoutMs = 8000): Promise<void> => {
      const lowerNeedle = needle.toLowerCase();
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const body = await cdp!.eval<string>('document.body.innerText');
        if (body.toLowerCase().includes(lowerNeedle)) return;
        await sleep(100);
      }
      const diag = await cdp!.eval<string>(
        `(document.querySelector('[role="dialog"]')?.innerText || document.body.innerText).slice(0, 800)`,
      );
      throw new Error(`[${opts.label}] Text not found: "${needle}". Visible text:\n${diag}`);
    };

    const assertNoRecoveryCrash = async (step: string) => {
      const text = await cdp!.eval<string>('document.body.innerText');
      assert(
        !text.includes('ULTIMATE POOL 3D — Recovery'),
        `[${opts.label}] Hit global Recovery screen at step "${step}":\n${text}`,
      );
      assert(
        !text.includes('Minified React error #310') && !text.includes('Minified React error #300'),
        `[${opts.label}] Minified React Hooks error rendered at step "${step}":\n${text}`,
      );
      assert.equal(
        reactHookErrors.length,
        0,
        `[${opts.label}] React Hook console error detected at "${step}": ${reactHookErrors.join(' | ')}`,
      );
    };

    // 1. Load main menu (defaults to Arabic RTL on fresh browser, verify no crash, then switch to English via menu selector)
    await cdp.call('Page.navigate', { url: opts.url });
    await waitForSelector('[data-testid="open-tournaments-btn"]', 15000);
    await assertNoRecoveryCrash('initial-menu-ar');
    await cdp.eval(`document.querySelector('[data-testid="menu-lang-en"]')?.click()`);
    await waitForText('Global Tournaments');

    // 2. Main menu -> Tournament screen (populated list)
    scenario = 'populated';
    await cdp.eval(`document.querySelector('[data-testid="open-tournaments-btn"]').click()`);
    await waitForText('Global Tournaments & Championships');
    await waitForText('Masters Bracket Cup');
    await assertNoRecoveryCrash('open-populated-discover');

    // 3. Open tournament details & Bracket view + Match card
    await cdp.eval(`
      Array.from(document.querySelectorAll('button'))
        .find((b) => b.textContent && b.textContent.includes('View Bracket'))?.click();
    `);
    await waitForText('Single-Elimination Bracket');
    await waitForText('AlphaCue');
    await waitForText('BravoEight');
    await assertNoRecoveryCrash('bracket-view');

    // 4. Switch tabs: Leaderboard & My Trophies & Admin -> Discover
    for (const tabText of ['Leaderboard', 'My Trophies', 'Admin', 'Discover']) {
      await cdp.eval(`
        Array.from(document.querySelectorAll('[role="dialog"] button'))
          .find((b) => b.textContent && b.textContent.trim() === ${JSON.stringify(tabText)})?.click();
      `);
      await sleep(180);
      await assertNoRecoveryCrash(`tab-${tabText}`);
    }

    // 5. Empty state
    scenario = 'empty';
    await cdp.eval(`document.querySelector('[aria-label="Refresh tournaments"]').click()`);
    await waitForText('No tournaments match your current filter.');
    await assertNoRecoveryCrash('empty-list');

    // 6. Network failure state -> does not crash app
    scenario = 'network_error';
    await cdp.eval(`document.querySelector('[aria-label="Refresh tournaments"]').click()`);
    await waitForSelector('[data-testid="tournament-list-error"]');
    await assertNoRecoveryCrash('network-error-list');

    // 7. Missing tournament details on Bracket tab
    scenario = 'populated';
    await cdp.eval(`document.querySelector('[aria-label="Refresh tournaments"]').click()`);
    await waitForText('Masters Bracket Cup');
    scenario = 'missing_detail';
    await cdp.eval(`
      Array.from(document.querySelectorAll('button'))
        .find((b) => b.textContent && b.textContent.includes('View Bracket'))?.click();
    `);
    await waitForSelector('[data-testid="tournament-detail-error"]');
    await assertNoRecoveryCrash('missing-detail');

    // 8. Malformed / partial tournament data payload
    scenario = 'malformed';
    await cdp.eval(`
      Array.from(document.querySelectorAll('[role="dialog"] button'))
        .find((b) => b.textContent && b.textContent.trim() === 'Discover')?.click();
    `);
    await cdp.eval(`document.querySelector('[aria-label="Refresh tournaments"]').click()`);
    await waitForText('Partial Safe Event');
    await assertNoRecoveryCrash('malformed-payload');

    // 9. Close back to Main Menu and reopen repeatedly + rapid toggle stress test
    scenario = 'populated';
    for (let i = 0; i < 6; i++) {
      await cdp.eval(`document.querySelector('[aria-label="Close tournaments hub"]')?.click()`);
      await sleep(40);
      await assertNoRecoveryCrash(`rapid-close-${i}`);
      await cdp.eval(`document.querySelector('[data-testid="open-tournaments-btn"]')?.click()`);
      await sleep(40);
      await assertNoRecoveryCrash(`rapid-open-${i}`);
    }
    await waitForText('Global Tournaments & Championships');
    await cdp.eval(`document.querySelector('[aria-label="Close tournaments hub"]')?.click()`);
    await sleep(100);

    // 10. Reload browser and reopen tournament screen
    await cdp.eval(`window.__preReloadMarker = 1`);
    await cdp.call('Page.reload', { ignoreCache: true });
    {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const ready = await cdp.eval<boolean>(
          `window.__preReloadMarker === undefined && Boolean(document.querySelector('[data-testid="open-tournaments-btn"]'))`,
        );
        if (ready) break;
        await sleep(120);
      }
    }
    await cdp.eval(`document.querySelector('[data-testid="open-tournaments-btn"]').click()`);
    await waitForText('Global Tournaments & Championships');
    await assertNoRecoveryCrash('reload-and-reopen');
    await cdp.eval(`document.querySelector('[aria-label="Close tournaments hub"]')?.click()`);
    await sleep(100);

    // 11. Verify Main Menu modes: Player Profile, Ranked Match, Quick Match, AI Opponent & Start 8-Ball Match
    await cdp.eval(`
      Array.from(document.querySelectorAll('button'))
        .find((b) => b.textContent && b.textContent.trim() === 'Profile')?.click();
    `);
    await waitForText('Player Profile & Career');
    await assertNoRecoveryCrash('player-profile');
    await cdp.eval(`document.querySelector('[aria-label="Close competitive hub"]')?.click()`);
    await sleep(100);

    // Online Lobby via Ranked Match
    await cdp.eval(`document.querySelector('[data-testid="open-ranked-btn"]')?.click()`);
    await waitForText('Online Multiplayer');
    await assertNoRecoveryCrash('online-lobby-ranked');
    await cdp.eval(`document.querySelector('[aria-label="Close online lobby"]')?.click()`);
    await sleep(100);

    // Online Lobby via Quick Match
    await cdp.eval(`
      Array.from(document.querySelectorAll('button'))
        .find((b) => b.textContent && b.textContent.trim() === 'Quick Match')?.click();
    `);
    await waitForText('Online Multiplayer');
    await assertNoRecoveryCrash('online-lobby-quick');
    await cdp.eval(`document.querySelector('[aria-label="Close online lobby"]')?.click()`);
    await sleep(100);

    // Start 8-Ball Match (AI Opponent)
    await cdp.eval(`
      Array.from(document.querySelectorAll('button'))
        .find((b) => b.textContent && b.textContent.includes('START 8-BALL MATCH'))?.click();
    `);
    await sleep(500);
    await assertNoRecoveryCrash('start-ai-match');

    assert.equal(pageExceptions.length, 0, `[${opts.label}] Page exceptions: ${pageExceptions.join(' | ')}`);
    assert(listRequestCount >= 4, `[${opts.label}] Expected >=4 tournament fetch requests, saw ${listRequestCount}`);
    const elapsedMs = Date.now() - startedAt;
    console.log(
      `PASS [${opts.label}] (${opts.viewport.width}x${opts.viewport.height} mobile=${opts.viewport.mobile}, ${elapsedMs}ms): All 11 tournament & navigation transitions verified with 0 React Hooks errors.`,
    );
  } finally {
    if (cdp) cdp.close();
    activeChildProcs.delete(chrome);
    killProcessTree(chrome);
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  }
}

function killProcessTree(proc: ChildProcess): void {
  if (proc.pid) {
    try {
      process.kill(-proc.pid, 'SIGKILL');
      return;
    } catch {
      // fallback
    }
  }
  try {
    proc.kill('SIGKILL');
  } catch {
    // ignore
  }
}

async function main() {
  const devPort = await allocateFreePort();
  const devCdpPort = await allocateFreePort();
  const prodPort = await allocateFreePort();
  const prodCdpPortMobile = await allocateFreePort();
  const prodCdpPortDesktop = await allocateFreePort();

  // 1. Vite Dev Mode (Non-minified React) on mobile viewport
  const devVite = spawn(
    './node_modules/.bin/vite',
    ['--port', String(devPort), '--host', '127.0.0.1', '--strictPort'],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  activeChildProcs.add(devVite);
  try {
    await waitForHttpReady(`http://127.0.0.1:${devPort}/`, 15000);
    await runBrowserSuite({
      label: 'Dev Non-Minified React Mobile',
      url: `http://127.0.0.1:${devPort}/`,
      cdpPort: devCdpPort,
      viewport: { width: 390, height: 844, mobile: true },
    });
  } finally {
    activeChildProcs.delete(devVite);
    killProcessTree(devVite);
  }

  // 2. Vite Preview (Minified Production Build) on mobile + desktop viewports
  const prodVite = spawn(
    './node_modules/.bin/vite',
    ['preview', '--port', String(prodPort), '--host', '127.0.0.1', '--strictPort'],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  activeChildProcs.add(prodVite);
  try {
    await waitForHttpReady(`http://127.0.0.1:${prodPort}/`, 15000);
    await runBrowserSuite({
      label: 'Production Build Mobile',
      url: `http://127.0.0.1:${prodPort}/`,
      cdpPort: prodCdpPortMobile,
      viewport: { width: 390, height: 844, mobile: true },
    });
    await runBrowserSuite({
      label: 'Production Build Desktop',
      url: `http://127.0.0.1:${prodPort}/`,
      cdpPort: prodCdpPortDesktop,
      viewport: { width: 1280, height: 800, mobile: false },
    });
  } finally {
    activeChildProcs.delete(prodVite);
    killProcessTree(prodVite);
  }

  console.log('Tournament React Hooks & Error Resilience Regression Suite: ALL PASSED.');
  process.exit(0);
}

void main().catch((err) => {
  console.error('Tournament regression suite FAILED:', err);
  process.exit(1);
});
