// Fixed window per key. Keys are forgotten once their window is over, so IPs are not kept.
export function createRateLimiter({ max, windowMs, now = Date.now }) {
  const hits = new Map();
  return {
    allow(key) {
      const t = now();
      const entry = hits.get(key);
      if (!entry || t - entry.since >= windowMs) {
        hits.set(key, { since: t, count: 1 });
        return true;
      }
      if (entry.count >= max) return false;
      entry.count++;
      return true;
    },
    sweep() {
      const t = now();
      for (const [key, entry] of hits) if (t - entry.since >= windowMs) hits.delete(key);
    },
  };
}
