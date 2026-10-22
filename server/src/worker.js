// Wortpoker online – Cloudflare Worker mit D1-Datenbank (Binding „DB“).
// Stufe 1: Ranglisten der Tages-Challenge (je Sprache, Filter Land) und Wochen-Liga (Gruppen à 30, Auf- und Abstieg).
// Alle Antworten sind JSON. Spieler melden sich ohne Konto an: das Gerät bekommt eine geheime ID + Schlüssel.
import { cleanName } from "./names.js";

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
  for (const k of ["char", "hat", "glasses", "outfit", "pin", "color"]) { const n = int(l[k], 0, 99); if (n != null) o[k] = n; }
  for (const k of ["frame", "skin"]) if (typeof l[k] === "string" && /^[a-z0-9-]{1,24}$/.test(l[k])) o[k] = l[k];
  return JSON.stringify(o);
};
const cleanCountry = (c) => (typeof c === "string" && /^[A-Z]{2}$/.test(c) ? c : "");
const publicRow = (r, me) => ({ pub: r.pub, name: r.hidden ? null : r.name, country: r.country, gold: !!r.gold, look: safeParse(r.look), me: r.id === me || undefined });
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
    env.DB.prepare(`INSERT OR IGNORE INTO league_results (week, player, tier, grp, rank, size, new_tier, claimed)
      SELECT week, player, tier, grp, rk, sz,
        CASE WHEN rk <= ${PROMOTE} AND tier < ${TIERS - 1} THEN tier + 1
             WHEN sz >= 10 AND rk > sz - ${DEMOTE} AND tier > 0 THEN tier - 1 ELSE tier END, 0
      FROM (SELECT week, player, tier, grp,
              ROW_NUMBER() OVER (PARTITION BY grp ORDER BY xp DESC, last_at ASC) AS rk,
              COUNT(*) OVER (PARTITION BY grp) AS sz
            FROM league_members WHERE week = ? AND xp > 0)`).bind(week),
    env.DB.prepare(`UPDATE players SET tier = (SELECT new_tier FROM league_results r WHERE r.week = ? AND r.player = players.id)
      WHERE id IN (SELECT player FROM league_results WHERE week = ?)`).bind(week, week),
    env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)").bind("final:" + week, String(now)),
  ]);
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
  ]);
}

async function leagueState(env, p, now) {
  const week = weekOf(now);
  await finalizeWeek(env, prevWeek(now), now);
  const fresh = await env.DB.prepare("SELECT tier FROM players WHERE id = ?").bind(p.id).first();
  const me = await env.DB.prepare("SELECT * FROM league_members WHERE week = ? AND player = ?").bind(week, p.id).first();
  let members = [];
  if (me) {
    const rows = await env.DB.prepare(`SELECT m.xp, m.player, p.id, p.pub, p.name, p.country, p.gold, p.look, p.hidden
      FROM league_members m JOIN players p ON p.id = m.player WHERE m.week = ? AND m.grp = ? ORDER BY m.xp DESC, m.last_at ASC`).bind(week, me.grp).all();
    members = rows.results.map((r, i) => ({ rank: i + 1, xp: r.xp, ...publicRow(r, p.id) }));
  }
  const last = await env.DB.prepare("SELECT * FROM league_results WHERE player = ? AND claimed = 0 ORDER BY week DESC LIMIT 1").bind(p.id).first();
  return {
    ok: true, week, endsAt: weekEnd(now), tier: me ? me.tier : fresh.tier, joined: !!me, members, promote: PROMOTE, demote: DEMOTE, group: GROUP,
    result: last ? { week: last.week, rank: last.rank, size: last.size, tier: last.tier, newTier: last.new_tier } : null,
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
  const where = country ? "d.day = ? AND d.lang = ? AND p.country = ?" : "d.day = ? AND d.lang = ?";
  const args = country ? [day, lang, country] : [day, lang];
  const ck = `${day}|${lang}|${country || ""}`, hit = boardCache.get(ck);
  let top, total;
  if (hit && !fresh && Date.now() - hit.at < 30000) ({ top, total } = hit);
  else {
    top = (await env.DB.prepare(`SELECT d.rounds, d.points, d.secs, p.id, p.pub, p.name, p.country, p.gold, p.look, p.hidden
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
    }
  }
  return { ok: true, day, lang, country: country || null, total, me,
    top: top.map((r, i) => ({ rank: i + 1, rounds: r.rounds, points: r.points, secs: r.secs, ...publicRow(r, meId) })) };
}

// ── Anfragen ──
async function handle(req, env, now) {
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
    const id = randHex(16), token = randHex(24), pub = randPub();
    await env.DB.prepare("INSERT INTO players (id, pub, token_hash, name, lang, country, gold, look, tier, hidden, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)")
      .bind(id, pub, await sha256(token), name, lang, cleanCountry(b.country), b.gold ? 1 : 0, cleanLook(b.look), now).run();
    return json({ ok: true, id, token, pub, name });
  }

  const p = await auth(env, b);
  if (!p) return fail("auth", 401);

  if (path === "/v1/profile") {
    const name = b.name == null ? p.name : cleanName(b.name); if (!name) return fail("name");
    const lang = LANGS.includes(b.lang) ? b.lang : p.lang;
    await env.DB.prepare("UPDATE players SET name = ?, lang = ?, country = ?, gold = ?, look = ?, hidden = CASE WHEN name = ? THEN hidden ELSE 0 END WHERE id = ?")
      .bind(name, lang, b.country == null ? p.country : cleanCountry(b.country), b.gold == null ? p.gold : b.gold ? 1 : 0, b.look == null ? p.look : cleanLook(b.look), name, p.id).run();
    boardCache.clear();
    return json({ ok: true, name });
  }
  if (path === "/v1/delete") { // alle Daten dieses Spielers löschen (Datenschutz)
    await env.DB.batch(["players WHERE id", "daily WHERE player", "league_members WHERE player", "league_results WHERE player", "xp_days WHERE player", "reports WHERE reporter"]
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
      await env.DB.prepare("INSERT OR IGNORE INTO daily (day, lang, player, rounds, points, secs, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(day, lang, p.id, rounds, points, secs, now).run();
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
