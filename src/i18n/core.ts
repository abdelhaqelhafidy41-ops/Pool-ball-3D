import type { AiDifficulty, BallGroup, MatchBannerNotice, PlayerId, PocketId, RuleProfileId } from '../game/rules/types';
import type { ReplayHighlight } from '../game/replay/types';
import type { CoinTransactionReason, CosmeticItemDef, ItemRarity } from '../multiplayer/shared/economy';
import type { ClubJoinMode, ClubRole, PresenceStatus } from '../multiplayer/shared/social';
import type { CompetitionRegion, TeamMatchFormat } from '../multiplayer/shared/clubLeagues';
import type { TournamentStatus, TournamentType } from '../multiplayer/shared/tournaments';
import { ar } from './translations/ar';
import { en } from './translations/en';
import type { AppLanguage, PluralForms, TextDirection, TranslationParams, TranslationTree } from './types';
export type { AppLanguage } from './types';
import { recordMissingTranslationKey } from './validation';

export const LANGUAGE_STORAGE_KEY = 'ultimate_pool_3d_language_v1';

export const TRANSLATIONS: Record<AppLanguage, typeof en> = {
  ar,
  en,
};

let activeRuntimeLanguage: AppLanguage = 'ar';

export function normalizeLanguage(raw: unknown): AppLanguage {
  return raw === 'en' ? 'en' : 'ar';
}

export function getDirectionForLanguage(lang: AppLanguage): TextDirection {
  return lang === 'ar' ? 'rtl' : 'ltr';
}

export function getIntlLocale(lang: AppLanguage): string {
  // Use western digits (ar-SA-u-nu-latn or ar-u-nu-latn) so ELO/scores/timers stay crisp & readable while months/days are Arabic
  return lang === 'ar' ? 'ar-u-nu-latn' : 'en-US';
}

export function getInitialLanguage(): AppLanguage {
  if (typeof window === 'undefined') {
    return activeRuntimeLanguage;
  }
  try {
    const saved = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (saved === 'en' || saved === 'ar') {
      activeRuntimeLanguage = saved;
      return saved;
    }
  } catch {
    // Ignore storage restriction and fall back to Arabic default
  }
  activeRuntimeLanguage = 'ar';
  return 'ar';
}

export function persistLanguage(lang: AppLanguage): void {
  const safe = normalizeLanguage(lang);
  activeRuntimeLanguage = safe;
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, safe);
  } catch {
    // Ignore storage quota errors
  }
}

export function getActiveRuntimeLanguage(): AppLanguage {
  return activeRuntimeLanguage;
}

export function setActiveRuntimeLanguage(lang: AppLanguage): void {
  activeRuntimeLanguage = normalizeLanguage(lang);
}

export function applyDocumentLocale(lang: AppLanguage): void {
  const safe = normalizeLanguage(lang);
  setActiveRuntimeLanguage(safe);
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.lang = safe;
  root.dir = getDirectionForLanguage(safe);
  document.title = TRANSLATIONS[safe].meta.appTitle;
}

function lookupPath(tree: TranslationTree, key: string): string | PluralForms | null {
  const parts = key.split('.');
  let cur: unknown = tree;
  for (const part of parts) {
    if (typeof cur !== 'object' || cur === null || !(part in cur)) {
      return null;
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  if (typeof cur === 'string') return cur;
  if (
    typeof cur === 'object' &&
    cur !== null &&
    typeof (cur as PluralForms).one === 'string' &&
    typeof (cur as PluralForms).other === 'string'
  ) {
    return cur as PluralForms;
  }
  return null;
}

const pluralRulesCache = new Map<AppLanguage, Intl.PluralRules>();

function getPluralRules(lang: AppLanguage): Intl.PluralRules {
  let pr = pluralRulesCache.get(lang);
  if (!pr) {
    pr = new Intl.PluralRules(lang === 'ar' ? 'ar' : 'en');
    pluralRulesCache.set(lang, pr);
  }
  return pr;
}

function resolvePluralForm(forms: PluralForms, count: number, lang: AppLanguage): string {
  if (count === 0 && typeof forms.zero === 'string') return forms.zero;
  const category = getPluralRules(lang).select(Math.abs(count));
  const candidate = forms[category as keyof PluralForms];
  if (typeof candidate === 'string') return candidate;
  return forms.other ?? forms.one;
}

function interpolate(template: string, params?: TranslationParams): string {
  if (!params) return template;
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_full, name: string) => {
    const val = params[name];
    if (val === undefined || val === null) return '';
    return String(val);
  });
}

export function tLang(
  lang: AppLanguage,
  key: string,
  params?: TranslationParams,
): string {
  const safeLang = normalizeLanguage(lang);
  let entry = lookupPath(TRANSLATIONS[safeLang] as unknown as TranslationTree, key);
  if (entry === null) {
    recordMissingTranslationKey(safeLang, key);
    if (safeLang !== 'en') {
      entry = lookupPath(TRANSLATIONS.en as unknown as TranslationTree, key);
    }
  }
  if (entry === null) {
    return key;
  }
  if (typeof entry === 'string') {
    return interpolate(entry, params);
  }
  const numericCount =
    typeof params?.count === 'number' && Number.isFinite(params.count)
      ? params.count
      : Number(params?.count ?? 0);
  const template = resolvePluralForm(entry, Number.isFinite(numericCount) ? numericCount : 0, safeLang);
  return interpolate(template, params);
}

// ---------- Locale-Aware Formatters ----------

export function formatLocalizedNumber(value: number, lang: AppLanguage): string {
  if (!Number.isFinite(value)) return '0';
  return new Intl.NumberFormat(getIntlLocale(lang)).format(value);
}

export function formatLocalizedDate(ms: number, lang: AppLanguage): string {
  if (!Number.isFinite(ms)) return '';
  return new Intl.DateTimeFormat(getIntlLocale(lang), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(ms));
}

export function formatLocalizedDateTime(ms: number, lang: AppLanguage): string {
  if (!Number.isFinite(ms)) return '';
  return new Intl.DateTimeFormat(getIntlLocale(lang), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms));
}

