import { Check, Clock, Crown, Eye, Swords, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { soundEngine } from '../game/utils/SoundEngine';
import {
  localizeRuleProfile,
  localizeServerError,
  localizeTournamentRoundLabel,
  useTranslation,
} from '../i18n';
import { multiplayerManager } from '../multiplayer/MultiplayerManager';
import { socialClient } from '../multiplayer/SocialClient';
import { getAvatarVisualMeta } from '../multiplayer/shared/economy';
import { useGameStore } from '../store/useGameStore';

export function InviteNotificationBanner() {
  const { t, lang } = useTranslation();
  const incomingInvitations = useGameStore((s) => s.incomingInvitations);
  const tournamentMatchAlert = useGameStore((s) => s.tournamentMatchAlert);
  const setTournamentMatchAlert = useGameStore((s) => s.setTournamentMatchAlert);
  const openTournamentModal = useGameStore((s) => s.openTournamentModal);
  const onlineRoom = useGameStore((s) => s.onlineRoom);
  const screen = useGameStore((s) => s.screen);
  const setOnlineError = useGameStore((s) => s.setOnlineError);
  const openSocialModal = useGameStore((s) => s.openSocialModal);
  const setSocialNotice = useGameStore((s) => s.setSocialNotice);

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [busyInviteId, setBusyInviteId] = useState<string | null>(null);
  const [joiningTournament, setJoiningTournament] = useState(false);

  const activeInvites = incomingInvitations.filter(
    (inv) => inv.status === 'pending' && inv.expiresAtMs > nowMs,
  );

  const showTournamentAlert = Boolean(
    tournamentMatchAlert &&
      onlineRoom?.tournament?.bracketMatchId !== tournamentMatchAlert.match.bracketMatchId,
  );

  useEffect(() => {
    if (activeInvites.length === 0 && !showTournamentAlert) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [activeInvites.length, showTournamentAlert]);

  if (activeInvites.length === 0 && !showTournamentAlert) return null;

  if (showTournamentAlert && tournamentMatchAlert) {
    const { tournamentId, tournamentTitle, match } = tournamentMatchAlert;
    const deadlineSec = match.readyDeadlineMs
      ? Math.max(0, Math.ceil((match.readyDeadlineMs - nowMs) / 1000))
      : null;

    return (
      <div
        data-testid="tournament-match-ready-banner"
        className={`pointer-events-auto fixed z-40 w-[min(92vw,350px)] rounded-xl border border-amber-400/60 bg-[#0d141d]/95 p-3 text-slate-100 shadow-2xl ${
          screen === 'playing' ? 'top-14 left-1/2 -translate-x-1/2' : 'top-3.5 right-3.5'
        }`}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-amber-400/40 bg-amber-500/15">
              <Crown className="h-4 w-4 text-amber-400" />
            </div>
            <div className="min-w-0">
              <div className="text-[10px] font-bold uppercase tracking-wider text-amber-300">
                {t('social.inviteTournamentReadyLabel', {
                  round: localizeTournamentRoundLabel(match.roundLabel, lang),
                })}
              </div>
              <div className="truncate text-xs font-extrabold text-white">{tournamentTitle}</div>
              <div className="flex items-center gap-1.5 text-[10px] text-slate-300 truncate">
                <span>
                  {t('social.inviteMatchupVs', {
                    p1: match.player1Name ?? t('tournaments.tbdSlot'),
                    p2: match.player2Name ?? t('tournaments.tbdSlot'),
                  })}
                </span>
                {deadlineSec !== null && (
                  <>
                    <span>·</span>
                    <span className="inline-flex items-center gap-0.5 font-mono tabular-nums text-amber-300 shrink-0" dir="ltr">
                      <Clock className="h-2.5 w-2.5" />
                      {deadlineSec}s
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setTournamentMatchAlert(null)}
            aria-label={t('social.inviteDismissTournamentAria')}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/5 text-slate-400 hover:text-white cursor-pointer"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="mt-2.5 grid grid-cols-2 gap-1.5">
          <button
            type="button"
            disabled={joiningTournament}
            onClick={async () => {
              soundEngine.unlock();
              soundEngine.playUiClick();
              setJoiningTournament(true);
              await multiplayerManager.joinTournamentMatch(tournamentId, match.bracketMatchId);
              setJoiningTournament(false);
            }}
            className="inline-flex items-center justify-center gap-1 rounded-lg bg-amber-500 px-3 py-1.5 text-[11px] font-extrabold text-slate-950 hover:bg-amber-400 disabled:opacity-50 cursor-pointer whitespace-nowrap"
          >
            <Swords className="h-3.5 w-3.5" />
            {joiningTournament ? t('social.inviteEnteringBtn') : t('social.inviteEnterMatchBtn')}
          </button>
          <button
            type="button"
            onClick={() => {
              soundEngine.unlock();
              soundEngine.playUiClick();
              openTournamentModal('bracket', tournamentId);
            }}
            className="inline-flex items-center justify-center rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-[11px] font-bold text-slate-200 hover:bg-white/10 cursor-pointer whitespace-nowrap"
          >
            {t('social.inviteViewBracketBtn')}
          </button>
        </div>
      </div>
    );
  }

  const topInvite = activeInvites[0];
  const remainingSec = Math.max(0, Math.ceil((topInvite.expiresAtMs - nowMs) / 1000));
  const av = getAvatarVisualMeta(topInvite.senderAvatar);
  const isSpectateInvite = topInvite.inviteKind === 'spectate';

  const handleRespond = async (action: 'accept' | 'reject') => {
    soundEngine.unlock();
    soundEngine.playUiClick();
    setBusyInviteId(topInvite.inviteId);
    if (action === 'accept') {
      multiplayerManager.ensureConnected();
    }
    const res = await socialClient.respondInvite(topInvite.inviteId, action);
    if (!res.ok) {
      setBusyInviteId(null);
      const msg = res.error ? localizeServerError(res.error, lang) : t('social.inviteUnavailableErr');
      setOnlineError({ code: res.code ?? 'INVITE_EXPIRED', message: msg });
      setSocialNotice({ type: 'err', text: msg });
      openSocialModal('friends');
      return;
    }

    if (action === 'accept') {
      if (isSpectateInvite || res.data?.spectateTarget) {
        const targetRoomId = res.data?.spectateTarget?.roomId ?? topInvite.roomId ?? undefined;
        const targetRoomCode = res.data?.spectateTarget?.roomCode ?? topInvite.roomCode ?? undefined;
        const specRes = await multiplayerManager.joinSpectate({
          roomId: targetRoomId,
          roomCode: targetRoomCode,
          returnTarget: 'menu',
        });
        setBusyInviteId(null);
        if (!specRes.ok) {
          setSocialNotice({
            type: 'err',
            text: specRes.error ? localizeServerError(specRes.error, lang) : t('social.inviteSpectateFailedErr'),
          });
        }
        return;
      }

      if (res.data?.room) {
        useGameStore.getState().setOnlineRoom(res.data.room);
        useGameStore.getState().openOnlineLobby('friend');
      }
    }
    setBusyInviteId(null);
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
              {isSpectateInvite ? <Eye className="h-3 w-3" /> : <Swords className="h-3 w-3" />}
              {isSpectateInvite ? t('social.inviteBannerSpectateTitle') : t('social.inviteBannerMatchTitle')}
            </div>
            <div className="truncate text-xs font-extrabold text-white">
              {topInvite.senderName}{' '}
              <span className="font-mono text-[10px] text-slate-400">
                ({t('spectator.eloBadge', { elo: topInvite.senderElo })})
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-[10px] text-slate-300">
              <span>{localizeRuleProfile(topInvite.ruleProfileId, lang, false)}</span>
              <span>·</span>
              <span className="inline-flex items-center gap-0.5 font-mono tabular-nums text-amber-300" dir="ltr">
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
          aria-label={t('social.inviteDismissAria')}
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
          className="inline-flex items-center justify-center gap-1 rounded-lg bg-amber-500 px-3 py-1.5 text-[11px] font-extrabold text-slate-950 hover:bg-amber-400 disabled:opacity-50 cursor-pointer whitespace-nowrap"
        >
          {isSpectateInvite ? <Eye className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
          {busyInviteId === topInvite.inviteId
            ? isSpectateInvite
              ? t('social.inviteOpeningBtn')
              : t('social.inviteJoiningBtn')
            : isSpectateInvite
              ? t('social.inviteWatchMatchBtn')
              : t('social.inviteAccept1v1Btn')}
        </button>
        <button
          type="button"
          disabled={busyInviteId === topInvite.inviteId}
          onClick={() => handleRespond('reject')}
          className="inline-flex items-center justify-center rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-[11px] font-bold text-slate-200 hover:bg-white/10 disabled:opacity-50 cursor-pointer whitespace-nowrap"
        >
          {t('social.inviteDeclineBtn')}
        </button>
      </div>
    </div>
  );
}
