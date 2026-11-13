import type { BallSettledSnapshot } from '../rules/types';
import {
  RapierIsolatedSimEngine,
  type SimShotInput,
  type SimShotOutput,
} from './aiSimulationEngine';

export interface WorkerSimBatchRequest {
  type: 'simulateBatch';
  requestId: number;
  balls: BallSettledSnapshot[];
  shots: SimShotInput[];
  isBreakShot: boolean;
}

export interface WorkerSimBatchResponse {
  type: 'batchResult';
  requestId: number;
  results: SimShotOutput[];
  error?: string;
}

const engine = new RapierIsolatedSimEngine();
let initPromise: Promise<void> | null = null;
let latestRequestId = 0;

function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = engine.init();
  }
  return initPromise;
}

self.onmessage = async (event: MessageEvent<WorkerSimBatchRequest>) => {
  const msg = event.data;
  if (!msg || msg.type !== 'simulateBatch') return;

  latestRequestId = Math.max(latestRequestId, msg.requestId);

  try {
    await ensureInit();
    // Skip stale work if a newer request already arrived
    if (msg.requestId < latestRequestId) {
      const cancelled: WorkerSimBatchResponse = {
        type: 'batchResult',
        requestId: msg.requestId,
        results: [],
      };
      self.postMessage(cancelled);
      return;
    }

    const results: SimShotOutput[] = [];
    for (const shot of msg.shots) {
      if (msg.requestId < latestRequestId) {
        break;
      }
      results.push(engine.simulateShot(msg.balls, shot, msg.isBreakShot));
    }

    const response: WorkerSimBatchResponse = {
      type: 'batchResult',
      requestId: msg.requestId,
      results,
    };
    self.postMessage(response);
  } catch (err) {
    const response: WorkerSimBatchResponse = {
      type: 'batchResult',
      requestId: msg.requestId,
      results: [],
      error: err instanceof Error ? err.message : 'Worker simulation failed',
    };
    self.postMessage(response);
  }
};