export function formatLocalizedDuration(totalSecRaw: number): string {
  const totalSec = Math.max(0, Math.floor(Number.isFinite(totalSecRaw) ? totalSecRaw : 0));
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function formatLastSeenLocalized(lastSeenAtMs: number | null, lang: AppLanguage): string {
  if (!lastSeenAtMs) return '';
  const diffMin = Math.max(0, Math.floor((Date.now() - lastSeenAtMs) / 60000));
  if (diffMin < 1) return tLang(lang, 'social.lastSeenJustNow');
  if (diffMin < 60) return tLang(lang, 'social.lastSeenMinutesAgo', { count: diffMin });
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return tLang(lang, 'social.lastSeenHoursAgo', { count: diffHr });
  const diffDay = Math.floor(diffHr / 24);
  return tLang(lang, 'social.lastSeenDaysAgo', { count: diffDay });
}

// ---------- Domain & Server Dynamic Message Localizers ----------

export function localizePlayerName(
  name: string | null | undefined,
  role: PlayerId | null | undefined,
  lang: AppLanguage,
): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed || trimmed === 'Player 1') {
    return role === 'player2'
      ? tLang(lang, 'common.player2')
      : tLang(lang, 'common.player1');
  }
  if (trimmed === 'Player 2') {
    return tLang(lang, 'common.player2');
  }
  const aiNameMap: Record<string, string> = {
    'Rookie Sam': 'ai.beginnerName',
    'Club Victor': 'ai.intermediateName',
    'Master Elena': 'ai.proName',
    'Grandmaster Vega': 'ai.legendName',
  };
  if (trimmed in aiNameMap) {
    return tLang(lang, aiNameMap[trimmed]);
  }
  return trimmed;
}

export function localizeBallGroup(group: BallGroup, lang: AppLanguage): string {
  if (group === 'solids') return tLang(lang, 'hud.solidsLabel');
  if (group === 'stripes') return tLang(lang, 'hud.stripesLabel');
  return tLang(lang, 'hud.unassignedLabel');
}

export function localizeRuleProfile(profileId: RuleProfileId, lang: AppLanguage, short = false): string {
  if (short) {
    return profileId === 'wpa' ? tLang(lang, 'hud.ruleWpaShort') : tLang(lang, 'hud.ruleCasualShort');
  }
  return profileId === 'wpa'
    ? tLang(lang, 'matchRules.profileWpaLabel')
    : tLang(lang, 'matchRules.profileCasualLabel');
}

export function localizePocketName(pocketId: PocketId | string | null | undefined, lang: AppLanguage): string {
  switch (pocketId) {
    case 'TL':
      return tLang(lang, 'calledShot.pocketTL');
    case 'TM':
      return tLang(lang, 'calledShot.pocketTM');
    case 'TR':
      return tLang(lang, 'calledShot.pocketTR');
    case 'BL':
      return tLang(lang, 'calledShot.pocketBL');
    case 'BM':
      return tLang(lang, 'calledShot.pocketBM');
    case 'BR':
      return tLang(lang, 'calledShot.pocketBR');
    default:
      return String(pocketId ?? '');
  }
}

export function localizeBallName(ballNumber: number, lang: AppLanguage): string {
  if (ballNumber === 0) return tLang(lang, 'matchRules.ballCue');
  if (ballNumber === 8) return tLang(lang, 'matchRules.ballEight');
  if (ballNumber >= 1 && ballNumber <= 7) {
    return tLang(lang, 'matchRules.ballSolid', { num: ballNumber });
  }
  return tLang(lang, 'matchRules.ballStripe', { num: ballNumber });
}

export function localizeAiDifficulty(diff: AiDifficulty, lang: AppLanguage): {
  label: string;
  defaultName: string;
  tagline: string;
} {
  return {
    label: tLang(lang, `ai.${diff}Label`),
    defaultName: tLang(lang, `ai.${diff}Name`),
    tagline: tLang(lang, `ai.${diff}Tagline`),
  };
}

export function localizeAiStatus(
  phase: 'idle' | 'analyzing' | 'placing' | 'evaluating' | 'aiming' | 'pullback',
  lang: AppLanguage,
): string {
  switch (phase) {
    case 'analyzing':
      return tLang(lang, 'ai.phaseThinking');
    case 'placing':
      return tLang(lang, 'ai.phasePlacing');
    case 'evaluating':
      return tLang(lang, 'ai.phaseEvaluating');
    case 'aiming':
      return tLang(lang, 'ai.phaseAiming');
    case 'pullback':
      return tLang(lang, 'ai.phasePullback');
    default:
      return tLang(lang, 'ai.phaseStandby');
  }
}

export function localizePlacementReason(reason: string | null | undefined, lang: AppLanguage): string | null {
  if (!reason) return null;
  if (lang === 'en') return reason;
  if (reason.includes('behind the head string')) return tLang(lang, 'ballInHand.reasonKitchen');
  if (reason.includes('inside the table rails')) return tLang(lang, 'ballInHand.reasonOutsideRails');
  if (reason.includes('overlap another ball')) return tLang(lang, 'ballInHand.reasonOverlapBall');
  if (reason.includes('inside a pocket')) return tLang(lang, 'ballInHand.reasonInsidePocket');
  return reason;
}

export function localizeMatchHeadline(headline: string | null | undefined, lang: AppLanguage): string {
  const raw = (headline ?? '').trim();
  if (!raw) return '';
  if (lang === 'en') return raw;
  const map: Record<string, string> = {
    'Free Play Practice': 'matchRules.headlineFreePlay',
    'Free Play': 'matchRules.headlineFreePlay',
    'Break Shot': 'matchRules.headlineBreak',
    'Ball in Hand (Behind Head String)': 'matchRules.headlineBallInHandKitchen',
    'Ball in Hand': 'matchRules.headlineBallInHand',
    'Open Table': 'matchRules.headlineOpenTable',
    '8-Ball Target': 'matchRules.headlineEightBallTarget',
    'Groups Assigned': 'matchRules.headlineGroupsAssigned',
    '8-Ball Pocketed — Victory!': 'matchRules.headlineEightBallVictory',
    'Foul — Loss of Game': 'matchRules.headlineFoulLoss',
    'Opponent Forfeited — Victory!': 'matchRules.headlineOpponentForfeit',
    'Match Complete': 'matchRules.headlineMatchComplete',
    'Online Match Complete': 'matchRules.headlineMatchComplete',
    'Shot Complete': 'matchRules.headlineShotComplete',
  };
  if (raw in map) return tLang(lang, map[raw]);
  if (raw.startsWith('Foul — ')) return tLang(lang, 'matchRules.headlineBallInHand');
  if (raw.endsWith('Wins!') || raw.includes('Victory')) {
    return tLang(lang, 'matchRules.headlineEightBallVictory');
  }
  return raw;
}

