import type { BallSettledSnapshot } from '../rules/types';
import {
  RapierIsolatedSimEngine,
  type SimShotInput,
  type SimShotOutput,
} from './aiSimulationEngine';
import type {
  WorkerSimBatchRequest,
  WorkerSimBatchResponse,
} from './aiSimulationWorker';

export type { SimShotInput, SimShotOutput };

interface PendingRequest {
  resolve: (results: SimShotOutput[]) => void;
  reject: (err: Error) => void;
}

/**
 * Isolated physics-based shot simulator for the AI opponent.
 * Runs candidate shots in a dedicated Rapier3D Web Worker (with automatic
 * isolated async chunked fallback if Worker is unavailable).
 * Never mutates the live PhysicsWorld.
 */
export class AIPhysicsSimulator {
  private worker: Worker | null = null;
  private workerFailed = false;
  private fallbackEngine: RapierIsolatedSimEngine | null = null;
  private fallbackInit: Promise<void> | null = null;
  private requestSeq = 0;
  private activeMinValidId = 0;
  private pending = new Map<number, PendingRequest>();

  private ensureWorker(): Worker | null {
    if (this.workerFailed || typeof Worker === 'undefined') {
      return null;
    }
    if (this.worker) return this.worker;

    try {
      const w = new Worker(new URL('./aiSimulationWorker.ts', import.meta.url), {
        type: 'module',
      });
      w.onmessage = (event: MessageEvent<WorkerSimBatchResponse>) => {
        const msg = event.data;
        if (!msg || msg.type !== 'batchResult') return;
        const req = this.pending.get(msg.requestId);
        if (!req) return;
        this.pending.delete(msg.requestId);
        if (msg.error) {
          req.reject(new Error(msg.error));
        } else {
          req.resolve(msg.results);
        }
      };
      w.onerror = () => {
        this.workerFailed = true;
        this.worker = null;
        for (const [id, req] of this.pending) {
          req.reject(new Error('AI simulation worker error'));
          this.pending.delete(id);
        }
      };
      this.worker = w;
      return w;
    } catch {
      this.workerFailed = true;
      return null;
    }
  }

  private async ensureFallbackEngine(): Promise<RapierIsolatedSimEngine> {
    if (!this.fallbackEngine) {
      this.fallbackEngine = new RapierIsolatedSimEngine();
    }
    if (!this.fallbackInit) {
      this.fallbackInit = this.fallbackEngine.init();
    }
    await this.fallbackInit;
    return this.fallbackEngine;
  }

  public cancelPending(): void {
    this.activeMinValidId = this.requestSeq + 1;
    for (const [id, req] of this.pending) {
      req.resolve([]);
      this.pending.delete(id);
    }
  }

  public async simulateBatch(
    balls: BallSettledSnapshot[],
    shots: SimShotInput[],
    isBreakShot: boolean,
    signal?: AbortSignal,
  ): Promise<SimShotOutput[]> {
    if (shots.length === 0 || signal?.aborted) return [];

    const reqId = ++this.requestSeq;
    const snapshotCopy = balls.map((b) => ({ ...b }));

    const worker = this.ensureWorker();
    if (worker) {
      try {
        const workerResults = await new Promise<SimShotOutput[]>((resolve, reject) => {
          if (signal?.aborted) {
            resolve([]);
            return;
          }
          const onAbort = () => {
            this.pending.delete(reqId);
            resolve([]);
          };
          signal?.addEventListener('abort', onAbort, { once: true });

          this.pending.set(reqId, {
            resolve: (res) => {
              signal?.removeEventListener('abort', onAbort);
              resolve(res);
            },
            reject: (err) => {
              signal?.removeEventListener('abort', onAbort);
              reject(err);
            },
          });

          const payload: WorkerSimBatchRequest = {
            type: 'simulateBatch',
            requestId: reqId,
            balls: snapshotCopy,
            shots,
            isBreakShot,
          };
          worker.postMessage(payload);
        });

        if (signal?.aborted || reqId < this.activeMinValidId) return [];
        return workerResults;
      } catch {
        // Fall through to isolated main-thread chunked simulator
      }
    }

    // Isolated async fallback (yields between small chunks so UI stays responsive)
    const engine = await this.ensureFallbackEngine();
    const results: SimShotOutput[] = [];
    for (let i = 0; i < shots.length; i++) {
      if (signal?.aborted || reqId < this.activeMinValidId) {
        return [];
      }
      results.push(engine.simulateShot(snapshotCopy, shots[i], isBreakShot));
      if (i % 4 === 3 && typeof window !== 'undefined') {
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    return results;
  }

  /**
   * Synchronous single/batch simulation helper for deterministic unit/integration tests.
   */
  public async simulateBatchSyncFallback(
    balls: BallSettledSnapshot[],
    shots: SimShotInput[],
    isBreakShot: boolean,
  ): Promise<SimShotOutput[]> {
    const engine = await this.ensureFallbackEngine();
    return shots.map((s) => engine.simulateShot(balls, s, isBreakShot));
  }

  public dispose(): void {
    this.cancelPending();
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    if (this.fallbackEngine) {
      this.fallbackEngine.dispose();
      this.fallbackEngine = null;
      this.fallbackInit = null;
    }
  }
}
