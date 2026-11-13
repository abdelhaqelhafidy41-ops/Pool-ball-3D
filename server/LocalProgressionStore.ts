import type { PlayerId, RuleProfileId } from '../src/game/rules/types';
import {
  constantTimeEqual,
  generatePlayerId,
  generateRandomHexToken,
  hashPasswordPBKDF2,
  isValidPlayerIdFormat,
  sanitizeAvatarId,
  sanitizeDisplayName,
  sha256Hex,
  validatePassword,
  validateUsername,
  verifyPasswordPBKDF2,
} from '../src/multiplayer/shared/authCrypto';
import {
  ACHIEVEMENT_MAP,
  calculateEloUpdate,
  calculateLevelFromXp,
  computeBaseMatchXp,
  ELO_CONFIG,
  evaluateUnlockedAchievements,
  type LeaderboardEntry,
  type LeaderboardResponse,
  type LeaderboardScope,
  type MatchProgressionRewardSummary,
  type MatchTelemetrySummaryForProgression,
  type OnlineMatchType,
  type PlayerProgressionDelta,
  type PlayerSearchResult,
  type PublicPlayerProfile,
  type UnlockedAchievement,
} from '../src/multiplayer/shared/progression';
import type { MatchHistoryRecord, OnlineAvatarId } from '../src/multiplayer/shared/protocol';

interface LocalPlayerRecord {
  playerId: string;
  username: string | null;
  usernameLower: string | null;
  displayName: string;
  avatarId: OnlineAvatarId;
  passwordHash: string | null;
  authTokenHash: string;
  isGuest: boolean;
  elo: number;
  peakElo: number;
  xp: number;
  level: number;
  totalMatches: number;
  wins: number;
  losses: number;
  currentStreak: number;
  bestStreak: number;
  totalShots: number;
  successfulShots: number;
  ballsPocketed: number;
  fouls: number;
  breaksAttempted: number;
  breaksSuccessful: number;
  eightBallWins: number;
  totalMatchDurationSec: number;
  casualMatches: number;
  casualWins: number;
  wpaMatches: number;
  wpaWins: number;
  quickMatches: number;
  quickWins: number;
  privateMatches: number;
  privateWins: number;
  createdAtMs: number;
  updatedAtMs: number;
  lastMatchAtMs: number | null;
}

interface LocalRatingEvent {
  matchId: string;
  playerId: string;
  eloBefore: number;
  eloAfter: number;
  eloDelta: number;
  xpGained: number;
  won: boolean;
  createdAtMs: number;
}

export type LocalAuthResult = {
  ok: true;
  playerId: string;
  playerToken: string;
  profile: PublicPlayerProfile;
};

export type LocalErrorResult = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

export class LocalProgressionStore {
  private players = new Map<string, LocalPlayerRecord>();
  private usernameIndex = new Map<string, string>();
  private achievements = new Map<string, Map<string, number>>();
  private matches = new Map<string, MatchHistoryRecord>();
  private matchOrder: string[] = [];
  private ratingEvents: LocalRatingEvent[] = [];

  public async authenticateOrCreatePlayer(input: {
    playerId?: string | null;
    playerToken?: string | null;
    displayName?: string | null;
    avatarId?: string | null;
    forceNewGuest?: boolean;
  }): Promise<LocalAuthResult> {
    const safeName = sanitizeDisplayName(input.displayName);
    const safeAvatar = sanitizeAvatarId(input.avatarId);

    if (
      !input.forceNewGuest &&
      isValidPlayerIdFormat(input.playerId) &&
      typeof input.playerToken === 'string' &&
      input.playerToken.length >= 16
    ) {
      const existing = this.players.get(input.playerId.trim());
      if (existing) {
        const providedHash = await sha256Hex(input.playerToken.trim());
        if (constantTimeEqual(providedHash, existing.authTokenHash)) {
          if (input.displayName) existing.displayName = safeName;
          if (input.avatarId) existing.avatarId = safeAvatar;
          existing.updatedAtMs = Date.now();
          return {
            ok: true,
            playerId: existing.playerId,
            playerToken: input.playerToken.trim(),
            profile: (await this.getPublicProfile(existing.playerId))!,
          };
        }
      }
    }

    const now = Date.now();
    const playerId = generatePlayerId();
    const playerToken = generateRandomHexToken(24);
    const tokenHash = await sha256Hex(playerToken);

    const record: LocalPlayerRecord = {
      playerId,
      username: null,
      usernameLower: null,
      displayName: safeName,
      avatarId: safeAvatar,
      passwordHash: null,
      authTokenHash: tokenHash,
      isGuest: true,
      elo: ELO_CONFIG.initialElo,
      peakElo: ELO_CONFIG.initialElo,
      xp: 0,
      level: 1,
      totalMatches: 0,
      wins: 0,
      losses: 0,
      currentStreak: 0,
      bestStreak: 0,
      totalShots: 0,
      successfulShots: 0,
      ballsPocketed: 0,
      fouls: 0,
      breaksAttempted: 0,
      breaksSuccessful: 0,
      eightBallWins: 0,
      totalMatchDurationSec: 0,
      casualMatches: 0,
      casualWins: 0,
      wpaMatches: 0,
      wpaWins: 0,
      quickMatches: 0,
      quickWins: 0,
      privateMatches: 0,
      privateWins: 0,
      createdAtMs: now,
      updatedAtMs: now,
      lastMatchAtMs: null,
    };

    this.players.set(playerId, record);
    return {
      ok: true,
      playerId,
      playerToken,
      profile: (await this.getPublicProfile(playerId))!,
    };
  }

