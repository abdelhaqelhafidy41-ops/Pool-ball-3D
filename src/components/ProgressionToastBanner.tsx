import { CheckCircle2, Crown, Flame, Sparkles, Target, X } from 'lucide-react';
import { useEffect } from 'react';
import { soundEngine } from '../game/utils/SoundEngine';
import {
  useGameStore,
  type BattlePassTab,
  type ProgressionNotificationKind,
} from '../store/useGameStore';

function iconForKind(kind: ProgressionNotificationKind) {
  switch (kind) {
    case 'mission_completed':
      return Target;
    case 'weekly_completed':
      return Flame;
    case 'tier_unlocked':
    case 'season_started':
    case 'season_ending_soon':
      return Crown;
    case 'reward_claimed':
      return CheckCircle2;
  }
}

function targetTabForKind(kind: ProgressionNotificationKind): BattlePassTab {
  switch (kind) {
    case 'mission_completed':
      return 'daily';
    case 'weekly_completed':
      return 'weekly';
    default:
      return 'pass';
  }
}

export function ProgressionToastBanner() {
  const notifications = useGameStore((s) => s.progressionNotifications);
  const dismiss = useGameStore((s) => s.dismissProgressionNotification);
  const openBattlePassModal = useGameStore((s) => s.openBattlePassModal);
  const battlePassModalOpen = useGameStore((s) => s.battlePassModalOpen);
  const screen = useGameStore((s) => s.screen);
  const isDraggingCue = useGameStore((s) => s.isDraggingCue);

  useEffect(() => {
    if (notifications.length === 0) return;
    const latest = notifications[notifications.length - 1];
    const timer = window.setTimeout(() => {
      dismiss(latest.id);
    }, 6500);
    return () => window.clearTimeout(timer);
  }, [notifications, dismiss]);

  if (notifications.length === 0 || battlePassModalOpen || isDraggingCue) return null;

  const visible = notifications.slice(-2);

  return (
    <div
      data-testid="progression-toast-stack"
      className={`pointer-events-none fixed z-30 flex flex-col gap-2 w-[min(92vw,340px)] ${
        screen === 'playing' ? 'top-14 right-3.5' : 'bottom-16 right-4'
      }`}
    >
      {visible.map((item) => {
        const Icon = iconForKind(item.kind);
        return (
          <div
            key={item.id}
            role="status"
            className="pointer-events-auto rounded-xl border border-amber-400/45 bg-[#0d141d]/95 p-3 text-slate-100 shadow-2xl transition-opacity duration-200"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-start gap-2.5 min-w-0">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-amber-400/35 bg-amber-500/15">
                  <Icon className="h-4 w-4 text-amber-400" />
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-extrabold text-white leading-snug">
                    {item.title}
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-300 leading-snug">
                    {item.detail}
                  </div>
                </div>
              </div>

              <button
                type="button"
                aria-label="Dismiss progression notification"
                onClick={() => dismiss(item.id)}
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/5 text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            {item.kind !== 'reward_claimed' && (
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  onClick={() => {
                    soundEngine.unlock();
                    soundEngine.playUiClick();
                    dismiss(item.id);
                    openBattlePassModal(targetTabForKind(item.kind));
                  }}
                  className="inline-flex items-center gap-1 rounded-md bg-amber-500 px-2.5 py-1 text-[11px] font-extrabold text-slate-950 hover:bg-amber-400 transition-colors cursor-pointer whitespace-nowrap"
                >
                  <Sparkles className="h-3 w-3" />
                  Open Battle Pass
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
