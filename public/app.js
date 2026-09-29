import { breakMinutes, derive, phases, MAX_FOCUS, MAX_ROUNDS, MIN_FOCUS } from './timeline.js';
import { MAX_CODE, normalizeCode } from './codes.js';
import * as audio from './audio.js';

const app = document.getElementById('app');
const MAX_NAME = 30;
const MAX_FOLLOWED = 20;

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

// Rooms moved to a new code: followers are carried over, editors of the old code are forgotten.
const RENAMED = { k93edv: 'fpendaries' };
const current = (code) => {
  const normalized = normalizeCode(code);
  return normalized && (RENAMED[normalized] ?? normalized);
};

function followed() {
  const legacy = saved.get('lastView');
  saved.remove('lastView');
  const list = [...new Set([legacy, ...saved.get('following', [])].map(current).filter(Boolean))];
  saved.set('following', list);
  return list;
}

function savedEditor() {
  const editor = saved.get('editor');
  if (editor && RENAMED[normalizeCode(editor.code)]) {
    saved.remove('editor');
    return null;
  }
  return editor;
}

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
const roomLabel = (name, code) => name || code;
const editLink = (code, secret) => `/edit/${code}#${secret}`;

// What a follower reads about a room, shared by the full-screen viewer and the dashboard cards.
function describe(session, missing) {
  const view = derive(session, serverNow());
  if (missing) return { view: 'missing', status: 'NOT FOUND', next: '', rel: '', meta: '' };
  if (view.status === 'free') return { view: 'free', status: session === undefined ? '…' : 'FREE', next: '', rel: '', meta: '' };
  const round = `round ${view.round}/${view.rounds}`;
  if (view.status === 'paused') return { view: 'paused', status: 'PAUSED', next: `since ${clockTime(view.pausedAt)}`, rel: '', meta: round };
  const inFocus = view.status === 'focus';
  const lastFocus = inFocus && view.round === view.rounds;
  return {
    view: view.status,
    status: inFocus ? 'FOCUS' : 'BREAK',
    next: `${lastFocus ? 'done' : inFocus ? 'break' : 'focus'} at ${clockTime(view.phaseEndsAt)}`,
    rel: `(${fromNow(view.remaining)})`,
    meta: `${round} · ends at ${clockTime(view.sessionEndsAt)}`,
  };
}

async function post(path, body = {}, secret) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(secret && { Authorization: `Bearer ${secret}` }) },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error ?? response.statusText), { status: response.status, code: data.error, suggestion: data.suggestion });
  return data;
}

