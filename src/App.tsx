import { useCallback, useEffect, useRef } from 'react';
import { ErrorBoundary } from './components/ErrorBoundary';
import { GameCanvas, type PoolSceneActions } from './components/GameCanvas';
import { GameHUD } from './components/GameHUD';
import { InviteNotificationBanner } from './components/InviteNotificationBanner';
import { MainMenu } from './components/MainMenu';
import { MatchEndModal } from './components/MatchEndModal';
import { OnlineLobbyUI } from './components/OnlineLobbyUI';
import { ProgressionModal } from './components/ProgressionModal';
import { ReplayOverlay } from './components/ReplayOverlay';
import { SettingsModal } from './components/SettingsModal';
import { SocialModal } from './components/SocialModal';
import { StoreModal } from './components/StoreModal';
import { TournamentModal } from './components/TournamentModal';
import { BattlePassModal } from './components/BattlePassModal';
import { ClubLeagueModal } from './components/ClubLeagueModal';
import { ProgressionToastBanner } from './components/ProgressionToastBanner';
import type { ReplayCameraMode, ReplaySpeed } from './game/replay/types';
import type { PocketId } from './game/rules/types';
import { soundEngine } from './game/utils/SoundEngine';
import { battlePassClient } from './multiplayer/BattlePassClient';
import { economyClient } from './multiplayer/EconomyClient';
import { multiplayerManager } from './multiplayer/MultiplayerManager';
import { progressionClient } from './multiplayer/ProgressionClient';
import { socialClient } from './multiplayer/SocialClient';
import { useGameStore } from './store/useGameStore';
import { useTranslation } from './i18n';

