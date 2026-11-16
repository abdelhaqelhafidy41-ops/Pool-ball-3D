import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GameHUD } from '../src/components/GameHUD';
import { formatCountdown, StoreModal } from '../src/components/StoreModal';
import {
  BALL_SPECS,
  CLOTH_PHYSICS,
  POCKET_POSITIONS,
  TABLE_DIMENSIONS,
} from '../src/game/utils/constants';
import { getTableSkinVisualSpec } from '../src/game/utils/ProceduralTextures';
import { economyClient } from '../src/multiplayer/EconomyClient';
import {
  COSMETIC_CATALOG,
  COSMETIC_CATALOG_MAP,
  DAILY_LOGIN_SCHEDULE,
  computeDailyRewardState,
  getNextUtcMidnightMs,
  type DailyRewardStatus,
} from '../src/multiplayer/shared/economy';
import { useGameStore } from '../src/store/useGameStore';

const CF_PORT = 8795;
const CF_STATE_DIR = '/tmp/cf-critical-fix-state';
const ORIGIN = 'https://test-user.github.io';

function setupBrowserGlobalsForTest(baseHttp: string) {
  const storage = new Map<string, string>();
  const mockLocalStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => {
      storage.set(k, v);
    },
    removeItem: (k: string) => {
      storage.delete(k);
    },
    clear: () => {
      storage.clear();
    },
  };

  Object.defineProperty(globalThis, 'localStorage', {
    value: mockLocalStorage,
    configurable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    value: {
      location: { origin: ORIGIN, hostname: '127.0.0.1' },
      localStorage: mockLocalStorage,
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
    },
    configurable: true,
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = typeof input === 'string' ? input : input.toString();
    const parsed = new URL(rawUrl, baseHttp);
    const targetUrl = `${baseHttp}${parsed.pathname}${parsed.search}`;
    const headers = new Headers(init?.headers ?? {});
    headers.set('Origin', ORIGIN);
    return realFetch(targetUrl, { ...init, headers });
  }) as typeof fetch;
}

