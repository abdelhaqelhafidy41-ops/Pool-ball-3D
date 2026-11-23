import { Cpu, User } from 'lucide-react';
import {
  canTargetEightBall,
  getRemainingBallsForGroup,
  SOLIDS_NUMBERS,
  STRIPES_NUMBERS,
} from '../game/rules/BallGroupManager';
import type { BallGroup, PlayerId } from '../game/rules/types';
import { BALL_DEFINITIONS } from '../game/utils/constants';
import {
  localizeBallName,
  localizeMatchHeadline,
  localizePlayerName,
  useTranslation,
} from '../i18n';
import {
  getAvatarVisualMeta,
  getBadgeVisualMeta,
  getNameplateVisualClass,
} from '../multiplayer/shared/economy';
import { useGameStore } from '../store/useGameStore';

function MiniBallBadge({
  num,
  pocketed,
  dimmed,
}: {
  num: number;
  pocketed?: boolean;
  dimmed?: boolean;
}) {
  const { lang } = useTranslation();
  const def = BALL_DEFINITIONS[num];
  if (!def) return null;
  const isCue = num === 0;
  const isEight = num === 8;

  return (
    <span
      title={localizeBallName(num, lang)}
      className={`inline-flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-extrabold transition-opacity ${
        pocketed ? 'opacity-20' : dimmed ? 'opacity-45' : 'opacity-100'
      }`}
      style={{
        backgroundColor: isCue
          ? '#f5f2e8'
          : isEight
            ? '#14151a'
            : def.isStripe
              ? '#f5f1e3'
              : def.color,
        color: isEight ? '#ffffff' : '#111318',
        border: isEight
          ? '1px solid #f59e0b'
          : isCue
            ? '1px solid #cbd5e1'
            : '1px solid rgba(255,255,255,0.28)',
        boxShadow: def.isStripe ? `inset 0 0 0 2.5px ${def.color}` : undefined,
      }}
    >
      {isCue ? '' : num}
    </span>
  );
}

