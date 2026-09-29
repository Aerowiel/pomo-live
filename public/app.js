import { breakMinutes, derive, phases, MAX_FOCUS, MAX_ROUNDS, MIN_FOCUS } from './timeline.js';
import { formatCode, normalizeCode } from './codes.js';
import * as audio from './audio.js';

const app = document.getElementById('app');

const saved = {
  get(key, fallback = null) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set: (key, value) => localStorage.setItem(key, JSON.stringify(value)),
  remove: (key) => localStorage.removeItem(key),
};

// Offset to the server clock, so that every device derives the same phase from the same events.
let offset = 0;
const serverNow = () => Date.now() + offset;
const toLocal = (serverMs) => serverMs - offset;

const pad = (n) => String(n).padStart(2, '0');
function countdown(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}
const clockTime = (serverMs) =>
  new Date(toLocal(serverMs)).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const fromNow = (ms) => (ms < 60_000 ? 'in less than a minute' : `in ${Math.round(ms / 60_000)} min`);

async function post(path, body = {}, secret) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(secret && { Authorization: `Bearer ${secret}` }) },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error ?? response.statusText), { status: response.status, code: data.error });
  return data;
}

function follow(code, { onState, onMissing }) {
  let source;
  function open() {
    source = new EventSource(`/api/rooms/${code}/events`);
    source.addEventListener('state', (event) => {
      const { session, serverNow: at } = JSON.parse(event.data);
      offset = at - Date.now();
      onState(session);
    });
    source.addEventListener('missing', () => {
      source.close();
      onMissing();
    });
  }
  open();
  return {
    reopen() {
      source.close();
      open();
    },
  };
}

const RING = 2 * Math.PI * 90;
const WORK_ICON = `
  <circle cx="62" cy="18" r="9" fill="currentColor"/>
  <g fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M60 34 L58 60 L38 60 L40 84"/>
    <path d="M60 42 L44 50"/>
    <path d="M73 44 L71 66 M52 66 H75 M68 66 V88"/>
    <path d="M12 50 H48 M20 48 L12 30"/>
  </g>`;
const BREAK_ICON = `
  <g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round">
    <path d="M38 12 c-4 5 4 8 0 14 M50 12 c-4 5 4 8 0 14 M62 12 c-4 5 4 8 0 14"/>
    <path d="M76 46 h4 a9 9 0 0 1 0 18 h-7"/>
    <path d="M16 88 H84"/>
  </g>
  <path fill="currentColor" d="M20 38 H80 V50 A30 30 0 0 1 50 80 A30 30 0 0 1 20 50 Z"/>`;
const PAUSE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>`;

const ring = (icon) => `
  <svg class="ring" viewBox="0 0 200 200" aria-hidden="true">
    <circle class="track" cx="100" cy="100" r="90"/>
    <circle class="left" cx="100" cy="100" r="90" transform="rotate(-90 100 100)"/>
    <g transform="translate(55 55) scale(0.9)">${icon}</g>
  </svg>`;

// The solid arc is the time left; it empties clockwise from the top, leaving the dotted track behind.
function setRing(half, fraction) {
  const arc = half.querySelector('.left');
  arc.style.strokeDasharray = `${fraction * RING} ${RING}`;
  arc.style.strokeDashoffset = `${-(1 - fraction) * RING}`;
}

function homePage() {
  const editor = saved.get('editor');
  const lastView = saved.get('lastView');
  if (!editor && lastView) return location.replace(`#view=${lastView}`);

  document.body.dataset.page = 'home';
  app.innerHTML = `
    <div class="home">
      <h1>pomo-live</h1>
      <p class="tagline">A pomodoro others can follow live.</p>
      <div class="actions">
        <a class="primary" id="mine" hidden></a>
        <button class="primary" id="create">Start a pomodoro</button>
      </div>
      <form class="join" id="join">
        <label for="code">Follow someone's pomodoro</label>
        <div>
          <input id="code" placeholder="K7F-2QM" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="7">
          <button class="primary">Watch</button>
        </div>
      </form>
      <p class="error" id="error" role="alert"></p>
      <p class="privacy">No account, no name. Each room only keeps its timer state, on a server in Paris (Fly.io), and is deleted after 30 days without a session.</p>
    </div>`;

  const error = app.querySelector('#error');
  const create = app.querySelector('#create');
  if (editor) {
    const mine = app.querySelector('#mine');
    mine.hidden = false;
    mine.href = `#edit=${editor.code}.${editor.secret}`;
    mine.textContent = `Back to my pomodoro (${formatCode(editor.code)})`;
    create.textContent = 'Start a new room';
    create.className = 'ghost';
  }

  create.addEventListener('click', async () => {
    if (editor && !confirm(`This device will forget your room ${formatCode(editor.code)} (keep its link if you need it). Continue?`)) return;
    try {
      const { code, secret } = await post('/api/rooms');
      location.hash = `edit=${code}.${secret}`;
    } catch (e) {
      error.textContent = e.status === 429
        ? 'Too many new rooms from your network. Try again in an hour.'
        : 'Could not create a room right now. Try again later.';
    }
  });

  app.querySelector('#join').addEventListener('submit', (event) => {
    event.preventDefault();
    const code = normalizeCode(app.querySelector('#code').value);
    if (!code) {
      error.textContent = 'A code looks like K7F-2QM.';
      return;
    }
    location.hash = `view=${code}`;
  });
}

