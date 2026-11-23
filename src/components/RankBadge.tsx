import { Shield, TrendingUp } from 'lucide-react';
import {
  localizeRankTierName,
  localizeSeasonNameAndTheme,
  useTranslation,
} from '../i18n';
import {
  getRankById,
  getRankForElo,
  getRankProgress,
  type RankTierDefinition,
} from '../multiplayer/shared/ranked';

interface RankBadgeProps {
  elo?: number;
  tier?: RankTierDefinition | null;
  tierId?: string | null;
  size?: 'xs' | 'sm' | 'md';
  showElo?: boolean;
  className?: string;
}

export function RankBadge({
  elo,
  tier,
  tierId,
  size = 'sm',
  showElo = false,
  className = '',
}: RankBadgeProps) {
  const { t, lang, formatNumber } = useTranslation();
  const resolved =
    tier ?? (tierId ? getRankById(tierId) : getRankForElo(typeof elo === 'number' ? elo : 1200));
  const tierName = localizeRankTierName(resolved.id, lang, resolved.name);

  const sizeClasses =
    size === 'xs'
      ? 'px-1.5 py-0.5 text-[10px] gap-1'
      : size === 'md'
        ? 'px-2.5 py-1 text-xs gap-1.5'
        : 'px-2 py-0.5 text-[11px] gap-1.5';

  return (
    <span
      className={`inline-flex items-center rounded border font-bold tracking-tight whitespace-nowrap shrink-0 ${resolved.bgClass} ${resolved.borderClass} ${resolved.textClass} ${sizeClasses} ${className}`}
      title={t('progression.rankTierTooltip', {
        tier: tierName,
        minElo: formatNumber(resolved.minElo),
      })}
    >
      <span
        dir="ltr"
        className="inline-flex items-center justify-center rounded px-1 font-mono text-[0.85em] font-black"
        style={{ backgroundColor: `${resolved.accentHex}30`, color: resolved.color }}
      >
        {resolved.badgeGlyph}
      </span>
      <span>{tierName}</span>
      {showElo && typeof elo === 'number' && (
        <span dir="ltr" className="font-mono tabular-nums opacity-85">
          {formatNumber(elo)}
        </span>
      )}
    </span>
  );
}

interface RankProgressCardProps {
  elo: number;
  peakElo?: number;
  seasonName?: string | null;
  seasonElo?: number | null;
}

export function RankProgressCard({
  elo,
  peakElo,
  seasonName,
  seasonElo,
}: RankProgressCardProps) {
  const { t, lang, formatNumber } = useTranslation();
  const progress = getRankProgress(elo);
  const pct = Math.round(progress.progressRatio * 100);
  const currentName = localizeRankTierName(progress.current.id, lang, progress.current.name);
  const nextName = progress.next
    ? localizeRankTierName(progress.next.id, lang, progress.next.name)
    : null;
  const displaySeason = seasonName
    ? localizeSeasonNameAndTheme(1, seasonName, '', lang).name.split('—')[0].split(':')[0].trim()
    : null;

  return (
    <div className="rounded-xl border border-white/10 bg-[#0b1118] p-3.5 space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            dir="ltr"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border font-mono text-sm font-black"
            style={{
              backgroundColor: `${progress.current.accentHex}24`,
              borderColor: `${progress.current.accentHex}66`,
              color: progress.current.color,
            }}
          >
            {progress.current.badgeGlyph}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={`text-sm font-extrabold ${progress.current.textClass}`}>
                {t('progression.rankDivisionTitle', { tier: currentName })}
              </span>
              <span dir="ltr" className="font-mono text-xs font-bold tabular-nums text-white">
                {formatNumber(progress.elo)} {t('common.elo')}
              </span>
            </div>
            <div className="text-[11px] text-slate-400">
              {progress.next && nextName
                ? t('progression.rankEloNeeded', {
                    pts: formatNumber(progress.eloNeededForNext ?? 0),
                    tier: nextName,
                    minElo: formatNumber(progress.next.minElo),
                  })
                : t('progression.maxTierReached')}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 text-[11px] font-mono tabular-nums text-slate-300">
          {typeof peakElo === 'number' && (
            <span className="inline-flex items-center gap-1">
              <TrendingUp className="h-3.5 w-3.5 text-amber-400" />
              {t('progression.rankPeakLabel', { elo: formatNumber(peakElo) })}
            </span>
          )}
          {typeof seasonElo === 'number' && (
            <span className="inline-flex items-center gap-1 text-amber-300">
              <Shield className="h-3.5 w-3.5 text-amber-400" />
              {displaySeason ? `${displaySeason}: ` : `${t('progression.rankSeasonPrefix')}: `}
              {formatNumber(seasonElo)}
            </span>
          )}
        </div>
      </div>

      <div>
        <div className="h-2 w-full overflow-hidden rounded-md bg-white/10">
          <div
            className="h-full transition-all duration-300"
            style={{
              width: `${pct}%`,
              backgroundColor: progress.current.color,
            }}
          />
        </div>
        <div className="mt-1 flex items-center justify-between text-[10px] font-mono tabular-nums text-slate-400">
          <span>
            {currentName} ({formatNumber(progress.current.minElo)})
          </span>
          <span dir="ltr">{pct}%</span>
          <span>
            {progress.next && nextName
              ? `${nextName} (${formatNumber(progress.next.minElo)})`
              : t('progression.rankMaxLabel')}
          </span>
        </div>
      </div>
    </div>
  );
}
