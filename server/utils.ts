import { ONLINE_AVATARS, type OnlineAvatarId } from '../src/multiplayer/shared/protocol';

export const ONLINE_AVARS_FALLBACK = new Set<OnlineAvatarId>(
  ONLINE_AVATARS.map((a) => a.id),
);