  public async ensureRowForExternalId(
    playerId: string,
    displayName: string,
    avatarId: OnlineAvatarId,
  ): Promise<LocalPlayerRecord> {
    const existing = this.players.get(playerId);
    if (existing) return existing;

    const now = Date.now();
    const record: LocalPlayerRecord = {
      playerId,
      username: null,
      usernameLower: null,
      displayName: sanitizeDisplayName(displayName),
      avatarId: sanitizeAvatarId(avatarId),
      passwordHash: null,
      authTokenHash: await sha256Hex(generateRandomHexToken(24)),
      isGuest: true,
      elo: ELO_CONFIG.initialElo,
      peakElo: ELO_CONFIG.initialElo,
      xp: 0,
      level: 1,
      totalMatches: 0,
      wins: 0,
      losses: 0,
      currentStreak: 0,
      bestStreak: 0,
      totalShots: 0,
      successfulShots: 0,
      ballsPocketed: 0,
      fouls: 0,
      breaksAttempted: 0,
      breaksSuccessful: 0,
      eightBallWins: 0,
      totalMatchDurationSec: 0,
      casualMatches: 0,
      casualWins: 0,
      wpaMatches: 0,
      wpaWins: 0,
      quickMatches: 0,
      quickWins: 0,
      privateMatches: 0,
      privateWins: 0,
      createdAtMs: now,
      updatedAtMs: now,
      lastMatchAtMs: null,
    };
    this.players.set(playerId, record);
    return record;
  }

  public async verifyPlayerToken(playerId: string, playerToken: string): Promise<boolean> {
    if (!isValidPlayerIdFormat(playerId) || typeof playerToken !== 'string' || playerToken.length < 16) {
      return false;
    }
    const existing = this.players.get(playerId.trim());
    if (!existing) return false;
    const providedHash = await sha256Hex(playerToken.trim());
    return constantTimeEqual(providedHash, existing.authTokenHash);
  }

