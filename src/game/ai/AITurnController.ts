import * as THREE from 'three';
import { useGameStore, type CueSpin } from '../../store/useGameStore';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { getLegalTargetBalls, getOpponent } from '../rules/BallGroupManager';
import type { MatchManager } from '../rules/MatchManager';
import { TABLE_DIMENSIONS } from '../utils/constants';
import { normalizeAngleDiff } from './AIAimingController';
import { getAiDifficultyProfile, getThinkingSpeedScale } from './AIDifficultyConfig';
import { AIManager, type AiTurnContext } from './AIManager';

export interface AITurnControllerCallbacks {
  isDisposed: () => boolean;
  onExecuteStrike: (power: number, aimAngle: number, spin: CueSpin) => void;
}

interface PendingTimer {
  id: ReturnType<typeof setTimeout>;
  resolve: (ok: boolean) => void;
}

interface PendingRaf {
  id: number | ReturnType<typeof setTimeout>;
  isTimeout: boolean;
  resolve: (ok: boolean) => void;
}

const _cuePosVec = new THREE.Vector3();

function scheduleAnimFrame(cb: (now: number) => void): {
  id: number | ReturnType<typeof setTimeout>;
  isTimeout: boolean;
} {
  if (typeof requestAnimationFrame === 'function') {
    return { id: requestAnimationFrame(cb), isTimeout: false };
  }
  return {
    id: globalThis.setTimeout(() => cb(performance.now()), 16),
    isTimeout: true,
  };
}

function cancelAnimFrame(handle: {
  id: number | ReturnType<typeof setTimeout>;
  isTimeout: boolean;
}): void {
  if (handle.isTimeout) {
    globalThis.clearTimeout(handle.id as ReturnType<typeof setTimeout>);
  } else if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(handle.id as number);
  }
}

export class AITurnController {
  private aiManager = new AIManager();
  private turnGeneration = 0;
  private activeRunGeneration = 0;
  private isExecutingTurn = false;
  private activeTimers: PendingTimer[] = [];
  private activeRaf: PendingRaf | null = null;
  private retryTimerId: ReturnType<typeof setTimeout> | null = null;

  private matchManager: MatchManager;
  private physics: PhysicsWorld;
  private callbacks: AITurnControllerCallbacks;

  constructor(
    matchManager: MatchManager,
    physics: PhysicsWorld,
    callbacks: AITurnControllerCallbacks,
  ) {
    this.matchManager = matchManager;
    this.physics = physics;
    this.callbacks = callbacks;
  }

  private clearRetryTimer(): void {
    if (this.retryTimerId !== null) {
      globalThis.clearTimeout(this.retryTimerId);
      this.retryTimerId = null;
    }
  }

  private isPlayablePhase(): boolean {
    const phase = this.matchManager.getPhase();
    return (
      phase === 'BREAK' ||
      phase === 'OPEN_TABLE' ||
      phase === 'GROUPS_ASSIGNED' ||
      phase === 'BALL_IN_HAND'
    );
  }

  private isTurnEligible(): boolean {
    const store = useGameStore.getState();
    if (this.callbacks.isDisposed() || store.screen !== 'playing' || store.replayActive) {
      return false;
    }
    if (!this.matchManager.isActivePlayerAi()) {
      return false;
    }
    return this.isPlayablePhase();
  }

  private scheduleRetryIfNeeded(attempt: number): void {
    this.clearRetryTimer();
    if (attempt >= 60 || !this.isTurnEligible()) {
      return;
    }
    this.retryTimerId = globalThis.setTimeout(() => {
      this.retryTimerId = null;
      if (!this.isTurnEligible()) return;
      const store = useGameStore.getState();
      if (store.settingsOpen || this.physics.areAnyBallsMoving()) {
        this.scheduleRetryIfNeeded(attempt + 1);
        return;
      }
      this.scheduleTurnIfNeeded();
    }, 100);
  }

  public cancel(): void {
    this.clearRetryTimer();
    this.turnGeneration++;
    this.isExecutingTurn = false;
    this.aiManager.cancel();

    const timers = this.activeTimers;
    this.activeTimers = [];
    for (const timer of timers) {
      globalThis.clearTimeout(timer.id);
      timer.resolve(false);
    }

    if (this.activeRaf) {
      const raf = this.activeRaf;
      this.activeRaf = null;
      cancelAnimFrame(raf);
      raf.resolve(false);
    }

    const store = useGameStore.getState();
    store.setIsAiThinking(false);
    store.setAiPullbackPower(0);
    store.setAiStatus({
      active: false,
      phase: 'idle',
      message: 'Standby',
      shotTypeLabel: null,
    });
  }