function PlayerScoreCard({
  playerId,
  name,
  isAi,
  isActive,
  group,
  tableOpen,
  pocketedSet,
  align,
  avatarId,
  nameplateId,
  badgeId,
}: {
  playerId: PlayerId;
  name: string;
  isAi: boolean;
  isActive: boolean;
  group: BallGroup;
  tableOpen: boolean;
  pocketedSet: Set<number>;
  align: 'left' | 'right';
  avatarId?: string | null;
  nameplateId?: string | null;
  badgeId?: string | null;
}) {
  const { t, formatNumber } = useTranslation();
  const remaining = group ? getRemainingBallsForGroup(pocketedSet, group) : [];
  const onEight = group ? canTargetEightBall(pocketedSet, group) : false;
  const groupNumbers =
    group === 'solids'
      ? SOLIDS_NUMBERS
      : group === 'stripes'
        ? STRIPES_NUMBERS
        : null;

  const groupTag = tableOpen
    ? t('hud.openTag')
    : group === 'solids'
      ? t('hud.solidsTag')
      : group === 'stripes'
        ? t('hud.stripesTag')
        : t('hud.openTag');

  const nameplate = getNameplateVisualClass(nameplateId);
  const badgeMeta = getBadgeVisualMeta(badgeId);
  const avatarMeta = avatarId ? getAvatarVisualMeta(avatarId) : null;

  return (
    <div
      data-testid={`player-card-${playerId}`}
      className={`flex flex-col gap-1 rounded-xl border px-2.5 py-1.5 min-w-[140px] sm:min-w-[196px] transition-all duration-300 ${
        isActive
          ? 'border-amber-400/85 bg-[#131d29]/95 shadow-[0_0_16px_rgba(245,158,11,0.18)]'
          : nameplateId && nameplateId !== 'nameplate_standard'
            ? `${nameplate.borderClass} ${nameplate.bgClass}`
            : 'border-white/10 bg-[#0c1219]/92 opacity-85'
      } ${align === 'right' ? 'items-end text-right' : 'items-start text-left'}`}
    >
      <div
        className={`flex w-full items-center justify-between gap-2 ${
          align === 'right' ? 'flex-row-reverse' : ''
        }`}
      >
        <div
          className={`flex items-center gap-1.5 min-w-0 ${
            align === 'right' ? 'flex-row-reverse' : ''
          }`}
        >
          {isAi ? (
            <Cpu className={`h-3.5 w-3.5 shrink-0 ${isActive ? 'text-amber-400' : 'text-slate-400'}`} />
          ) : avatarMeta ? (
            <span
              className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border border-white/15 text-[10px] font-bold"
              style={{ backgroundColor: `${avatarMeta.accent}22`, color: avatarMeta.accent }}
            >
              {avatarMeta.glyph}
            </span>
          ) : (
            <User className={`h-3.5 w-3.5 shrink-0 ${isActive ? 'text-amber-400' : 'text-slate-400'}`} />
          )}
          <span className="truncate text-xs font-bold text-white max-w-[88px] sm:max-w-[110px]">
            {name}
          </span>
          {badgeMeta && (
            <span
              className={`hidden sm:inline-flex items-center rounded border px-1 py-0.2 text-[8px] font-extrabold shrink-0 ${badgeMeta.className}`}
              title={badgeMeta.shortLabel}
            >
              {badgeMeta.glyph}
            </span>
          )}
        </div>

        <span
          className={`text-[10px] font-mono font-bold tracking-wider uppercase whitespace-nowrap ${
            group === 'solids'
              ? 'text-amber-300'
              : group === 'stripes'
                ? 'text-sky-300'
                : 'text-slate-400'
          }`}
        >
          {groupTag}
        </span>
      </div>

      {/* Ball group progress row */}
      <div
        className={`flex items-center gap-1 ${
          align === 'right' ? 'flex-row-reverse' : ''
        }`}
      >
        {groupNumbers ? (
          <>
            {groupNumbers.map((num) => (
              <MiniBallBadge
                key={num}
                num={num}
                pocketed={pocketedSet.has(num)}
              />
            ))}
            {onEight && !pocketedSet.has(8) && (
              <span className="ml-0.5 flex items-center gap-0.5 border-l border-white/15 pl-1">
                <MiniBallBadge num={8} />
              </span>
            )}
          </>
        ) : (
          <div className="flex items-center gap-1 text-[10px] font-mono tabular-nums text-slate-400">
            <MiniBallBadge num={1} dimmed />
            <MiniBallBadge num={9} dimmed />
            <MiniBallBadge num={8} dimmed />
            <span className="ml-0.5">{t('hud.awaitingGroup')}</span>
          </div>
        )}
      </div>

      <div
        className={`flex w-full items-center justify-between gap-2 text-[10px] font-mono tabular-nums ${
          align === 'right' ? 'flex-row-reverse' : ''
        }`}
      >
        <span className={isActive ? 'text-slate-200 font-semibold' : 'text-slate-400'}>
          {group
            ? onEight
              ? t('hud.targetEightTag')
              : t('hud.remainingRatio', { count: formatNumber(remaining.length) })
            : isActive
              ? t('hud.openTableBadge')
              : t('hud.waitingTag')}
        </span>
        {isActive && (
          <span
            data-testid={`turn-badge-${playerId}`}
            className="rounded bg-amber-400/18 px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-wider text-amber-300 border border-amber-400/35"
          >
            {t('hud.activeTurnBadge')}
          </span>
        )}
      </div>
    </div>
  );
}

