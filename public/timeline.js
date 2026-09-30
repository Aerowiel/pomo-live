// Pure timeline logic, shared by the browser and the server.
// A session is { focusMin, rounds, startedAt, pausedAt, pausedMs }, all times in server milliseconds.

export const MIN_FOCUS = 5;
export const MAX_FOCUS = 180;
export const MAX_ROUNDS = 12;
export const INTRO_MS = 7_000;
const MINUTE = 60_000;
const DAY = 86_400_000;

export function breakMinutes(focusMin) {
  return Math.max(1, Math.round(focusMin / 5));
}

export function isValidSettings(focusMin, rounds) {
  return Number.isInteger(focusMin) && focusMin >= MIN_FOCUS && focusMin <= MAX_FOCUS
    && Number.isInteger(rounds) && rounds >= 1 && rounds <= MAX_ROUNDS;
}

export function isValidSession(session, now) {
  if (session === null) return true;
  return typeof session === 'object'
    && isValidSettings(session.focusMin, session.rounds)
    && Number.isFinite(session.startedAt) && session.startedAt > now - DAY && session.startedAt <= now + MINUTE
    && Number.isFinite(session.pausedMs) && session.pausedMs >= 0
    && (session.pausedAt === null
      || (Number.isFinite(session.pausedAt) && session.pausedAt >= session.startedAt && session.pausedAt <= now + MINUTE));
}

// Phases in order, as offsets from the start of active time. The last focus is not followed by a break.
export function phases({ focusMin, rounds }) {
  const focus = focusMin * MINUTE;
  const pause = breakMinutes(focusMin) * MINUTE;
  const list = [];
  let t = 0;
  for (let round = 1; round <= rounds; round++) {
    list.push({ kind: 'focus', round, start: t, end: t + focus });
    t += focus;
    if (round < rounds) {
      list.push({ kind: 'break', round, start: t, end: t + pause });
      t += pause;
    }
  }
  return list;
}

function activeElapsed(session, now) {
  const until = session.pausedAt ?? now;
  return Math.max(0, until - session.startedAt - session.pausedMs);
}

export function isFinished(session, now) {
  return !session || activeElapsed(session, now) >= phases(session).at(-1).end;
}

export function derive(session, now) {
  if (isFinished(session, now)) return { status: 'free' };
  const list = phases(session);
  if (session.pausedAt == null && now < session.startedAt) {
    return {
      status: 'intro',
      phase: 'focus',
      round: 1,
      rounds: session.rounds,
      focusMs: session.focusMin * MINUTE,
      breakMs: breakMinutes(session.focusMin) * MINUTE,
      phaseMs: INTRO_MS,
      remaining: session.startedAt - now,
      phaseEndsAt: session.startedAt,
      sessionEndsAt: session.startedAt + list.at(-1).end,
    };
  }
  const elapsed = activeElapsed(session, now);
  const current = list.find((phase) => elapsed < phase.end);
  const remaining = current.end - elapsed;
  const view = {
    phase: current.kind,
    round: current.round,
    rounds: session.rounds,
    focusMs: session.focusMin * MINUTE,
    breakMs: breakMinutes(session.focusMin) * MINUTE,
    phaseMs: current.end - current.start,
    remaining,
  };
  if (session.pausedAt != null) return { ...view, status: 'paused', pausedAt: session.pausedAt };
  return {
    ...view,
    status: current.kind,
    phaseEndsAt: now + remaining,
    sessionEndsAt: now + list.at(-1).end - elapsed,
  };
}

export function applyCommand(session, command, now) {
  const running = !isFinished(session, now);
  switch (command.action) {
    case 'start':
      if (!isValidSettings(command.focusMin, command.rounds)) throw new RangeError('invalid settings');
      return { focusMin: command.focusMin, rounds: command.rounds, startedAt: now + INTRO_MS, pausedAt: null, pausedMs: 0 };
    case 'pause':
      return running && session.pausedAt == null && now >= session.startedAt ? { ...session, pausedAt: now } : session;
    case 'resume':
      return running && session.pausedAt != null
        ? { ...session, pausedAt: null, pausedMs: session.pausedMs + (now - session.pausedAt) }
        : session;
    case 'stop':
      return null;
    default:
      throw new RangeError('unknown action');
  }
}