  public scheduleTurnIfNeeded(): void {
    this.clearRetryTimer();
    if (!this.isTurnEligible()) {
      if (this.isExecutingTurn || useGameStore.getState().isAiThinking) {
        this.cancel();
      }
      return;
    }

    const store = useGameStore.getState();
    if (store.settingsOpen || this.physics.areAnyBallsMoving()) {
      this.scheduleRetryIfNeeded(0);
      return;
    }

    // Avoid tearing down an in-flight AI turn coroutine for the same active turn
    if (
      this.isExecutingTurn &&
      this.activeRunGeneration === this.turnGeneration &&
      !this.isCancelled(this.activeRunGeneration)
    ) {
      return;
    }

    this.cancel();
    const gen = ++this.turnGeneration;
    this.activeRunGeneration = gen;
    this.isExecutingTurn = true;
    console.debug('[AI] Scheduled turn', {
      gen,
      phase: this.matchManager.getPhase(),
      activePlayer: this.matchManager.getActivePlayer(),
    });
    void this.runTurnSequence(gen);
  }

  private isCancelled(gen: number): boolean {
    if (gen !== this.turnGeneration || this.callbacks.isDisposed()) return true;
    const store = useGameStore.getState();
    if (store.screen !== 'playing' || store.settingsOpen || store.replayActive) return true;
    if (!this.matchManager.isActivePlayerAi()) return true;
    if (!this.isPlayablePhase()) return true;
    if (this.physics.areAnyBallsMoving()) return true;
    return false;
  }

  private waitMs(ms: number, gen: number): Promise<boolean> {
    if (this.isCancelled(gen)) return Promise.resolve(false);
    return new Promise((resolve) => {
      const entry: PendingTimer = {
        id: globalThis.setTimeout(() => {
          this.activeTimers = this.activeTimers.filter((t) => t !== entry);
          resolve(!this.isCancelled(gen));
        }, Math.max(16, ms)),
        resolve,
      };
      this.activeTimers.push(entry);
    });
  }

  private animateDuration(
    durationMs: number,
    gen: number,
    onFrame: (t: number) => void,
  ): Promise<boolean> {
    if (this.isCancelled(gen)) return Promise.resolve(false);
    return new Promise((resolve) => {
      const start = performance.now();
      const total = Math.max(40, durationMs);

      const step = (now: number) => {
        if (this.isCancelled(gen)) {
          this.activeRaf = null;
          resolve(false);
          return;
        }
        const raw = Math.min(1, (now - start) / total);
        // Smooth easeInOutCubic
        const eased =
          raw < 0.5 ? 4 * raw * raw * raw : 1 - Math.pow(-2 * raw + 2, 3) / 2;
        onFrame(eased);

        if (raw >= 1) {
          this.activeRaf = null;
          resolve(true);
          return;
        }
        const nextHandle = scheduleAnimFrame(step);
        this.activeRaf = {
          id: nextHandle.id,
          isTimeout: nextHandle.isTimeout,
          resolve,
        };
      };

      const initialHandle = scheduleAnimFrame(step);
      this.activeRaf = {
        id: initialHandle.id,
        isTimeout: initialHandle.isTimeout,
        resolve,
      };
    });
  }

  private buildContext(): AiTurnContext {
    const snap = this.matchManager.getSnapshot();
    const aiPlayer = snap.activePlayer;
    const oppPlayer = getOpponent(aiPlayer);

    return {
      worldVersion: this.physics.getWorldVersion(),
      balls: this.physics.getAllBallStates(),
      velocities: this.physics.getBallVelocities(),
      aiPlayer,
      aiGroup: snap.playerGroups[aiPlayer],
      opponentGroup: snap.playerGroups[oppPlayer],
      tableOpen: snap.tableOpen,
      isBreakShot: snap.isBreakShot,
      ballInHandZone: snap.ballInHandZone,
      ruleProfile: snap.profile,
      difficulty: snap.config.aiDifficulty,
    };
  }

