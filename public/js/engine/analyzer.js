// Chat-based "viral moment" detector. Scores each second of chat and fires when the
// recent window spikes far above the rolling baseline.

const CATEGORY_WORDS = {
  funny: ['lul', 'lol', 'lmao', 'lmfao', 'kekw', 'omegalul', 'icant', 'kek', 'haha', 'hahaha', 'xd', 'lulw', 'pepelaugh', 'dead', '💀', '😂', '🤣', 'kappa', 'aware'],
  hype: ['pog', 'poggers', 'pogchamp', 'pogu', 'w', 'ww', 'www', 'letsgo', 'lets go', 'ez', 'clutch', 'goat', 'insane', 'hype', 'gg', '🔥', 'peepoclap', 'clap', 'catjam', 'monkaw'],
  shock: ['wtf', 'omg', 'what', 'monkas', 'd:', '???', '😱', '😳', 'nooo', 'no way', 'noway', 'holy', 'bruh', 'yo'],
  sad: ['f', 'sadge', 'rip', 'l', 'pain', 'peepohands', 'biblethump', 'notlikethis', '😭', 'unlucky'],
};
const HYPE = new Map();
for (const [cat, words] of Object.entries(CATEGORY_WORDS)) for (const w of words) HYPE.set(w, cat);
const STOP = new Set('the a an and or to of in is it i you he she we they this that be are was for on at with my your me so just im its not do dont what no yes chat'.split(' '));

const norm = (t) => t.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60);

export function thresholds(sensitivity) {
  const s = Math.min(10, Math.max(1, Number(sensitivity) || 5));
  return { z: 6 - 0.4 * s, ratio: 3.2 - 0.15 * s, minMsgs: Math.max(4, 14 - s) };
}

export class HypeAnalyzer {
  constructor(opts = {}) {
    this.windowSec = opts.windowSec || 6;
    this.baselineSec = opts.baselineSec || 180;
    this.warmupSec = opts.warmupSec ?? 45;
    this.configure(opts);
    this.buckets = new Map();
    this.startedAt = null;
    this.lastMomentAt = 0;
    this.momentTimes = [];
    this.candidate = null;
  }

  configure({ sensitivity = 5, cooldownSec = 120, maxClipsPerHour = 10 } = {}) {
    this.th = thresholds(sensitivity);
    this.cooldownMs = cooldownSec * 1000;
    this.maxPerHour = maxClipsPerHour;
  }

