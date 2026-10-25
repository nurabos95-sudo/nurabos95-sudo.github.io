// Wortpoker online – Cloudflare Worker mit D1-Datenbank (Binding „DB“).
// Stufe 1: Ranglisten der Tages-Challenge (je Sprache, Filter Land) und Wochen-Liga (Gruppen à 30, Auf- und Abstieg).
// Alle Antworten sind JSON. Spieler melden sich ohne Konto an: das Gerät bekommt eine geheime ID + Schlüssel.
import { cleanName } from "./names.js";
import { verifyLog } from "./verify.js";

const LANGS = ["de", "en", "es", "fr", "pt"];
export const TIERS = 7;            // 0 Bronze, 1 Silber, 2 Gold, 3 Smaragd, 4 Saphir, 5 Rubin, 6 Diamant
export const GROUP = 30;           // Spieler je Liga-Gruppe
export const PROMOTE = 7, DEMOTE = 5;
const XP_PER_CALL = 5000, XP_PER_DAY = 12000;

// ── Hilfen ──
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "content-type", "Access-Control-Max-Age": "86400" };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS } });
const fail = (code, status = 400) => json({ ok: false, error: code }, status);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
const randHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const PUB_ABC = "abcdefghjkmnpqrstuvwxyz23456789";
const randPub = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => PUB_ABC[b % PUB_ABC.length]).join("");
const int = (v, lo, hi) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
const utcDay = (ts) => new Date(ts).toISOString().slice(0, 10);

// ISO-Kalenderwoche in UTC: Montag 00:00 bis Sonntag 24:00
export function weekOf(ts) {
  const d = new Date(ts); const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dd = new Date(t); const day = dd.getUTCDay() || 7; dd.setUTCDate(dd.getUTCDate() + 4 - day);
  const y0 = Date.UTC(dd.getUTCFullYear(), 0, 1);
  return `${dd.getUTCFullYear()}-W${String(Math.ceil(((dd - y0) / 86400000 + 1) / 7)).padStart(2, "0")}`;
}
export function weekEnd(ts) { // Zeitpunkt, an dem die Woche von ts endet
  const d = new Date(ts); const day = d.getUTCDay() || 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + (8 - day));
}

const cleanLook = (l) => {
  if (!l || typeof l !== "object") return "{}";
  const o = {};
  for (const k of ["char", "hat", "glasses", "outfit", "pin", "color", "hair", "hcol", "beard", "tone"]) { const n = int(l[k], 0, 99); if (n != null) o[k] = n; }
  for (const k of ["frame", "skin", "nfx", "dance"]) if (typeof l[k] === "string" && /^[a-z0-9-]{1,24}$/.test(l[k])) o[k] = l[k];
  return JSON.stringify(o);
};
// Profil-Statistik: nur bekannte Zahlen, bis zu 5 Vitrinen-Stücke (Erfolge, „b-…“ = Abzeichen) und die Abzeichen
const STAT_KEYS = ["ach", "achTotal", "duels", "duelWins", "ghosts", "record", "stars", "bosses", "games", "words", "wins"];
const cleanStats = (st) => {
  if (!st || typeof st !== "object") return "{}";
  const o = {};
  for (const k of STAT_KEYS) { const n = int(st[k], 0, 100000000); if (n != null) o[k] = n; }
  if (Array.isArray(st.showcase)) o.showcase = st.showcase.filter((x) => typeof x === "string" && /^[a-z0-9-]{1,24}$/i.test(x)).slice(0, 5);
  if (Array.isArray(st.badges)) o.badges = st.badges.filter((x) => typeof x === "string" && /^[a-z0-9-]{1,20}$/.test(x)).slice(0, 80);
  return JSON.stringify(o);
};
const cleanCountry = (c) => (typeof c === "string" && /^[A-Z]{2}$/.test(c) ? c : "");
const trophyCount = (t) => Object.values(safeParse(t)).reduce((a, v) => a + (Array.isArray(v) ? v[0] + v[1] + v[2] : 0), 0);
const publicRow = (r, me) => ({ pub: r.pub, name: r.hidden ? null : r.name, country: r.country, gold: !!r.gold, look: safeParse(r.look), tro: trophyCount(r.trophies) || undefined, me: r.id === me || undefined });
// Kronen je Platz (Wochen-Liga): 1. 12, 2. 8, 3. 6, Aufstiegszone 3, sonst 1 – höhere Ligen geben mehr (× (4 + Stufe) / 4)
export const CROWN_SQL = `((CASE WHEN rk = 1 THEN 12 WHEN rk = 2 THEN 8 WHEN rk = 3 THEN 6 WHEN rk <= ${PROMOTE} THEN 3 ELSE 1 END) * (4 + tier)) / 4`;
const safeParse = (s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };

async function auth(env, b) {
  if (typeof b.id !== "string" || typeof b.token !== "string" || b.id.length !== 32) return null;
  const p = await env.DB.prepare("SELECT * FROM players WHERE id = ?").bind(b.id).first();
  if (!p || p.token_hash !== (await sha256(b.token))) return null;
  return p;
}