function editorPage(code, secret) {
  saved.set('editor', { code, secret });
  document.body.dataset.page = 'editor';
  const settings = saved.get('settings', { focusMin: 25, rounds: 4 });
  let noise = saved.get('noise', false);
  let session = saved.get(`session:${code}`);
  let mode = null;
  let audioKey = '';

  app.innerHTML = `
    <div class="editor">
      <button class="pill share" id="share"></button>
      <div class="pill center" id="center"></div>
      <section class="split">
        <div class="half" id="focusHalf"><h2>FOCUS</h2>${ring(WORK_ICON)}<div class="time" id="focusTime"></div></div>
        <div class="half" id="breakHalf"><h2>BREAK</h2>${ring(BREAK_ICON)}<div class="time" id="breakTime"></div></div>
      </section>
      <div class="corner bottom-left" id="left"></div>
      <div class="corner bottom-middle" id="middle"></div>
      <button class="pill corner bottom-right" id="noise"></button>
      <div class="overlay" id="overlay" hidden>
        <p class="overlay-title">PAUSED</p>
        <div class="overlay-actions">
          <button class="primary light" id="resume">Resume</button>
          <button class="ghost" id="stop">Stop</button>
        </div>
      </div>
      <p class="pill problem" id="problem" role="alert" hidden></p>
    </div>`;

  const $ = (selector) => app.querySelector(selector);
  const focusHalf = $('#focusHalf');
  const breakHalf = $('#breakHalf');
  const noiseButton = $('#noise');
  const problem = $('#problem');
  const say = (message) => {
    problem.textContent = message;
    problem.hidden = !message;
  };

  function setSession(next) {
    session = next;
    saved.set(`session:${code}`, next);
    update();
  }

  function send(action, extra = {}) {
    return post(`/api/rooms/${code}/command`, { action, ...extra }, secret)
      .then(({ session: next, serverNow: at }) => {
        offset = at - Date.now();
        say('');
        setSession(next);
      })
      .catch(() => say('Could not reach the server. Try again.'));
  }

  async function restore() {
    try {
      await post(`/api/rooms/${code}/restore`, { session }, secret);
      say('');
      connection.reopen();
    } catch (e) {
      if (e.code === 'taken') return say('This code now belongs to someone else. Start a new pomodoro from the home page.');
      say('Server unavailable, retrying…');
      setTimeout(restore, 10_000);
    }
  }

  const connection = follow(code, { onState: setSession, onMissing: restore });

  const share = $('#share');
  share.innerHTML = `${formatCode(code)} <small>copy viewer link</small>`;
  share.addEventListener('click', async () => {
    const hint = share.querySelector('small');
    await navigator.clipboard.writeText(`${location.origin}/#view=${code}`);
    hint.textContent = 'copied!';
    setTimeout(() => (hint.textContent = 'copy viewer link'), 2000);
  });

  noiseButton.addEventListener('click', async () => {
    if (mode === 'run' && !audio.ready()) {
      await audio.ensure().catch(() => {});
    } else {
      noise = !noise;
      saved.set('noise', noise);
    }
    update();
  });
  $('#resume').addEventListener('click', () => send('resume'));
  $('#stop').addEventListener('click', () => send('stop'));

  function buildMode(next) {
    mode = next;
    const setup = next === 'setup';
    $('#center').innerHTML = setup
      ? `ROUNDS <button id="less" aria-label="One round less">-</button><span id="roundsValue"></span><button id="more" aria-label="One round more">+</button>`
      : `<span id="roundLabel"></span>`;
    $('#focusTime').innerHTML = setup
      ? `<input id="focusInput" type="number" inputmode="numeric" min="${MIN_FOCUS}" max="${MAX_FOCUS}" aria-label="Focus minutes"><span>:00</span>`
      : '';
    $('#left').innerHTML = setup ? '' : `<button class="round-button" id="pause" aria-label="Pause (space)">${PAUSE_ICON}</button>`;
    $('#middle').innerHTML = setup ? `<button class="primary" id="start">START</button>` : '';

    if (!setup) {
      $('#pause').addEventListener('click', () => send('pause'));
      return;
    }
    const input = $('#focusInput');
    input.value = settings.focusMin;
    input.addEventListener('input', () => {
      const value = Number(input.value);
      if (Number.isInteger(value) && value >= MIN_FOCUS && value <= MAX_FOCUS) {
        settings.focusMin = value;
        update();
      }
    });
    input.addEventListener('change', () => (input.value = settings.focusMin));
    $('#less').addEventListener('click', () => {
      settings.rounds = Math.max(1, settings.rounds - 1);
      update();
    });
    $('#more').addEventListener('click', () => {
      settings.rounds = Math.min(MAX_ROUNDS, settings.rounds + 1);
      update();
    });
    $('#start').addEventListener('click', async () => {
      saved.set('settings', settings);
      await audio.ensure().catch(() => {});
      send('start', settings);
    });
  }

  function syncAudio(view) {
    const key = JSON.stringify([session, noise, audio.ready()]);
    if (key === audioKey) return;
    audioKey = key;
    if (!audio.ready() || view.status === 'free' || view.status === 'paused') return audio.silence();
    const base = session.startedAt + session.pausedMs;
    const plan = phases(session).map((phase) => ({
      kind: phase.kind,
      start: toLocal(base + phase.start),
      end: toLocal(base + phase.end),
    }));
    audio.schedule(plan, { noise });
  }

  function update() {
    const view = derive(session, serverNow());
    const next = view.status === 'free' ? 'setup' : 'run';
    if (next !== mode) buildMode(next);

    if (mode === 'setup') {
      focusHalf.classList.add('active');
      breakHalf.classList.remove('active');
      $('#roundsValue').textContent = settings.rounds;
      $('#breakTime').textContent = countdown(breakMinutes(settings.focusMin) * 60_000);
      setRing(focusHalf, 1);
      setRing(breakHalf, 1);
      $('#overlay').hidden = true;
      document.title = 'pomo-live';
    } else {
      const inFocus = view.phase === 'focus';
      focusHalf.classList.toggle('active', inFocus);
      breakHalf.classList.toggle('active', !inFocus);
      $('#focusTime').textContent = countdown(inFocus ? view.remaining : view.focusMs);
      $('#breakTime').textContent = countdown(inFocus ? view.breakMs : view.remaining);
      setRing(focusHalf, inFocus ? view.remaining / view.phaseMs : 1);
      setRing(breakHalf, inFocus ? 1 : view.remaining / view.phaseMs);
      $('#roundLabel').textContent = `ROUND ${view.round} / ${view.rounds}`;
      $('#overlay').hidden = view.status !== 'paused';
      document.title = `${countdown(view.remaining)} ${inFocus ? 'focus' : 'break'} · pomo-live`;
    }
    noiseButton.textContent = mode === 'run' && !audio.ready() ? 'tap to enable sound' : `white noise: ${noise ? 'on' : 'off'}`;
    syncAudio(view);
  }

  document.addEventListener('keydown', (event) => {
    if (event.code !== 'Space' || mode !== 'run' || event.target.matches('input, button')) return;
    event.preventDefault();
    send(session?.pausedAt == null ? 'pause' : 'resume');
  });

  update();
  setInterval(update, 250);
}

