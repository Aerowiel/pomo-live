// Sounds are generated in the browser and scheduled on the audio clock,
// so countdowns stay on time even when the tab is in the background.
const NOISE_LEVEL = 0.05;
let ctx = null;
let noiseGain = null;
let pending = [];

export async function ensure() {
  if (!ctx) {
    ctx = new AudioContext();
    startNoise();
  }
  if (ctx.state !== 'running') await ctx.resume();
}

export const ready = () => ctx?.state === 'running';

function startNoise() {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  noiseGain = ctx.createGain();
  noiseGain.gain.value = 0;
  source.connect(noiseGain).connect(ctx.destination);
  source.start();
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
export function schedule(plan, { noise }) {
  silence();
  const nowMs = Date.now();
  const base = ctx.currentTime;
  const at = (ms) => base + (ms - nowMs) / 1000;
  plan.forEach((phase, index) => {
    if (phase.end <= nowMs) return;
    if (noise && phase.kind === 'focus') {
      noiseGain.gain.setValueAtTime(NOISE_LEVEL, Math.max(base, at(phase.start)));
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
