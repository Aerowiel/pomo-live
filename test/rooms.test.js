import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCode, normalizeCode } from '../public/codes.js';
import { createStore, hashSecret, MAX_NAME, parsePinned } from '../lib/rooms.js';
import { createRateLimiter } from '../lib/rate-limit.js';

const MIN = 60_000;
const DAY = 86_400_000;
const SECRET = 'a-long-enough-editor-secret';

function clock(t = Date.UTC(2026, 8, 29, 9)) {
  const now = () => now.t;
  now.t = t;
  return now;
}

test('codes are normalized, validated and formatted', () => {
  assert.equal(normalizeCode('k7f-2qm'), 'K7F2QM');
  assert.equal(normalizeCode(' K7F 2QM '), 'K7F2QM');
  assert.equal(normalizeCode('K7F-2QO'), null);
  assert.equal(normalizeCode('K7F2Q'), null);
  assert.equal(normalizeCode(null), null);
  assert.equal(formatCode('K7F2QM'), 'K7F-2QM');
});

test('only the editor secret can drive a room', () => {
  const store = createStore({ now: clock() });
  const { code, secret } = store.create();
  assert.ok(normalizeCode(code));
  store.command(code, secret, { action: 'start', focusMin: 25, rounds: 4 });
  assert.equal(store.get(code).session.rounds, 4);
  assert.throws(() => store.command(code, 'wrong', { action: 'stop' }), { code: 'forbidden' });
  assert.throws(() => store.command('ZZZZZZ', secret, { action: 'stop' }), { code: 'not_found' });
  assert.throws(() => store.command(code, secret, { action: 'start', focusMin: 1, rounds: 1 }), { code: 'invalid' });
  assert.throws(() => store.command(code, secret, null), { code: 'invalid' });
});

test('subscribers hear about every change', () => {
  const store = createStore({ now: clock() });
  const { code, secret } = store.create();
  const seen = [];
  const unsubscribe = store.subscribe(code, (room) => seen.push(room.session?.rounds ?? null));
  store.command(code, secret, { action: 'start', focusMin: 25, rounds: 2 });
  store.command(code, secret, { action: 'stop' });
  unsubscribe();
  store.command(code, secret, { action: 'start', focusMin: 25, rounds: 3 });
  assert.deepEqual(seen, [2, null]);
});

test('open rooms are capped, pinned rooms do not count', () => {
  const store = createStore({ maxRooms: 2, pinned: [{ code: 'K7F2QM', hash: hashSecret(SECRET) }], now: clock() });
  store.create();
  store.create();
  assert.throws(() => store.create(), { code: 'full' });
});

test('rooms without a session for 30 days are deleted, pinned rooms stay', () => {
  const now = clock();
  const store = createStore({ pinned: [{ code: 'K7F2QM', hash: hashSecret(SECRET) }], now });
  const old = store.create();
  now.t += 20 * DAY;
  const recent = store.create();
  now.t += 11 * DAY;
  store.sweep();
  assert.equal(store.get(old.code), undefined);
  assert.ok(store.get(recent.code));
  assert.ok(store.get('K7F2QM'));
});

test('an editor recreates its forgotten room, and nobody else can claim it', () => {
  const now = clock();
  const store = createStore({ now });
  store.restore('K7F2QM', SECRET, null);
  assert.ok(store.get('K7F2QM'));
  assert.throws(() => store.restore('K7F2QM', 'another-long-enough-secret', null), { code: 'taken' });
  assert.throws(() => store.restore('ABCDEF', 'short', null), { code: 'invalid' });
});

test('a restored session fills an empty room but never overrides a running one', () => {
  const now = clock();
  const store = createStore({ pinned: [{ code: 'K7F2QM', hash: hashSecret(SECRET) }], now });
  const session = { focusMin: 25, rounds: 2, startedAt: now.t - 5 * MIN, pausedAt: null, pausedMs: 0 };
  store.restore('K7F2QM', SECRET, { ...session, extra: 'dropped' });
  assert.deepEqual(store.get('K7F2QM').session, session);
  store.restore('K7F2QM', SECRET, { ...session, rounds: 4 });
  assert.equal(store.get('K7F2QM').session.rounds, 2);
});

test('absurd restored sessions are rejected', () => {
  const now = clock();
  const store = createStore({ now });
  const future = { focusMin: 25, rounds: 2, startedAt: now.t + DAY, pausedAt: null, pausedMs: 0 };
  assert.throws(() => store.restore('K7F2QM', SECRET, future), { code: 'invalid' });
  assert.throws(() => store.restore('K7F2QM', SECRET, 'nope'), { code: 'invalid' });
});

test('the creator names the room with plain, one-line, bounded text', () => {
  const store = createStore({ now: clock() });
  const { code, secret } = store.create();
  store.command(code, secret, { action: 'rename', name: '  Florian\n  <b>desk</b>\u0007 ' });
  assert.equal(store.get(code).name, 'Florian <b>desk</b>');
  store.command(code, secret, { action: 'rename', name: 'x'.repeat(40) });
  assert.equal(store.get(code).name.length, MAX_NAME);
  assert.throws(() => store.command(code, secret, { action: 'rename', name: 42 }), { code: 'invalid' });
  assert.throws(() => store.command(code, 'wrong', { action: 'rename', name: 'hijack' }), { code: 'forbidden' });
});

test('a restore brings the name back without overriding an existing one', () => {
  const store = createStore({ pinned: [{ code: 'K7F2QM', hash: hashSecret(SECRET) }], now: clock() });
  const seen = [];
  store.subscribe('K7F2QM', (room) => seen.push(room.name));
  store.restore('K7F2QM', SECRET, null, 'Florian');
  store.restore('K7F2QM', SECRET, null, 'Other');
  assert.equal(store.get('K7F2QM').name, 'Florian');
  assert.deepEqual(seen, ['Florian', 'Florian']);
});

test('pinned rooms are read from the environment', () => {
  const hash = 'a'.repeat(64);
  assert.deepEqual(parsePinned(`k7f-2qm:${hash}`), [{ code: 'K7F2QM', hash }]);
  assert.deepEqual(parsePinned(''), []);
  assert.throws(() => parsePinned('nope'));
});

test('the rate limiter forgets keys once their window is over', () => {
  const now = clock(0);
  const limiter = createRateLimiter({ max: 2, windowMs: 1000, now });
  assert.equal(limiter.allow('ip'), true);
  assert.equal(limiter.allow('ip'), true);
  assert.equal(limiter.allow('ip'), false);
  assert.equal(limiter.allow('other'), true);
  now.t = 1000;
  assert.equal(limiter.allow('ip'), true);
});