  private resetUiIdle(): void {
    const st = useGameStore.getState();
    st.setAiPullbackPower(0);
    st.setIsAiThinking(false);
    st.setAiStatus({
      active: false,
      phase: 'idle',
      message: 'Standby',
      shotTypeLabel: null,
    });
  }

  private executeEmergencyFallbackStrike(gen: number): void {
    if (this.isCancelled(gen)) return;

    const snap = this.matchManager.getSnapshot();
    if (this.matchManager.getPhase() === 'BALL_IN_HAND') {
      const safeSpot = this.physics.findNearestValidCuePlacement(snap.ballInHandZone);
      this.physics.setCueBallPlacement(safeSpot.x, safeSpot.z);
      useGameStore.getState().setCuePlacementPreview(safeSpot.x, safeSpot.z, true, null);
      const confirmed = this.matchManager.confirmBallInHandPlacement();
      useGameStore.getState().syncFromMatchSnapshot(confirmed);
    }

    if (this.isCancelled(gen) || !this.matchManager.canShoot()) return;

    if (!this.physics.isCueBallAvailable()) {
      this.physics.respotCueBall();
    }

    const latestSnap = this.matchManager.getSnapshot();
    const aiGroup = latestSnap.playerGroups[latestSnap.activePlayer];
    const pocketedSet = new Set(latestSnap.pocketedNumbers);
    const legalTargets = getLegalTargetBalls(
      pocketedSet,
      latestSnap.tableOpen,
      aiGroup,
    );

    this.physics.getCueBallPosition(_cuePosVec);
    const allBalls = this.physics.getAllBallStates();
    const targetBall =
      allBalls.find((b) => !b.pocketed && legalTargets.includes(b.number)) ??
      allBalls.find((b) => !b.pocketed && b.number !== 0);

    const aimAngle = targetBall
      ? Math.atan2(targetBall.z - _cuePosVec.z, targetBall.x - _cuePosVec.x)
      : Math.atan2(-_cuePosVec.z, TABLE_DIMENSIONS.footSpotX - _cuePosVec.x);
    const power = latestSnap.isBreakShot ? 0.85 : 0.56;
    const spin: CueSpin = { x: 0, y: 0 };

    useGameStore.getState().setCueAngle(aimAngle);
    useGameStore.getState().setCueSpin(0, 0);
    this.resetUiIdle();

    console.warn('[AI] Executed emergency fallback strike', {
      gen,
      targetBall: targetBall?.number ?? null,
      aimAngle,
      power,
    });
    this.callbacks.onExecuteStrike(power, aimAngle, spin);
  }

