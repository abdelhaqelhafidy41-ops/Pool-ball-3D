import { Check, Clock, Swords, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { soundEngine } from '../game/utils/SoundEngine';
import { multiplayerManager } from '../multiplayer/MultiplayerManager';
import { socialClient } from '../multiplayer/SocialClient';
import { ONLINE_AVATARS } from '../multiplayer/shared/protocol';
import { useGameStore } from '../store/useGameStore';

export function InviteNotificationBanner() {
  const incomingInvitations = useGameStore((s) => s.incomingInvitations);
  const screen = useGameStore((s) => s.screen);
  const setOnlineError = useGameStore((s) => s.setOnlineError);
  const openSocialModal = useGameStore((s) => s.openSocialModal);
  const setSocialNotice = useGameStore((s) => s.setSocialNotice);

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [busyInviteId, setBusyInviteId] = useState<string | null>(null);

  const activeInvites = incomingInvitations.filter(
    (inv) => inv.status === 'pending' && inv.expiresAtMs > nowMs,
  );

  useEffect(() => {
    if (activeInvites.length === 0) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [activeInvites.length]);

  if (activeInvites.length === 0) return null;

  const topInvite = activeInvites[0];
  const remainingSec = Math.max(0, Math.ceil((topInvite.expiresAtMs - nowMs) / 1000));
  const av =
    ONLINE_AVATARS.find((a) => a.id === topInvite.senderAvatar) ?? ONLINE_AVATARS[0];

  const handleRespond = async (action: 'accept' | 'reject') => {
    soundEngine.unlock();
    soundEngine.playUiClick();
    setBusyInviteId(topInvite.inviteId);
    if (action === 'accept') {
      multiplayerManager.ensureConnected();
    }
    const res = await socialClient.respondInvite(topInvite.inviteId, action);
    setBusyInviteId(null);

    if (!res.ok) {
      const msg = res.error ?? 'Invitation unavailable.';
      setOnlineError({ code: res.code ?? 'INVITE_EXPIRED', message: msg });
      setSocialNotice({ type: 'err', text: msg });
      openSocialModal('friends');
      return;
    }

    if (action === 'accept' && res.data?.room) {
      useGameStore.getState().setOnlineRoom(res.data.room);
      useGameStore.getState().openOnlineLobby('friend');
    }
  };

  return (
    <div
      data-testid="invite-notification-banner"
      className={`pointer-events-auto fixed z-40 w-[min(92vw,340px)] rounded-xl border border-amber-400/50 bg-[#0d141d]/95 p-3 text-slate-100 shadow-2xl ${
        screen === 'playing' ? 'top-14 left-1/2 -translate-x-1/2' : 'top-3.5 right-3.5'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <span
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/15 text-xs font-bold"
            style={{ backgroundColor: `${av.accent}22`, color: av.accent }}
          >
            {av.glyph}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-amber-300">
              <Swords className="h-3 w-3" />
              Match Invitation
            </div>
            <div className="truncate text-xs font-extrabold text-white">
              {topInvite.senderName}{' '}
              <span className="font-mono text-[10px] text-slate-400">
                ({topInvite.senderElo} ELO)
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-[10px] text-slate-300">
              <span>{topInvite.ruleProfileId === 'wpa' ? 'Strict WPA' : 'Standard Casual'}</span>
              <span>·</span>
              <span className="inline-flex items-center gap-0.5 font-mono tabular-nums text-amber-300">
                <Clock className="h-2.5 w-2.5" />
                {remainingSec}s
              </span>
            </div>
          </div>
        </div>

        <button
          type="button"
          disabled={busyInviteId === topInvite.inviteId}
          onClick={() => handleRespond('reject')}
          aria-label="Decline match invitation"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/5 text-slate-400 hover:text-white cursor-pointer"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mt-2.5 grid grid-cols-2 gap-1.5">
        <button
          type="button"
          disabled={busyInviteId === topInvite.inviteId}
          onClick={() => handleRespond('accept')}
          className="inline-flex items-center justify-center gap-1 rounded-lg bg-amber-500 px-3 py-1.5 text-[11px] font-extrabold text-slate-950 hover:bg-amber-400 disabled:opacity-50 cursor-pointer"
        >
          <Check className="h-3.5 w-3.5" />
          {busyInviteId === topInvite.inviteId ? 'Joining...' : 'Accept 1v1'}
        </button>
        <button
          type="button"
          disabled={busyInviteId === topInvite.inviteId}
          onClick={() => handleRespond('reject')}
          className="inline-flex items-center justify-center rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-[11px] font-bold text-slate-200 hover:bg-white/10 disabled:opacity-50 cursor-pointer"
        >
          Decline
        </button>
      </div>
    </div>
  );
}