export function localizeFoulOrReason(text: string | null | undefined, lang: AppLanguage): string | null {
  if (!text) return null;
  const raw = text.trim();
  if (!raw) return null;
  if (lang === 'en') return raw;

  const exactMap: Record<string, string> = {
    '8-Ball pocketed before clearing your group.': 'matchRules.reasonEarly8BallLoss',
    'Scratch: 8-Ball pocketed with cue ball scratch.': 'matchRules.reason8BallScratch',
    'Foul on the 8-Ball (cue ball scratched).': 'matchRules.reason8BallScratch',
    '8-Ball pocketed on an illegal shot.': 'matchRules.reason8BallFoulPocket',
    '8-Ball pocketed into an uncalled pocket.': 'matchRules.reason8BallWrongPocket',
    '8-Ball pocket must be called first.': 'matchRules.reason8BallNotCalled',
    '8-Ball legally pocketed — Victory!': 'matchRules.reason8BallLegalWin',
    '8-Ball legally pocketed!': 'matchRules.reason8BallLegalWin',
    'Scratch: Cue ball pocketed.': 'matchRules.reasonScratchPocketed',
    'Illegal break: fewer than 4 object balls hit a rail or pocket.': 'matchRules.reasonNoRailOrPocketOnBreak',
    'Foul: Cue ball failed to contact any legal ball.': 'matchRules.reasonNoContact',
    'Foul: No ball contacted a rail or pocket after impact.': 'matchRules.reasonNoRailAfterContact',
    '8-Ball pocketed on break was respotted.': 'matchRules.reason8BallPocketedOnBreakRespot',
    'Illegal shot.': 'matchRules.reasonIllegalShot',
    'Opponent forfeited the match.': 'matchRules.reasonOpponentForfeit',
    'Opponent disconnected and forfeited.': 'matchRules.reasonOpponentDisconnectForfeit',
    'Match resigned.': 'matchRules.reasonMatchResigned',
  };
  if (raw in exactMap) return tLang(lang, exactMap[raw]);

  if (raw.includes('Must strike a SOLID')) {
    return tLang(lang, 'matchRules.reasonWrongFirstBall', { group: tLang(lang, 'hud.solidsLabel') });
  }
  if (raw.includes('Must strike a STRIPE')) {
    return tLang(lang, 'matchRules.reasonWrongFirstBall', { group: tLang(lang, 'hud.stripesLabel') });
  }
  if (raw.includes('Cannot strike the 8-Ball')) {
    return tLang(lang, 'matchRules.reasonHit8BallTooEarly');
  }
  if (raw.includes('uncalled pocket') || raw.includes('wrong pocket')) {
    return tLang(lang, 'matchRules.reason8BallWrongPocket');
  }
  if (raw.includes('before clearing')) {
    return tLang(lang, 'matchRules.reasonEarly8BallLoss');
  }
  if (raw.includes('Scratch') || raw.includes('Cue ball pocketed')) {
    return tLang(lang, 'matchRules.reasonScratchPocketed');
  }
  if (raw.includes('failed to contact') || raw.includes('No contact')) {
    return tLang(lang, 'matchRules.reasonNoContact');
  }
  if (raw.includes('rail or pocket')) {
    return tLang(lang, 'matchRules.reasonNoRailAfterContact');
  }
  if (raw.includes('disconnected') && raw.includes('forfeit')) {
    return tLang(lang, 'matchRules.reasonOpponentDisconnectForfeit');
  }
  if (raw.includes('forfeit') || raw.includes('Forfeit')) {
    return tLang(lang, 'matchRules.reasonOpponentForfeit');
  }
  if (raw.startsWith('Foul · ')) {
    const inner = localizeFoulOrReason(raw.slice('Foul · '.length), lang) ?? '';
    return `${tLang(lang, 'hud.foulPrefix')} · ${inner}`;
  }
  return raw;
}

export function localizeMatchBanner(
  banner: MatchBannerNotice | null | undefined,
  lang: AppLanguage,
): { title: string; detail: string; kind: MatchBannerNotice['kind'] } | null {
  if (!banner) return null;
  if (lang === 'en') {
    return { title: banner.title, detail: banner.detail, kind: banner.kind };
  }

  const title = banner.title;
  const detail = banner.detail ?? '';
  let localizedTitle = title;
  let localizedDetail = detail;

  const winMatch = title.match(/^(.+?)\s+Wins!$/);
  const foulMatch = title.match(/^Foul by\s+(.+)$/);
  const bihMatch = title.match(/^Ball in Hand:\s+(.+)$/);
  const takesMatch = title.match(/^(.+?)\s+takes\s+(SOLIDS|STRIPES)$/i);

  if (winMatch) {
    const winner = localizePlayerName(winMatch[1], null, lang);
    localizedTitle = tLang(lang, 'matchRules.noticeWinnerTitle', { winner });
  } else if (foulMatch) {
    const p = localizePlayerName(foulMatch[1], null, lang);
    localizedTitle = tLang(lang, 'matchRules.noticeFoulTitle', { player: p });
  } else if (bihMatch) {
    const p = localizePlayerName(bihMatch[1], null, lang);
    localizedTitle = tLang(lang, 'matchRules.noticeBallInHandTitle', { player: p });
  } else if (takesMatch) {
    const p = localizePlayerName(takesMatch[1], null, lang);
    const grp =
      takesMatch[2].toUpperCase() === 'SOLIDS'
        ? tLang(lang, 'hud.solidsLabel')
        : tLang(lang, 'hud.stripesLabel');
    localizedTitle = tLang(lang, 'matchRules.noticeGroupsTitle', { player: p, group: grp });
  } else if (title === '8-Ball Respotted') {
    localizedTitle = tLang(lang, 'matchRules.noticeRespotTitle');
  } else {
    localizedTitle = localizeMatchHeadline(title, lang);
  }

  if (detail) {
    if (detail.includes('behind the head string')) {
      localizedDetail = tLang(lang, 'matchRules.noticePlaceBehindHead');
    } else if (detail.includes('anywhere on the table')) {
      localizedDetail = tLang(lang, 'matchRules.noticePlaceAnywhere');
    } else if (detail.includes('foot spot')) {
      localizedDetail = tLang(lang, 'matchRules.noticeEightRespotted');
    } else {
      localizedDetail = localizeFoulOrReason(detail, lang) ?? detail;
    }
  }

  return {
    title: localizedTitle,
    detail: localizedDetail,
    kind: banner.kind,
  };
}