function viewerPage(code) {
  saved.set('lastView', code);
  document.body.dataset.page = 'viewer';
  app.innerHTML = `
    <div class="viewer">
      <a class="leave" id="leave" href="#">follow another code</a>
      <div class="status" id="status"></div>
      <div class="next" id="next"></div>
      <div class="in" id="in"></div>
      <div class="meta" id="meta"></div>
    </div>`;
  app.querySelector('#leave').addEventListener('click', () => saved.remove('lastView'));

  let session;
  let missing = false;
  const connection = follow(code, {
    onState(next) {
      session = next;
      missing = false;
      update();
    },
    onMissing() {
      missing = true;
      update();
      setTimeout(() => connection.reopen(), 10_000);
    },
  });

  const texts = (values) => {
    for (const [id, text] of Object.entries(values)) app.querySelector(`#${id}`).textContent = text;
  };

  function update() {
    const view = derive(session, serverNow());
    if (missing) {
      document.body.dataset.view = 'missing';
      return texts({ status: 'NOT FOUND', next: `No pomodoro with code ${formatCode(code)} right now.`, in: 'Retrying…', meta: '' });
    }
    if (view.status === 'free') {
      document.body.dataset.view = 'free';
      return texts({ status: session === undefined ? '…' : 'FREE', next: '', in: '', meta: '' });
    }
    const round = `round ${view.round}/${view.rounds}`;
    if (view.status === 'paused') {
      document.body.dataset.view = 'paused';
      return texts({ status: 'PAUSED', next: `since ${clockTime(view.pausedAt)}`, in: '', meta: round });
    }
    const inFocus = view.status === 'focus';
    const lastFocus = inFocus && view.round === view.rounds;
    document.body.dataset.view = view.status;
    texts({
      status: inFocus ? 'FOCUS' : 'BREAK',
      next: `${lastFocus ? 'done' : inFocus ? 'break' : 'focus'} at ${clockTime(view.phaseEndsAt)}`,
      in: `(${fromNow(view.remaining)})`,
      meta: `${round} · ends at ${clockTime(view.sessionEndsAt)}`,
    });
  }

  update();
  setInterval(update, 1000);
}

function route() {
  const params = new URLSearchParams(location.hash.slice(1));
  const edit = params.get('edit');
  if (edit) {
    const [rawCode, secret] = edit.split('.');
    const code = normalizeCode(rawCode);
    if (code && secret) return editorPage(code, secret);
  }
  const view = normalizeCode(params.get('view'));
  if (view) return viewerPage(view);
  homePage();
}

window.addEventListener('hashchange', () => location.reload());
route();