export default function App() {
  const { t } = useTranslation();
  const actionsRef = useRef<PoolSceneActions | null>(null);
  const spectateLinkHandledRef = useRef(false);
  const setIsFullscreen = useGameStore((s) => s.setIsFullscreen);
  const setScreen = useGameStore((s) => s.setScreen);
  const ownPlayerId = useGameStore((s) => s.ownProfile?.playerId ?? null);

  const handleToggleFullscreen = useCallback(() => {
    soundEngine.playUiClick();
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }, []);

  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      soundEngine.dispose();
    };
  }, [setIsFullscreen]);

  useEffect(() => {
    if (!ownPlayerId) {
      void progressionClient.ensurePlayerSession();
      return;
    }
    multiplayerManager.ensureConnected();
    void socialClient.fetchOverview();
    void economyClient.refreshWallet();
    void battlePassClient.refreshOverview({ skipTransitionToasts: true });

    if (!spectateLinkHandledRef.current && typeof window !== 'undefined') {
      spectateLinkHandledRef.current = true;
      const url = new URL(window.location.href);
      const spectateCode = url.searchParams.get('spectate')?.trim().toUpperCase();
      const shareToken = url.searchParams.get('token')?.trim();
      if (spectateCode) {
        url.searchParams.delete('spectate');
        url.searchParams.delete('token');
        window.history.replaceState({}, '', url.pathname + url.search + url.hash);
        void multiplayerManager.joinSpectate({
          roomCode: spectateCode,
          shareToken: shareToken || undefined,
          returnTarget: 'lobby',
        });
      }
    }
  }, [ownPlayerId]);

  const handleStartMatch = useCallback(() => {
    actionsRef.current?.startMatch();
  }, []);

  const handleShoot = useCallback((power: number) => {
    actionsRef.current?.shoot(power);
  }, []);

  const handleResetRack = useCallback(() => {
    actionsRef.current?.resetRack();
  }, []);

  const handleConfirmPlacement = useCallback(() => {
    actionsRef.current?.confirmCuePlacement();
  }, []);

  const handlePlaceAtHeadSpot = useCallback(() => {
    actionsRef.current?.placeCueAtHeadSpot();
  }, []);

  const handleSelectCalledShot = useCallback(
    (targetBall: number | null, targetPocket: PocketId | null) => {
      actionsRef.current?.setCalledShot(targetBall, targetPocket);
    },
    [],
  );

  const handleResetAllStats = useCallback(() => {
    actionsRef.current?.resetAllStats();
  }, []);

  const handleEnterReplay = useCallback((shotId?: string) => {
    actionsRef.current?.enterReplay(shotId);
  }, []);

  const handleExitReplay = useCallback(() => {
    actionsRef.current?.exitReplay();
  }, []);

  const handleSelectReplayShot = useCallback((shotId: string) => {
    actionsRef.current?.selectReplayShot(shotId);
  }, []);

  const handleToggleReplayPlay = useCallback(() => {
    actionsRef.current?.toggleReplayPlay();
  }, []);

  const handleRestartReplay = useCallback(() => {
    actionsRef.current?.restartReplay();
  }, []);

  const handleSeekReplay = useCallback((timeSec: number) => {
    actionsRef.current?.seekReplay(timeSec);
  }, []);

  const handleSetReplaySpeed = useCallback((speed: ReplaySpeed) => {
    actionsRef.current?.setReplaySpeed(speed);
  }, []);

  const handleToggleReplayAutoSlowMo = useCallback(() => {
    actionsRef.current?.toggleReplayAutoSlowMo();
  }, []);

  const handleToggleReplayAnalysis = useCallback(() => {
    actionsRef.current?.toggleReplayAnalysis();
  }, []);

  const handleJumpToReplayImpact = useCallback(() => {
    actionsRef.current?.jumpToReplayImpact();
  }, []);

  const handlePrevReplayShot = useCallback(() => {
    actionsRef.current?.prevReplayShot();
  }, []);

  const handleNextReplayShot = useCallback(() => {
    actionsRef.current?.nextReplayShot();
  }, []);

  const handleJumpToReplayStart = useCallback(() => {
    actionsRef.current?.jumpToReplayStart();
  }, []);

  const handleJumpToReplayEnd = useCallback(() => {
    actionsRef.current?.jumpToReplayEnd();
  }, []);

  const handleJumpToReplayHighlight = useCallback((highlightId: string) => {
    actionsRef.current?.jumpToReplayHighlight(highlightId);
  }, []);

  const handleSetReplayCameraMode = useCallback((mode: ReplayCameraMode) => {
    actionsRef.current?.setReplayCameraMode(mode);
  }, []);

  const handleExportActiveReplayJson = useCallback(() => {
    actionsRef.current?.exportActiveReplayJson();
  }, []);

  const handleStartReplayVideoRecording = useCallback(() => {
    actionsRef.current?.startReplayVideoRecording();
  }, []);

  const handleStopReplayVideoRecording = useCallback(() => {
    actionsRef.current?.stopReplayVideoRecording();
  }, []);

  const handleMainMenu = useCallback(() => {
    if (useGameStore.getState().matchConfig.opponentType === 'online') {
      multiplayerManager.leaveMatchOrRoom();
    } else {
      setScreen('menu');
    }
  }, [setScreen]);

  return (
    <ErrorBoundary>
      <main className="relative h-screen w-screen overflow-hidden bg-[#090d11]">
        <GameCanvas
          actionsRef={actionsRef}
          onToggleFullscreen={handleToggleFullscreen}
        />
        <MainMenu
          onStartMatch={handleStartMatch}
          onToggleFullscreen={handleToggleFullscreen}
        />
        <GameHUD
          onShoot={handleShoot}
          onResetRack={handleResetRack}
          onConfirmPlacement={handleConfirmPlacement}
          onPlaceAtHeadSpot={handlePlaceAtHeadSpot}
          onSelectCalledShot={handleSelectCalledShot}
          onToggleFullscreen={handleToggleFullscreen}
          onEnterReplay={handleEnterReplay}
        />
        <ReplayOverlay
          onExitReplay={handleExitReplay}
          onSelectShot={handleSelectReplayShot}
          onPrevShot={handlePrevReplayShot}
          onNextShot={handleNextReplayShot}
          onJumpToStart={handleJumpToReplayStart}
          onJumpToEnd={handleJumpToReplayEnd}
          onJumpToHighlight={handleJumpToReplayHighlight}
          onTogglePlay={handleToggleReplayPlay}
          onRestart={handleRestartReplay}
          onSeek={handleSeekReplay}
          onSetSpeed={handleSetReplaySpeed}
          onSetCameraMode={handleSetReplayCameraMode}
          onToggleAutoSlowMo={handleToggleReplayAutoSlowMo}
          onToggleAnalysis={handleToggleReplayAnalysis}
          onJumpToImpact={handleJumpToReplayImpact}
          onExportJson={handleExportActiveReplayJson}
          onStartVideoRecording={handleStartReplayVideoRecording}
          onStopVideoRecording={handleStopReplayVideoRecording}
        />
        <MatchEndModal
          onPlayAgain={handleStartMatch}
          onMainMenu={handleMainMenu}
          onWatchReplay={() => handleEnterReplay()}
        />
        <SettingsModal
          onRestartMatch={handleStartMatch}
          onResetAllStats={handleResetAllStats}
        />
        <OnlineLobbyUI />
        <ProgressionModal />
        <SocialModal />
        <StoreModal />
        <ErrorBoundary
          sectionName={t('menu.globalTournamentsButton')}
          onReset={() => useGameStore.getState().closeTournamentModal()}
        >
          <TournamentModal />
        </ErrorBoundary>
        <ErrorBoundary
          sectionName={t('menu.clubsLeaguesButton')}
          onReset={() => useGameStore.getState().closeClubLeagueModal()}
        >
          <ClubLeagueModal />
        </ErrorBoundary>
        <BattlePassModal />
        <InviteNotificationBanner />
        <ProgressionToastBanner />
      </main>
    </ErrorBoundary>
  );
}