export function localizeReplayVideoNotice(notice: string | null | undefined, lang: AppLanguage): string | null {
  if (!notice) return null;
  if (lang === 'en') return notice;
  if (notice.includes('unavailable in this browser')) return tLang(lang, 'replay.videoUnavailable');
  if (notice.startsWith('Recording viewport video')) return tLang(lang, 'replay.recordingInProgress');
  if (notice.includes('Unable to start video capture')) return tLang(lang, 'replay.videoStartFailed');
  if (notice.startsWith('Saved ')) {
    return tLang(lang, 'replay.videoSaved', { filename: notice.slice('Saved '.length) });
  }
  return notice;
}

export function localizeCoinBreakdownLabel(label: string, lang: AppLanguage): string {
  if (lang === 'en') return label;
  const lower = label.toLowerCase();
  if (lower.includes('base win') || lower === 'victory bonus' || lower === 'match win') {
    return tLang(lang, 'matchEnd.coinBreakdownBaseWin');
  }
  if (lower.includes('match play') || lower.includes('participation')) {
    return tLang(lang, 'matchEnd.coinBreakdownMatchPlay');
  }
  if (lower.includes('streak')) {
    return tLang(lang, 'matchEnd.coinBreakdownWinStreak');
  }
  if (lower.includes('rank') || lower.includes('tier')) {
    return tLang(lang, 'matchEnd.coinBreakdownRankBonus');
  }
  if (lower.includes('clean')) {
    return tLang(lang, 'matchEnd.coinBreakdownCleanRack');
  }
  return label;
}

export function localizeShotResultLabel(label: string | null | undefined, lang: AppLanguage): string {
  const raw = (label ?? '').trim();
  if (!raw || lang === 'en') return raw;
  if (raw === 'Clean Shot') return tLang(lang, 'matchRules.shotResultClean');
  if (raw === 'Foul') return tLang(lang, 'matchRules.shotResultFoul');
  if (raw === 'Break Complete') return tLang(lang, 'matchRules.shotResultBreakComplete');
  if (raw === 'Shot Complete') return tLang(lang, 'matchRules.headlineShotComplete');
  if (raw.startsWith('Foul · ')) {
    const reason = localizeFoulOrReason(raw.slice('Foul · '.length), lang);
    return `${tLang(lang, 'hud.foulPrefix')} · ${reason ?? ''}`;
  }
  if (raw.endsWith('Wins!')) {
    const name = localizePlayerName(raw.slice(0, -5).trim(), null, lang);
    return tLang(lang, 'matchRules.noticeWinnerTitle', { winner: name });
  }
  const pktMatch = raw.match(/^(\d+)\s+Pocketed/i);
  if (pktMatch) {
    return tLang(lang, 'matchRules.shotResultBallPocketed', { count: pktMatch[1] });
  }
  return localizeMatchHeadline(raw, lang);
}

export function localizeHighlight(hl: ReplayHighlight, lang: AppLanguage): { title: string; description: string } {
  if (lang === 'en') return { title: hl.title, description: hl.description };
  const shooter = localizePlayerName(hl.shooterName, hl.shooter, lang);
  switch (hl.category) {
    case 'break':
      return {
        title: tLang(lang, 'replay.hlOpeningBreakTitle'),
        description: tLang(lang, 'replay.hlOpeningBreakDesc', {
          shooter,
          pocketNote: '',
        }).replace(/\s+\./, '.'),
      };
    case 'eight_ball':
      return {
        title: tLang(lang, 'replay.hlEightBallTitle'),
        description: hl.description,
      };
    case 'winning_moment':
      return {
        title: tLang(lang, 'replay.hlWinningMomentTitle'),
        description: tLang(lang, 'replay.hlWinningMomentDesc', {
          shooter,
          shot: hl.shotNumber,
        }).trim(),
      };
    case 'multi_pocket': {
      const countMatch = hl.title.match(/(\d+)/);
      const count = countMatch ? Number(countMatch[1]) : 2;
      return {
        title: tLang(lang, 'replay.hlMultiPocketTitle', { count }),
        description: tLang(lang, 'replay.hlMultiPocketDesc', { shooter, count }),
      };
    }
    case 'long_pocket':
      return {
        title: tLang(lang, 'replay.hlLongPotTitle'),
        description: tLang(lang, 'replay.hlLongPotDesc', { shot: hl.shotNumber }),
      };
    case 'foul':
      return {
        title: tLang(lang, 'replay.hlFoulTurnTitle'),
        description: hl.description,
      };
    default:
      return { title: hl.title, description: hl.description };
  }
}

