import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { ALPHABET, MAX_CODE, RANDOM_LENGTH, normalizeCode } from '../public/codes.js';
import { applyCommand, isFinished, isValidSession } from '../public/timeline.js';

const DAY = 86_400_000;
const MIN_SECRET_LENGTH = 20;
export const MAX_NAME = 30;

export class StoreError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export const hashSecret = (secret) => createHash('sha256').update(String(secret)).digest('hex');

function randomChars(length) {
  let chars = '';
  for (let i = 0; i < length; i++) chars += ALPHABET[randomInt(ALPHABET.length)];
  return chars;
}

export const newCode = () => randomChars(RANDOM_LENGTH);

// PINNED_ROOMS="code:<sha256 of the editor secret>,...": rooms that exist from startup and never expire.
export function parsePinned(value) {
  return value.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [rawCode, hash] = entry.split(':');
    const code = normalizeCode(rawCode);
    if (!code || !/^[0-9a-f]{64}$/.test(hash ?? '')) throw new Error(`invalid PINNED_ROOMS entry: ${rawCode}`);
    return { code, hash };
  });
}

export function cleanName(value) {
  if (typeof value !== 'string') throw new StoreError('invalid');
  const name = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(name).slice(0, MAX_NAME).join('');
}

function pickSession(session) {
  if (!session || typeof session !== 'object') return session ?? null;
  const { focusMin, rounds, startedAt, pausedAt = null, pausedMs } = session;
  return { focusMin, rounds, startedAt, pausedAt, pausedMs };
}

export function createStore({ pinned = [], maxRooms = 200, ttlMs = 30 * DAY, now = Date.now } = {}) {
  const rooms = new Map();
  const listeners = new Map();
  for (const { code, hash } of pinned) {
    rooms.set(code, { code, hash, pinned: true, name: '', session: null, touchedAt: now() });
  }

  const openRooms = () => [...rooms.values()].filter((room) => !room.pinned).length;

  function notify(code) {
    const room = rooms.get(code) ?? null;
    for (const listener of listeners.get(code) ?? []) listener(room);
  }

  function authorized(room, secret) {
    return timingSafeEqual(Buffer.from(room.hash, 'hex'), Buffer.from(hashSecret(secret), 'hex'));
  }

  function add(code, hash) {
    if (openRooms() >= maxRooms) throw new StoreError('full');
    const room = { code, hash, pinned: false, name: '', session: null, touchedAt: now() };
    rooms.set(code, room);
    return room;
  }

  return {
    get: (code) => rooms.get(code),

    create(requested) {
      let code;
      if (requested == null || requested === '') {
        do code = newCode(); while (rooms.has(code));
      } else {
        code = normalizeCode(requested);
        if (!code) throw new StoreError('invalid');
        if (rooms.has(code)) throw new StoreError('taken');
      }
      const secret = randomBytes(24).toString('base64url');
      add(code, hashSecret(secret));
      return { code, secret };
    },

    // e.g. focus -> focus-k7f; trims first so the result still fits MAX_CODE.
    suggest(requested) {
      const base = normalizeCode(requested);
      if (!base) return null;
      let code;
      do code = `${base.slice(0, MAX_CODE - 4).replace(/-$/, '')}-${randomChars(3)}`; while (rooms.has(code));
      return code;
    },

    command(code, secret, command) {
      const room = rooms.get(code);
      if (!room) throw new StoreError('not_found');
      if (!authorized(room, secret)) throw new StoreError('forbidden');
      if (command?.action === 'rename') {
        room.name = cleanName(command.name);
      } else {
        try {
          room.session = applyCommand(room.session, command, now());
        } catch {
          throw new StoreError('invalid');
        }
      }
      room.touchedAt = now();
      notify(code);
      return room;
    },

    // After a restart the server has forgotten its rooms: each editor recreates its own
    // and hands back its session and name.
    restore(code, secret, session, name = '') {
      const clean = pickSession(session);
      if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH || !isValidSession(clean, now())) {
        throw new StoreError('invalid');
      }
      let room = rooms.get(code);
      if (room && !authorized(room, secret)) throw new StoreError('taken');
      room ??= add(code, hashSecret(secret));
      if (isFinished(room.session, now()) && !isFinished(clean, now())) room.session = clean;
      if (!room.name && typeof name === 'string') room.name = cleanName(name);
      room.touchedAt = now();
      notify(code);
      return room;
    },

    sweep() {
      const limit = now() - ttlMs;
      for (const room of rooms.values()) {
        if (!room.pinned && room.touchedAt < limit) {
          rooms.delete(room.code);
          notify(room.code);
        }
      }
    },

    subscribe(code, listener) {
      if (!listeners.has(code)) listeners.set(code, new Set());
      listeners.get(code).add(listener);
      return () => {
        const set = listeners.get(code);
        set?.delete(listener);
        if (set?.size === 0) listeners.delete(code);
      };
    },
  };
}