  public async updatePlayerProfile(
    playerId: string,
    playerToken: string,
    updates: { displayName?: unknown; avatarId?: unknown },
  ): Promise<{ ok: true; profile: PublicPlayerProfile } | LocalErrorResult> {
    if (!(await this.verifyPlayerToken(playerId, playerToken))) {
      return {
        ok: false,
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Invalid or missing player credentials.',
      };
    }
    const existing = this.players.get(playerId);
    if (!existing) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Player profile not found.' };
    }
    if (updates.displayName !== undefined) {
      existing.displayName = sanitizeDisplayName(updates.displayName);
    }
    if (updates.avatarId !== undefined) {
      existing.avatarId = sanitizeAvatarId(updates.avatarId);
    }
    existing.updatedAtMs = Date.now();
    return { ok: true, profile: (await this.getPublicProfile(playerId))! };
  }

  public async updateProfileInternal(
    playerId: string,
    displayName: string,
    avatarId: OnlineAvatarId,
  ): Promise<void> {
    const existing = this.players.get(playerId);
    if (!existing) return;
    existing.displayName = sanitizeDisplayName(displayName);
    existing.avatarId = sanitizeAvatarId(avatarId);
    existing.updatedAtMs = Date.now();
  }

  public async registerAccount(
    playerId: string,
    playerToken: string,
    input: {
      username: unknown;
      password: unknown;
      displayName?: unknown;
      avatarId?: unknown;
    },
  ): Promise<LocalAuthResult | LocalErrorResult> {
    if (!(await this.verifyPlayerToken(playerId, playerToken))) {
      return {
        ok: false,
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Authenticate your active session before claiming a username.',
      };
    }
    const userCheck = validateUsername(input.username);
    if (!userCheck.valid) {
      return { ok: false, status: 400, code: 'INVALID_INPUT', message: userCheck.error };
    }
    const passCheck = validatePassword(input.password);
    if (!passCheck.valid) {
      return { ok: false, status: 400, code: 'INVALID_INPUT', message: passCheck.error };
    }

    const takenBy = this.usernameIndex.get(userCheck.usernameLower);
    if (takenBy && takenBy !== playerId) {
      return {
        ok: false,
        status: 409,
        code: 'USERNAME_TAKEN',
        message: 'That username is already registered to another competitor.',
      };
    }

    const existing = this.players.get(playerId);
    if (!existing) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Player profile not found.' };
    }
    if (!existing.isGuest && existing.usernameLower && existing.usernameLower !== userCheck.usernameLower) {
      return {
        ok: false,
        status: 409,
        code: 'ALREADY_REGISTERED',
        message: 'This account already has a registered username.',
      };
    }

    const passwordHash = await hashPasswordPBKDF2(passCheck.password);
    const nextToken = generateRandomHexToken(24);
    existing.username = userCheck.username;
    existing.usernameLower = userCheck.usernameLower;
    existing.passwordHash = passwordHash;
    existing.authTokenHash = await sha256Hex(nextToken);
    existing.isGuest = false;
    if (input.displayName !== undefined) {
      existing.displayName = sanitizeDisplayName(input.displayName);
    } else if (existing.displayName === 'Player') {
      existing.displayName = sanitizeDisplayName(userCheck.username);
    }
    if (input.avatarId !== undefined) {
      existing.avatarId = sanitizeAvatarId(input.avatarId);
    }
    existing.updatedAtMs = Date.now();
    this.usernameIndex.set(userCheck.usernameLower, playerId);

    return {
      ok: true,
      playerId,
      playerToken: nextToken,
      profile: (await this.getPublicProfile(playerId))!,
    };
  }

  public async loginAccount(input: {
    username: unknown;
    password: unknown;
  }): Promise<LocalAuthResult | LocalErrorResult> {
    const userCheck = validateUsername(input.username);
    if (!userCheck.valid) {
      return { ok: false, status: 400, code: 'INVALID_INPUT', message: userCheck.error };
    }
    if (typeof input.password !== 'string' || input.password.length === 0) {
      return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'Password is required.' };
    }
    const targetId = this.usernameIndex.get(userCheck.usernameLower);
    const row = targetId ? this.players.get(targetId) : undefined;
    if (!row || !row.passwordHash) {
      return {
        ok: false,
        status: 401,
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid username or password.',
      };
    }
    const ok = await verifyPasswordPBKDF2(input.password, row.passwordHash);
    if (!ok) {
      return {
        ok: false,
        status: 401,
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid username or password.',
      };
    }

    const freshToken = generateRandomHexToken(24);
    row.authTokenHash = await sha256Hex(freshToken);
    row.updatedAtMs = Date.now();
    return {
      ok: true,
      playerId: row.playerId,
      playerToken: freshToken,
      profile: (await this.getPublicProfile(row.playerId))!,
    };
  }

  private getSortedAllPlayers(): LocalPlayerRecord[] {
    return Array.from(this.players.values()).sort((a, b) => {
      if (b.elo !== a.elo) return b.elo - a.elo;
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (a.totalMatches !== b.totalMatches) return a.totalMatches - b.totalMatches;
      return a.createdAtMs - b.createdAtMs;
    });
  }

  public async getPublicProfile(playerId: string): Promise<PublicPlayerProfile | null> {
    if (!isValidPlayerIdFormat(playerId)) return null;
    const row = this.players.get(playerId.trim());
    if (!row) return null;

    const sorted = this.getSortedAllPlayers();
    const rankIdx = sorted.findIndex((p) => p.playerId === row.playerId);
    const achMap = this.achievements.get(row.playerId);
    const unlocked: UnlockedAchievement[] = [];
    if (achMap) {
      for (const [achId, ts] of achMap.entries()) {
        const def = ACHIEVEMENT_MAP.get(achId);
        if (def) unlocked.push({ ...def, unlockedAtMs: ts });
      }
      unlocked.sort((a, b) => b.unlockedAtMs - a.unlockedAtMs);
    }

    const levelProgress = calculateLevelFromXp(row.xp);
    return {
      playerId: row.playerId,
      username: row.username,
      displayName: row.displayName,
      avatarId: row.avatarId,
      isGuest: row.isGuest,
      elo: row.elo,
      peakElo: row.peakElo,
      xp: row.xp,
      level: levelProgress.level,
      levelProgress,
      rank: rankIdx >= 0 ? rankIdx + 1 : null,
      stats: {
        totalMatches: row.totalMatches,
        wins: row.wins,
        losses: row.losses,
        winRate:
          row.totalMatches > 0
            ? Math.round((row.wins / row.totalMatches) * 1000) / 10
            : 0,
        currentStreak: row.currentStreak,
        bestStreak: row.bestStreak,
        totalShots: row.totalShots,
        successfulShots: row.successfulShots,
        ballsPocketed: row.ballsPocketed,
        fouls: row.fouls,
        breaksAttempted: row.breaksAttempted,
        breaksSuccessful: row.breaksSuccessful,
        breakSuccessRate:
          row.breaksAttempted > 0
            ? Math.round((row.breaksSuccessful / row.breaksAttempted) * 1000) / 10
            : 0,
        eightBallWins: row.eightBallWins,
        avgMatchDurationSec:
          row.totalMatches > 0 ? Math.round(row.totalMatchDurationSec / row.totalMatches) : 0,
        byMatchType: {
          casual: { matches: row.casualMatches, wins: row.casualWins },
          wpa: { matches: row.wpaMatches, wins: row.wpaWins },
          quick: { matches: row.quickMatches, wins: row.quickWins },
          private: { matches: row.privateMatches, wins: row.privateWins },
        },
      },
      achievements: unlocked,
      createdAtMs: row.createdAtMs,
      lastMatchAtMs: row.lastMatchAtMs,
    };
  }

  public async searchPlayers(query: string, limit = 15): Promise<PlayerSearchResult[]> {
    const cleaned = query.trim().toLowerCase();
    const safeLimit = Math.max(1, Math.min(30, limit));
    const sorted = this.getSortedAllPlayers();
    const filtered = cleaned
      ? sorted.filter(
          (p) =>
            (p.usernameLower && p.usernameLower.includes(cleaned)) ||
            p.displayName.toLowerCase().includes(cleaned) ||
            p.playerId === query.trim(),
        )
      : sorted;

    return filtered.slice(0, safeLimit).map((p) => ({
      playerId: p.playerId,
      username: p.username,
      displayName: p.displayName,
      avatarId: p.avatarId,
      elo: p.elo,
      level: p.level,
      wins: p.wins,
      totalMatches: p.totalMatches,
    }));
  }

  public async getLeaderboard(params: {
    scope: LeaderboardScope;
    page?: number;
    limit?: number;
    query?: string;
    currentPlayerId?: string | null;
  }): Promise<LeaderboardResponse> {
    const page = Math.max(1, Math.floor(params.page ?? 1));
    const limit = Math.max(1, Math.min(50, Math.floor(params.limit ?? 20)));
    const offset = (page - 1) * limit;
    const searchClean = (params.query ?? '').trim().toLowerCase();

    if (params.scope === 'global') {
      const sorted = this.getSortedAllPlayers();
      const filtered = searchClean
        ? sorted.filter(
            (p) =>
              (p.usernameLower && p.usernameLower.includes(searchClean)) ||
              p.displayName.toLowerCase().includes(searchClean),
          )
        : sorted;
      const total = filtered.length;
      const totalPages = Math.max(1, Math.ceil(total / limit));
      const items: LeaderboardEntry[] = filtered.slice(offset, offset + limit).map((p, idx) => ({
        rank: offset + idx + 1,
        playerId: p.playerId,
        username: p.username,
        displayName: p.displayName,
        avatarId: p.avatarId,
        isGuest: p.isGuest,
        elo: p.elo,
        periodDelta: 0,
        level: p.level,
        wins: p.wins,
        losses: p.losses,
        totalMatches: p.totalMatches,
        winRate: p.totalMatches > 0 ? Math.round((p.wins / p.totalMatches) * 1000) / 10 : 0,
      }));

      let currentPlayer: LeaderboardEntry | null = null;
      if (params.currentPlayerId) {
        const rankIdx = sorted.findIndex((p) => p.playerId === params.currentPlayerId);
        if (rankIdx >= 0) {
          const p = sorted[rankIdx];
          currentPlayer = {
            rank: rankIdx + 1,
            playerId: p.playerId,
            username: p.username,
            displayName: p.displayName,
            avatarId: p.avatarId,
            isGuest: p.isGuest,
            elo: p.elo,
            periodDelta: 0,
            level: p.level,
            wins: p.wins,
            losses: p.losses,
            totalMatches: p.totalMatches,
            winRate: p.totalMatches > 0 ? Math.round((p.wins / p.totalMatches) * 1000) / 10 : 0,
          };
        }
      }

      return { scope: params.scope, page, limit, total, totalPages, items, currentPlayer };
    }

    const windowMs = params.scope === 'weekly' ? 7 * 86400_000 : 30 * 86400_000;
    const cutoff = Date.now() - windowMs;
    const agg = new Map<string, { delta: number; wins: number; matches: number }>();

    for (const ev of this.ratingEvents) {
      if (ev.createdAtMs < cutoff) continue;
      const entry = agg.get(ev.playerId) ?? { delta: 0, wins: 0, matches: 0 };
      entry.delta += ev.eloDelta;
      if (ev.won) entry.wins += 1;
      entry.matches += 1;
      agg.set(ev.playerId, entry);
    }

    const allRanked = Array.from(agg.entries())
      .map(([pid, stats]) => ({ player: this.players.get(pid)!, stats }))
      .filter((x) => Boolean(x.player))
      .sort((a, b) => {
        if (b.stats.delta !== a.stats.delta) return b.stats.delta - a.stats.delta;
        if (b.stats.wins !== a.stats.wins) return b.stats.wins - a.stats.wins;
        return b.player.elo - a.player.elo;
      });

    const filtered = searchClean
      ? allRanked.filter(
          ({ player }) =>
            (player.usernameLower && player.usernameLower.includes(searchClean)) ||
            player.displayName.toLowerCase().includes(searchClean),
        )
      : allRanked;

    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const items: LeaderboardEntry[] = filtered
      .slice(offset, offset + limit)
      .map(({ player, stats }, idx) => ({
        rank: offset + idx + 1,
        playerId: player.playerId,
        username: player.username,
        displayName: player.displayName,
        avatarId: player.avatarId,
        isGuest: player.isGuest,
        elo: player.elo,
        periodDelta: stats.delta,
        level: player.level,
        wins: stats.wins,
        losses: Math.max(0, stats.matches - stats.wins),
        totalMatches: stats.matches,
        winRate: stats.matches > 0 ? Math.round((stats.wins / stats.matches) * 1000) / 10 : 0,
      }));

    let currentPlayer: LeaderboardEntry | null = null;
    if (params.currentPlayerId) {
      const idx = allRanked.findIndex((x) => x.player.playerId === params.currentPlayerId);
      if (idx >= 0) {
        const { player, stats } = allRanked[idx];
        currentPlayer = {
          rank: idx + 1,
          playerId: player.playerId,
          username: player.username,
          displayName: player.displayName,
          avatarId: player.avatarId,
          isGuest: player.isGuest,
          elo: player.elo,
          periodDelta: stats.delta,
          level: player.level,
          wins: stats.wins,
          losses: Math.max(0, stats.matches - stats.wins),
          totalMatches: stats.matches,
          winRate: stats.matches > 0 ? Math.round((stats.wins / stats.matches) * 1000) / 10 : 0,
        };
      }
    }

    return { scope: params.scope, page, limit, total, totalPages, items, currentPlayer };
  }

  public async getMatchHistory(params: {
    playerId?: string | null;
    limit?: number;
  }): Promise<MatchHistoryRecord[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(params.limit ?? 30)));
    const list: MatchHistoryRecord[] = [];
    for (const id of this.matchOrder) {
      const m = this.matches.get(id);
      if (!m) continue;
      if (
        params.playerId &&
        m.player1Id !== params.playerId &&
        m.player2Id !== params.playerId
      ) {
        continue;
      }
      list.push(m);
      if (list.length >= safeLimit) break;
    }
    return list;
  }

  public async recordCompletedMatch(input: {
    matchId: string;
    roomId: string;
    roomCode: string;
    ruleProfileId: RuleProfileId;
    matchType: OnlineMatchType;
    winnerRole: PlayerId;
    reason: string;
    totalShots: number;
    endedAtMs: number;
    player1: { playerId: string; displayName: string; avatarId: OnlineAvatarId };
    player2: { playerId: string; displayName: string; avatarId: OnlineAvatarId };
    telemetry: MatchTelemetrySummaryForProgression;
  }): Promise<{
    alreadyRecorded: boolean;
    summary: MatchProgressionRewardSummary;
  }> {
    const p1 = await this.ensureRowForExternalId(
      input.player1.playerId,
      input.player1.displayName,
      input.player1.avatarId,
    );
    const p2 = await this.ensureRowForExternalId(
      input.player2.playerId,
      input.player2.displayName,
      input.player2.avatarId,
    );

    const sameAccount = p1.playerId === p2.playerId;
    const rankedApplied = input.telemetry.rankedValid && !sameAccount;

    if (this.matches.has(input.matchId)) {
      return {
        alreadyRecorded: true,
        summary: {
          matchId: input.matchId,
          rankedApplied,
          durationSec: input.telemetry.durationSec,
          players: {
            player1: {
              playerId: p1.playerId,
              role: 'player1',
              eloBefore: p1.elo,
              eloAfter: p1.elo,
              eloDelta: 0,
              xpBefore: p1.xp,
              xpAfter: p1.xp,
              xpGained: 0,
              levelBefore: p1.level,
              levelAfter: p1.level,
              unlockedAchievements: [],
            },
            player2: {
              playerId: p2.playerId,
              role: 'player2',
              eloBefore: p2.elo,
              eloAfter: p2.elo,
              eloDelta: 0,
              xpBefore: p2.xp,
              xpAfter: p2.xp,
              xpGained: 0,
              levelBefore: p2.level,
              levelAfter: p2.level,
              unlockedAchievements: [],
            },
          },
        },
      };
    }

    const eloCalc = rankedApplied
      ? calculateEloUpdate({
          player1Elo: p1.elo,
          player2Elo: p2.elo,
          player1Matches: p1.totalMatches,
          player2Matches: p2.totalMatches,
          winnerRole: input.winnerRole,
        })
      : {
          player1After: p1.elo,
          player2After: p2.elo,
          player1Delta: 0,
          player2Delta: 0,
        };

    const winnerId = input.winnerRole === 'player1' ? p1.playerId : p2.playerId;
    const winnerName =
      input.winnerRole === 'player1' ? input.player1.displayName : input.player2.displayName;

    const historyRecord: MatchHistoryRecord = {
      matchId: input.matchId,
      roomId: input.roomId,
      player1Id: p1.playerId,
      player2Id: p2.playerId,
      player1Name: sanitizeDisplayName(input.player1.displayName),
      player2Name: sanitizeDisplayName(input.player2.displayName),
      player1Avatar: sanitizeAvatarId(input.player1.avatarId),
      player2Avatar: sanitizeAvatarId(input.player2.avatarId),
      winnerId,
      winnerName,
      winnerRole: input.winnerRole,
      ruleProfileId: input.ruleProfileId,
      matchType: input.matchType,
      completionType: input.telemetry.completionType,
      rankedApplied,
      p1EloDelta: eloCalc.player1Delta,
      p2EloDelta: eloCalc.player2Delta,
      durationSec: input.telemetry.durationSec,
      reason: input.reason,
      totalShots: input.totalShots,
      endedAtMs: input.endedAtMs,
    };

    this.matches.set(input.matchId, historyRecord);
    this.matchOrder.unshift(input.matchId);

    const applySide = (
      role: PlayerId,
      row: LocalPlayerRecord,
      eloAfter: number,
      eloDelta: number,
    ): PlayerProgressionDelta => {
      if (!rankedApplied) {
        return {
          playerId: row.playerId,
          role,
          eloBefore: row.elo,
          eloAfter: row.elo,
          eloDelta: 0,
          xpBefore: row.xp,
          xpAfter: row.xp,
          xpGained: 0,
          levelBefore: row.level,
          levelAfter: row.level,
          unlockedAchievements: [],
        };
      }

      const won = input.winnerRole === role;
      const sideTel = role === 'player1' ? input.telemetry.player1 : input.telemetry.player2;
      const eloBefore = row.elo;
      const xpBefore = row.xp;
      const levelBefore = calculateLevelFromXp(xpBefore).level;

      row.elo = eloAfter;
      row.peakElo = Math.max(row.peakElo, eloAfter);
      row.totalMatches += 1;
      if (won) {
        row.wins += 1;
        row.currentStreak += 1;
        row.bestStreak = Math.max(row.bestStreak, row.currentStreak);
      } else {
        row.losses += 1;
        row.currentStreak = 0;
      }

      row.totalShots += sideTel.shotsTaken;
      row.successfulShots += sideTel.successfulShots;
      row.ballsPocketed += sideTel.ballsPocketed;
      row.fouls += sideTel.fouls;
      row.breaksAttempted += sideTel.breaksAttempted;
      row.breaksSuccessful += sideTel.breaksSuccessful;
      if (sideTel.legalEightBallWin) row.eightBallWins += 1;
      row.totalMatchDurationSec += input.telemetry.durationSec;

      if (input.ruleProfileId === 'casual') {
        row.casualMatches += 1;
        if (won) row.casualWins += 1;
      } else {
        row.wpaMatches += 1;
        if (won) row.wpaWins += 1;
      }

      if (input.matchType === 'quick') {
        row.quickMatches += 1;
        if (won) row.quickWins += 1;
      } else {
        row.privateMatches += 1;
        if (won) row.privateWins += 1;
      }

      let achMap = this.achievements.get(row.playerId);
      if (!achMap) {
        achMap = new Map<string, number>();
        this.achievements.set(row.playerId, achMap);
      }

      const newAchs = evaluateUnlockedAchievements({
        totalMatches: row.totalMatches,
        wins: row.wins,
        bestStreak: row.bestStreak,
        ballsPocketed: row.ballsPocketed,
        breaksSuccessful: row.breaksSuccessful,
        eightBallWins: row.eightBallWins,
        comebackWinInMatch: sideTel.comebackWin,
        alreadyUnlockedIds: new Set(achMap.keys()),
      });

      const unlockedList: UnlockedAchievement[] = [];
      let achBonus = 0;
      for (const a of newAchs) {
        if (!achMap.has(a.id)) {
          achMap.set(a.id, input.endedAtMs);
          achBonus += a.rewardXp;
          unlockedList.push({ ...a, unlockedAtMs: input.endedAtMs });
        }
      }

      const baseXp = computeBaseMatchXp({
        won,
        shotsTaken: sideTel.shotsTaken,
        successfulShots: sideTel.successfulShots,
        ballsPocketed: sideTel.ballsPocketed,
        fouls: sideTel.fouls,
        breaksAttempted: sideTel.breaksAttempted,
        breaksSuccessful: sideTel.breaksSuccessful,
        legalEightBallWin: sideTel.legalEightBallWin,
        comebackWin: sideTel.comebackWin,
        newWinStreak: row.currentStreak,
        ruleProfileId: input.ruleProfileId,
        validCompetitiveMatch: true,
      });

      const xpGained = baseXp + achBonus;
      row.xp += xpGained;
      row.level = calculateLevelFromXp(row.xp).level;
      row.updatedAtMs = input.endedAtMs;
      row.lastMatchAtMs = input.endedAtMs;

      this.ratingEvents.push({
        matchId: input.matchId,
        playerId: row.playerId,
        eloBefore,
        eloAfter,
        eloDelta,
        xpGained,
        won,
        createdAtMs: input.endedAtMs,
      });

      return {
        playerId: row.playerId,
        role,
        eloBefore,
        eloAfter,
        eloDelta,
        xpBefore,
        xpAfter: row.xp,
        xpGained,
        levelBefore,
        levelAfter: row.level,
        unlockedAchievements: unlockedList,
      };
    };

    const p1Delta = applySide('player1', p1, eloCalc.player1After, eloCalc.player1Delta);
    const p2Delta = applySide('player2', p2, eloCalc.player2After, eloCalc.player2Delta);

    return {
      alreadyRecorded: false,
      summary: {
        matchId: input.matchId,
        rankedApplied,
        durationSec: input.telemetry.durationSec,
        players: {
          player1: p1Delta,
          player2: p2Delta,
        },
      },
    };
  }
}
