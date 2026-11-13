import { useCallback, useEffect, useRef } from 'react';
import { ErrorBoundary } from './components/ErrorBoundary';
import { GameCanvas, type PoolSceneActions } from './components/GameCanvas';
import { GameHUD } from './components/GameHUD';
import { MainMenu } from './components/MainMenu';
import { MatchEndModal } from './components/MatchEndModal';
import { OnlineLobbyUI } from './components/OnlineLobbyUI';
import { ProgressionModal } from './components/ProgressionModal';
import { SettingsModal } from './components/SettingsModal';
import type { PocketId } from './game/rules/types';
import { soundEngine } from './game/utils/SoundEngine';
import { multiplayerManager } from './multiplayer/MultiplayerManager';
import { useGameStore } from './store/useGameStore';

export default function App() {
  const actionsRef = useRef<PoolSceneActions | null>(null);
  const setIsFullscreen = useGameStore((s) => s.setIsFullscreen);
  const setScreen = useGameStore((s) => s.setScreen);

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
        />
        <MatchEndModal
          onPlayAgain={handleStartMatch}
          onMainMenu={handleMainMenu}
        />
        <SettingsModal
          onRestartMatch={handleStartMatch}
          onResetAllStats={handleResetAllStats}
        />
        <OnlineLobbyUI />
        <ProgressionModal />
      </main>
    </ErrorBoundary>
  );
}
