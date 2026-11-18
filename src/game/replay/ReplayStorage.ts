import { generateMatchHighlights } from './HighlightGenerator';
import {
  REPLAY_FLOATS_PER_FRAME,
  REPLAY_FORMAT_VERSION,
  summarizeMatchReplay,
  type MatchReplayRecord,
  type RecordedShot,
  type ReplayStorageStats,
  type SavedReplaySummary,
} from './types';

const DB_NAME = 'ultimate_pool_3d_replays_db';
const DB_VERSION = 1;
const STORE_NAME = 'match_replays';

export const DEFAULT_REPLAY_MAX_COUNT = 24;
export const DEFAULT_REPLAY_MAX_BYTES = 40 * 1024 * 1024; // 40 MB
const MAX_IMPORT_JSON_CHARS = 28 * 1024 * 1024;
const MAX_SHOTS_PER_REPLAY = 200;
const MAX_FRAMES_PER_IMPORTED_SHOT = 2500;

interface SerializedShot {
  id: string;
  shotNumber: number;
  recordedAtMs: number;
  mode: 'local' | 'ai' | 'online';
  shooter: 'player1' | 'player2';
  shooterName: string;
  isBreakShot: boolean;
  cueAngle: number;
  power: number;
  spin: { x: number; y: number };
  calledShot: { targetBall: number | null; targetPocket: RecordedShot['calledShot']['targetPocket'] };
  durationSec: number;
  timestepSec: number;
  frameCount: number;
  framesBase64: string;
  collisions: RecordedShot['collisions'];
  pocketedBalls: RecordedShot['pocketedBalls'];
  trajectories: RecordedShot['trajectories'];
  firstImpactTimeSec: number | null;
  resultLabel: string;
  isFoul: boolean;
  foulReason: string | null;
  startMatchTimeSec?: number;
  endMatchTimeSec?: number;
  tableOpenAfter?: boolean;
  playerGroupsAfter?: RecordedShot['playerGroupsAfter'];
  pocketedNumbersAfter?: number[];
  activePlayerAfter?: RecordedShot['activePlayerAfter'];
  ballInHandNext?: boolean;
}

interface StoredReplayEnvelope {
  replayId: string;
  matchId: string;
  savedAtMs: number;
  byteSize: number;
  summary: SavedReplaySummary;
  payload: Omit<MatchReplayRecord, 'shots'> & { shots: SerializedShot[] };
}

export interface ReplayImportResult {
  ok: true;
  replay: MatchReplayRecord;
  summary: SavedReplaySummary;
}

export interface ReplayImportError {
  ok: false;
  error: string;
}

