// Sounds are generated in the browser and scheduled on the audio clock,
// so countdowns stay on time even when the tab is in the background.
export const NOISES = ['white', 'pink', 'brown'];
const LEVELS = { white: 0.1, pink: 0.18, brown: 0.3 };
let ctx = null;
let noiseGain = null;
let noiseSource = null;
let noiseType = null;
let pending = [];

export async function ensure() {
  if (!ctx) {
    ctx = new AudioContext();
    noiseGain = ctx.createGain();
    noiseGain.gain.value = 0;
    noiseGain.connect(ctx.destination);
  }
  if (ctx.state !== 'running') await ctx.resume();
}

export const ready = () => ctx?.state === 'running';

function noiseBuffer(type) {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate);
  const samples = buffer.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, last = 0;
  for (let i = 0; i < samples.length; i++) {
    const white = Math.random() * 2 - 1;
    if (type === 'white') {
      samples[i] = white;
    } else if (type === 'pink') {
      b0 = 0.99765 * b0 + white * 0.099;
      b1 = 0.963 * b1 + white * 0.2965;
      b2 = 0.57 * b2 + white * 1.0526;
      samples[i] = (b0 + b1 + b2 + white * 0.1848) * 0.2;
    } else {
      last = (last + 0.02 * white) / 1.02;
      samples[i] = last * 3.5;
    }
  }
  return buffer;
}

function useNoise(type) {
  if (type === noiseType) return;
  noiseSource?.stop();
  noiseSource?.disconnect();
  noiseSource = null;
  noiseType = type;
  if (!type) return;
  noiseSource = ctx.createBufferSource();
  noiseSource.buffer = noiseBuffer(type);
  noiseSource.loop = true;
  noiseSource.connect(noiseGain);
  noiseSource.start();
}

function tone(at, frequency, duration, volume = 0.2) {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(volume, at + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, at + duration);
  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(at);
  oscillator.stop(at + duration + 0.05);
  pending.push(oscillator);
}

export function silence() {
  if (!ctx) return;
  for (const oscillator of pending) {
    try {
      oscillator.stop();
    } catch {}
    oscillator.disconnect();
  }
  pending = [];
  noiseGain.gain.cancelScheduledValues(0);
  noiseGain.gain.setValueAtTime(0, ctx.currentTime);
}

// plan: the session phases with start/end in local milliseconds (Date.now() clock).
// noise: one of NOISES, or null for silence during focus.
export function schedule(plan, { noise }) {
  silence();
  useNoise(noise);
  const nowMs = Date.now();
  const base = ctx.currentTime;
  const at = (ms) => base + (ms - nowMs) / 1000;
  plan.forEach((phase, index) => {
    if (phase.end <= nowMs) return;
    if (noise && phase.kind === 'focus') {
      noiseGain.gain.setValueAtTime(LEVELS[noise], Math.max(base, at(phase.start)));
      noiseGain.gain.setValueAtTime(0, at(phase.end));
    }
    for (let second = 5; second >= 1; second--) {
      const beepAt = phase.end - second * 1000;
      if (beepAt > nowMs) tone(at(beepAt), 880, 0.12, 0.15);
    }
    const end = at(phase.end);
    if (index === plan.length - 1) {
      tone(end, 523, 0.4);
      tone(end + 0.25, 659, 0.4);
      tone(end + 0.5, 784, 0.9);
    } else if (phase.kind === 'focus') {
      tone(end, 660, 0.3);
      tone(end + 0.3, 440, 0.7);
    } else {
      tone(end, 440, 0.3);
      tone(end + 0.3, 880, 0.7);
    }
  });
}