  #bucket(sec) {
    let b = this.buckets.get(sec);
    if (!b) {
      b = { msgs: 0, users: new Set(), emotes: 0, hype: 0, caps: 0, cats: {}, texts: new Map(), tokens: new Map(), samples: [] };
      this.buckets.set(sec, b);
    }
    return b;
  }

  addMessage(m) {
    if (this.startedAt == null) this.startedAt = m.ts;
    const b = this.#bucket(Math.floor(m.ts / 1000));
    b.msgs++;
    b.users.add(m.user);
    b.emotes += m.emotes.length;
    const letters = m.text.replace(/[^A-Za-z]/g, '');
    if (letters.length >= 4 && letters === letters.toUpperCase()) b.caps++;
    const tokens = m.text.split(/\s+/).filter(Boolean);
    const seen = new Set();
    for (const raw of tokens) {
      const t = raw.toLowerCase().replace(/[.,!]+$/g, '');
      if (seen.has(t)) continue;
      seen.add(t);
      const cat = HYPE.get(t);
      if (cat) { b.hype++; b.cats[cat] = (b.cats[cat] || 0) + 1; }
      if (!STOP.has(t) && t.length <= 25) b.tokens.set(raw.replace(/[.,!]+$/g, ''), (b.tokens.get(raw.replace(/[.,!]+$/g, '')) || 0) + 1);
    }
    for (const e of m.emotes) {
      const cat = HYPE.get(e.toLowerCase());
      if (cat) b.cats[cat] = (b.cats[cat] || 0) + 1;
    }
    const n = norm(m.text);
    if (n) b.texts.set(n, (b.texts.get(n) || 0) + 1);
    if (b.samples.length < 8 && m.text.length <= 120) b.samples.push({ user: m.user, text: m.text });
  }

  #score(b) {
    if (!b) return 0;
    let repeat = 0;
    for (const c of b.texts.values()) if (c > 1) repeat += c - 1;
    return b.msgs + 0.6 * b.emotes + 1.5 * b.hype + 0.5 * b.caps + 0.5 * repeat;
  }

  tick(now = Date.now()) {
    const cur = Math.floor(now / 1000) - 1; // last complete second
    for (const k of this.buckets.keys()) if (k < cur - this.baselineSec - 30) this.buckets.delete(k);

    const W = this.windowSec;
    const from = Math.max(cur - this.baselineSec, this.startedAt != null ? Math.floor(this.startedAt / 1000) : cur);
    const series = [];
    for (let s = from; s <= cur; s++) series.push(this.#score(this.buckets.get(s)));
    const sums = [];
    let acc = 0;
    for (let i = 0; i < series.length; i++) {
      acc += series[i];
      if (i >= W) acc -= series[i - W];
      if (i >= W - 1) sums.push(acc);
    }
    const current = sums[sums.length - 1] || 0;
    const base = sums.slice(0, Math.max(1, sums.length - 2 * W));
    const mean = base.length ? base.reduce((a, v) => a + v, 0) / base.length : 0;
    const std = base.length ? Math.sqrt(base.reduce((a, v) => a + (v - mean) ** 2, 0) / base.length) : 0;
    const z = (current - mean) / Math.max(std, 1, mean * 0.15);
    const ratio = current / Math.max(mean, 1);

    let windowMsgs = 0;
    for (let s = cur - W + 1; s <= cur; s++) windowMsgs += this.buckets.get(s)?.msgs || 0;
    let baseMsgs = 0, baseSecs = 0;
    for (let s = from; s <= cur - 2 * W; s++) { baseMsgs += this.buckets.get(s)?.msgs || 0; baseSecs++; }
    const rates = [];
    for (let s = cur - 119; s <= cur; s++) rates.push(this.buckets.get(s)?.msgs || 0);

    const warm = this.startedAt != null && now - this.startedAt >= this.warmupSec * 1000;
    const hot = warm && z >= this.th.z && ratio >= this.th.ratio && windowMsgs >= this.th.minMsgs;
    const stats = {
      ts: now, rate: windowMsgs / W, baseline: baseSecs ? baseMsgs / baseSecs : 0, z: +z.toFixed(2), ratio: +ratio.toFixed(2),
      heat: warm ? Math.max(0, Math.min(1.5, z / this.th.z)) : 0, warm, rates,
    };

    let moment = null;
    if (hot && this.#canFire(now)) {
      if (!this.candidate) this.candidate = { since: now, peakSec: cur, peakScore: series[series.length - 1], z, ratio };
    }
    if (this.candidate) {
      const sc = series[series.length - 1];
      if (sc > this.candidate.peakScore) Object.assign(this.candidate, { peakSec: cur, peakScore: sc });
      if (z > this.candidate.z) this.candidate.z = z;
      if (ratio > this.candidate.ratio) this.candidate.ratio = ratio;
      if (now - this.candidate.since >= 4000 || !hot) {
        moment = this.#buildMoment(this.candidate, stats.baseline);
        this.candidate = null;
        this.lastMomentAt = now;
        this.momentTimes.push(now);
      }
    }
    return { stats, moment };
  }

  #canFire(now) {
    this.momentTimes = this.momentTimes.filter((t) => now - t < 3600_000);
    return now - this.lastMomentAt >= this.cooldownMs && this.momentTimes.length < this.maxPerHour;
  }

  /** What the analyzer has learned (the chat baseline), as plain JSON, to survive a server restart. */
  exportState() {
    const buckets = [];
    for (const [sec, b] of this.buckets) {
      buckets.push([sec, { ...b, users: [...b.users], texts: [...b.texts], tokens: [...b.tokens] }]);
    }
    return { startedAt: this.startedAt, lastMomentAt: this.lastMomentAt, momentTimes: this.momentTimes, buckets };
  }

  /** Continue from exportState() (seconds without chat while the server was down simply count as quiet). */
  importState(s) {
    if (!s || !Array.isArray(s.buckets)) return false;
    this.startedAt = s.startedAt ?? null;
    this.lastMomentAt = s.lastMomentAt || 0;
    this.momentTimes = Array.isArray(s.momentTimes) ? s.momentTimes : [];
    this.buckets = new Map(s.buckets.map(([sec, b]) => [sec, { ...b, users: new Set(b.users), texts: new Map(b.texts), tokens: new Map(b.tokens) }]));
    return true;
  }

  // Manual "Clip now" moment for an explicit time.
  manualMoment(now = Date.now()) {
    const cur = Math.floor(now / 1000) - 1;
    return this.#buildMoment({ peakSec: cur, z: 0, ratio: 1, manual: true }, 0);
  }

  #buildMoment(c, baselineRate) {
    const W = this.windowSec;
    const users = new Set(), cats = {}, texts = new Map(), tokens = new Map(), samples = [];
    let msgs = 0, peakRate = 0;
    for (let s = c.peakSec - W; s <= c.peakSec + 2; s++) {
      const b = this.buckets.get(s);
      if (!b) continue;
      msgs += b.msgs;
      peakRate = Math.max(peakRate, b.msgs);
      b.users.forEach((u) => users.add(u));
      for (const [k, v] of Object.entries(b.cats)) cats[k] = (cats[k] || 0) + v;
      for (const [k, v] of b.texts) texts.set(k, (texts.get(k) || 0) + v);
      for (const [k, v] of b.tokens) tokens.set(k, (tokens.get(k) || 0) + v);
      samples.push(...b.samples);
    }
    const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
    const category = Object.entries(cats).sort((a, b) => b[1] - a[1])[0]?.[0] || 'hype';
    const topWords = top(tokens, 6).filter(([, v]) => v > 1);
    const topMessages = top(texts, 5).filter(([, v]) => v > 1).map(([t, n]) => ({ text: t, count: n }));
    // Absolute spike strength, independent of the user's sensitivity setting.
    const score = c.manual ? 50 : Math.round(Math.min(99, Math.max(1,
      20 + 8 * c.z + 15 * Math.log2(Math.max(1, c.ratio)))));
    const reasonBits = [];
    if (!c.manual) reasonBits.push(`Chat spiked ${c.ratio.toFixed(1)}× above normal (${peakRate} msgs/sec peak, ${users.size} chatters)`);
    else reasonBits.push('Manually clipped');
    if (topWords.length) reasonBits.push(`spamming ${topWords.slice(0, 3).map(([w]) => `"${w}"`).join(', ')}`);
    return {
      peakTs: c.peakSec * 1000 + 500,
      score, category, manual: Boolean(c.manual),
      z: +(c.z || 0).toFixed(2), ratio: +(c.ratio || 1).toFixed(2),
      msgs, chatters: users.size, peakRate, baselineRate: +baselineRate.toFixed(2),
      topWords: topWords.map(([w, n]) => ({ word: w, count: n })),
      topMessages,
      samples: samples.slice(0, 6),
      reason: reasonBits.join(' — '),
    };
  }
}