function uint8ToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, Math.min(bytes.length, i + chunk));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(b64, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function encodeFramesFloat32(framesData: Float32Array): string {
  const view = new Uint8Array(
    framesData.buffer,
    framesData.byteOffset,
    framesData.byteLength,
  );
  return uint8ToBase64(view);
}

export function decodeFramesFloat32(base64: string, frameCount: number): Float32Array {
  const bytes = base64ToUint8(base64);
  const expectedFloats = frameCount * REPLAY_FLOATS_PER_FRAME;
  const expectedBytes = expectedFloats * 4;
  if (bytes.byteLength !== expectedBytes) {
    throw new Error(
      `Replay frame buffer size mismatch: expected ${expectedBytes} bytes, got ${bytes.byteLength}.`,
    );
  }
  const copy = new Uint8Array(expectedBytes);
  copy.set(bytes);
  const floats = new Float32Array(copy.buffer);
  for (let i = 0; i < floats.length; i++) {
    if (!Number.isFinite(floats[i])) {
      throw new Error('Replay contains non-finite physics frame coordinates.');
    }
  }
  return floats;
}

function serializeShot(shot: RecordedShot): SerializedShot {
  return {
    id: shot.id,
    shotNumber: shot.shotNumber,
    recordedAtMs: shot.recordedAtMs,
    mode: shot.mode,
    shooter: shot.shooter,
    shooterName: shot.shooterName,
    isBreakShot: shot.isBreakShot,
    cueAngle: shot.cueAngle,
    power: shot.power,
    spin: { ...shot.spin },
    calledShot: { ...shot.calledShot },
    durationSec: shot.durationSec,
    timestepSec: shot.timestepSec,
    frameCount: shot.frameCount,
    framesBase64: encodeFramesFloat32(shot.framesData),
    collisions: shot.collisions,
    pocketedBalls: shot.pocketedBalls,
    trajectories: shot.trajectories,
    firstImpactTimeSec: shot.firstImpactTimeSec,
    resultLabel: shot.resultLabel,
    isFoul: shot.isFoul,
    foulReason: shot.foulReason,
    startMatchTimeSec: shot.startMatchTimeSec,
    endMatchTimeSec: shot.endMatchTimeSec,
    tableOpenAfter: shot.tableOpenAfter,
    playerGroupsAfter: shot.playerGroupsAfter,
    pocketedNumbersAfter: shot.pocketedNumbersAfter,
    activePlayerAfter: shot.activePlayerAfter,
    ballInHandNext: shot.ballInHandNext,
  };
}

function deserializeShot(raw: SerializedShot): RecordedShot {
  const framesData = decodeFramesFloat32(raw.framesBase64, raw.frameCount);
  return {
    id: raw.id,
    shotNumber: raw.shotNumber,
    recordedAtMs: raw.recordedAtMs,
    mode: raw.mode,
    shooter: raw.shooter,
    shooterName: raw.shooterName,
    isBreakShot: raw.isBreakShot,
    cueAngle: raw.cueAngle,
    power: raw.power,
    spin: { ...raw.spin },
    calledShot: { ...raw.calledShot },
    durationSec: raw.durationSec,
    timestepSec: raw.timestepSec,
    frameCount: raw.frameCount,
    framesData,
    collisions: Array.isArray(raw.collisions) ? raw.collisions : [],
    pocketedBalls: Array.isArray(raw.pocketedBalls) ? raw.pocketedBalls : [],
    trajectories: Array.isArray(raw.trajectories) ? raw.trajectories : [],
    firstImpactTimeSec: raw.firstImpactTimeSec ?? null,
    resultLabel: raw.resultLabel,
    isFoul: Boolean(raw.isFoul),
    foulReason: raw.foulReason ?? null,
    startMatchTimeSec: raw.startMatchTimeSec,
    endMatchTimeSec: raw.endMatchTimeSec,
    tableOpenAfter: raw.tableOpenAfter,
    playerGroupsAfter: raw.playerGroupsAfter,
    pocketedNumbersAfter: raw.pocketedNumbersAfter,
    activePlayerAfter: raw.activePlayerAfter,
    ballInHandNext: raw.ballInHandNext,
  };
}

function sanitizeSafeString(val: unknown, fallback: string, maxLen = 140): string {
  if (typeof val !== 'string') return fallback;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLen) : fallback;
}

function isFinitePositive(n: unknown, max = 1e9): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= max;
}

function isFiniteNonNeg(n: unknown, max = 1e9): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= max;
}

function estimateEnvelopeBytes(payload: StoredReplayEnvelope['payload']): number {
  let bytes = 2048;
  for (const s of payload.shots) {
    bytes += s.framesBase64.length + 512;
  }
  return bytes;
}

export class ReplayStorageService {
  private maxCount = DEFAULT_REPLAY_MAX_COUNT;
  private maxBytes = DEFAULT_REPLAY_MAX_BYTES;
  private memoryStore = new Map<string, StoredReplayEnvelope>();
  private dbPromise: Promise<IDBDatabase | null> | null = null;

  public configure(limits: { maxCount?: number; maxBytes?: number }): void {
    if (typeof limits.maxCount === 'number' && limits.maxCount >= 1) {
      this.maxCount = Math.floor(limits.maxCount);
    }
    if (typeof limits.maxBytes === 'number' && limits.maxBytes >= 16_384) {
      this.maxBytes = Math.floor(limits.maxBytes);
    }
  }

  public getConfiguredLimits(): { maxCount: number; maxBytes: number } {
    return { maxCount: this.maxCount, maxBytes: this.maxBytes };
  }

  private hasIndexedDb(): boolean {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  }

