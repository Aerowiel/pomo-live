import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, breakMinutes, derive, phases } from '../public/timeline.js';

const MIN = 60_000;
const start = (focusMin, rounds, now = 0) => applyCommand(null, { action: 'start', focusMin, rounds }, now);

test('the break is a fifth of the focus, rounded, and at least one minute', () => {
  assert.equal(breakMinutes(25), 5);
  assert.equal(breakMinutes(40), 8);
  assert.equal(breakMinutes(42), 8);
  assert.equal(breakMinutes(43), 9);
  assert.equal(breakMinutes(5), 1);
  assert.equal(breakMinutes(180), 36);
});

test('rounds alternate focus and break, without a final break', () => {
  const list = phases({ focusMin: 50, rounds: 3 });
  assert.deepEqual(list.map((p) => `${p.kind}${p.round}`), ['focus1', 'break1', 'focus2', 'break2', 'focus3']);
  assert.equal(list.at(-1).end, 170 * MIN);
});

test('derives the current phase from the start time alone', () => {
  const session = start(50, 2);
  const early = derive(session, 13 * MIN + 15_000);
  assert.equal(early.status, 'focus');
  assert.equal(early.round, 1);
  assert.equal(early.remaining, 36 * MIN + 45_000);
  assert.equal(early.phaseEndsAt, 50 * MIN);
  assert.equal(early.sessionEndsAt, 110 * MIN);

  const resting = derive(session, 55 * MIN);
  assert.equal(resting.status, 'break');
  assert.equal(resting.remaining, 5 * MIN);

  assert.equal(derive(session, 60 * MIN).round, 2);
  assert.equal(derive(session, 110 * MIN).status, 'free');
});

test('a pause freezes the timer and shifts everything after it', () => {
  let session = start(25, 1);
  session = applyCommand(session, { action: 'pause' }, 10 * MIN);
  const paused = derive(session, 30 * MIN);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.remaining, 15 * MIN);
  assert.equal(paused.pausedAt, 10 * MIN);

  session = applyCommand(session, { action: 'resume' }, 30 * MIN);
  assert.equal(derive(session, 40 * MIN).remaining, 5 * MIN);
  assert.equal(derive(session, 45 * MIN).status, 'free');
});

test('pause and resume do nothing when no session runs', () => {
  assert.equal(applyCommand(null, { action: 'pause' }, 0), null);
  const done = start(25, 1);
  assert.equal(applyCommand(done, { action: 'pause' }, 30 * MIN), done);
  assert.equal(applyCommand(start(25, 1), { action: 'resume' }, MIN).pausedMs, 0);
  assert.equal(applyCommand(start(25, 1), { action: 'stop' }, 5 * MIN), null);
});

test('rejects invalid settings and unknown actions', () => {
  assert.throws(() => start(4, 1));
  assert.throws(() => start(181, 1));
  assert.throws(() => start(25, 0));
  assert.throws(() => start(25, 13));
  assert.throws(() => start(25.5, 2));
  assert.throws(() => applyCommand(null, { action: 'explode' }, 0));
});