export function MatchScoreboard() {
  const { t, lang, formatNumber } = useTranslation();
  const screen = useGameStore((s) => s.screen);
  const matchConfig = useGameStore((s) => s.matchConfig);
  const matchPhase = useGameStore((s) => s.matchPhase);
  const activePlayer = useGameStore((s) => s.activePlayer);
  const tableOpen = useGameStore((s) => s.tableOpen);
  const playerGroups = useGameStore((s) => s.playerGroups);
  const pocketedNumbers = useGameStore((s) => s.pocketedNumbers);
  const statusHeadline = useGameStore((s) => s.statusHeadline);
  const shotCount = useGameStore((s) => s.shotCount);
  const isAiThinking = useGameStore((s) => s.isAiThinking);
  const cueBallPocketed = useGameStore((s) => s.cueBallPocketed);
  const equippedCosmetics = useGameStore((s) => s.equippedCosmetics);
  const onlineRoom = useGameStore((s) => s.onlineRoom);
  void isAiThinking;

  if (screen !== 'playing') return null;

  if (matchConfig.gameMode === 'freePlay') {
    return (
      <div className="pointer-events-auto flex items-center gap-3 rounded-xl border border-white/10 bg-[#0c1219]/92 px-3 py-1.5 shadow-lg">
        <div className="text-[11px] font-bold uppercase tracking-wider text-amber-400">
          {t('hud.freePlayLabel')}
        </div>
        <div className="h-3.5 w-px bg-white/15" />
        <div className="text-[11px] font-mono tabular-nums text-slate-300">
          {t('hud.freePlayStats', {
            shots: formatNumber(shotCount),
            pocketed: formatNumber(pocketedNumbers.length),
          })}
        </div>
      </div>
    );
  }

  const pocketedSet = new Set(pocketedNumbers);
  const p1Name = localizePlayerName(matchConfig.player1Name, 'player1', lang);
  const p2Name =
    matchConfig.opponentType === 'ai'
      ? localizePlayerName(matchConfig.player2Name || 'CPU Pro', 'player2', lang)
      : localizePlayerName(matchConfig.player2Name, 'player2', lang);

  const isOnline = matchConfig.opponentType === 'online';
  const onlineP1 = isOnline
    ? onlineRoom?.players.find((p) => p.role === 'player1') ?? null
    : null;
  const onlineP2 = isOnline
    ? onlineRoom?.players.find((p) => p.role === 'player2') ?? null
    : null;

  const statusText = localizeMatchHeadline(statusHeadline, lang);

  return (
    <div dir="ltr" className="pointer-events-auto flex flex-wrap items-center justify-center gap-2">
      <PlayerScoreCard
        playerId="player1"
        name={p1Name}
        isAi={false}
        isActive={activePlayer === 'player1' && matchPhase !== 'GAME_OVER'}
        group={playerGroups.player1}
        tableOpen={tableOpen}
        pocketedSet={pocketedSet}
        align="left"
        avatarId={isOnline ? onlineP1?.avatarId : equippedCosmetics.avatarId}
        nameplateId={isOnline ? onlineP1?.equippedCosmetics?.nameplateId : equippedCosmetics.nameplateId}
        badgeId={isOnline ? onlineP1?.equippedCosmetics?.badgeId : equippedCosmetics.badgeId}
      />

      {/* Center Match Status Box */}
      <div
        dir={lang === 'ar' ? 'rtl' : 'ltr'}
        className="hidden md:flex flex-col items-center justify-center rounded-xl border border-white/10 bg-[#0c1219]/92 px-3 py-1.5 text-center min-w-[164px]"
      >
        <div className="flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-[0.16em] text-amber-400">
          <MiniBallBadge num={0} pocketed={cueBallPocketed} />
          <span>{t('hud.eightBallMatchLabel')}</span>
          <MiniBallBadge num={8} pocketed={pocketedSet.has(8)} />
        </div>
        <div className="mt-0.5 text-[11px] font-semibold text-white max-w-[190px] truncate">
          {statusText}
        </div>
        <div className="text-[10px] font-mono tabular-nums text-slate-400">
          {matchConfig.calledShotsEnabled
            ? t('hud.calledPocketShot', { shot: formatNumber(shotCount) })
            : t('hud.shotPrefix', { shot: formatNumber(shotCount) })}
        </div>
      </div>

      <PlayerScoreCard
        playerId="player2"
        name={p2Name}
        isAi={matchConfig.opponentType === 'ai'}
        isActive={activePlayer === 'player2' && matchPhase !== 'GAME_OVER'}
        group={playerGroups.player2}
        tableOpen={tableOpen}
        pocketedSet={pocketedSet}
        align="right"
        avatarId={isOnline ? onlineP2?.avatarId : null}
        nameplateId={isOnline ? onlineP2?.equippedCosmetics?.nameplateId : null}
        badgeId={isOnline ? onlineP2?.equippedCosmetics?.badgeId : null}
      />
    </div>
  );
}

