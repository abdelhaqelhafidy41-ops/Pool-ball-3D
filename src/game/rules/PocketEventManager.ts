import type { PocketEvent, PocketId } from './types';

export class PocketEventManager {
  private currentShotId = 0;
  private events: PocketEvent[] = [];

  public startShot(shotId: number): void {
    this.currentShotId = shotId;
    this.events = [];
  }

  public recordPocket(ballNumber: number, pocketId: PocketId): PocketEvent | null {
    if (this.events.some((e) => e.ballNumber === ballNumber)) return null;
    const evt: PocketEvent = {
      shotId: this.currentShotId,
      ballNumber,
      pocketId,
      order: this.events.length + 1,
      timestampMs: Date.now(),
    };
    this.events.push(evt);
    return evt;
  }

  public getEvents(): PocketEvent[] {
    return this.events.map((e) => ({ ...e }));
  }
}