  private async runTurnSequence(gen: number): Promise<void> {
    const store = useGameStore.getState();
    const snap = this.matchManager.getSnapshot();
    const profile = getAiDifficultyProfile(snap.config.aiDifficulty);
    const speedScale = getThinkingSpeedScale(snap.config.aiThinkingSpeed);

    store.setIsAiThinking(true);
    store.setAiPullbackPower(0);
    store.setAiStatus({
      active: true,
      phase: 'analyzing',
      message: 'Thinking',
      shotTypeLabel: null,
    });

    try {
      if (!(await this.waitMs(profile.analyzeDelayMs * speedScale, gen))) {
        return;
      }

      // Step 1: Ball-in-Hand placement (if AI has Ball in Hand)
      if (this.matchManager.getPhase() === 'BALL_IN_HAND') {
        useGameStore.getState().setAiStatus({
          active: true,
          phase: 'placing',
          message: 'Thinking',
          shotTypeLabel: null,
        });

        const rawPlacement = await this.aiManager.decideBallInHandPlacement(this.buildContext());
        if (this.isCancelled(gen)) return;

        const currentZone = this.matchManager.getSnapshot().ballInHandZone;
        const check = this.physics.validateCueBallPlacement(
          rawPlacement.x,
          rawPlacement.z,
          currentZone,
        );
        const placement = check.valid
          ? { x: check.clampedX, z: check.clampedZ }
          : this.physics.findNearestValidCuePlacement(currentZone);

        this.physics.getCueBallPosition(_cuePosVec);
        const startX = Number.isFinite(_cuePosVec.x)
          ? _cuePosVec.x
          : useGameStore.getState().cuePlacementPos.x;
        const startZ = Number.isFinite(_cuePosVec.z)
          ? _cuePosVec.z
          : useGameStore.getState().cuePlacementPos.z;

        const placedOk = await this.animateDuration(420 * speedScale, gen, (t) => {
          const curX = startX + (placement.x - startX) * t;
          const curZ = startZ + (placement.z - startZ) * t;
          // Non-colliding visual glide prevents bumping object balls mid-animation
          this.physics.setCueBallVisualGlide(curX, curZ);
          useGameStore.getState().setCuePlacementPreview(curX, curZ, true, null);
        });
        if (!placedOk || this.isCancelled(gen)) {
          // Ensure cue ball is restored to Dynamic state if interrupted mid-glide
          const safeRestore = this.physics.findNearestValidCuePlacement(currentZone);
          this.physics.setCueBallPlacement(safeRestore.x, safeRestore.z);
          return;
        }

        this.physics.setCueBallPlacement(placement.x, placement.z);
        useGameStore.getState().setCuePlacementPreview(placement.x, placement.z, true, null);
        const confirmed = this.matchManager.confirmBallInHandPlacement();
        useGameStore.getState().syncFromMatchSnapshot(confirmed);
        console.debug('[AI] Ball in hand placed', { gen, placement });

        if (!(await this.waitMs(220 * speedScale, gen))) return;
      }

      if (!this.matchManager.canShoot() || this.isCancelled(gen)) {
        return;
      }

      // Step 2: Evaluate shots via isolated Rapier3D physics simulations
      useGameStore.getState().setAiStatus({
        active: true,
        phase: 'evaluating',
        message: 'Thinking',
        shotTypeLabel: null,
      });

      const { plan, executed } = await this.aiManager.planShot(this.buildContext());
      if (this.isCancelled(gen)) return;

      console.debug('[AI] Planned shot', {
        gen,
        kind: plan.kind,
        calledBall: plan.calledBall,
        calledPocket: plan.calledPocket,
        power: executed.power,
      });

      const withCall = this.matchManager.setCalledShot(plan.calledBall, plan.calledPocket);
      useGameStore.getState().syncFromMatchSnapshot(withCall);
      useGameStore.getState().setCueSpin(executed.spin.x, executed.spin.y);
      useGameStore.getState().setAiStatus({
        active: true,
        phase: 'aiming',
        message: 'Aiming',
        shotTypeLabel: null,
      });

      // Step 3: Smooth visual cue stick rotation toward selected aimAngle
      const startAngle = useGameStore.getState().cueAngle;
      const angleDelta = normalizeAngleDiff(startAngle, executed.aimAngle);
      const aimOk = await this.animateDuration(profile.aimingDurationMs * speedScale, gen, (t) => {
        useGameStore.getState().setCueAngle(startAngle + angleDelta * t);
      });
      if (!aimOk) return;
      useGameStore.getState().setCueAngle(executed.aimAngle);

      // Step 4: Smooth cue stick pullback animation before strike
      useGameStore.getState().setAiStatus({
        active: true,
        phase: 'pullback',
        message: 'Aiming',
        shotTypeLabel: null,
      });

      const pullOk = await this.animateDuration(profile.pullbackDurationMs * speedScale, gen, (t) => {
        useGameStore.getState().setAiPullbackPower(executed.power * t);
      });
      if (!pullOk) return;

      if (!(await this.waitMs(110 * speedScale, gen))) return;

      // Step 5: Execute real physical strike through the same player pipeline
      if (this.isCancelled(gen) || !this.matchManager.canShoot()) return;

      this.resetUiIdle();
      console.debug('[AI] Executing physical strike', {
        gen,
        aimAngle: executed.aimAngle,
        power: executed.power,
      });
      this.callbacks.onExecuteStrike(executed.power, executed.aimAngle, executed.spin);
    } catch (err) {
      console.warn('[AI] Turn sequence failed unexpectedly', err);
      this.executeEmergencyFallbackStrike(gen);
    } finally {
      if (this.activeRunGeneration === gen) {
        this.isExecutingTurn = false;
      }
      if (gen === this.turnGeneration) {
        const st = useGameStore.getState();
        if (st.isAiThinking || st.aiPullbackPower !== 0 || st.aiStatus.active) {
          this.resetUiIdle();
        }
      }
    }
  }

  public dispose(): void {
    this.cancel();
    this.aiManager.dispose();
  }
}

