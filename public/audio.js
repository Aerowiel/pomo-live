export const NOISES = ['brown'];
const FILES = ['tick', 'focus', 'break', 'brown'];
const OPENING_TICKS = 4;
const CLOSING_TICKS = 7;
const OPENING_LENGTH = 8;
const FADE_IN = 1.5;
const LATE_TOLERANCE = 0.5;
let ctx = null;
let buffers = null;
let loading = null;
let noiseGain = null;
let master = null;
let volume = 1;
let pending = [];

// Squared so the slider feels even to the ear: half-way is a quarter of the power.
export function setVolume(value) {
  volume = value;
  master?.gain.setTargetAtTime(value * value, ctx.currentTime, 0.05);
}

async function load() {
  const entries = await Promise.all(FILES.map(async (name) => {
    const response = await fetch(`/sounds/${name}.wav`);
    return [name, await ctx.decodeAudioData(await response.arrayBuffer())];
  }));
  buffers = Object.fromEntries(entries);
  noiseGain = ctx.createGain();
  noiseGain.gain.value = 0;
  noiseGain.connect(master);
  const noise = ctx.createBufferSource();
  noise.buffer = buffers.brown;
  noise.loop = true;
  noise.connect(noiseGain);
  noise.start();
}

// Browsers allow decoding before a click, but playback only starts after one.
export function preload() {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = volume * volume;
    master.connect(ctx.destination);
  }
  loading ??= load();
  return loading;
}

export async function ensure() {
  preload();
  if (ctx.state !== 'running') await ctx.resume();
  await loading;
}

export const ready = () => ctx?.state === 'running' && buffers !== null;

function play(name, at) {
  if (at < ctx.currentTime - LATE_TOLERANCE) return;
  const source = ctx.createBufferSource();
  source.buffer = buffers[name];
  source.connect(master);
  source.start(Math.max(at, ctx.currentTime));
  pending.push(source);
}

export function silence() {
  if (!buffers) return;
  for (const source of pending) {
    try {
      source.stop();
    } catch {}
    source.disconnect();
  }
  pending = [];
  noiseGain.gain.cancelScheduledValues(0);
  noiseGain.gain.setValueAtTime(0, ctx.currentTime);
}

// plan: the session phases with start/end in local milliseconds (Date.now() clock).
// noise: 'brown', or null for cues only.
export function schedule(plan, { noise }) {
  silence();
  const nowMs = Date.now();
  // The audio clock, not setTimeout: background tabs throttle timers, not audio.
  const base = ctx.currentTime;
  const at = (ms) => base + (ms - nowMs) / 1000;
  const gain = noiseGain.gain;
  for (const phase of plan) {
    if (phase.kind !== 'focus' || phase.end <= nowMs) continue;
    const start = at(phase.start);
    const end = at(phase.end);
    for (let i = 0; i < OPENING_TICKS; i++) play('tick', start + i);
    play('focus', start + OPENING_TICKS);

    const fadeOut = end - CLOSING_TICKS;
    const from = Math.max(base, start + OPENING_LENGTH);
    if (noise && from < fadeOut) {
      gain.setValueAtTime(0, from);
      gain.linearRampToValueAtTime(1, Math.min(from + FADE_IN, fadeOut));
      gain.setValueAtTime(1, fadeOut);
      gain.linearRampToValueAtTime(0, end);
    }
    for (let i = CLOSING_TICKS; i >= 1; i--) play('tick', end - i);
    play('break', end);
  }
}
