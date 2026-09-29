import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCode } from '../public/codes.js';
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

test('codes are lowercase letters, digits and single hyphens, 3 to 24 long', () => {
  assert.equal(normalizeCode(' FPendaries '), 'fpendaries');
  assert.equal(normalizeCode('Jean Dupont'), 'jean-dupont');
  assert.equal(normalizeCode('K93EDV'), 'k93edv');
  assert.equal(normalizeCode('ab'), null);
  assert.equal(normalizeCode('a'.repeat(25)), null);
  assert.equal(normalizeCode('-abc'), null);
  assert.equal(normalizeCode('ab--c'), null);
  assert.equal(normalizeCode('é-été'), null);
  assert.equal(normalizeCode(null), null);
});

test('a creator can pick a code, and gets a free variant when it is taken', () => {
  const store = createStore({ now: clock() });
  assert.equal(store.create('FPendaries').code, 'fpendaries');
  assert.throws(() => store.create('fpendaries'), { code: 'taken' });
  assert.throws(() => store.create('x'), { code: 'invalid' });
  const variant = store.suggest('fpendaries');
  assert.match(variant, /^fpendaries-[2-9a-hjkmnp-z]{3}$/);
  assert.equal(store.create(variant).code, variant);
  assert.equal(store.suggest('a'.repeat(24)).length, 24);
  assert.match(store.create().code, /^[2-9a-hjkmnp-z]{6}$/);
});

test('only the editor secret can drive a room', () => {
  const store = createStore({ now: clock() });
  const { code, secret } = store.create();
  assert.ok(normalizeCode(code));
  store.command(code, secret, { action: 'start', focusMin: 25, rounds: 4 });
  assert.equal(store.get(code).session.rounds, 4);
  assert.throws(() => store.command(code, 'wrong', { action: 'stop' }), { code: 'forbidden' });
  assert.throws(() => store.command('zzzzzz', secret, { action: 'stop' }), { code: 'not_found' });
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
  const store = createStore({ maxRooms: 2, pinned: [{ code: 'fpendaries', hash: hashSecret(SECRET) }], now: clock() });
  store.create();
  store.create();
  assert.throws(() => store.create(), { code: 'full' });
});

test('rooms without a session for 30 days are deleted, pinned rooms stay', () => {
  const now = clock();
  const store = createStore({ pinned: [{ code: 'fpendaries', hash: hashSecret(SECRET) }], now });
  const old = store.create();
  now.t += 20 * DAY;
  const recent = store.create();
  now.t += 11 * DAY;
  store.sweep();
  assert.equal(store.get(old.code), undefined);
  assert.ok(store.get(recent.code));
  assert.ok(store.get('fpendaries'));
});

test('an editor recreates its forgotten room, and nobody else can claim it', () => {
  const now = clock();
  const store = createStore({ now });
  store.restore('fpendaries', SECRET, null);
  assert.ok(store.get('fpendaries'));
  assert.throws(() => store.restore('fpendaries', 'another-long-enough-secret', null), { code: 'taken' });
  assert.throws(() => store.restore('abcdef', 'short', null), { code: 'invalid' });
});

test('a restored session fills an empty room but never overrides a running one', () => {
  const now = clock();
  const store = createStore({ pinned: [{ code: 'fpendaries', hash: hashSecret(SECRET) }], now });
  const session = { focusMin: 25, rounds: 2, startedAt: now.t - 5 * MIN, pausedAt: null, pausedMs: 0 };
  store.restore('fpendaries', SECRET, { ...session, extra: 'dropped' });
  assert.deepEqual(store.get('fpendaries').session, session);
  store.restore('fpendaries', SECRET, { ...session, rounds: 4 });
  assert.equal(store.get('fpendaries').session.rounds, 2);
});

test('absurd restored sessions are rejected', () => {
  const now = clock();
  const store = createStore({ now });
  const future = { focusMin: 25, rounds: 2, startedAt: now.t + DAY, pausedAt: null, pausedMs: 0 };
  assert.throws(() => store.restore('fpendaries', SECRET, future), { code: 'invalid' });
  assert.throws(() => store.restore('fpendaries', SECRET, 'nope'), { code: 'invalid' });
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
  const store = createStore({ pinned: [{ code: 'fpendaries', hash: hashSecret(SECRET) }], now: clock() });
  const seen = [];
  store.subscribe('fpendaries', (room) => seen.push(room.name));
  store.restore('fpendaries', SECRET, null, 'Florian');
  store.restore('fpendaries', SECRET, null, 'Other');
  assert.equal(store.get('fpendaries').name, 'Florian');
  assert.deepEqual(seen, ['Florian', 'Florian']);
});

test('pinned rooms are read from the environment', () => {
  const hash = 'a'.repeat(64);
  assert.deepEqual(parsePinned(`FPendaries:${hash}`), [{ code: 'fpendaries', hash }]);
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