function follow(code, { onState, onMissing }) {
  let source;
  function open() {
    source = new EventSource(`/api/rooms/${code}/events`);
    source.addEventListener('state', (event) => {
      const data = JSON.parse(event.data);
      offset = data.serverNow - Date.now();
      onState(data);
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

function watchRooms(codes, onRoom) {
  const source = new EventSource(`/api/watch?codes=${codes.join(',')}`);
  source.addEventListener('room', (event) => {
    const data = JSON.parse(event.data);
    offset = data.serverNow - Date.now();
    onRoom(data);
  });
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
  const editor = savedEditor();
  let following = followed();
  const codeRule = `3 to ${MAX_CODE} characters: letters, digits and hyphens.`;

  document.body.dataset.page = 'home';
  app.innerHTML = `
    <div class="home">
      <h1>pomo-live</h1>
      <p class="tagline">A pomodoro others can follow live.</p>
      <section class="following" id="following" hidden>
        <h2>Following</h2>
        <ul class="cards" id="cards"></ul>
      </section>
      <a class="primary" id="mine" hidden></a>
      <form class="join" id="create">
        <label for="newCode" id="createLabel">Start a pomodoro</label>
        <div>
          <input id="newCode" placeholder="your code (optional)" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="${MAX_CODE}">
          <button class="primary">Create</button>
        </div>
        <p class="hint" id="suggestion" hidden></p>
      </form>
      <form class="join" id="join">
        <label for="code">Follow someone's pomodoro</label>
        <div>
          <input id="code" placeholder="their code" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="${MAX_CODE}">
          <button class="primary">Watch</button>
        </div>
      </form>
      <p class="error" id="error" role="alert"></p>
      <p class="privacy">No account. Each room only keeps its timer state and the name its creator gave it, visible to anyone with the code, on a server in Paris (Fly.io). Rooms are deleted after 30 days without a session.</p>
    </div>`;

  const error = app.querySelector('#error');
  const newCode = app.querySelector('#newCode');
  const suggestion = app.querySelector('#suggestion');
  if (editor) {
    const mine = app.querySelector('#mine');
    mine.hidden = false;
    mine.href = editLink(editor.code, editor.secret);
    mine.textContent = `Back to my pomodoro (${roomLabel(saved.get(`name:${editor.code}`, ''), editor.code)})`;
    app.querySelector('#createLabel').textContent = 'Start a new room';
  }

  app.querySelector('#create').addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    suggestion.hidden = true;
    const wanted = newCode.value.trim();
    if (wanted && !normalizeCode(wanted)) {
      error.textContent = `A code is ${codeRule}`;
      return;
    }
    if (editor && !confirm(`This device will forget your room ${editor.code} (keep its link if you need it). Continue?`)) return;
    try {
      const { code, secret } = await post('/api/rooms', wanted ? { code: wanted } : {});
      location.assign(editLink(code, secret));
    } catch (e) {
      if (e.code === 'taken' && e.suggestion) {
        suggestion.hidden = false;
        suggestion.textContent = `“${normalizeCode(wanted)}” is taken. `;
        const accept = document.createElement('button');
        accept.type = 'button';
        accept.className = 'ghost';
        accept.textContent = `Use ${e.suggestion}`;
        accept.addEventListener('click', () => {
          newCode.value = e.suggestion;
          suggestion.hidden = true;
        });
        suggestion.append(accept);
        return;
      }
      error.textContent = e.status === 429
        ? 'Too many new rooms from your network. Try again in an hour.'
        : 'Could not create a room right now. Try again later.';
    }
  });

  app.querySelector('#join').addEventListener('submit', (event) => {
    event.preventDefault();
    const code = current(app.querySelector('#code').value);
    if (!code) {
      error.textContent = `A code is ${codeRule}`;
      return;
    }
    location.assign(`/view/${code}`);
  });

  if (following.length === 0) return;
  const section = app.querySelector('#following');
  const list = app.querySelector('#cards');
  section.hidden = false;
  const rooms = new Map();
  for (const code of following) {
    const card = document.createElement('li');
    card.className = 'card';
    card.innerHTML = `
      <a href="/view/${code}">
        <span class="card-name"></span>
        <span class="card-status"></span>
        <span class="card-next"></span>
      </a>
      <button class="card-remove" aria-label="Stop following">×</button>`;
    card.querySelector('.card-remove').addEventListener('click', () => {
      following = following.filter((c) => c !== code);
      saved.set('following', following);
      card.remove();
      section.hidden = following.length === 0;
    });
    list.append(card);
    rooms.set(code, { card, name: '', session: undefined, missing: false });
  }

  function render() {
    for (const [code, room] of rooms) {
      const text = describe(room.session, room.missing);
      room.card.dataset.view = text.view;
      room.card.querySelector('.card-name').textContent = roomLabel(room.name, code);
      room.card.querySelector('.card-status').textContent = text.status;
      room.card.querySelector('.card-next').textContent = text.next;
    }
  }

  watchRooms(following, (data) => {
    const room = rooms.get(data.code);
    if (!room) return;
    room.missing = Boolean(data.missing);
    if (!data.missing) {
      room.name = data.name;
      room.session = data.session;
    }
    render();
  });
  render();
  setInterval(render, 1000);
}

function editorPage(code, secret) {
  saved.set('editor', { code, secret });
  document.body.dataset.page = 'editor';
  const settings = saved.get('settings', { focusMin: 25, rounds: 4 });
  const storedNoise = saved.get('noise', 'brown');
  let noise = audio.NOISES.includes(storedNoise) || storedNoise === 'off' ? storedNoise : 'brown';
  let session = saved.get(`session:${code}`);
  let name = saved.get(`name:${code}`, '');
  let mode = null;
  let audioKey = '';

  app.innerHTML = `
    <div class="editor">
      <div class="pill share">
        <input class="room-name" id="roomName" maxlength="${MAX_NAME}" placeholder="name this room" aria-label="Room name" autocomplete="off">
        <span class="room-code">${code}</span>
        <button id="copy"><small>copy viewer link</small></button>
      </div>
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
  const nameInput = $('#roomName');
  const problem = $('#problem');
  const say = (message) => {
    problem.textContent = message;
    problem.hidden = !message;
  };

  function setState(data) {
    session = data.session;
    saved.set(`session:${code}`, session);
    if (typeof data.name === 'string') {
      name = data.name;
      saved.set(`name:${code}`, name);
      if (document.activeElement !== nameInput) nameInput.value = name;
    }
    update();
  }

  function send(action, extra = {}) {
    return post(`/api/rooms/${code}/command`, { action, ...extra }, secret)
      .then((data) => {
        offset = data.serverNow - Date.now();
        say('');
        setState(data);
      })
      .catch(() => say('Could not reach the server. Try again.'));
  }

  async function restore() {
    try {
      await post(`/api/rooms/${code}/restore`, { session, name }, secret);
      say('');
      connection.reopen();
    } catch (e) {
      if (e.code === 'taken') return say('This code now belongs to someone else. Start a new pomodoro from the home page.');
      say('Server unavailable, retrying…');
      setTimeout(restore, 10_000);
    }
  }

  const connection = follow(code, { onState: setState, onMissing: restore });

  nameInput.value = name;
  nameInput.addEventListener('keydown', (event) => event.key === 'Enter' && nameInput.blur());
  nameInput.addEventListener('change', () => send('rename', { name: nameInput.value }));

  const copy = $('#copy');
  copy.addEventListener('click', async () => {
    const hint = copy.querySelector('small');
    await navigator.clipboard.writeText(`${location.origin}/view/${code}`);
    hint.textContent = 'copied!';
    setTimeout(() => (hint.textContent = 'copy viewer link'), 2000);
  });

  noiseButton.addEventListener('click', async () => {
    if (mode === 'run' && !audio.ready()) {
      await audio.ensure().catch(() => {});
    } else {
      const cycle = [...audio.NOISES, 'off'];
      noise = cycle[(cycle.indexOf(noise) + 1) % cycle.length];
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
    audio.schedule(plan, { noise: noise === 'off' ? null : noise });
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
    noiseButton.textContent = mode === 'run' && !audio.ready() ? 'tap to enable sound' : `noise: ${noise}`;
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
  const following = followed();
  if (!following.includes(code)) saved.set('following', [code, ...following].slice(0, MAX_FOLLOWED));
  document.body.dataset.page = 'viewer';
  app.innerHTML = `
    <div class="viewer">
      <a class="leave" href="/">all rooms</a>
      <div class="room" id="room"></div>
      <div class="status" id="status"></div>
      <div class="next" id="next"></div>
      <div class="in" id="in"></div>
      <div class="meta" id="meta"></div>
    </div>`;

  let session;
  let name = '';
  let missing = false;
  const connection = follow(code, {
    onState(data) {
      session = data.session;
      name = data.name;
      missing = false;
      update();
    },
    onMissing() {
      missing = true;
      update();
      setTimeout(() => connection.reopen(), 10_000);
    },
  });

  function update() {
    const text = describe(session, missing);
    document.body.dataset.view = text.view;
    document.title = `${roomLabel(name, code)} · pomo-live`;
    const values = {
      room: roomLabel(name, code),
      status: text.status,
      next: missing ? `No pomodoro with code ${code} right now.` : text.next,
      in: missing ? 'Retrying…' : text.rel,
      meta: text.meta,
    };
    for (const [id, value] of Object.entries(values)) app.querySelector(`#${id}`).textContent = value;
  }

  update();
  setInterval(update, 1000);
}

// The editor secret stays after the #, so it never reaches the server or its logs.
function route() {
  const legacy = new URLSearchParams(location.hash.slice(1));
  if (legacy.has('view')) return location.replace(`/view/${current(legacy.get('view')) ?? ''}`);
  if (legacy.has('edit')) {
    const [code, secret] = legacy.get('edit').split('.');
    return location.replace(editLink(normalizeCode(code) ?? '', secret ?? ''));
  }

  const [, page, rawCode] = location.pathname.split('/');
  const code = normalizeCode(rawCode);
  if (page === 'edit' && code && location.hash.length > 1) return editorPage(code, location.hash.slice(1));
  if (page === 'view' && code) {
    if (current(code) !== code) return location.replace(`/view/${current(code)}`);
    return viewerPage(code);
  }
  if (location.pathname !== '/') return location.replace('/');
  homePage();
}

route();
