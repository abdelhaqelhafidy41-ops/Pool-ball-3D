import type { PlayerId } from './types';

export interface TurnPlayerMeta {
  id: PlayerId;
  name: string;
  isAi: boolean;
}

export class TurnManager {
  private activePlayer: PlayerId = 'player1';

  public reset(startingPlayer: PlayerId = 'player1'): void {
    this.activePlayer = startingPlayer;
  }

  public getActivePlayer(): PlayerId {
    return this.activePlayer;
  }

  public resolveAfterShot(
    turnContinues: boolean,
    players: Record<PlayerId, TurnPlayerMeta>,
  ): { activePlayer: PlayerId; turnChanged: boolean; activeMeta: TurnPlayerMeta } {
    const previous = this.activePlayer;
    if (!turnContinues) {
      this.activePlayer = this.activePlayer === 'player1' ? 'player2' : 'player1';
    }
    return {
      activePlayer: this.activePlayer,
      turnChanged: this.activePlayer !== previous,
      activeMeta: players[this.activePlayer],
    };
  }
}
