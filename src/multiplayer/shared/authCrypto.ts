import { ONLINE_AVATARS, type OnlineAvatarId } from './protocol';

const VALID_AVATAR_IDS = new Set<OnlineAvatarId>(ONLINE_AVATARS.map((a) => a.id));
const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,20}$/;
const PBKDF2_ITERATIONS = 100_000;

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (typeof hex !== 'string' || hex.length === 0 || hex.length % 2 !== 0) {
    return null;
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    return null;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function generateRandomHexToken(byteLen = 24): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export function generatePlayerId(): string {
  return `ply_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) {
    diff |= ab[i] ^ bb[i];
  }
  return diff === 0;
}

export async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(digest));
}

export async function hashPasswordPBKDF2(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    256,
  );
  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${bytesToHex(salt)}$${bytesToHex(new Uint8Array(derived))}`;
}

export async function verifyPasswordPBKDF2(
  password: string,
  storedHash: string | null | undefined,
): Promise<boolean> {
  if (!storedHash || typeof storedHash !== 'string') return false;
  const parts = storedHash.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
  const iterations = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(iterations) || iterations < 10_000 || iterations > 500_000) {
    return false;
  }
  const salt = hexToBytes(parts[2]);
  const expectedHex = parts[3];
  if (!salt || !expectedHex) return false;

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt as unknown as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    256,
  );
  const derivedHex = bytesToHex(new Uint8Array(derived));
  return constantTimeEqual(derivedHex, expectedHex);
}

export function sanitizeDisplayName(raw: unknown): string {
  if (typeof raw !== 'string') return 'Player';
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F<>]/g, '')
    .trim()
    .slice(0, 16);
  return cleaned.length > 0 ? cleaned : 'Player';
}

export function sanitizeAvatarId(raw: unknown): OnlineAvatarId {
  if (typeof raw === 'string' && VALID_AVATAR_IDS.has(raw as OnlineAvatarId)) {
    return raw as OnlineAvatarId;
  }
  return 'cue_gold';
}

export function validateUsername(raw: unknown):
  | { valid: true; username: string; usernameLower: string }
  | { valid: false; error: string } {
  if (typeof raw !== 'string') {
    return { valid: false, error: 'Username is required.' };
  }
  const trimmed = raw.trim();
  if (!USERNAME_PATTERN.test(trimmed)) {
    return {
      valid: false,
      error: 'Username must be 3-20 characters using letters, numbers, _, ., or -.',
    };
  }
  return {
    valid: true,
    username: trimmed,
    usernameLower: trimmed.toLowerCase(),
  };
}

export function validatePassword(raw: unknown):
  | { valid: true; password: string }
  | { valid: false; error: string } {
  if (typeof raw !== 'string') {
    return { valid: false, error: 'Password is required.' };
  }
  if (raw.length < 6) {
    return { valid: false, error: 'Password must be at least 6 characters.' };
  }
  if (raw.length > 128) {
    return { valid: false, error: 'Password cannot exceed 128 characters.' };
  }
  return { valid: true, password: raw };
}

export function isValidPlayerIdFormat(raw: unknown): raw is string {
  return typeof raw === 'string' && /^ply_[a-zA-Z0-9_-]{6,40}$/.test(raw.trim());
}