// ── Wochen-Liga ──
// Woche abschließen (einmalig, sobald sie vorbei ist): Rang je Gruppe, Top 7 steigen auf, die letzten 5 ab (bei Gruppen ab 10 Spielern)
export async function finalizeWeek(env, week, now = Date.now()) {
  const done = await env.DB.prepare("SELECT v FROM meta WHERE k = ?").bind("final:" + week).first();
  if (done) return false;
  const any = await env.DB.prepare("SELECT last_at FROM league_members WHERE week = ? LIMIT 1").bind(week).first();
  if (any && weekEnd(any.last_at) > now) return false; // Woche läuft noch
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO league_results (week, player, tier, grp, rank, size, new_tier, claimed, crowns)
      SELECT week, player, tier, grp, rk, sz,
        CASE WHEN rk <= ${PROMOTE} AND tier < ${TIERS - 1} THEN tier + 1
             WHEN sz >= 10 AND rk > sz - ${DEMOTE} AND tier > 0 THEN tier - 1 ELSE tier END, 0, ${CROWN_SQL}
      FROM (SELECT week, player, tier, grp,
              ROW_NUMBER() OVER (PARTITION BY grp ORDER BY xp DESC, last_at ASC) AS rk,
              COUNT(*) OVER (PARTITION BY grp) AS sz
            FROM league_members WHERE week = ? AND xp > 0)`).bind(week),
    env.DB.prepare(`UPDATE players SET tier = (SELECT new_tier FROM league_results r WHERE r.week = ? AND r.player = players.id), weeks = weeks + 1,
        best_tier = MAX(best_tier, (SELECT new_tier FROM league_results r WHERE r.week = ? AND r.player = players.id))
      WHERE id IN (SELECT player FROM league_results WHERE week = ?)`).bind(week, week, week),
    env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)").bind("final:" + week, String(now)),
  ]);
  // Pokale für Platz 1–3 (Gold, Silber, Bronze) je Liga-Stufe
  const pods = await env.DB.prepare(`SELECT r.player, r.tier, r.rank, p.trophies FROM league_results r JOIN players p ON p.id = r.player WHERE r.week = ? AND r.rank <= 3`).bind(week).all();
  const ups = pods.results.map((r) => {
    const t = safeParse(r.trophies), k = String(r.tier), a = Array.isArray(t[k]) ? t[k] : [0, 0, 0];
    a[r.rank - 1] += 1; t[k] = a;
    return env.DB.prepare("UPDATE players SET trophies = ? WHERE id = ?").bind(JSON.stringify(t), r.player);
  });
  for (let i = 0; i < ups.length; i += 50) await env.DB.batch(ups.slice(i, i + 50));
  return true;
}
const prevWeek = (now) => weekOf(now - 7 * 86400000);
// Alte Ergebnisse löschen (versprochen in der Datenschutzerklärung: nach spätestens 12 Monaten)
export async function cleanup(env, now) {
  const cut = now - 365 * 86400000, wk = weekOf(cut), day = utcDay(cut);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM daily WHERE at < ?").bind(cut),
    env.DB.prepare("DELETE FROM league_members WHERE last_at < ?").bind(cut),
    env.DB.prepare("DELETE FROM league_results WHERE week < ?").bind(wk),
    env.DB.prepare("DELETE FROM xp_days WHERE day < ?").bind(day),
    env.DB.prepare("DELETE FROM reports WHERE at < ?").bind(cut),
    env.DB.prepare("DELETE FROM matches WHERE created < ?").bind(now - 60 * 86400000),
    env.DB.prepare("DELETE FROM flags WHERE at < ?").bind(now - 90 * 86400000),
    env.DB.prepare("DELETE FROM arena_results WHERE at < ?").bind(now - 60 * 86400000),
  ]);
}

async function leagueState(env, p, now) {
  const week = weekOf(now);
  await finalizeWeek(env, prevWeek(now), now);
  const fresh = await env.DB.prepare("SELECT tier, trophies, best_tier, weeks FROM players WHERE id = ?").bind(p.id).first();
  const me = await env.DB.prepare("SELECT * FROM league_members WHERE week = ? AND player = ?").bind(week, p.id).first();
  let members = [];
  if (me) {
    const rows = await env.DB.prepare(`SELECT m.xp, m.player, p.id, p.pub, p.name, p.country, p.gold, p.look, p.hidden, p.trophies
      FROM league_members m JOIN players p ON p.id = m.player WHERE m.week = ? AND m.grp = ? ORDER BY m.xp DESC, m.last_at ASC`).bind(week, me.grp).all();
    members = rows.results.map((r, i) => ({ rank: i + 1, xp: r.xp, ...publicRow(r, p.id) }));
  }
  const last = await env.DB.prepare("SELECT * FROM league_results WHERE player = ? AND claimed = 0 ORDER BY week DESC LIMIT 1").bind(p.id).first();
  return {
    ok: true, week, endsAt: weekEnd(now), tier: me ? me.tier : fresh.tier, joined: !!me, members, promote: PROMOTE, demote: DEMOTE, group: GROUP,
    result: last ? { week: last.week, rank: last.rank, size: last.size, tier: last.tier, newTier: last.new_tier, crowns: last.crowns } : null,
    mine: { trophies: safeParse(fresh.trophies), bestTier: fresh.best_tier, weeks: fresh.weeks },
  };
}

async function addXp(env, p, xp, now) {
  const day = utcDay(now), week = weekOf(now);
  const used = await env.DB.prepare("SELECT xp FROM xp_days WHERE player = ? AND day = ?").bind(p.id, day).first();
  const add = Math.max(0, Math.min(xp, XP_PER_DAY - (used ? used.xp : 0)));
  await finalizeWeek(env, prevWeek(now), now);
  let me = await env.DB.prepare("SELECT * FROM league_members WHERE week = ? AND player = ?").bind(week, p.id).first();
  if (!me) {
    // Gruppe suchen: gleiche Sprache und Liga-Stufe, je 30 Spieler (die n-te Gruppe füllt sich, dann kommt die nächste)
    const tier = (await env.DB.prepare("SELECT tier FROM players WHERE id = ?").bind(p.id).first()).tier;
    const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM league_members WHERE week = ? AND lang = ? AND tier = ?").bind(week, p.lang, tier).first()).n;
    const grp = `${p.lang}-${tier}-${Math.floor(n / GROUP)}`;
    await env.DB.prepare("INSERT OR IGNORE INTO league_members (week, player, lang, tier, grp, xp, last_at) VALUES (?, ?, ?, ?, ?, 0, ?)")
      .bind(week, p.id, p.lang, tier, grp, now).run();
  }
  if (add > 0) {
    await env.DB.batch([
      env.DB.prepare("UPDATE league_members SET xp = xp + ?, last_at = ? WHERE week = ? AND player = ?").bind(add, now, week, p.id),
      env.DB.prepare("INSERT INTO xp_days (player, day, xp) VALUES (?, ?, ?) ON CONFLICT (player, day) DO UPDATE SET xp = xp + excluded.xp").bind(p.id, day, add),
    ]);
  }
  return add;
}

// ── Tages-Challenge ──
// Top 50 und Gesamtzahl je Tag/Sprache/Land kurz zwischenspeichern (spart Datenbank-Lesezugriffe, wenn viele gleichzeitig schauen)
const boardCache = new Map();
export const clearCache = () => boardCache.clear();
async function dailyBoard(env, day, lang, country, meId, fresh = false) {
  const where = (country ? "d.day = ? AND d.lang = ? AND p.country = ?" : "d.day = ? AND d.lang = ?") + " AND d.flag = 0";
  const args = country ? [day, lang, country] : [day, lang];
  const ck = `${day}|${lang}|${country || ""}`, hit = boardCache.get(ck);
  let top, total;
  if (hit && !fresh && Date.now() - hit.at < 30000) ({ top, total } = hit);
  else {
    top = (await env.DB.prepare(`SELECT d.rounds, d.points, d.secs, p.id, p.pub, p.name, p.country, p.gold, p.look, p.hidden, p.trophies
      FROM daily d JOIN players p ON p.id = d.player WHERE ${where} ORDER BY d.rounds DESC, d.points DESC, d.secs ASC LIMIT 50`).bind(...args).all()).results;
    total = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM daily d JOIN players p ON p.id = d.player WHERE ${where}`).bind(...args).first()).n;
    if (boardCache.size > 500) boardCache.clear();
    boardCache.set(ck, { top, total, at: Date.now() });
  }
  let me = null;
  if (meId) {
    const m = await env.DB.prepare("SELECT * FROM daily WHERE day = ? AND lang = ? AND player = ?").bind(day, lang, meId).first();
    if (m) {
      const better = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM daily d JOIN players p ON p.id = d.player WHERE ${where}
        AND (d.rounds > ? OR (d.rounds = ? AND d.points > ?) OR (d.rounds = ? AND d.points = ? AND d.secs < ?))`)
        .bind(...args, m.rounds, m.rounds, m.points, m.rounds, m.points, m.secs).first()).n;
      me = { rank: better + 1, rounds: m.rounds, points: m.points, secs: m.secs };
      if (m.flag) { // auffälliges Ergebnis: nur für den Spieler selbst in der Liste
        total += 1;
        const pr = await env.DB.prepare("SELECT * FROM players WHERE id = ?").bind(meId).first();
        if (pr && (!country || pr.country === country) && better < 50) top = [...top.slice(0, better), { ...m, ...pr, id: meId }, ...top.slice(better)].slice(0, 50);
      }
    }
  }
  return { ok: true, day, lang, country: country || null, total, me,
    top: top.map((r, i) => ({ rank: i + 1, rounds: r.rounds, points: r.points, secs: r.secs, ...publicRow(r, meId) })) };
}

// ── Freunde ──
// Freundescode „Name#1234“: der Name allein ist nicht eindeutig, die 4 Ziffern machen ihn eindeutig.
const MAX_FRIENDS = 200;
async function freeTag(env, name, selfId = "") {
  for (let i = 0; i < 20; i++) {
    const tag = 1000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 9000);
    if (!(await env.DB.prepare("SELECT 1 FROM players WHERE name = ? COLLATE NOCASE AND tag = ? AND id != ?").bind(name, tag, selfId).first())) return tag;
  }
  return 1000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 9000);
}
const friendRow = (r, meId) => ({ ...publicRow(r, meId), tag: r.tag, level: r.level, rating: r.rating, lang: r.lang });
async function findPlayer(env, b) {
  if (typeof b.target === "string" && b.target) return env.DB.prepare("SELECT * FROM players WHERE pub = ?").bind(b.target).first();
  const m = /^(.{2,14})#(\d{4})$/u.exec(String(b.code || "").trim());
  return m ? env.DB.prepare("SELECT * FROM players WHERE name = ? COLLATE NOCASE AND tag = ? AND hidden = 0").bind(m[1].trim(), Number(m[2])).first() : null;
}
async function friendList(env, p) {
  const rows = (await env.DB.prepare(`SELECT p.*, f.w AS fw, f.l AS fl, f.t AS ft, f.created AS since FROM friends f JOIN players p ON p.id = f.friend
      WHERE f.player = ? ORDER BY p.name COLLATE NOCASE LIMIT ${MAX_FRIENDS}`).bind(p.id).all()).results;
  return rows.map((r) => ({ ...friendRow(r, p.id), w: r.fw, l: r.fl, t: r.ft, since: r.since }));
}
// Bilanz unter Freunden weiterzählen (beide Richtungen)
const friendTally = (env, aId, bId, win) => [
  env.DB.prepare("UPDATE friends SET w = w + ?, l = l + ?, t = t + ? WHERE player = ? AND friend = ?").bind(win === 1 ? 1 : 0, win === -1 ? 1 : 0, win === 0 ? 1 : 0, aId, bId),
  env.DB.prepare("UPDATE friends SET w = w + ?, l = l + ?, t = t + ? WHERE player = ? AND friend = ?").bind(win === -1 ? 1 : 0, win === 1 ? 1 : 0, win === 0 ? 1 : 0, bId, aId),
];

// Ergebnis prüfen (verify.js); env.VERIFY = "off" schaltet die Prüfung ab (nur für Tests)
async function check(env, p, kind, log, res, now) {
  if (env.VERIFY === "off") return 0;
  let why; try { why = verifyLog(log, res); } catch (e) { why = "error"; }
  if (!why) return 0;
  await env.DB.prepare("INSERT INTO flags (player, kind, reason, at) VALUES (?, ?, ?, ?)").bind(p.id, kind, String(why).slice(0, 80), now).run();
  return 1;
}

// ── Online-Duelle (wie Quizduell: gleiche Karten, nacheinander) ──
// Ablauf: start → A spielt → submit (open) → B bekommt das Duell bei start (claimed) → B spielt → submit (done, Wertung für beide).
// Herausforderung (Revanche): challenge {target} legt ein Duell an, das nur target annehmen kann.
const CLAIM_TIMEOUT = 2 * 3600000;   // B spielt nicht zu Ende → nach 2 Stunden wieder frei für andere
const duelWin = (ap, as, bp, bs) => (ap !== bp ? (ap > bp ? 1 : -1) : as !== bs ? (as < bs ? 1 : -1) : 0);
const elo = (ra, rb, res) => { const ea = 1 / (1 + Math.pow(10, (rb - ra) / 400)); return Math.round(24 * ((res === 1 ? 1 : res === 0 ? 0.5 : 0) - ea)); };
const matchView = (m, meId, opp) => {
  const mine = m.a === meId ? "a" : "b", other = mine === "a" ? "b" : "a", done = m.status === "done";
  return { id: m.id, seed: m.seed, len: m.len, status: m.status, role: mine, created: m.created, finished: m.finished || null,
    me: m[mine + "_points"] == null ? null : { points: m[mine + "_points"], secs: m[mine + "_secs"], rounds: m[mine + "_rounds"] },
    opp: opp ? { ...publicRow(opp, meId), level: opp.level, rating: opp.rating, ...(done ? { points: m[other + "_points"], secs: m[other + "_secs"], rounds: m[other + "_rounds"] } : {}) } : null,
    delta: done ? m[mine + "_delta"] : null, seen: !!m[mine + "_seen"], challenge: !!m.target };
};
async function matchStart(env, p, len, now) {
  // 1. offenes Duell eines anderen Spielers mit ähnlicher Wertung (gleiche Sprache und Länge), nicht gegen sich selbst
  const cand = await env.DB.prepare(`SELECT * FROM matches WHERE lang = ? AND len = ? AND a != ? AND target IS NULL
      AND a_flag = 0 AND (status = 'open' OR (status = 'claimed' AND claimed < ?)) ORDER BY ABS(a_rating - ?) ASC, created ASC LIMIT 5`)
    .bind(p.lang, len, p.id, now - CLAIM_TIMEOUT, p.rating).all();
  for (const m of cand.results) {
    const r = await env.DB.prepare("UPDATE matches SET status = 'claimed', b = ?, claimed = ? WHERE id = ? AND (status = 'open' OR (status = 'claimed' AND claimed < ?))")
      .bind(p.id, now, m.id, now - CLAIM_TIMEOUT).run();
    if (r.meta && r.meta.changes > 0) {
      const opp = await env.DB.prepare("SELECT * FROM players WHERE id = ?").bind(m.a).first();
      return { ...matchView({ ...m, status: "claimed", b: p.id }, p.id, opp), fresh: false };
    }
  }
  // 2. sonst ein neues Duell anlegen – du spielst zuerst, ein anderer bekommt danach dieselben Karten
  const id = randHex(10), seed = crypto.getRandomValues(new Uint32Array(1))[0];
  await env.DB.prepare("INSERT INTO matches (id, seed, len, lang, status, a, a_rating, created) VALUES (?, ?, ?, ?, 'playing_a', ?, ?, ?)")
    .bind(id, seed, len, p.lang, p.id, p.rating, now).run();
  return { id, seed, len, status: "playing_a", role: "a", me: null, opp: null, fresh: true };
}
async function matchSubmit(env, p, b, now) {
  const m = await env.DB.prepare("SELECT * FROM matches WHERE id = ?").bind(String(b.mid || "")).first();
  if (!m) return { error: "match" };
  const points = int(b.points, 0, 50000000), secs = int(b.secs, 1, 86400), rounds = int(b.rounds, 0, 20);
  if (points == null || secs == null || rounds == null || rounds > m.len) return { error: "score" };
  const res = { lang: m.lang, rounds, points, secs, len: m.len };
  if (m.a === p.id && m.status === "playing_a") {
    const flag = await check(env, p, "duel", b.log, res, now);
    await env.DB.prepare("UPDATE matches SET a_points = ?, a_secs = ?, a_rounds = ?, a_flag = ?, status = 'open' WHERE id = ? AND status = 'playing_a'").bind(points, secs, rounds, flag, m.id).run();
    const opp = m.target ? await env.DB.prepare("SELECT * FROM players WHERE id = ?").bind(m.target).first() : null;
    return { match: matchView({ ...m, status: "open", a_points: points, a_secs: secs, a_rounds: rounds }, p.id, opp) };
  }
  if (m.b === p.id && m.status === "claimed") {
    const a = await env.DB.prepare("SELECT * FROM players WHERE id = ?").bind(m.a).first();
    const bflag = await check(env, p, "duel", b.log, res, now), rated = a && !bflag && !m.a_flag; // auffällig → Duell zählt nicht für die Wertung
    const win = duelWin(points, secs, m.a_points, m.a_secs); // aus Sicht von B
    const db = rated ? elo(p.rating, a.rating, win) : null, da = rated ? elo(a.rating, p.rating, -win) : null;
    const stmts = [
      env.DB.prepare("UPDATE matches SET b_points = ?, b_secs = ?, b_rounds = ?, b_flag = ?, status = 'done', finished = ?, a_delta = ?, b_delta = ?, b_seen = 1 WHERE id = ? AND status = 'claimed'")
        .bind(points, secs, rounds, bflag, now, da, db, m.id),
    ];
    const res2 = win;
    if (a && !bflag && !m.a_flag) stmts.push(...friendTally(env, p.id, a.id, win));
    if (rated) stmts.push(env.DB.prepare("UPDATE players SET rating = MAX(0, rating + ?), duels = duels + 1, duel_wins = duel_wins + ? WHERE id = ?").bind(db, res2 === 1 ? 1 : 0, p.id));
    if (rated) stmts.push(env.DB.prepare("UPDATE players SET rating = MAX(0, rating + ?), duels = duels + 1, duel_wins = duel_wins + ? WHERE id = ?").bind(da, res2 === -1 ? 1 : 0, a.id));
    await env.DB.batch(stmts);
    const done = { ...m, status: "done", b_points: points, b_secs: secs, b_rounds: rounds, finished: now, a_delta: da, b_delta: db, b_seen: 1 };
    const mine = rated ? Math.max(0, p.rating + db) : p.rating;
    return { match: matchView(done, p.id, a), rating: mine };
  }
  return { error: "state" };
}
async function matchList(env, p, now) {
  const rows = (await env.DB.prepare(`SELECT * FROM matches WHERE (a = ? OR b = ? OR (target = ? AND status = 'open')) AND created > ?
      AND NOT (a = ? AND status = 'playing_a' AND created < ?) ORDER BY COALESCE(finished, created) DESC LIMIT 30`)
    .bind(p.id, p.id, p.id, now - 30 * 86400000, p.id, now - CLAIM_TIMEOUT).all()).results;
  const ids = [...new Set(rows.flatMap((m) => [m.a, m.b, m.target]).filter((x) => x && x !== p.id))];
  const players = new Map();
  for (const id of ids) { const q = await env.DB.prepare("SELECT * FROM players WHERE id = ?").bind(id).first(); if (q) players.set(id, q); }
  return rows.map((m) => {
    const oid = m.a === p.id ? (m.b || m.target) : m.a;
    const v = matchView(m, p.id, players.get(oid) || null);
    if (m.target === p.id && m.status === "open") v.role = "invite"; // Herausforderung an mich
    return v;
  });
}

// Datenbank auf den neuesten Stand bringen (neue Spalten), einmal je Version
const SCHEMA = 7;
let migrated = false;
async function migrate(env) {
  if (migrated) return;
  const v = await env.DB.prepare("SELECT v FROM meta WHERE k = 'schema'").first().catch(() => null);
  if (!v || Number(v.v) < SCHEMA) {
    for (const sql of ["ALTER TABLE players ADD COLUMN trophies TEXT NOT NULL DEFAULT '{}'", "ALTER TABLE players ADD COLUMN best_tier INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE players ADD COLUMN weeks INTEGER NOT NULL DEFAULT 0", "ALTER TABLE players ADD COLUMN level INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE players ADD COLUMN best_word TEXT NOT NULL DEFAULT ''", "ALTER TABLE players ADD COLUMN best_score INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE league_results ADD COLUMN crowns INTEGER NOT NULL DEFAULT 0", "ALTER TABLE players ADD COLUMN stats TEXT NOT NULL DEFAULT '{}'",
      "ALTER TABLE players ADD COLUMN rating INTEGER NOT NULL DEFAULT 1000", "ALTER TABLE players ADD COLUMN duels INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE players ADD COLUMN duel_wins INTEGER NOT NULL DEFAULT 0", `CREATE TABLE IF NOT EXISTS matches (   id TEXT PRIMARY KEY, seed INTEGER NOT NULL, len INTEGER NOT NULL, lang TEXT NOT NULL,   status TEXT NOT NULL,              -- playing_a (A spielt) → open (wartet auf B) → claimed (B spielt) → done   a TEXT NOT NULL, b TEXT, target TEXT, a_rating INTEGER NOT NULL DEFAULT 1000,   a_points INTEGER, a_secs INTEGER, a_rounds INTEGER, b_points INTEGER, b_secs INTEGER, b_rounds INTEGER,   a_delta INTEGER, b_delta INTEGER, a_seen INTEGER NOT NULL DEFAULT 0, b_seen INTEGER NOT NULL DEFAULT 0,   created INTEGER NOT NULL, claimed INTEGER, finished INTEGER )`,
      "CREATE INDEX IF NOT EXISTS match_open ON matches (status, lang, len, created)", "CREATE INDEX IF NOT EXISTS match_a ON matches (a, created)",
      "CREATE INDEX IF NOT EXISTS match_b ON matches (b, created)", "CREATE INDEX IF NOT EXISTS match_t ON matches (target, status)",
      "ALTER TABLE daily ADD COLUMN flag INTEGER NOT NULL DEFAULT 0", "ALTER TABLE matches ADD COLUMN a_flag INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE matches ADD COLUMN b_flag INTEGER NOT NULL DEFAULT 0", "CREATE TABLE IF NOT EXISTS flags (player TEXT NOT NULL, kind TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL)",
      "ALTER TABLE players ADD COLUMN tag INTEGER NOT NULL DEFAULT 0", "CREATE INDEX IF NOT EXISTS player_name ON players (lang, name COLLATE NOCASE)",
      "CREATE TABLE IF NOT EXISTS friends (player TEXT NOT NULL, friend TEXT NOT NULL, created INTEGER NOT NULL, w INTEGER NOT NULL DEFAULT 0, l INTEGER NOT NULL DEFAULT 0, t INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (player, friend))",
      "CREATE TABLE IF NOT EXISTS arena_results (id INTEGER PRIMARY KEY AUTOINCREMENT, player TEXT NOT NULL, lang TEXT NOT NULL, wins INTEGER NOT NULL, seed INTEGER NOT NULL, points INTEGER NOT NULL, secs INTEGER NOT NULL, rounds INTEGER NOT NULL, flag INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL)",
      "CREATE INDEX IF NOT EXISTS arena_pick ON arena_results (lang, wins, at)"]) {
      try { await env.DB.prepare(sql).run(); } catch { /* Spalte gibt es schon */ }
    }
    await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema', ?)").bind(String(SCHEMA)).run();
  }
  migrated = true;
}

// ── Anfragen ──
async function handle(req, env, now) {
  await migrate(env);
  const url = new URL(req.url), path = url.pathname.replace(/\/+$/, "");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method === "GET" && (path === "" || path === "/v1/ping")) return json({ ok: true, service: "wortpoker", time: now });
  if (req.method !== "POST") return fail("method", 405);
  let b;
  try { b = await req.json(); } catch { return fail("json"); }
  if (!b || typeof b !== "object") return fail("json");

  if (path === "/v1/register") {
    const name = cleanName(b.name); if (!name) return fail("name");
    const lang = LANGS.includes(b.lang) ? b.lang : null; if (!lang) return fail("lang");
    const id = randHex(16), token = randHex(24), pub = randPub(), tag = await freeTag(env, name);
    await env.DB.prepare("INSERT INTO players (id, pub, token_hash, name, lang, country, gold, look, tier, hidden, created, tag) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)")
      .bind(id, pub, await sha256(token), name, lang, cleanCountry(b.country), b.gold ? 1 : 0, cleanLook(b.look), now, tag).run();
    return json({ ok: true, id, token, pub, name, tag });
  }

  const p = await auth(env, b);
  if (!p) return fail("auth", 401);
  if (!p.tag) { p.tag = await freeTag(env, p.name, p.id); await env.DB.prepare("UPDATE players SET tag = ? WHERE id = ?").bind(p.tag, p.id).run(); }

  if (path === "/v1/profile") {
    const name = b.name == null ? p.name : cleanName(b.name); if (!name) return fail("name");
    const lang = LANGS.includes(b.lang) ? b.lang : p.lang;
    const level = int(b.level, 1, 99999) ?? p.level, bw = typeof b.bestWord === "string" && /^\p{L}{3,12}$/u.test(b.bestWord) ? b.bestWord.toUpperCase() : p.best_word;
    const bs = bw === p.best_word && b.bestScore == null ? p.best_score : int(b.bestScore, 0, 10000000) ?? p.best_score;
    await env.DB.prepare("UPDATE players SET name = ?, lang = ?, country = ?, gold = ?, look = ?, hidden = CASE WHEN name = ? THEN hidden ELSE 0 END, level = ?, best_word = ?, best_score = ?, stats = ? WHERE id = ?")
      .bind(name, lang, b.country == null ? p.country : cleanCountry(b.country), b.gold == null ? p.gold : b.gold ? 1 : 0, b.look == null ? p.look : cleanLook(b.look), name, level, bw, bs,
        b.stats == null ? p.stats : cleanStats(b.stats), p.id).run();
    if (name.toLowerCase() !== p.name.toLowerCase() && (await env.DB.prepare("SELECT 1 FROM players WHERE name = ? COLLATE NOCASE AND tag = ? AND id != ?").bind(name, p.tag, p.id).first())) {
      p.tag = await freeTag(env, name, p.id); await env.DB.prepare("UPDATE players SET tag = ? WHERE id = ?").bind(p.tag, p.id).run();
    }
    boardCache.clear();
    return json({ ok: true, name, tag: p.tag });
  }
  if (path === "/v1/delete") { // alle Daten dieses Spielers löschen (Datenschutz)
    await env.DB.batch(["players WHERE id", "daily WHERE player", "league_members WHERE player", "league_results WHERE player", "xp_days WHERE player", "reports WHERE reporter", "matches WHERE a", "matches WHERE b", "flags WHERE player", "friends WHERE player", "friends WHERE friend", "arena_results WHERE player"]
      .map((t) => env.DB.prepare(`DELETE FROM ${t} = ?`).bind(p.id)));
    boardCache.clear();
    return json({ ok: true });
  }
  if (path === "/v1/daily") {
    const lang = LANGS.includes(b.lang) ? b.lang : p.lang;
    const day = typeof b.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.day) ? b.day : null; if (!day) return fail("day");
    // nur heute (± ein Tag wegen Zeitzonen) – keine alten oder zukünftigen Tage
    const dt = Date.parse(day + "T12:00:00Z"); if (!(Math.abs(dt - now) <= 40 * 3600000)) return fail("day");
    if (b.rounds != null) {
      const rounds = int(b.rounds, 0, 40), points = int(b.points, 0, 50000000), secs = int(b.secs, 1, 86400);
      if (rounds == null || points == null || secs == null) return fail("score");
      // erster Versuch zählt; spätere Einsendungen desselben Tages werden ignoriert
      const old = await env.DB.prepare("SELECT 1 FROM daily WHERE day = ? AND lang = ? AND player = ?").bind(day, lang, p.id).first();
      if (!old) {
        const flag = await check(env, p, "daily", b.log, { lang, rounds, points, secs }, now);
        await env.DB.prepare("INSERT OR IGNORE INTO daily (day, lang, player, rounds, points, secs, at, flag) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(day, lang, p.id, rounds, points, secs, now, flag).run();
      }
    }
    return json(await dailyBoard(env, day, lang, cleanCountry(b.country), p.id, b.rounds != null));
  }
  if (path === "/v1/xp") {
    const xp = int(b.xp, 0, XP_PER_CALL); if (xp == null) return fail("xp");
    const added = await addXp(env, p, xp, now);
    return json({ ...(await leagueState(env, p, now)), added });
  }
  if (path === "/v1/league") return json(await leagueState(env, p, now));
  if (path === "/v1/league/claim") {
    const r = await env.DB.prepare("UPDATE league_results SET claimed = 1 WHERE player = ? AND week = ? AND claimed = 0").bind(p.id, String(b.week || "")).run();
    return json({ ok: true, claimed: (r.meta && r.meta.changes) > 0 });
  }
  if (path === "/v1/friends") return json({ ok: true, tag: p.tag, friends: await friendList(env, p) });
  if (path === "/v1/friends/add") {
    const t = await findPlayer(env, b);
    if (!t || t.id === p.id) return fail("target");
    const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM friends WHERE player = ?").bind(p.id).first()).n;
    if (n >= MAX_FRIENDS) return fail("full");
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO friends (player, friend, created) VALUES (?, ?, ?)").bind(p.id, t.id, now),
      env.DB.prepare("INSERT OR IGNORE INTO friends (player, friend, created) VALUES (?, ?, ?)").bind(t.id, p.id, now),
    ]);
    return json({ ok: true, friend: friendRow(t, p.id), tag: p.tag, friends: await friendList(env, p) });
  }
  if (path === "/v1/friends/remove") {
    const t = await env.DB.prepare("SELECT id FROM players WHERE pub = ?").bind(String(b.target || "")).first();
    if (t) await env.DB.batch([env.DB.prepare("DELETE FROM friends WHERE player = ? AND friend = ?").bind(p.id, t.id), env.DB.prepare("DELETE FROM friends WHERE player = ? AND friend = ?").bind(t.id, p.id)]);
    return json({ ok: true, tag: p.tag, friends: await friendList(env, p) });
  }
  if (path === "/v1/friends/search") { // Namenssuche (gleiche Sprache, ausgeblendete Namen nicht)
    const q = String(b.q || "").trim().replace(/#\d*$/, "");
    if (q.length < 2 || q.length > 14) return json({ ok: true, players: [] });
    const like = q.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
    const rows = (await env.DB.prepare(`SELECT * FROM players WHERE lang = ? AND hidden = 0 AND id != ? AND name LIKE ? ESCAPE '\\'
        ORDER BY (name = ? COLLATE NOCASE) DESC, level DESC LIMIT 20`).bind(p.lang, p.id, like, q).all()).results;
    return json({ ok: true, players: rows.map((r) => friendRow(r, p.id)) });
  }
  // ── Wort-Arena: Gegner = gespeichertes Arena-Duell eines anderen Spielers mit ähnlich vielen Siegen ──
  if (path === "/v1/arena/opponent") {
    const w = int(b.wins, 0, 12) ?? 0, skip = Array.isArray(b.skip) ? b.skip.filter(Number.isInteger).slice(0, 20) : [];
    const q = `SELECT r.*, p.pub, p.name, p.country, p.gold, p.look, p.hidden, p.trophies, p.level, p.rating FROM arena_results r JOIN players p ON p.id = r.player
      WHERE r.lang = ? AND r.player != ? AND r.flag = 0 AND r.at > ? AND r.wins BETWEEN ? AND ?${skip.length ? ` AND r.id NOT IN (${skip.map(() => "?").join(",")})` : ""} ORDER BY RANDOM() LIMIT 1`;
    let r = await env.DB.prepare(q).bind(p.lang, p.id, now - 21 * 86400000, Math.max(0, w - 1), w + 1, ...skip).first();
    if (!r) r = await env.DB.prepare(q).bind(p.lang, p.id, now - 60 * 86400000, 0, 12, ...skip).first();   // zur Not irgendein Gegner
    return json({ ok: true, opp: r ? { rid: r.id, seed: r.seed, points: r.points, secs: r.secs, rounds: r.rounds, wins: r.wins, ...publicRow(r, p.id), level: r.level, rating: r.rating } : null });
  }
  if (path === "/v1/arena/submit") {
    const w = int(b.wins, 0, 12), seed = int(b.seed, 0, 4294967295), points = int(b.points, 0, 50000000), secs = int(b.secs, 1, 86400), rounds = int(b.rounds, 0, 3);
    if (w == null || seed == null || points == null || secs == null || rounds == null) return fail("score");
    const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM arena_results WHERE player = ? AND at > ?").bind(p.id, now - 86400000).first()).n;
    if (n >= 60) return json({ ok: true, stored: false });
    const flag = await check(env, p, "arena", b.log, { lang: p.lang, rounds, points, secs, len: 3 }, now);
    await env.DB.prepare("INSERT INTO arena_results (player, lang, wins, seed, points, secs, rounds, flag, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(p.id, p.lang, w, seed, points, secs, rounds, flag, now).run();
    return json({ ok: true, stored: true });
  }
  if (path === "/v1/match/start") {
    const len = b.len === 3 ? 3 : 5;
    const m = await matchStart(env, p, len, now);
    return json({ ok: true, match: m, rating: p.rating });
  }
  if (path === "/v1/match/challenge") { // Revanche: neues Duell nur für diesen Spieler – du spielst zuerst
    const t = await env.DB.prepare("SELECT id, lang FROM players WHERE pub = ?").bind(String(b.target || "")).first();
    if (!t || t.id === p.id) return fail("target");
    if (t.lang !== p.lang) return fail("lang");   // gleiche Karten nur in derselben Sprache
    const id = randHex(10), seed = crypto.getRandomValues(new Uint32Array(1))[0], len = b.len === 3 ? 3 : 5;
    await env.DB.prepare("INSERT INTO matches (id, seed, len, lang, status, a, target, a_rating, created) VALUES (?, ?, ?, ?, 'playing_a', ?, ?, ?, ?)")
      .bind(id, seed, len, p.lang, p.id, t.id, p.rating, now).run();
    return json({ ok: true, match: { id, seed, len, status: "playing_a", role: "a", me: null, opp: null, challenge: true } });
  }
  if (path === "/v1/match/accept") { // Herausforderung annehmen
    const m = await env.DB.prepare("SELECT * FROM matches WHERE id = ? AND target = ? AND status = 'open'").bind(String(b.mid || ""), p.id).first();
    if (!m) return fail("match");
    if (m.lang !== p.lang) return fail("lang");
    await env.DB.prepare("UPDATE matches SET status = 'claimed', b = ?, claimed = ? WHERE id = ? AND status = 'open'").bind(p.id, now, m.id).run();
    const opp = await env.DB.prepare("SELECT * FROM players WHERE id = ?").bind(m.a).first();
    return json({ ok: true, match: matchView({ ...m, status: "claimed", b: p.id }, p.id, opp) });
  }
  if (path === "/v1/match/submit") {
    const r = await matchSubmit(env, p, b, now);
    return r.error ? fail(r.error) : json({ ok: true, ...r });
  }
  if (path === "/v1/match/list") return json({ ok: true, matches: await matchList(env, p, now), rating: p.rating, duels: p.duels, wins: p.duel_wins });
  if (path === "/v1/match/seen") {
    await env.DB.prepare("UPDATE matches SET a_seen = CASE WHEN a = ? THEN 1 ELSE a_seen END, b_seen = CASE WHEN b = ? THEN 1 ELSE b_seen END WHERE id = ?").bind(p.id, p.id, String(b.mid || "")).run();
    return json({ ok: true });
  }
  if (path === "/v1/player") { // Profilkarte eines anderen Spielers (öffentliche Angaben)
    const t = await env.DB.prepare("SELECT * FROM players WHERE pub = ?").bind(String(b.target || "")).first();
    if (!t) return fail("target", 404);
    return json({ ok: true, player: { ...publicRow(t, p.id), tier: t.tier, bestTier: t.best_tier, weeks: t.weeks, trophies: safeParse(t.trophies),
      level: t.level, bestWord: t.hidden ? "" : t.best_word, bestScore: t.best_score, since: t.created, stats: safeParse(t.stats),
      rating: t.rating, onlineDuels: t.duels, onlineWins: t.duel_wins } });
  }
  if (path === "/v1/report") {
    if (typeof b.target !== "string" || b.target === p.pub) return fail("target");
    const t = await env.DB.prepare("SELECT id FROM players WHERE pub = ?").bind(b.target).first(); if (!t) return fail("target");
    await env.DB.prepare("INSERT OR IGNORE INTO reports (reporter, target, at) VALUES (?, ?, ?)").bind(p.id, t.id, now).run();
    const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE target = ?").bind(t.id).first()).n;
    if (n >= 3) { await env.DB.prepare("UPDATE players SET hidden = 1 WHERE id = ?").bind(t.id).run(); boardCache.clear(); }
    return json({ ok: true });
  }
  return fail("path", 404);
}

export default {
  async fetch(req, env) {
    try { return await handle(req, env, Date.now()); }
    catch (e) { return json({ ok: false, error: "server" }, 500); }
  },
  // Montag kurz nach Mitternacht (UTC): letzte Woche abschließen (passiert sonst auch beim nächsten Aufruf)
  async scheduled(event, env) { await finalizeWeek(env, prevWeek(Date.now())); await cleanup(env, Date.now()); },
};
export { handle };
