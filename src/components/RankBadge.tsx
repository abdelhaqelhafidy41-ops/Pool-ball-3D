import { Shield, TrendingUp } from 'lucide-react';
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
  const resolved =
    tier ?? (tierId ? getRankById(tierId) : getRankForElo(typeof elo === 'number' ? elo : 1200));

  const sizeClasses =
    size === 'xs'
      ? 'px-1.5 py-0.5 text-[10px] gap-1'
      : size === 'md'
        ? 'px-2.5 py-1 text-xs gap-1.5'
        : 'px-2 py-0.5 text-[11px] gap-1.5';

  return (
    <span
      className={`inline-flex items-center rounded border font-bold tracking-tight whitespace-nowrap shrink-0 ${resolved.bgClass} ${resolved.borderClass} ${resolved.textClass} ${sizeClasses} ${className}`}
      title={`${resolved.name} Tier (${resolved.minElo}+ ELO)`}
    >
      <span
        className="inline-flex items-center justify-center rounded px-1 font-mono text-[0.85em] font-black"
        style={{ backgroundColor: `${resolved.accentHex}30`, color: resolved.color }}
      >
        {resolved.badgeGlyph}
      </span>
      <span>{resolved.name}</span>
      {showElo && typeof elo === 'number' && (
        <span className="font-mono tabular-nums opacity-85">{elo}</span>
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
  const progress = getRankProgress(elo);
  const pct = Math.round(progress.progressRatio * 100);

  return (
    <div className="rounded-xl border border-white/10 bg-[#0b1118] p-3.5 space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div
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
                {progress.current.name} Division
              </span>
              <span className="font-mono text-xs font-bold tabular-nums text-white">
                {progress.elo} ELO
              </span>
            </div>
            <div className="text-[11px] text-slate-400">
              {progress.next
                ? `${progress.eloNeededForNext} ELO to ${progress.next.name} (${progress.next.minElo})`
                : 'Highest competitive division reached'}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 text-[11px] font-mono tabular-nums text-slate-300">
          {typeof peakElo === 'number' && (
            <span className="inline-flex items-center gap-1">
              <TrendingUp className="h-3.5 w-3.5 text-amber-400" />
              Peak {peakElo}
            </span>
          )}
          {typeof seasonElo === 'number' && (
            <span className="inline-flex items-center gap-1 text-amber-300">
              <Shield className="h-3.5 w-3.5 text-amber-400" />
              {seasonName ? `${seasonName.split('—')[0].trim()}: ` : 'Season: '}
              {seasonElo}
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
            {progress.current.name} ({progress.current.minElo})
          </span>
          <span>{pct}%</span>
          <span>
            {progress.next ? `${progress.next.name} (${progress.next.minElo})` : 'MAX'}
          </span>
        </div>
      </div>
    </div>
  );
}
