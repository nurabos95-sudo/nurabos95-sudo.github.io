// Prüfung der Online-Ergebnisse (Tages-Challenge und Duelle): Die App schickt ein Wort-Protokoll mit, der Server rechnet nach.
// Geprüft wird: Wort steht im Wörterbuch (Bloom-Filter, server/dict), Punkte stimmen (gleiche Rechnung wie in der App: score.js),
// Joker/Veredelungen/Boss passen zur Runde, Rundenziele wurden erreicht, Summe und Rundenzahl stimmen, nicht unmenschlich schnell.
// Ergebnis: null = in Ordnung, sonst ein kurzer Grund. Auffällige Ergebnisse werden nicht abgelehnt, sondern still aus Ranglisten
// und Wertung genommen (der Spieler sieht sein Ergebnis weiter) – so lernen Schummler nicht, was auffällt.
import { scoreCore, LETTER_VALS } from "./score.js";

// ── Wörterbuch: Bloom-Filter je Sprache (tools/make_bloom.py) ──
const BLOOMS = {};
export const setBlooms = (map) => { for (const [k, buf] of Object.entries(map)) BLOOMS[k] = buf instanceof Uint8Array ? buf : new Uint8Array(buf); };
const fnv = (bytes, h = 0x811c9dc5) => { for (const x of bytes) h = Math.imul(h ^ x, 0x01000193) >>> 0; return h >>> 0; };
const enc = new TextEncoder();
export const inDict = (lang, w) => {
  const b = BLOOMS[lang]; if (!b) return true; // ohne Wörterbuch nicht prüfen
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), m = dv.getUint32(0, true), k = dv.getUint32(4, true);
  const by = enc.encode(w), h1 = fnv(by), h2 = (fnv(by, 0x2545f491) | 1) >>> 0;
  for (let i = 0; i < k; i++) { const j = (h1 + i * h2) % m; if (!(b[8 + (j >> 3)] & (1 << (j & 7)))) return false; }
  return true;
};

// ── Rundenziele (wie targetFor in der App, Stufe 1) ──
const TARGETS = [50, 110, 190, 330, 560, 850, 1200, 1600, 2000, 2600, 3400, 4100];
const LANG_TARGET = { es: 1.08, fr: 1.02, pt: 1.04 };
const WIN_ROUND = 12;
export const targetOf = (r, rules, lang) => {
  const last = TARGETS[TARGETS.length - 1];
  let t = r <= TARGETS.length ? TARGETS[r - 1] : Math.round(last * Math.pow(1.4, r - TARGETS.length));
  t = Math.round(t * (LANG_TARGET[lang] || 1));
  if (rules.includes("zoll")) t = Math.round(t * 1.25);
  if (rules.includes("ziel85")) t = Math.round(t * 0.85);
  if (rules.includes("mauer")) t = Math.round(t * 0.7);
  return t;
};
const isBossRound = (r) => r % WIN_ROUND === 0 || r % 3 === 0;

const MAX_WORDS_ROUND = 8, JOKER_SLOTS = 5;
const isInt = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;
// log: [{ r, w, c, p, j, e, b, f, l, d, m, ws, rw, sw, cap }], res: { lang, rounds, points, secs, len? (Duell) }
export const verifyLog = (log, res) => {
  if (!Array.isArray(log)) return "nolog";
  if (log.length > 200) return "long";
  const LV = LETTER_VALS[res.lang]; if (!LV) return "lang";
  if (!log.length) return res.points === 0 ? null : "sum";
  const rounds = new Map();
  let sum = 0, dudens = 0;
  for (let i = 0; i < log.length; i++) {
    const x = log[i] || {};
    if (!isInt(x.r, 1, 60) || (i && x.r < log[i - 1].r)) return "round";
    const w = String(x.w || ""), c = String(x.c || "");
    if (!/^\p{Lu}{3,9}$/u.test(w) || [...c].length !== [...w].length) return "word";
    const cs = [...c], ws = [...w];
    if (cs.some((ch, k) => ch !== "★" && ch !== ws[k])) return "letters";
    if (!inDict(res.lang, w)) return "dict:" + w;
    const j = Array.isArray(x.j) ? x.j.map(String) : null;
    if (!j || j.length > JOKER_SLOTS || new Set(j).size !== j.length) return "jokers";
    const e = x.e && typeof x.e === "object" ? x.e : {};
    const ek = Object.keys(e);
    if (ek.some((k) => !cs.includes(k) || (e[k] !== "gold" && e[k] !== "kristall")) || ek.length > 2 * x.r) return "enh";
    const b = Array.isArray(x.b) ? x.b.map(String) : null;
    if (!b || b.length > 4 || b.some((r) => !/^[a-z0-9]{2,12}$/.test(r))) return "boss";
    if (isBossRound(x.r) !== b.length > 0) return "bossround";
    if (!isInt(x.m, 0, 999) || !isInt(x.ws, 0, MAX_WORDS_ROUND) || !isInt(x.rw, 0, 200) || !isInt(x.sw, 0, 12) || !isInt(x.cap, 0, 1e7)) return "fields";
    const R = rounds.get(x.r) || { sum: 0, n: 0, rules: b, last: false };
    if (R.last) return "afterlast";                        // nach dem letzten Zug der Runde kommt kein Wort mehr
    if (x.ws !== R.n || x.rw !== i) return "count";
    if (x.f && x.ws !== 0) return "first";
    if (JSON.stringify(b) !== JSON.stringify(R.rules)) return "bosschange";
    const target = targetOf(x.r, b, res.lang);
    if (b.includes("deckel") ? x.cap > Math.round(target * 0.4) + 1 : x.cap !== 0) return "cap";
    if (x.d) dudens++;
    const opts = { isLastPlay: !!x.l, isFirstPlay: !!x.f, wordsSoFar: x.ws, moneyNow: x.m, roundNum: x.r, runWordsNow: x.rw, swapsNow: x.sw,
      duden: !!x.d, cap: x.cap, secret: null, theme: null, bossRules: b };
    const sc = scoreCore(w, cs, j, e, opts, LV).total;
    if (!isInt(x.p, 0, 1e8) || sc !== x.p) return `score:${w}:${x.p}/${sc}`;
    R.sum += sc; R.n++; if (x.l) R.last = true;
    if (R.n > MAX_WORDS_ROUND) return "words";
    rounds.set(x.r, R);
    sum += sc;
  }
  if (dudens > rounds.size + 2) return "duden";
  if (sum !== res.points) return "sum";
  // Runden: 1..rounds geschafft (Ziel erreicht), eine weitere Runde darf verloren sein
  const maxR = log[log.length - 1].r;
  if (res.rounds !== maxR && res.rounds !== maxR - 1) return "rounds";
  for (let r = 1; r <= maxR; r++) {
    const R = rounds.get(r);
    if (!R) return "gap";
    const t = targetOf(r, R.rules, res.lang), won = R.sum >= t;
    if (r <= res.rounds && !won) return "target";
    if (r > res.rounds && won) return "lost";
  }
  if (res.len && res.rounds > res.len) return "len";
  if (res.secs < Math.ceil(log.length * 1.5)) return "fast";
  return null;
};
