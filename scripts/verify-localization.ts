import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import {
  TRANSLATIONS,
  localizeBallGroup,
  localizeClubRegion,
  localizeClubRole,
  localizeHighlight,
  localizeMatchHeadline,
  localizeRuleProfile,
  localizeServerError,
  localizeTeamBoardLabel,
  localizeTournamentStatus,
  tLang,
} from '../src/i18n/core';
import { validateTranslationDictionaries } from '../src/i18n/validation';

const CHROMIUM_SHELL =
  '/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-linux64/chrome-headless-shell';

const activeChildProcs = new Set<ChildProcess>();

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
          if (msg.error) entry.reject(new Error(msg.error.message));
          else entry.resolve(msg.result);
        }
      } else if (msg.method) {
        for (const h of this.eventHandlers) h(msg.method, msg.params);
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
    if (!wsUrl) throw new Error(`Unable to attach CDP on port ${port}`);
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

function runStaticDictionaryValidation(): void {
  const report = validateTranslationDictionaries(TRANSLATIONS.en, TRANSLATIONS.ar);
  assert.equal(
    report.missingInAr.length,
    0,
    `Missing keys in Arabic dictionary: ${report.missingInAr.slice(0, 15).join(', ')}`,
  );
  assert.equal(
    report.missingInEn.length,
    0,
    `Missing keys in English dictionary: ${report.missingInEn.slice(0, 15).join(', ')}`,
  );
  assert.equal(
    report.emptyValues.length,
    0,
    `Empty translation values: ${JSON.stringify(report.emptyValues.slice(0, 10))}`,
  );
  assert.equal(
    report.placeholderMismatches.length,
    0,
    `Placeholder mismatches: ${JSON.stringify(report.placeholderMismatches.slice(0, 10))}`,
  );
  assert.equal(
    report.mixedScriptSuspicious.length,
    0,
    `Suspicious Arabic characters in English dictionary: ${JSON.stringify(report.mixedScriptSuspicious.slice(0, 10))}`,
  );
  assert.equal(report.ok, true, 'Static dictionary validation report must be ok');

  // Verify pluralization and interpolation helpers
  assert.ok(tLang('ar', 'menu.startMatchButton').length > 0);
  assert.ok(tLang('en', 'menu.startMatchButton').includes('8-BALL'));
  assert.ok(!tLang('ar', 'tournaments.title').includes('Global Tournaments'));
  assert.ok(localizeClubRegion('MENA', 'ar').includes('الشرق'));
  assert.equal(localizeClubRole('owner', 'ar'), 'المالك');
  assert.equal(localizeTournamentStatus('registration_open', 'ar'), 'التسجيل مفتوح');
  assert.ok(localizeRuleProfile('wpa', 'ar', true).length > 0);
  assert.ok(localizeBallGroup('solids', 'ar').length > 0);
  assert.ok(localizeTeamBoardLabel('Main Singles Match', 'ar').length > 0);
  assert.ok(localizeServerError({ code: 'INSUFFICIENT_COINS' }, 'ar').length > 0);
  assert.ok(localizeMatchHeadline('Player 1 Wins!', 'ar').length > 0);
  const hlAr = localizeHighlight(
    {
      id: 'hl_1',
      category: 'winning_moment',
      title: 'Winning Moment',
      description: 'Sealed the rack.',
      matchTimeSec: 12,
      shotNumber: 9,
      shotId: 's_9',
      shooter: 'player1',
      shooterName: 'Player 1',
      importanceScore: 100,
    },
    'ar',
  );
  assert.ok(hlAr.title.length > 0 && /[\u0600-\u06FF]/.test(hlAr.title));

  console.log(
    `PASS [Static i18n Validation]: ${report.totalKeysEn} EN keys == ${report.totalKeysAr} AR keys, 0 missing, 0 placeholder mismatches, 0 empty values.`,
  );
}

async function runBrowserLocalizationSuite(opts: {
  label: string;
  url: string;
  cdpPort: number;
  viewport: { width: number; height: number; mobile: boolean };
}): Promise<void> {
  const startedAt = Date.now();
  const userDataDir = path.join(
    tmpdir(),
    `pool-i18n-verify-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const chrome = spawn(
    CHROMIUM_SHELL,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      `--remote-debugging-port=${opts.cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  activeChildProcs.add(chrome);

  let cdp: CdpClient | null = null;
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];

  try {
    cdp = await CdpClient.connect(opts.cdpPort);
    await cdp.call('Page.enable');
    await cdp.call('Runtime.enable');
    await cdp.call('Log.enable');

    cdp.onEvent((method, params) => {
      if (method === 'Runtime.exceptionThrown') {
        const text =
          params?.exceptionDetails?.exception?.description ||
          params?.exceptionDetails?.text ||
          'Unknown exception';
        pageErrors.push(text);
      } else if (method === 'Runtime.consoleAPICalled' && params?.type === 'error') {
        const msg = (params.args ?? []).map((a: any) => a.value ?? a.description ?? '').join(' ');
        if (!msg.includes('WebSocket') && !msg.includes('ERR_CONNECTION_REFUSED') && !msg.includes('Failed to fetch')) {
          consoleErrors.push(msg);
        }
      }
    });

    await cdp.call('Emulation.setDeviceMetricsOverride', {
      width: opts.viewport.width,
      height: opts.viewport.height,
      deviceScaleFactor: opts.viewport.mobile ? 2 : 1,
      mobile: opts.viewport.mobile,
    });

    const waitForSelector = async (selector: string, timeoutMs = 15000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const ok = await cdp!.eval<boolean>(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
        if (ok) return;
        await sleep(120);
      }
      throw new Error(`[${opts.label}] Timed out waiting for selector: ${selector}`);
    };

    const assertZeroCrashAndOverflow = async (step: string) => {
      const check = await cdp!.eval<{
        text: string;
        scrollWidth: number;
        innerWidth: number;
      }>(`({
        text: document.body.innerText,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      })`);
      assert(
        !check.text.includes('ULTIMATE POOL 3D — Recovery'),
        `[${opts.label}] Hit global Recovery screen at "${step}"`,
      );
      assert(
        !check.text.includes('Minified React error #310') &&
          !check.text.includes('Minified React error #300'),
        `[${opts.label}] Hit React Hooks error at "${step}"`,
      );
      assert(
        check.scrollWidth <= check.innerWidth + 2,
        `[${opts.label}] Horizontal overflow at "${step}": scrollWidth=${check.scrollWidth}, innerWidth=${check.innerWidth}`,
      );
    };

    // 1. Fresh load -> Arabic ('ar') MUST be the default for first-time users
    await cdp.call('Page.navigate', { url: opts.url });
    await waitForSelector('[data-testid="menu-language-selector"]', 15000);
    await waitForSelector('[data-testid="open-tournaments-btn"]', 15000);

    const initialMeta = await cdp.eval<{
      lang: string;
      dir: string;
      title: string;
      body: string;
    }>(`({
      lang: document.documentElement.lang,
      dir: document.documentElement.dir,
      title: document.title,
      body: document.body.innerText,
    })`);
    assert.equal(initialMeta.lang, 'ar', `[${opts.label}] Fresh browser must default to lang="ar"`);
    assert.equal(initialMeta.dir, 'rtl', `[${opts.label}] Fresh browser must default to dir="rtl"`);
    assert.ok(
      /[\u0600-\u06FF]/.test(initialMeta.title),
      `[${opts.label}] Document title must be localized to Arabic on fresh boot, got "${initialMeta.title}"`,
    );
    assert.ok(
      !initialMeta.body.includes('Online Multiplayer'),
      `[${opts.label}] Arabic default menu leaked English button text`,
    );
    await assertZeroCrashAndOverflow('initial-ar-menu');

    // 2. Switch to English via visible Main Menu selector -> immediate update without reload
    await cdp.eval(`document.querySelector('[data-testid="menu-lang-en"]')?.click()`);
    await sleep(150);
    const switchedEn = await cdp.eval<{
      lang: string;
      dir: string;
      title: string;
      stored: string | null;
      body: string;
    }>(`({
      lang: document.documentElement.lang,
      dir: document.documentElement.dir,
      title: document.title,
      stored: window.localStorage.getItem('ultimate_pool_3d_language_v1'),
      body: document.body.innerText,
    })`);
    assert.equal(switchedEn.lang, 'en');
    assert.equal(switchedEn.dir, 'ltr');
    assert.equal(switchedEn.stored, 'en');
    assert.ok(switchedEn.title.includes('ULTIMATE POOL 3D'));
    assert.ok(switchedEn.body.includes('START 8-BALL MATCH'));
    await assertZeroCrashAndOverflow('menu-switched-en');

    // 3. Reload persists English choice
    await cdp.eval(`window.__i18nReloadMarker = 1`);
    await cdp.call('Page.reload', { ignoreCache: true });
    {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const ready = await cdp.eval<boolean>(
          `window.__i18nReloadMarker === undefined && Boolean(document.querySelector('[data-testid="menu-language-selector"]'))`,
        );
        if (ready) break;
        await sleep(120);
      }
    }
    const afterReload = await cdp.eval<{ lang: string; dir: string }>(`({
      lang: document.documentElement.lang,
      dir: document.documentElement.dir,
    })`);
    assert.equal(afterReload.lang, 'en', `[${opts.label}] Persisted EN language must survive reload`);
    assert.equal(afterReload.dir, 'ltr');

    // 4. Open Settings modal -> verify Settings language selector switches cleanly AR <-> EN
    await cdp.eval(`document.querySelector('[data-testid="open-settings-btn"]')?.click()`);
    await waitForSelector('[data-testid="settings-language-selector"]');
    await cdp.eval(`document.querySelector('[data-testid="settings-lang-ar"]')?.click()`);
    await sleep(150);
    assert.equal(await cdp.eval<string>(`document.documentElement.lang`), 'ar');
    assert.equal(await cdp.eval<string>(`document.documentElement.dir`), 'rtl');
    const settingsArText = await cdp.eval<string>(`document.body.innerText`);
    assert.ok(
      settingsArText.includes(tLang('ar', 'settings.title')),
      `[${opts.label}] Settings must switch immediately to Arabic`,
    );
    await assertZeroCrashAndOverflow('settings-ar');
    await cdp.eval(`document.querySelector(${JSON.stringify(`[aria-label="${tLang('ar', 'common.close')}"]`)})?.click()`);
    await sleep(150);

    // 5. Inspect modals in BOTH Arabic and English
    const modalSpecs: Array<{
      name: string;
      openSelector: string;
      titleKey: string;
      closeAriaKey: string;
    }> = [
      {
        name: 'Store',
        openSelector: '[data-testid="open-store-btn"]',
        titleKey: 'store.armoryTitle',
        closeAriaKey: 'store.closeAria',
      },
      {
        name: 'BattlePass',
        openSelector: '[data-testid="open-battle-pass-btn"]',
        titleKey: 'battlePass.defaultTitle',
        closeAriaKey: 'battlePass.closeAria',
      },
      {
        name: 'Social',
        openSelector: '[data-testid="open-social-btn"]',
        titleKey: 'social.headerTitle',
        closeAriaKey: 'social.closeAria',
      },
      {
        name: 'Tournaments',
        openSelector: '[data-testid="open-tournaments-btn"]',
        titleKey: 'tournaments.headerTitle',
        closeAriaKey: 'tournaments.closeAria',
      },
      {
        name: 'ClubLeagues',
        openSelector: '[data-testid="open-clubs-leagues-btn"]',
        titleKey: 'clubLeagues.title',
        closeAriaKey: 'clubLeagues.close',
      },
      {
        name: 'OnlineLobby',
        openSelector: '[data-testid="open-ranked-btn"]',
        titleKey: 'lobby.headerTitle',
        closeAriaKey: 'lobby.closeAria',
      },
    ];

    for (const langMode of ['ar', 'en'] as const) {
      await cdp.eval(`document.querySelector('[data-testid="menu-lang-${langMode}"]')?.click()`);
      await sleep(140);

      for (const spec of modalSpecs) {
        await cdp.eval(`document.querySelector(${JSON.stringify(spec.openSelector)})?.click()`);
        await sleep(240);

        const bodyText = await cdp.eval<string>(`document.body.innerText`);
        const expected = tLang(langMode, spec.titleKey);
        assert.ok(
          bodyText.toLowerCase().includes(expected.toLowerCase()),
          `[${opts.label}] Modal "${spec.name}" in "${langMode}" missing expected heading "${expected}"`,
        );
        await assertZeroCrashAndOverflow(`${spec.name}-${langMode}`);

        if (spec.name === 'ClubLeagues') {
          // Cycle tabs inside ClubLeagueModal in this language
          for (const tabId of ['teams', 'leagues', 'championships', 'rankings', 'club_hq']) {
            await cdp.eval(`document.querySelector('[data-testid="club-league-tab-${tabId}"]')?.click()`);
            await sleep(80);
          }
          // Verify in-modal language toggle syncs document locale immediately
          await cdp.eval(`document.querySelector('[data-testid="club-league-lang-toggle"]')?.click()`);
          await sleep(100);
          const flippedLang = langMode === 'ar' ? 'en' : 'ar';
          assert.equal(
            await cdp.eval<string>(`document.documentElement.lang`),
            flippedLang,
            `[${opts.label}] ClubLeagueModal language toggle must update document.lang`,
          );
          await cdp.eval(`document.querySelector('[data-testid="club-league-lang-toggle"]')?.click()`);
          await sleep(100);

          await cdp.eval(`document.querySelector('[data-testid="club-league-close-btn"]')?.click()`);
        } else {
          const closeAria = tLang(langMode, spec.closeAriaKey);
          await cdp.eval(`document.querySelector(${JSON.stringify(`[aria-label="${closeAria}"]`)})?.click()`);
        }
        await sleep(160);
      }
    }

    // 6. Start offline 8-Ball match in Arabic -> verify HUD renders in Arabic and switches live via HUD settings
    await cdp.eval(`document.querySelector('[data-testid="menu-lang-ar"]')?.click()`);
    await sleep(150);
    const startBtnText = tLang('ar', 'menu.startMatchButton');
    await cdp.eval(`
      Array.from(document.querySelectorAll('button'))
        .find((b) => b.textContent && b.textContent.includes(${JSON.stringify(startBtnText)}))?.click();
    `);
    await waitForSelector('[data-testid="hud-settings-btn"]', 15000);
    await sleep(300);
    assert.equal(await cdp.eval<string>(`document.documentElement.lang`), 'ar');
    await assertZeroCrashAndOverflow('in-match-hud-ar');

    // Open Settings from HUD and toggle to EN without resetting game
    await cdp.eval(`document.querySelector('[data-testid="hud-settings-btn"]')?.click()`);
    await waitForSelector('[data-testid="settings-language-selector"]');
    await cdp.eval(`document.querySelector('[data-testid="settings-lang-en"]')?.click()`);
    await sleep(180);
    assert.equal(await cdp.eval<string>(`document.documentElement.lang`), 'en');
    assert.equal(await cdp.eval<string>(`document.documentElement.dir`), 'ltr');
    await assertZeroCrashAndOverflow('in-match-hud-en');

    assert.equal(pageErrors.length, 0, `[${opts.label}] Runtime exceptions: ${pageErrors.join(' | ')}`);
    assert.equal(consoleErrors.length, 0, `[${opts.label}] Console errors: ${consoleErrors.join(' | ')}`);

    console.log(
      `PASS [${opts.label}] (${opts.viewport.width}x${opts.viewport.height}, ${Date.now() - startedAt}ms): Arabic default, live AR/EN switching, reload persistence, all 6 modals & live match HUD verified.`,
    );
  } finally {
    if (cdp) cdp.close();
    activeChildProcs.delete(chrome);
    killProcessTree(chrome);
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

async function main() {
  runStaticDictionaryValidation();

  const port = await allocateFreePort();
  const desktopCdp = await allocateFreePort();
  const mobileCdp = await allocateFreePort();

  const vite = spawn(
    './node_modules/.bin/vite',
    ['--port', String(port), '--host', '127.0.0.1', '--strictPort'],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  activeChildProcs.add(vite);

  try {
    await waitForHttpReady(`http://127.0.0.1:${port}/`, 15000);

    await runBrowserLocalizationSuite({
      label: 'Localization Desktop',
      url: `http://127.0.0.1:${port}/`,
      cdpPort: desktopCdp,
      viewport: { width: 1280, height: 800, mobile: false },
    });

    await runBrowserLocalizationSuite({
      label: 'Localization Mobile',
      url: `http://127.0.0.1:${port}/`,
      cdpPort: mobileCdp,
      viewport: { width: 390, height: 844, mobile: true },
    });
  } finally {
    activeChildProcs.delete(vite);
    killProcessTree(vite);
    cleanupAllChildren();
  }

  console.log('Complete Arabic & English Localization Verification Suite: ALL PASSED.');
  process.exit(0);
}

void main().catch((err) => {
  cleanupAllChildren();
  console.error('Localization verification FAILED:', err);
  process.exit(1);
});
