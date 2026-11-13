import { useGameStore, type CueSpin } from '../../store/useGameStore';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { MatchManager } from '../rules/MatchManager';
import { getOpponent } from '../rules/BallGroupManager';
import { normalizeAngleDiff } from './AIAimingController';
import { getAiDifficultyProfile, getThinkingSpeedScale } from './AIDifficultyConfig';
import { AIManager, type AiTurnContext } from './AIManager';

export interface AITurnControllerCallbacks {
  isDisposed: () => boolean;
  onExecuteStrike: (power: number, aimAngle: number, spin: CueSpin) => void;
}

export class AITurnController {
  private aiManager = new AIManager();
  private turnGeneration = 0;
  private activeTimerIds: number[] = [];
  private activeRafId = 0;

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

  public cancel(): void {
    this.turnGeneration++;
    this.aiManager.cancel();
    for (const id of this.activeTimerIds) {
      window.clearTimeout(id);
    }
    this.activeTimerIds = [];
    if (this.activeRafId) {
      cancelAnimationFrame(this.activeRafId);
      this.activeRafId = 0;
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
    this.cancel();
    const store = useGameStore.getState();
    if (this.callbacks.isDisposed() || store.screen !== 'playing') return;
    if (!this.matchManager.isActivePlayerAi()) return;

    const phase = this.matchManager.getPhase();
    if (
      phase !== 'BREAK' &&
      phase !== 'OPEN_TABLE' &&
      phase !== 'GROUPS_ASSIGNED' &&
      phase !== 'BALL_IN_HAND'
    ) {
      return;
    }

    // Never shoot while balls are still moving
    if (this.physics.areAnyBallsMoving()) {
      return;
    }

    const gen = ++this.turnGeneration;
    void this.runTurnSequence(gen);
  }

  private isCancelled(gen: number): boolean {
    if (gen !== this.turnGeneration || this.callbacks.isDisposed()) return true;
    const store = useGameStore.getState();
    if (store.screen !== 'playing') return true;
    if (!this.matchManager.isActivePlayerAi()) return true;
    if (this.physics.areAnyBallsMoving()) return true;
    return false;
  }

  private waitMs(ms: number, gen: number): Promise<boolean> {
    return new Promise((resolve) => {
      const id = window.setTimeout(() => {
        resolve(!this.isCancelled(gen));
      }, Math.max(16, ms));
      this.activeTimerIds.push(id);
    });
  }

  private animateDuration(
    durationMs: number,
    gen: number,
    onFrame: (t: number) => void,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const start = performance.now();
      const total = Math.max(40, durationMs);

      const step = (now: number) => {
        if (this.isCancelled(gen)) {
          this.activeRafId = 0;
          resolve(false);
          return;
        }
        const raw = Math.min(1, (now - start) / total);
        // Smooth easeInOutCubic
        const eased =
          raw < 0.5 ? 4 * raw * raw * raw : 1 - Math.pow(-2 * raw + 2, 3) / 2;
        onFrame(eased);

        if (raw >= 1) {
          this.activeRafId = 0;
          resolve(true);
          return;
        }
        this.activeRafId = requestAnimationFrame(step);
      };

      this.activeRafId = requestAnimationFrame(step);
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

      const placement = await this.aiManager.decideBallInHandPlacement(this.buildContext());
      if (this.isCancelled(gen)) return;

      const startPos = useGameStore.getState().cuePlacementPos;
      const placedOk = await this.animateDuration(420 * speedScale, gen, (t) => {
        const curX = startPos.x + (placement.x - startPos.x) * t;
        const curZ = startPos.z + (placement.z - startPos.z) * t;
        this.physics.setCueBallPlacement(curX, curZ);
        useGameStore.getState().setCuePlacementPreview(curX, curZ, true, null);
      });
      if (!placedOk) return;

      this.physics.setCueBallPlacement(placement.x, placement.z);
      useGameStore.getState().setCuePlacementPreview(placement.x, placement.z, true, null);
      const confirmed = this.matchManager.confirmBallInHandPlacement();
      useGameStore.getState().syncFromMatchSnapshot(confirmed);

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

    useGameStore.getState().setAiPullbackPower(0);
    useGameStore.getState().setIsAiThinking(false);
    useGameStore.getState().setAiStatus({
      active: false,
      phase: 'idle',
      message: 'Standby',
      shotTypeLabel: null,
    });

    this.callbacks.onExecuteStrike(executed.power, executed.aimAngle, executed.spin);
  }

  public dispose(): void {
    this.cancel();
    this.aiManager.dispose();
  }
}
