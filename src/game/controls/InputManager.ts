import { canLocalPlayerAct, useGameStore } from '../../store/useGameStore';
import { soundEngine } from '../utils/SoundEngine';

export interface InputActions {
  onStartMatch: () => void;
  onResetRack: () => void;
  onConfirmCuePlacement: () => void;
  onToggleFullscreen: () => void;
  onToggleReplayPlay?: () => void;
  onRestartReplay?: () => void;
  onExitReplay?: () => void;
}

export class InputManager {
  private heldKeys = new Set<string>();
  private actions: InputActions;

  private handleKeyDownBound: (e: KeyboardEvent) => void;
  private handleKeyUpBound: (e: KeyboardEvent) => void;
  private handleBlurBound: () => void;

  constructor(actions: InputActions) {
    this.actions = actions;
    this.handleKeyDownBound = this.onKeyDown.bind(this);
    this.handleKeyUpBound = this.onKeyUp.bind(this);
    this.handleBlurBound = this.onBlur.bind(this);

    window.addEventListener('keydown', this.handleKeyDownBound);
    window.addEventListener('keyup', this.handleKeyUpBound);
    window.addEventListener('blur', this.handleBlurBound);
  }

  private onKeyDown(e: KeyboardEvent) {
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement ||
      e.target instanceof HTMLSelectElement
    ) {
      return;
    }

    this.heldKeys.add(e.code);
    const store = useGameStore.getState();

    // Edge-triggered shortcuts (ignore key repeat)
    if (e.repeat) return;

    if (store.screen === 'menu') {
      if (store.onlineLobbyOpen || store.settingsOpen) return;
      if (e.code === 'Enter' || e.code === 'Space') {
        e.preventDefault();
        soundEngine.unlock();
        soundEngine.playUiClick();
        this.actions.onStartMatch();
      }
      return;
    }

    if (store.replayActive) {
      switch (e.code) {
        case 'Space':
          e.preventDefault();
          this.actions.onToggleReplayPlay?.();
          return;
        case 'KeyR':
          e.preventDefault();
          this.actions.onRestartReplay?.();
          return;
        case 'Escape':
          e.preventDefault();
          this.actions.onExitReplay?.();
          return;
      }
    }

    if (
      store.matchPhase === 'BALL_IN_HAND' &&
      !store.isAiThinking &&
      canLocalPlayerAct(store) &&
      (e.code === 'Enter' || e.code === 'Space')
    ) {
      e.preventDefault();
      this.actions.onConfirmCuePlacement();
      return;
    }

    switch (e.code) {
      case 'KeyR':
        if (store.matchConfig.opponentType === 'online') break;
        e.preventDefault();
        this.actions.onResetRack();
        break;
      case 'Digit1':
        store.requestCameraPreset('threeQuarter');
        break;
      case 'Digit2':
        store.requestCameraPreset('topDown');
        break;
      case 'Digit3':
        store.requestCameraPreset('cueAim');
        break;
      case 'Digit4':
        store.requestCameraPreset('sideView');
        break;
      case 'KeyH':
        store.toggleHudCollapsed();
        break;
      case 'KeyM':
        store.toggleSound();
        break;
      case 'KeyF':
        this.actions.onToggleFullscreen();
        break;
      case 'Escape':
        store.setSettingsOpen(!store.settingsOpen);
        break;
    }
  }

  private onKeyUp(e: KeyboardEvent) {
    this.heldKeys.delete(e.code);
  }

  private onBlur() {
    this.heldKeys.clear();
  }

  /** Continuous held-key aiming processing per frame (locked during cue drag/shot/BIH/AI/GameOver) */
  public update(delta: number) {
    const store = useGameStore.getState();
    if (
      store.screen !== 'playing' ||
      store.settingsOpen ||
      store.ballsMoving ||
      store.isDraggingCue ||
      store.isShotAnimating ||
      store.isAiThinking ||
      !canLocalPlayerAct(store) ||
      store.matchPhase === 'BALL_IN_HAND' ||
      store.matchPhase === 'GAME_OVER' ||
      store.matchPhase === 'BALLS_MOVING'
    ) {
      return;
    }

    const fine = this.heldKeys.has('ShiftLeft') || this.heldKeys.has('ShiftRight');
    const aimSpeed = fine ? 0.45 : 1.55;

    if (this.heldKeys.has('ArrowLeft') || this.heldKeys.has('KeyA')) {
      store.adjustCueAngle(-aimSpeed * delta);
    }
    if (this.heldKeys.has('ArrowRight') || this.heldKeys.has('KeyD')) {
      store.adjustCueAngle(aimSpeed * delta);
    }
  }

  public dispose() {
    window.removeEventListener('keydown', this.handleKeyDownBound);
    window.removeEventListener('keyup', this.handleKeyUpBound);
    window.removeEventListener('blur', this.handleBlurBound);
    this.heldKeys.clear();
  }
}