async function waitForWrangler(baseHttp: string): Promise<void> {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseHttp}/health`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Timed out waiting for wrangler dev (Critical Economy & UI verification)');
}

async function main() {
  // =========================================================================
  // [1] Complete Store Product Catalog Verification & Physics Immutability
  // =========================================================================
  const expectedCueNames = [
    'Classic Wood Cue',
    'Professional Carbon Cue',
    'Golden Cue',
    'Royal Platinum Cue',
    'Neon Cyber Cue',
    'Legendary Dragon Cue',
  ];
  const expectedBallNames = [
    'Classic Balls',
    'Metallic Balls',
    'Neon Balls',
    'Marble Balls',
    'Golden Balls',
    'Crystal Balls',
  ];
  const expectedTableNames = [
    'Classic Green Table',
    'Tournament Blue Table',
    'Luxury Dark Table',
    'Neon Arena Table',
    'Royal Gold Table',
  ];

  const catalogNames = new Set(COSMETIC_CATALOG.map((i) => i.name));
  for (const name of [...expectedCueNames, ...expectedBallNames, ...expectedTableNames]) {
    assert(catalogNames.has(name), `Catalog missing expected product: ${name}`);
  }
  assert(COSMETIC_CATALOG_MAP.has('ball_golden'));
  assert(COSMETIC_CATALOG_MAP.has('ball_crystal'));
  assert(COSMETIC_CATALOG_MAP.has('table_royal_gold'));

  // Physics constants must be 100% immutable
  assert.equal(TABLE_DIMENSIONS.playLength, 2.54);
  assert.equal(TABLE_DIMENSIONS.playWidth, 1.27);
  assert.equal(BALL_SPECS.radius, 0.028575);
  assert.equal(POCKET_POSITIONS.length, 6);
  assert.equal(CLOTH_PHYSICS.slideMu, 0.21);
  assert.equal(CLOTH_PHYSICS.rollMu, 0.014);

  // Table visual specs render distinct styles for all tables including Royal Gold
  const royalGoldSpec = getTableSkinVisualSpec('table_royal_gold');
  assert.equal(royalGoldSpec.id, 'table_royal_gold');
  assert.equal(royalGoldSpec.trimMetal, 'gold');
  assert.equal(royalGoldSpec.woodFinish, 'rosewood');
  assert.notEqual(royalGoldSpec.clothBase, getTableSkinVisualSpec('table_classic_green').clothBase);
  console.log('PASS [1] Product catalog (cues, balls incl. Golden/Crystal, tables incl. Royal Gold) & physics immutability verified');

  // =========================================================================
  // [2] Daily Rewards 7-Day Lifecycle, UTC Midnight Rollover & Streak Reset
  // =========================================================================
  const day1Noon = Date.UTC(2026, 6, 10, 12, 0, 0);
  const s0 = computeDailyRewardState(0, null, day1Noon);
  assert.equal(s0.streak, 0);
  assert.equal(s0.nextDayIndex, 1);
  assert.equal(s0.nextRewardCoins, DAILY_LOGIN_SCHEDULE[0].coins);
  assert.equal(s0.canClaim, true);
  assert.equal(s0.serverNowMs, day1Noon);

  // Claimed Day 1 -> blocked same day, countdown non-zero (12:00:00 until UTC midnight)
  const s1Claimed = computeDailyRewardState(1, day1Noon, day1Noon);
  assert.equal(s1Claimed.canClaim, false);
  assert.equal(s1Claimed.claimedToday, true);
  assert.equal(s1Claimed.nextClaimAtMs, getNextUtcMidnightMs(day1Noon));
  assert.equal(formatCountdown(s1Claimed.nextClaimAtMs, day1Noon), '12:00:00');

  // Cross UTC midnight -> Day 2 Ready (+75)
  const day2Early = Date.UTC(2026, 6, 11, 0, 0, 5);
  const s2Ready = computeDailyRewardState(1, day1Noon, day2Early);
  assert.equal(s2Ready.streak, 1);
  assert.equal(s2Ready.nextDayIndex, 2);
  assert.equal(s2Ready.nextRewardCoins, DAILY_LOGIN_SCHEDULE[1].coins);
  assert.equal(s2Ready.canClaim, true);

  // Day 7 ready & claimed -> wraps cleanly back to Day 1 next UTC day
  const day7Noon = Date.UTC(2026, 6, 16, 12, 0, 0);
  const day6Noon = Date.UTC(2026, 6, 15, 12, 0, 0);
  const s7Ready = computeDailyRewardState(6, day6Noon, day7Noon);
  assert.equal(s7Ready.nextDayIndex, 7);
  assert.equal(s7Ready.nextRewardCoins, 400);
  const s7Claimed = computeDailyRewardState(7, day7Noon, day7Noon);
  assert.equal(s7Claimed.nextDayIndex, 7);
  assert.equal(s7Claimed.claimedToday, true);
  const day8Noon = Date.UTC(2026, 6, 17, 12, 0, 0);
  const s8Cycle = computeDailyRewardState(7, day7Noon, day8Noon);
  assert.equal(s8Cycle.nextDayIndex, 1);
  assert.equal(s8Cycle.nextRewardCoins, 50);

  // Missed full UTC day -> resets streak cleanly back to 0 / Day 1
  const dayMissed = Date.UTC(2026, 6, 12, 10, 0, 0);
  const sMissed = computeDailyRewardState(5, day1Noon, dayMissed);
  assert.equal(sMissed.streak, 0);
  assert.equal(sMissed.nextDayIndex, 1);
  assert.equal(sMissed.canClaim, true);
  console.log('PASS [2] Daily Rewards 7-day cycle, UTC midnight rollover, missed-day reset & countdown math verified');

  // =========================================================================
  // [3] Live Worker + EconomyClient End-to-End Sync, Purchase, Daily Claim & Equip
  // =========================================================================
  rmSync(CF_STATE_DIR, { recursive: true, force: true });
  const wranglerBin = join(process.cwd(), 'node_modules', '.bin', 'wrangler');
  const baseHttp = `http://127.0.0.1:${CF_PORT}`;

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
    setupBrowserGlobalsForTest(baseHttp);

    // Ensure catalog fetch works via EconomyClient
    const catalog = await economyClient.fetchCatalog(true);
    assert(catalog.some((i) => i.id === 'ball_golden'));
    assert(catalog.some((i) => i.id === 'ball_crystal'));
    assert(catalog.some((i) => i.id === 'table_royal_gold'));

    // Refresh wallet via EconomyClient (tests the fixed flat-response parser!)
    const initialSnap = await economyClient.refreshWallet();
    assert(initialSnap !== null, 'EconomyClient.refreshWallet() returned null');
    assert.equal(initialSnap.wallet.balance, 100);
    assert.equal(initialSnap.dailyReward.canClaim, true);
    assert(typeof initialSnap.dailyReward.serverNowMs === 'number');

    // Claim Day 1 Daily Reward via EconomyClient -> balance becomes 150
    const dailyClaim = await economyClient.claimDailyReward();
    assert.equal(dailyClaim.ok, true);
    assert.equal(useGameStore.getState().wallet?.balance, 150);
    assert.equal(useGameStore.getState().dailyReward?.canClaim, false);
    assert.equal(useGameStore.getState().dailyReward?.claimedToday, true);

    // Check store state received valid non-expired nextClaimAtMs
    const dailyAfter = useGameStore.getState().dailyReward!;
    assert(dailyAfter.nextClaimAtMs > economyClient.getTrustedNowMs());
    const countdownStr = formatCountdown(dailyAfter.nextClaimAtMs, economyClient.getTrustedNowMs());
    assert.notEqual(countdownStr, '00:00:00', 'Claimed daily reward countdown must not freeze at 00:00:00');

    // Duplicate claim fails safely with balance intact
    const dailyDup = await economyClient.claimDailyReward();
    assert.equal(dailyDup.ok, false);
    assert.equal(useGameStore.getState().wallet?.balance, 150);

    // Insufficient funds purchase (Golden Balls 2400 > 150) fails cleanly
    const failBuy = await economyClient.purchaseItem('ball_golden');
    assert.equal(failBuy.ok, false);
    assert.equal(failBuy.code, 'INSUFFICIENT_FUNDS');
    assert.equal(useGameStore.getState().wallet?.balance, 150);

    // Simulate reload: reset Zustand economy slice and re-fetch via EconomyClient.refreshWallet()
    useGameStore.setState({ wallet: null, inventoryIds: [], dailyReward: null });
    const reloadedSnap = await economyClient.refreshWallet();
    assert(reloadedSnap !== null);
    assert.equal(reloadedSnap.wallet.balance, 150);
    assert.equal(reloadedSnap.dailyReward.claimedToday, true);
    assert.equal(reloadedSnap.dailyReward.streak, 1);

    // Check ledger sync
    const txs = await economyClient.fetchTransactions(20);
    assert(txs.some((t) => t.reason === 'daily_login' && t.amount === 50));
    console.log('PASS [3] EconomyClient live Worker wallet sync, daily claim, insufficient-funds guard & reload persistence verified');

    // =========================================================================
    // [4] UI Component DOM Verification: GameHUD Vertical Utility Stack & StoreModal
    // =========================================================================
    const syncTestStoreState = (patch: Partial<ReturnType<typeof useGameStore.getState>>) => {
      useGameStore.setState(patch);
      Object.assign(useGameStore.getInitialState(), useGameStore.getState());
    };

    syncTestStoreState({
      screen: 'playing',
      replayActive: false,
      replayShots: [],
      settings: {
        ...useGameStore.getState().settings,
        showFps: true,
      },
      soundEnabled: true,
      isFullscreen: false,
    });

    const hudHtml = renderToStaticMarkup(
      React.createElement(GameHUD, {
        onShoot: () => {},
        onResetRack: () => {},
        onConfirmPlacement: () => {},
        onPlaceAtHeadSpot: () => {},
        onSelectCalledShot: () => {},
        onToggleFullscreen: () => {},
        onEnterReplay: () => {},
      }),
    );

    const stackStart = hudHtml.indexOf('data-testid="hud-utility-stack"');
    assert(stackStart !== -1, 'GameHUD missing hud-utility-stack');
    const stackHtml = hudHtml.slice(stackStart);
    assert(stackHtml.includes('flex-col'), 'Utility stack must use vertical flex-col layout');
    const fpsPos = stackHtml.indexOf('Development FPS Indicator');
    const soundPos = stackHtml.indexOf('data-testid="hud-sound-btn"');
    const fsPos = stackHtml.indexOf('data-testid="hud-fullscreen-btn"');
    assert(fpsPos !== -1 && soundPos !== -1 && fsPos !== -1, 'Missing FPS, Sound, or Fullscreen inside utility stack');
    assert(fpsPos < soundPos && soundPos < fsPos, 'Utility stack order must be FPS -> Sound -> Fullscreen top-to-bottom');
    assert.equal(hudHtml.match(/data-testid="hud-sound-btn"/g)?.length, 1, 'Duplicate Sound button detected');
    assert.equal(hudHtml.match(/data-testid="hud-fullscreen-btn"/g)?.length, 1, 'Duplicate Fullscreen button detected');

    // Verify StoreModal SSR output on Store tab (Catalog + Buy/Equip + Mobile Scroll Classes)
    syncTestStoreState({
      storeModalOpen: true,
      storeTab: 'store',
      storeCategory: 'all',
    });
    const storeHtml = renderToStaticMarkup(React.createElement(StoreModal));
    assert(storeHtml.includes('h-[94dvh] max-h-[94dvh]'), 'StoreModal must use dynamic dvh viewport height');
    assert(storeHtml.includes('data-testid="store-scroll-region"'), 'Missing primary mobile scroll region');
    assert(storeHtml.includes('modal-scroll-y'), 'Store scroll region must use modal-scroll-y (touch-action: pan-y)');
    assert(storeHtml.includes('Classic Wood Cue'));
    assert(storeHtml.includes('Golden Balls'));
    assert(storeHtml.includes('Crystal Balls'));
    assert(storeHtml.includes('Royal Gold Table'));
    assert(storeHtml.includes('data-testid="card-buy-btn-ball_golden"'), 'Store item cards must expose direct Buy action');
    assert(storeHtml.includes('data-testid="card-equip-btn-cue_classic_maple"'), 'Owned starter cards must expose direct Equip/Default action');

    // Verify Daily Rewards SSR output with claimed-today countdown & all 7 tier cards
    const claimedState: DailyRewardStatus = {
      ...s1Claimed,
      nextClaimAtMs: economyClient.getTrustedNowMs() + 5 * 3600_000,
    };
    syncTestStoreState({
      storeTab: 'daily',
      dailyReward: claimedState,
    });
    const dailyHtml = renderToStaticMarkup(React.createElement(StoreModal));
    assert(dailyHtml.includes('data-testid="daily-rewards-scroll"'));
    assert(dailyHtml.includes('data-testid="daily-countdown-timer"'));
    assert(!dailyHtml.includes('>00:00:00<'), 'Daily countdown must display actual remaining time when claimed today');
    for (let day = 1; day <= 7; day++) {
      assert(dailyHtml.includes(`data-testid="daily-tier-${day}"`), `Missing Daily Day ${day} card`);
    }
    console.log('PASS [4] GameHUD vertical utility stack (FPS -> Sound -> Fullscreen) & StoreModal/DailyRewards mobile DOM structure verified');
    console.log('\nCritical Economy, Store, Daily Rewards, HUD & Mobile UI Verification: ALL 4 SUITES PASSED.');
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
    rmSync(CF_STATE_DIR, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