export function localizeCollisionLabel(rawLabel: string | null | undefined, lang: AppLanguage): string {
  const raw = (rawLabel ?? '').trim();
  if (!raw || lang === 'en') return raw;
  const ballTok = (tok: string) => {
    const t = tok.trim();
    if (t === 'Cue Ball') return tLang(lang, 'replay.collisionCueBall');
    if (t === '8-Ball') return tLang(lang, 'matchRules.ballEight');
    const numMatch = t.match(/^#(\d+)$/);
    if (numMatch) return localizeBallName(Number(numMatch[1]), lang);
    return t;
  };
  if (raw.startsWith('Cue Impact → ')) {
    const rest = raw.slice('Cue Impact → '.length);
    return tLang(lang, 'replay.collisionCueImpact', { ball: ballTok(rest) });
  }
  if (raw.endsWith(' → Rail Cushion')) {
    const rest = raw.slice(0, -' → Rail Cushion'.length);
    return tLang(lang, 'replay.collisionRailCushion', { ball: ballTok(rest) });
  }
  if (raw.startsWith('Ball Collision: ')) {
    const parts = raw.slice('Ball Collision: '.length).split('↔');
    return tLang(lang, 'replay.collisionBallBall', {
      ballA: ballTok(parts[0] ?? ''),
      ballB: ballTok(parts[1] ?? ''),
    });
  }
  return raw;
}

export function localizeCosmeticItem(
  item: CosmeticItemDef,
  lang: AppLanguage,
): { name: string; subCategory: string; description: string } {
  if (lang === 'en') {
    return { name: item.name, subCategory: item.subCategory, description: item.description };
  }
  const dictItem = TRANSLATIONS.ar.catalog.cosmetics.items[item.id];
  if (dictItem) {
    return {
      name: dictItem.name,
      subCategory: dictItem.subCategory ?? item.subCategory,
      description: dictItem.description,
    };
  }
  // Starter avatars constructed dynamically
  if (item.category === 'avatar' && item.id in TRANSLATIONS.ar.catalog.avatars) {
    const avLabel = TRANSLATIONS.ar.catalog.avatars[item.id as keyof typeof TRANSLATIONS.ar.catalog.avatars];
    return {
      name: tLang(lang, 'catalog.cosmetics.avatarEmblemName', { label: avLabel }),
      subCategory: tLang(lang, 'catalog.cosmetics.starterAvatarSub'),
      description: tLang(lang, 'catalog.cosmetics.starterAvatarDesc'),
    };
  }
  return { name: item.name, subCategory: item.subCategory, description: item.description };
}

export function localizeCosmeticCategory(category: CosmeticItemDef['category'], lang: AppLanguage): string {
  switch (category) {
    case 'cue':
      return tLang(lang, 'store.catCue');
    case 'ball':
      return tLang(lang, 'store.catBall');
    case 'table':
      return tLang(lang, 'store.catTable');
    case 'avatar':
      return tLang(lang, 'store.catAvatar');
    case 'nameplate':
      return tLang(lang, 'store.catNameplate');
    case 'badge':
      return tLang(lang, 'store.catBadge');
    case 'victory':
      return tLang(lang, 'store.catVictory');
    case 'decoration':
      return tLang(lang, 'store.catDecoration');
  }
}

export function localizeRarity(rarity: ItemRarity, lang: AppLanguage): string {
  switch (rarity) {
    case 'common':
      return tLang(lang, 'store.rarityCommon');
    case 'rare':
      return tLang(lang, 'store.rarityRare');
    case 'epic':
      return tLang(lang, 'store.rarityEpic');
    case 'legendary':
      return tLang(lang, 'store.rarityLegendary');
  }
}

export function localizeTxReason(reason: CoinTransactionReason, lang: AppLanguage): string {
  const map: Record<CoinTransactionReason, string> = {
    online_match_win: 'store.txReasonOnlineWin',
    online_match_play: 'store.txReasonOnlinePlay',
    achievement_unlock: 'store.txReasonAchievement',
    ai_match_win: 'store.txReasonAiWin',
    daily_login: 'store.txReasonDailyLogin',
    mission_reward: 'store.txReasonMission',
    weekly_challenge_reward: 'store.txReasonWeeklyChallenge',
    battle_pass_reward: 'store.txReasonBattlePassReward',
    battle_pass_premium: 'store.txReasonBattlePassPremium',
    tournament_reward: 'store.txReasonTournamentReward',
    tournament_entry: 'store.txReasonTournamentEntry',
    tournament_refund: 'store.txReasonTournamentRefund',
    season_reward: 'store.txReasonSeasonReward',
    store_purchase: 'store.txReasonStorePurchase',
    purchase_refund: 'store.txReasonPurchaseRefund',
  };
  return tLang(lang, map[reason] ?? 'common.unknown');
}

export function localizeRankTierName(tierId: string | null | undefined, lang: AppLanguage, fallback?: string): string {
  if (tierId && tierId in TRANSLATIONS[lang].catalog.ranks) {
    return tLang(lang, `catalog.ranks.${tierId}`);
  }
  return fallback ?? tLang(lang, 'catalog.ranks.bronze');
}

export function localizeAchievement(
  id: string,
  fallbackName: string,
  fallbackDescription: string,
  lang: AppLanguage,
): { name: string; description: string } {
  if (id in TRANSLATIONS[lang].catalog.achievements) {
    const entry = TRANSLATIONS[lang].catalog.achievements[id as keyof typeof en.catalog.achievements];
    return { name: entry.name, description: entry.description };
  }
  return { name: fallbackName, description: fallbackDescription };
}

export function localizeMission(
  id: string,
  fallbackTitle: string,
  fallbackDescription: string,
  lang: AppLanguage,
): { title: string; description: string } {
  if (id in TRANSLATIONS[lang].catalog.missions) {
    const entry = TRANSLATIONS[lang].catalog.missions[id as keyof typeof en.catalog.missions];
    return { title: entry.title, description: entry.description };
  }
  return { title: fallbackTitle, description: fallbackDescription };
}

export function localizeTournamentTrophy(
  id: string,
  fallbackName: string,
  fallbackDescription: string,
  lang: AppLanguage,
): { name: string; description: string } {
  if (id in TRANSLATIONS[lang].catalog.trophies) {
    const entry = TRANSLATIONS[lang].catalog.trophies[id as keyof typeof en.catalog.trophies];
    return { name: entry.name, description: entry.description };
  }
  return { name: fallbackName, description: fallbackDescription };
}

export function localizeSeasonNameAndTheme(
  seasonNumber: number,
  fallbackName: string,
  fallbackTheme: string,
  lang: AppLanguage,
): { name: string; theme: string } {
  if (lang === 'en') return { name: fallbackName, theme: fallbackTheme };
  const idx = ((Math.max(1, seasonNumber) - 1) % 4) + 1;
  const theme = tLang(lang, `catalog.seasons.s${idx}Theme`);
  const name =
    seasonNumber <= 4
      ? tLang(lang, `catalog.seasons.s${seasonNumber}Name`)
      : tLang(lang, 'catalog.seasons.mastersTourName', { num: seasonNumber });
  return { name, theme };
}

export function localizeProgressionToast(
  title: string,
  detail: string,
  lang: AppLanguage,
): { title: string; detail: string } {
  if (lang === 'en') return { title, detail };

  let locTitle = title;
  let locDetail = detail;

  const seasonStartedMatch = title.match(/^(.+?)\s+Started$/);
  const tierUnlockedMatch = title.match(/^Battle Pass Tier\s+(\d+)\s+Unlocked$/);
  const dailyMissionMatch = title.match(/^Daily Mission Complete:\s+(.+)$/);
  const weeklyChallengeMatch = title.match(/^Weekly Challenge Complete:\s+(.+)$/);
  const seasonEndingMatch = title.match(/^(.+?)\s+Ending Soon$/);
  const tierClaimedMatch = title.match(/^Tier\s+(\d+)\s+Reward Claimed$/);

  if (seasonStartedMatch) {
    locTitle = tLang(lang, 'battlePass.toastSeasonStartedTitle', { season: seasonStartedMatch[1] });
  } else if (tierUnlockedMatch) {
    locTitle = tLang(lang, 'battlePass.toastTierUnlockedTitle', { level: tierUnlockedMatch[1] });
  } else if (dailyMissionMatch) {
    const rawM = dailyMissionMatch[1];
    const arM = Object.values(TRANSLATIONS.en.catalog.missions).findIndex((m) => m.title === rawM);
    const missionKeys = Object.keys(TRANSLATIONS.ar.catalog.missions);
    const localizedMTitle =
      arM >= 0 ? TRANSLATIONS.ar.catalog.missions[missionKeys[arM] as keyof typeof ar.catalog.missions].title : rawM;
    locTitle = tLang(lang, 'battlePass.toastDailyMissionTitle', { title: localizedMTitle });
  } else if (weeklyChallengeMatch) {
    const rawW = weeklyChallengeMatch[1];
    const arW = Object.values(TRANSLATIONS.en.catalog.missions).findIndex((m) => m.title === rawW);
    const missionKeys = Object.keys(TRANSLATIONS.ar.catalog.missions);
    const localizedWTitle =
      arW >= 0 ? TRANSLATIONS.ar.catalog.missions[missionKeys[arW] as keyof typeof ar.catalog.missions].title : rawW;
    locTitle = tLang(lang, 'battlePass.toastWeeklyChallengeTitle', { title: localizedWTitle });
  } else if (seasonEndingMatch) {
    locTitle = tLang(lang, 'battlePass.toastSeasonEndingTitle', { season: seasonEndingMatch[1] });
  } else if (title === 'Mission Reward Claimed') {
    locTitle = tLang(lang, 'battlePass.toastMissionClaimedTitle');
  } else if (title === 'Premium Battle Pass Activated') {
    locTitle = tLang(lang, 'battlePass.toastPremiumActivatedTitle');
  } else if (tierClaimedMatch) {
    locTitle = tLang(lang, 'battlePass.toastTierClaimedTitle', { level: tierClaimedMatch[1] });
  } else if (title === 'All Pending Rewards Claimed') {
    locTitle = tLang(lang, 'battlePass.toastAllClaimedTitle');
  }

  const maxTiersMatch = detail.match(/^(\d+)\s+seasonal Battle Pass tiers are now live\.$/);
  const coinsXpReadyMatch = detail.match(/^\+(\d+)\s+POOL COINS\s+·\s+\+(\d+)\s+Season XP ready to claim\.$/);
  const coinsXpAddedMatch = detail.match(/^\+(\d+)\s+POOL COINS\s+·\s+\+(\d+)\s+Season XP added\.$/);
  const premDetailMatch = detail.match(/^(.+?)\s+Premium Track rewards are now unlocked\.$/);

  if (maxTiersMatch) {
    locDetail = tLang(lang, 'battlePass.toastSeasonStartedDetail', { max: maxTiersMatch[1] });
  } else if (detail === 'Earn more Season XP or claim your unlocked rewards.') {
    locDetail = tLang(lang, 'battlePass.toastTierUnlockedDetail');
  } else if (coinsXpReadyMatch) {
    locDetail = tLang(lang, 'battlePass.toastMissionDetailCoinsXp', {
      coins: coinsXpReadyMatch[1],
      xp: coinsXpReadyMatch[2],
    });
  } else if (detail === 'Claim any remaining Battle Pass rewards before rollover.') {
    locDetail = tLang(lang, 'battlePass.toastSeasonEndingDetail');
  } else if (coinsXpAddedMatch) {
    locDetail = tLang(lang, 'battlePass.toastMissionClaimedDetail', {
      coins: coinsXpAddedMatch[1],
      xp: coinsXpAddedMatch[2],
    });
  } else if (premDetailMatch) {
    locDetail = tLang(lang, 'battlePass.toastPremiumActivatedDetail', { season: premDetailMatch[1] });
  } else if (detail === 'Reward added to your account.') {
    locDetail = tLang(lang, 'battlePass.toastTierClaimedDetailFallback');
  } else if (detail === 'Account synchronized.') {
    locDetail = tLang(lang, 'battlePass.toastAllClaimedDetailFallback');
  }

  return { title: locTitle, detail: locDetail };
}

export function localizePresence(status: PresenceStatus, lang: AppLanguage): string {
  switch (status) {
    case 'online':
      return tLang(lang, 'social.presenceOnline');
    case 'in_match':
      return tLang(lang, 'social.presenceInMatch');
    case 'in_tournament':
      return tLang(lang, 'social.presenceInTournament');
    case 'spectating':
      return tLang(lang, 'social.presenceSpectating');
    case 'busy':
      return tLang(lang, 'social.presenceBusy');
    case 'offline':
    default:
      return tLang(lang, 'social.presenceOffline');
  }
}

export function localizeClubRole(role: ClubRole | string, lang: AppLanguage): string {
  switch (role) {
    case 'owner':
      return tLang(lang, 'clubLeagues.roles.owner');
    case 'president':
      return tLang(lang, 'clubLeagues.roles.president');
    case 'vice_president':
    case 'admin':
      return tLang(lang, 'clubLeagues.roles.vice_president');
    case 'captain':
      return tLang(lang, 'clubLeagues.roles.captain');
    default:
      return tLang(lang, 'clubLeagues.roles.member');
  }
}

export function localizeClubRegion(region: CompetitionRegion | string | undefined, lang: AppLanguage): string {
  const code = (region ?? 'GLOBAL').toUpperCase();
  if (code in TRANSLATIONS[lang].clubLeagues.regions) {
    return tLang(lang, `clubLeagues.regions.${code}`);
  }
  return code;
}

export function localizeTeamMatchFormat(format: TeamMatchFormat, lang: AppLanguage): string {
  return tLang(lang, `clubLeagues.formats.${format}`);
}

export function localizeTeamBoardLabel(rawLabel: string | null | undefined, lang: AppLanguage): string {
  const raw = (rawLabel ?? '').trim();
  if (!raw || lang === 'en') return raw;
  if (raw === 'Main Singles Match') return tLang(lang, 'clubLeagues.formats.boardMainSingles');
  if (raw === 'Doubles Pair · Board 1') return tLang(lang, 'clubLeagues.formats.boardDoubles1');
  if (raw === 'Doubles Pair · Board 2') return tLang(lang, 'clubLeagues.formats.boardDoubles2');
  if (raw === 'Doubles Decider · Board 3') return tLang(lang, 'clubLeagues.formats.boardDoublesDecider');
  const m = raw.match(/^Board\s+(\d+)$/i);
  if (m) return tLang(lang, 'clubLeagues.formats.boardNumber', { num: m[1] });
  return raw;
}

export function localizeTournamentType(type: TournamentType, lang: AppLanguage): string {
  switch (type) {
    case 'quick':
      return tLang(lang, 'tournaments.typeQuick');
    case 'daily':
      return tLang(lang, 'tournaments.typeDaily');
    case 'weekly':
      return tLang(lang, 'tournaments.typeWeekly');
    case 'private':
      return tLang(lang, 'tournaments.typePrivate');
    case 'scheduled':
      return tLang(lang, 'tournaments.typeScheduled');
  }
}

export function localizeTournamentStatus(status: TournamentStatus, lang: AppLanguage): string {
  switch (status) {
    case 'upcoming':
      return tLang(lang, 'tournaments.statusUpcoming');
    case 'registration_open':
      return tLang(lang, 'tournaments.statusRegistrationOpen');
    case 'in_progress':
      return tLang(lang, 'tournaments.statusInProgress');
    case 'completed':
      return tLang(lang, 'tournaments.statusCompleted');
    case 'cancelled':
      return tLang(lang, 'tournaments.statusCancelled');
  }
}

export function localizeTournamentRoundLabel(rawLabel: string | null | undefined, lang: AppLanguage): string {
  const raw = (rawLabel ?? '').trim();
  if (!raw || lang === 'en') return raw;
  const map: Record<string, string> = {
    'Third Place': 'tournaments.thirdPlace',
    Final: 'tournaments.final',
    'Semi-finals': 'tournaments.semiFinals',
    'Quarter-finals': 'tournaments.quarterFinals',
    'Round of 16': 'tournaments.roundOf16',
    'Round of 32': 'tournaments.roundOf32',
  };
  return raw in map ? tLang(lang, map[raw]) : raw;
}

export function localizeClubJoinMode(mode: ClubJoinMode, lang: AppLanguage): string {
  return mode === 'public'
    ? tLang(lang, 'social.clubJoinModePublic')
    : tLang(lang, 'social.clubJoinModeApproval');
}

export function localizeServerError(
  codeOrMessage: { code?: string | null; message?: string | null } | string | null | undefined,
  lang: AppLanguage,
): string {
  if (!codeOrMessage) return '';
  const code = typeof codeOrMessage === 'string' ? undefined : codeOrMessage.code ?? undefined;
  const message = typeof codeOrMessage === 'string' ? codeOrMessage : codeOrMessage.message ?? '';

  if (code) {
    const codeKeyMap: Record<string, string> = {
      CONNECTION_FAILED: 'errors.connectionFailed',
      UNAUTHORIZED: 'errors.unauthorized',
      ROOM_EXPIRED: 'errors.roomExpired',
      INVALID_ROOM: 'errors.invalidRoom',
      ALREADY_IN_MATCH: 'errors.alreadyInMatch',
      MATCHMAKING_TIMEOUT: 'errors.matchmakingTimeout',
      RANKED_RESTRICTED: 'errors.rankedRestricted',
      SUSPENDED: 'errors.suspended',
      SPECTATE_UNAVAILABLE: 'errors.spectateUnavailable',
      INSUFFICIENT_COINS: 'errors.insufficientCoins',
      ALREADY_OWNED: 'errors.alreadyOwned',
      ALREADY_CLAIMED: 'errors.alreadyClaimed',
      INVALID_INPUT: 'errors.invalidInput',
      INVALID_CREDENTIALS: 'errors.invalidCredentials',
      USERNAME_TAKEN: 'errors.usernameTaken',
      ROOM_FULL: 'errors.roomFull',
      ROOM_NOT_FOUND: 'errors.roomNotFound',
      NOT_HOST: 'errors.notRoomHost',
      RATE_LIMITED: 'errors.rateLimited',
      BLOCKED: 'errors.blockedUser',
      CLUB_FULL: 'errors.clubFull',
      ALREADY_IN_CLUB: 'errors.alreadyInClub',
      FORBIDDEN: 'errors.permissionDenied',
    };
    if (code in codeKeyMap) {
      return tLang(lang, codeKeyMap[code]);
    }
  }

  if (lang === 'en') {
    return message || tLang(lang, 'errors.networkGeneric');
  }

  // Fallback message translation for common English server/client error strings
  const lower = message.toLowerCase();
  if (!lower) return tLang(lang, 'errors.networkGeneric');
  if (lower.includes('competitive player session is unavailable')) {
    return tLang(lang, 'errors.competitiveSessionUnavailable');
  }
  if (lower.includes('session not initialized') || lower.includes('player session')) {
    return tLang(lang, 'errors.sessionNotInitialized');
  }
  if (lower.includes('insufficient')) return tLang(lang, 'errors.insufficientCoins');
  if (lower.includes('already own')) return tLang(lang, 'errors.alreadyOwned');
  if (lower.includes('already claimed')) return tLang(lang, 'errors.alreadyClaimed');
  if (lower.includes('invalid username or password')) return tLang(lang, 'errors.invalidCredentials');
  if (lower.includes('username') && lower.includes('taken')) return tLang(lang, 'errors.usernameTaken');
  if (lower.includes('spectator')) return tLang(lang, 'errors.unableSpectateJoin');
  if (lower.includes('friend room')) return tLang(lang, 'errors.unableFriendRoom');
  if (lower.includes('tournament') && lower.includes('room')) return tLang(lang, 'errors.unableEnterMatchRoom');
  if (lower.includes('tournament')) return tLang(lang, 'errors.unableTournamentRoom');
  if (lower.includes('board')) return tLang(lang, 'errors.unableClubBoardRoom');
  if (lower.includes('webgl')) return tLang(lang, 'errors.webglInitFailed');
  if (lower.includes('room') && lower.includes('expired')) return tLang(lang, 'errors.roomExpired');
  if (lower.includes('room') && lower.includes('full')) return tLang(lang, 'errors.roomFull');
  if (lower.includes('room') && lower.includes('not found')) return tLang(lang, 'errors.roomNotFound');
  if (lower.includes('unable to create club')) return tLang(lang, 'errors.unableCreateClub');
  if (lower.includes('unable to create team')) return tLang(lang, 'errors.unableCreateTeam');
  if (lower.includes('unable to create league')) return tLang(lang, 'errors.unableCreateLeague');
  if (lower.includes('unable to create championship')) return tLang(lang, 'errors.unableCreateChampionship');
  if (lower.includes('unable to update club')) return tLang(lang, 'errors.unableUpdateClub');
  if (lower.includes('unable to leave club')) return tLang(lang, 'errors.unableLeaveClub');
  if (lower.includes('unable to invite')) return tLang(lang, 'errors.unableSendInvite');
  if (lower.includes('unable to respond')) return tLang(lang, 'errors.unableRespondInvite');
  if (lower.includes('unable to enter match room')) return tLang(lang, 'errors.unableEnterMatchRoom');
  if (lower.includes('unable to enter') || lower.includes('unable to join match room')) {
    return tLang(lang, 'errors.unableEnterRoom');
  }
  if (lower.includes('club') && lower.includes('full')) return tLang(lang, 'errors.clubFull');
  if (lower.includes('already') && lower.includes('club')) return tLang(lang, 'errors.alreadyInClub');
  if (lower.includes('permission') || lower.includes('forbidden') || lower.includes('not authorized')) {
    return tLang(lang, 'errors.permissionDenied');
  }
  if (lower.includes('rate limit') || lower.includes('too many')) return tLang(lang, 'errors.rateLimited');
  if (lower.includes('blocked')) return tLang(lang, 'errors.blockedUser');
  if (lower.includes('network error')) return tLang(lang, 'errors.networkGeneric');
  if (lower.includes('timed out') || lower.includes('timeout')) return tLang(lang, 'errors.matchmakingTimeout');
  if (lower.includes('restricted')) return tLang(lang, 'errors.rankedRestricted');
  if (lower.includes('suspended')) return tLang(lang, 'errors.suspended');
  if (lower === 'action failed.' || lower === 'action failed') return tLang(lang, 'errors.actionFailedGeneric');
  return message;
}

export function localizeReplayError(rawError: string | null | undefined, lang: AppLanguage): string {
  const msg = (rawError ?? '').trim();
  if (!msg) return tLang(lang, 'errors.replayImportFailed');
  if (lang === 'en') return msg;
  const lower = msg.toLowerCase();
  if (lower.includes('empty')) return tLang(lang, 'errors.replayEmpty');
  if (lower.includes('maximum permitted size')) return tLang(lang, 'errors.replayTooLarge');
  if (lower.includes('corrupted replay json')) return tLang(lang, 'errors.replayCorruptedJson');
  if (lower.includes('invalid replay structure')) return tLang(lang, 'errors.replayInvalidStructure');
  if (lower.includes('unrecognized replay file format')) return tLang(lang, 'errors.replayUnrecognizedHeader');
  if (lower.includes('unsupported replay format version')) return tLang(lang, 'errors.replayUnsupportedVersion');
  if (lower.includes('missing replay payload')) return tLang(lang, 'errors.replayMissingPayload');
  if (lower.includes('between 1 and 200')) return tLang(lang, 'errors.replayInvalidShotCount');
  if (lower.includes('invalid replay match type')) return tLang(lang, 'errors.replayInvalidMatchType');
  if (lower.includes('metadata is missing')) return tLang(lang, 'errors.replayMissingMetadata');
  if (lower.includes('corrupted shot entry')) return tLang(lang, 'errors.replayCorruptedShot');
  if (lower.includes('physics timing')) return tLang(lang, 'errors.replayInvalidShotPhysics');
  if (lower.includes('frame buffer size mismatch')) return tLang(lang, 'errors.replayFrameSizeMismatch');
  if (lower.includes('non-finite physics')) return tLang(lang, 'errors.replayNonFiniteCoords');
  return tLang(lang, 'errors.replayImportFailed');
}

export function localizeAvatarLabel(id: string, fallback: string, lang: AppLanguage): string {
  const avatars = TRANSLATIONS[lang].catalog.avatars as Record<string, string>;
  if (id in avatars) {
    return avatars[id];
  }
  return fallback;
}

export function localizeOnlineMatchType(matchType: string | null | undefined, lang: AppLanguage): string {
  switch (matchType) {
    case 'ranked':
      return tLang(lang, 'lobby.roomRanked');
    case 'private':
      return tLang(lang, 'progression.matchTypePrivate');
    case 'tournament':
      return tLang(lang, 'progression.matchTypeTournament');
    case 'quick':
    default:
      return tLang(lang, 'progression.matchTypeQuick');
  }
}