  private async openDb(): Promise<IDBDatabase | null> {
    if (!this.hasIndexedDb()) return null;
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve) => {
        try {
          const req = indexedDB.open(DB_NAME, DB_VERSION);
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
              const store = db.createObjectStore(STORE_NAME, { keyPath: 'replayId' });
              store.createIndex('savedAtMs', 'savedAtMs', { unique: false });
              store.createIndex('matchId', 'matchId', { unique: false });
            }
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
          req.onblocked = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
    }
    return this.dbPromise;
  }

  private async getAllEnvelopes(): Promise<{
    envelopes: StoredReplayEnvelope[];
    backend: 'indexeddb' | 'memory';
  }> {
    const db = await this.openDb();
    if (!db) {
      return {
        envelopes: Array.from(this.memoryStore.values()),
        backend: 'memory',
      };
    }

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.getAll();
        req.onsuccess = () => {
          const rows = Array.isArray(req.result)
            ? (req.result as StoredReplayEnvelope[])
            : [];
          resolve({ envelopes: rows, backend: 'indexeddb' });
        };
        req.onerror = () => {
          resolve({
            envelopes: Array.from(this.memoryStore.values()),
            backend: 'memory',
          });
        };
      } catch {
        resolve({
          envelopes: Array.from(this.memoryStore.values()),
          backend: 'memory',
        });
      }
    });
  }

  private async putEnvelope(env: StoredReplayEnvelope): Promise<void> {
    const db = await this.openDb();
    if (!db) {
      this.memoryStore.set(env.replayId, env);
      return;
    }

    await new Promise<void>((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put(env);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
      } catch (err) {
        reject(err);
      }
    });
  }

  private async removeById(replayId: string): Promise<void> {
    this.memoryStore.delete(replayId);
    const db = await this.openDb();
    if (!db) return;
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(replayId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  public async saveReplay(replay: MatchReplayRecord): Promise<SavedReplaySummary> {
    const savedAtMs = replay.savedAtMs ?? Date.now();
    const serializedShots = replay.shots.map(serializeShot);
    const payload: StoredReplayEnvelope['payload'] = {
      ...replay,
      savedAtMs,
      shots: serializedShots,
    };
    const byteSize = estimateEnvelopeBytes(payload);
    const normalizedRecord: MatchReplayRecord = { ...replay, savedAtMs };
    const summary = summarizeMatchReplay(normalizedRecord, byteSize);

    // Deduplicate existing entries sharing same matchId or replayId
    const { envelopes } = await this.getAllEnvelopes();
    for (const existing of envelopes) {
      if (
        existing.replayId !== replay.replayId &&
        existing.matchId === replay.matchId
      ) {
        await this.removeById(existing.replayId);
      }
    }

    const envelope: StoredReplayEnvelope = {
      replayId: replay.replayId,
      matchId: replay.matchId,
      savedAtMs,
      byteSize,
      summary,
      payload,
    };

    await this.putEnvelope(envelope);
    await this.enforceStorageLimits();
    return summary;
  }

  private async enforceStorageLimits(): Promise<void> {
    const { envelopes } = await this.getAllEnvelopes();
    // Keep newest first
    const sorted = [...envelopes].sort((a, b) => b.savedAtMs - a.savedAtMs);
    let totalBytes = 0;
    const toDelete: string[] = [];

    for (let i = 0; i < sorted.length; i++) {
      const env = sorted[i];
      const keepByCount = i < this.maxCount;
      const keepBySize = i === 0 || totalBytes + env.byteSize <= this.maxBytes;
      if (keepByCount && keepBySize) {
        totalBytes += env.byteSize;
      } else {
        toDelete.push(env.replayId);
      }
    }

    for (const id of toDelete) {
      await this.removeById(id);
    }
  }

  public async listSavedReplays(): Promise<SavedReplaySummary[]> {
    const { envelopes } = await this.getAllEnvelopes();
    return envelopes
      .map((e) => e.summary)
      .sort((a, b) => b.savedAtMs - a.savedAtMs || b.endedAtMs - a.endedAtMs);
  }

  public async loadReplay(replayId: string): Promise<MatchReplayRecord | null> {
    const db = await this.openDb();
    let envelope: StoredReplayEnvelope | undefined;

    if (!db) {
      envelope = this.memoryStore.get(replayId);
    } else {
      envelope = await new Promise<StoredReplayEnvelope | undefined>((resolve) => {
        try {
          const tx = db.transaction(STORE_NAME, 'readonly');
          const req = tx.objectStore(STORE_NAME).get(replayId);
          req.onsuccess = () => resolve(req.result as StoredReplayEnvelope | undefined);
          req.onerror = () => resolve(this.memoryStore.get(replayId));
        } catch {
          resolve(this.memoryStore.get(replayId));
        }
      });
    }

    if (!envelope) return null;
    try {
      const shots = envelope.payload.shots.map(deserializeShot);
      return {
        ...envelope.payload,
        shots,
      };
    } catch {
      return null;
    }
  }

  public async deleteReplay(replayId: string): Promise<void> {
    await this.removeById(replayId);
  }

  public async clearAllReplays(): Promise<void> {
    this.memoryStore.clear();
    const db = await this.openDb();
    if (!db) return;
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  public async getStorageStats(): Promise<ReplayStorageStats> {
    const { envelopes, backend } = await this.getAllEnvelopes();
    const totalBytes = envelopes.reduce((acc, e) => acc + (e.byteSize || 0), 0);
    return {
      count: envelopes.length,
      maxCount: this.maxCount,
      totalBytes,
      maxBytes: this.maxBytes,
      backend,
    };
  }

  public exportReplayToJson(replay: MatchReplayRecord): string {
    const bundle = {
      format: 'ultimate-pool-3d-replay',
      version: REPLAY_FORMAT_VERSION,
      exportedAtMs: Date.now(),
      replay: {
        ...replay,
        // Imported copies are never treated as authoritative server proof
        authoritative: replay.authoritative,
        shots: replay.shots.map(serializeShot),
      },
    };
    return JSON.stringify(bundle);
  }

  public validateAndParseImportJson(jsonText: string): ReplayImportResult | ReplayImportError {
    if (typeof jsonText !== 'string' || jsonText.trim().length === 0) {
      return { ok: false, error: 'Replay file is empty.' };
    }
    if (jsonText.length > MAX_IMPORT_JSON_CHARS) {
      return { ok: false, error: 'Replay file exceeds maximum permitted size.' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return { ok: false, error: 'Corrupted replay JSON: unable to parse.' };
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'Invalid replay structure.' };
    }

    const root = parsed as Record<string, unknown>;
    if (root.format !== 'ultimate-pool-3d-replay') {
      return { ok: false, error: 'Unrecognized replay file format header.' };
    }
    if (root.version !== REPLAY_FORMAT_VERSION) {
      return { ok: false, error: `Unsupported replay format version: ${String(root.version)}.` };
    }

    const rawReplay = root.replay;
    if (!rawReplay || typeof rawReplay !== 'object' || Array.isArray(rawReplay)) {
      return { ok: false, error: 'Missing replay payload object.' };
    }
    const r = rawReplay as Record<string, unknown>;

    if (!Array.isArray(r.shots) || r.shots.length === 0 || r.shots.length > MAX_SHOTS_PER_REPLAY) {
      return {
        ok: false,
        error: 'Replay must contain between 1 and 200 valid recorded shots.',
      };
    }

    const matchType =
      r.matchType === 'ai' || r.matchType === 'online' || r.matchType === 'local'
        ? r.matchType
        : null;
    if (!matchType) {
      return { ok: false, error: 'Invalid replay match type.' };
    }

    const p1Raw = r.player1 as Record<string, unknown> | undefined;
    const p2Raw = r.player2 as Record<string, unknown> | undefined;
    if (!p1Raw || !p2Raw || typeof p1Raw !== 'object' || typeof p2Raw !== 'object') {
      return { ok: false, error: 'Replay player metadata is missing.' };
    }

    const shots: RecordedShot[] = [];
    for (let i = 0; i < r.shots.length; i++) {
      const s = r.shots[i] as Record<string, unknown>;
      if (!s || typeof s !== 'object' || Array.isArray(s)) {
        return { ok: false, error: `Corrupted shot entry at index ${i}.` };
      }
      if (
        !isFinitePositive(s.frameCount, MAX_FRAMES_PER_IMPORTED_SHOT) ||
        !Number.isInteger(s.frameCount) ||
        typeof s.framesBase64 !== 'string' ||
        s.framesBase64.length === 0 ||
        !isFinitePositive(s.durationSec, 300) ||
        !isFinitePositive(s.timestepSec, 1)
      ) {
        return { ok: false, error: `Invalid shot physics timing or frame buffer at shot #${i + 1}.` };
      }

      try {
        const framesData = decodeFramesFloat32(s.framesBase64, s.frameCount);
        const shooter = s.shooter === 'player2' ? 'player2' : 'player1';
        const shotMode = s.mode === 'ai' || s.mode === 'online' ? s.mode : 'local';
        const spinRaw = (s.spin ?? {}) as Record<string, unknown>;
        const spinX =
          typeof spinRaw.x === 'number' && Number.isFinite(spinRaw.x)
            ? Math.max(-0.78, Math.min(0.78, spinRaw.x))
            : 0;
        const spinY =
          typeof spinRaw.y === 'number' && Number.isFinite(spinRaw.y)
            ? Math.max(-0.78, Math.min(0.78, spinRaw.y))
            : 0;

        shots.push({
          id: sanitizeSafeString(s.id, `imp_shot_${i + 1}`, 80),
          shotNumber:
            typeof s.shotNumber === 'number' && Number.isInteger(s.shotNumber) && s.shotNumber > 0
              ? s.shotNumber
              : i + 1,
          recordedAtMs: isFiniteNonNeg(s.recordedAtMs) ? s.recordedAtMs : Date.now(),
          mode: shotMode,
          shooter,
          shooterName: sanitizeSafeString(s.shooterName, shooter === 'player1' ? 'Player 1' : 'Player 2', 32),
          isBreakShot: Boolean(s.isBreakShot),
          cueAngle:
            typeof s.cueAngle === 'number' && Number.isFinite(s.cueAngle) ? s.cueAngle : 0,
          power:
            typeof s.power === 'number' && Number.isFinite(s.power)
              ? Math.max(0.01, Math.min(1, s.power))
              : 0.5,
          spin: { x: spinX, y: spinY },
          calledShot: {
            targetBall:
              typeof (s.calledShot as Record<string, unknown> | undefined)?.targetBall === 'number'
                ? ((s.calledShot as Record<string, unknown>).targetBall as number)
                : null,
            targetPocket:
              typeof (s.calledShot as Record<string, unknown> | undefined)?.targetPocket === 'string'
                ? ((s.calledShot as Record<string, unknown>).targetPocket as RecordedShot['calledShot']['targetPocket'])
                : null,
          },
          durationSec: s.durationSec,
          timestepSec: s.timestepSec,
          frameCount: s.frameCount,
          framesData,
          collisions: Array.isArray(s.collisions)
            ? (s.collisions as RecordedShot['collisions']).slice(0, 120)
            : [],
          pocketedBalls: Array.isArray(s.pocketedBalls)
            ? (s.pocketedBalls as RecordedShot['pocketedBalls']).slice(0, 16)
            : [],
          trajectories: Array.isArray(s.trajectories)
            ? (s.trajectories as RecordedShot['trajectories']).slice(0, 16)
            : [],
          firstImpactTimeSec:
            typeof s.firstImpactTimeSec === 'number' && Number.isFinite(s.firstImpactTimeSec)
              ? s.firstImpactTimeSec
              : null,
          resultLabel: sanitizeSafeString(s.resultLabel, 'Shot Recorded', 100),
          isFoul: Boolean(s.isFoul),
          foulReason:
            typeof s.foulReason === 'string' ? sanitizeSafeString(s.foulReason, '', 100) : null,
          startMatchTimeSec:
            typeof s.startMatchTimeSec === 'number' && Number.isFinite(s.startMatchTimeSec)
              ? s.startMatchTimeSec
              : undefined,
          endMatchTimeSec:
            typeof s.endMatchTimeSec === 'number' && Number.isFinite(s.endMatchTimeSec)
              ? s.endMatchTimeSec
              : undefined,
          tableOpenAfter:
            typeof s.tableOpenAfter === 'boolean' ? s.tableOpenAfter : undefined,
          playerGroupsAfter:
            s.playerGroupsAfter && typeof s.playerGroupsAfter === 'object'
              ? (s.playerGroupsAfter as RecordedShot['playerGroupsAfter'])
              : undefined,
          pocketedNumbersAfter: Array.isArray(s.pocketedNumbersAfter)
            ? (s.pocketedNumbersAfter as number[]).filter(
                (n) => Number.isInteger(n) && n >= 1 && n <= 15,
              )
            : undefined,
          activePlayerAfter:
            s.activePlayerAfter === 'player1' || s.activePlayerAfter === 'player2'
              ? s.activePlayerAfter
              : undefined,
          ballInHandNext:
            typeof s.ballInHandNext === 'boolean' ? s.ballInHandNext : undefined,
        });
      } catch (err) {
        return {
          ok: false,
          error:
            err instanceof Error
              ? err.message
              : `Corrupted shot frame data at shot #${i + 1}.`,
        };
      }
    }

    let cursor = 0;
    for (const s of shots) {
      if (s.startMatchTimeSec === undefined) s.startMatchTimeSec = cursor;
      s.endMatchTimeSec = s.startMatchTimeSec + s.durationSec;
      cursor = s.endMatchTimeSec;
    }

    const matchId = sanitizeSafeString(r.matchId, `imported_${Date.now()}`, 80);
    const replayId = `imp_${matchId}_${Date.now().toString(36)}`;
    const winner =
      r.winner === 'player1' || r.winner === 'player2' ? r.winner : null;
    const loser =
      r.loser === 'player1' || r.loser === 'player2'
        ? r.loser
        : winner === 'player1'
          ? 'player2'
          : winner === 'player2'
            ? 'player1'
            : null;

    const record: MatchReplayRecord = {
      version: REPLAY_FORMAT_VERSION,
      replayId,
      matchId,
      createdAtMs: isFiniteNonNeg(r.createdAtMs) ? r.createdAtMs : Date.now(),
      endedAtMs: isFiniteNonNeg(r.endedAtMs) ? r.endedAtMs : Date.now(),
      durationSec: Number(cursor.toFixed(3)),
      matchType,
      onlineSubType:
        r.onlineSubType === 'ranked' ||
        r.onlineSubType === 'quick' ||
        r.onlineSubType === 'private' ||
        r.onlineSubType === 'tournament'
          ? r.onlineSubType
          : undefined,
      aiDifficulty:
        r.aiDifficulty === 'beginner' ||
        r.aiDifficulty === 'intermediate' ||
        r.aiDifficulty === 'pro' ||
        r.aiDifficulty === 'legend'
          ? r.aiDifficulty
          : undefined,
      gameMode: r.gameMode === 'freePlay' ? 'freePlay' : 'eightBall',
      ruleProfileId: r.ruleProfileId === 'wpa' ? 'wpa' : 'casual',
      calledShotsEnabled: Boolean(r.calledShotsEnabled),
      // SECURITY INVARIANT: imported JSON files are NEVER trusted as authoritative server matches
      authoritative: false,
      player1: {
        id: typeof p1Raw.id === 'string' ? sanitizeSafeString(p1Raw.id, '', 64) : null,
        name: sanitizeSafeString(p1Raw.name, 'Player 1', 32),
        group: p1Raw.group === 'solids' || p1Raw.group === 'stripes' ? p1Raw.group : null,
        pocketedCount: isFiniteNonNeg(p1Raw.pocketedCount, 15) ? p1Raw.pocketedCount : 0,
      },
      player2: {
        id: typeof p2Raw.id === 'string' ? sanitizeSafeString(p2Raw.id, '', 64) : null,
        name: sanitizeSafeString(p2Raw.name, 'Player 2', 32),
        group: p2Raw.group === 'solids' || p2Raw.group === 'stripes' ? p2Raw.group : null,
        pocketedCount: isFiniteNonNeg(p2Raw.pocketedCount, 15) ? p2Raw.pocketedCount : 0,
      },
      winner,
      loser,
      finalResult: sanitizeSafeString(r.finalResult, 'Imported Match Replay', 140),
      totalShots: shots.length,
      shots,
      timelineEvents: Array.isArray(r.timelineEvents)
        ? (r.timelineEvents as MatchReplayRecord['timelineEvents']).slice(0, 1000)
        : [],
      highlights: [],
      savedAtMs: Date.now(),
    };
    record.highlights = generateMatchHighlights(record);

    const summary = summarizeMatchReplay(record, jsonText.length);
    return { ok: true, replay: record, summary };
  }

  public async importReplayFromJson(jsonText: string): Promise<ReplayImportResult | ReplayImportError> {
    const parsed = this.validateAndParseImportJson(jsonText);
    if (!parsed.ok) return parsed;
    const summary = await this.saveReplay(parsed.replay);
    return { ok: true, replay: parsed.replay, summary };
  }
}

export const replayStorage = new ReplayStorageService();

export function downloadTextFile(filename: string, content: string, mime = 'application/json'): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return;
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
