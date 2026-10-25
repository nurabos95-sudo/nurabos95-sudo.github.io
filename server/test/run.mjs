// Tests für den Worker (ohne Cloudflare): node --experimental-sqlite server/test/run.mjs
import { D1 } from "./d1shim.mjs";
import { handle, weekOf, weekEnd, cleanup } from "../src/worker.js";
import { cleanName } from "../src/names.js";
import { setBlooms, inDict, verifyLog } from "../src/verify.js";
import { scoreCore, LETTER_VALS } from "../src/score.js";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const env = { DB: new D1(join(here, "..", "schema.sql")), VERIFY: "off" }; // Prüfung erst im Abschnitt „Ergebnis-Prüfung“
setBlooms(Object.fromEntries(["de", "en", "es", "fr", "pt"].map((l) => [l, readFileSync(join(here, "..", "dict", l + ".bin"))])));
const errors = [];
const ok = (c, msg) => { console.log((c ? "  ✔ " : "  ✘ ") + msg); if (!c) errors.push(msg); };
let NOW = Date.UTC(2026, 9, 21, 12); // Mittwoch, 21.10.2026 12:00 UTC
const call = async (path, body) => (await handle(new Request("https://x" + path, { method: "POST", body: JSON.stringify(body) }), env, NOW)).json();

console.log("Namen");
for (const n of ["Lena", "Max_99", "Zoë", "José", "Frankreich", "Hitchcock", "Barsch", "Ana Lúcia"]) ok(cleanName(n) === n, `erlaubt: ${n}`);
for (const n of ["Arschloch", "H1tler", "fuck you", "PuTa", "x", "Ein sehr langer Name", "<script>", "kz", "Sieg Heil", "5h1t"]) ok(cleanName(n) === null, `gesperrt: ${n}`);

console.log("Anmelden");
const reg = async (name, lang = "de", country = "DE") => call("/v1/register", { name, lang, country, gold: name.startsWith("G"), look: { char: 3, hat: 1, frame: "gold" } });
const a = await reg("Lena");
ok(a.ok && a.id.length === 32 && a.token && a.pub, "Anmeldung gibt ID, Schlüssel und öffentliche ID");
ok((await reg("Arschloch")).error === "name", "Beleidigender Name wird abgelehnt");
ok((await call("/v1/league", { id: a.id, token: "falsch" })).error === "auth", "Falscher Schlüssel → abgelehnt");

console.log("Tages-Challenge");
const day = "2026-10-21";
const b = await reg("Bruno", "de", "AT"), c = await reg("Chris", "de", "DE"), e = await reg("Emma", "en", "GB");
let r = await call("/v1/daily", { id: a.id, token: a.token, day, lang: "de", rounds: 7, points: 4200, secs: 300 });
ok(r.ok && r.me.rank === 1 && r.total === 1, "Erster Eintrag: Platz 1 von 1");
await call("/v1/daily", { id: b.id, token: b.token, day, lang: "de", rounds: 9, points: 3000, secs: 500 });
await call("/v1/daily", { id: c.id, token: c.token, day, lang: "de", rounds: 7, points: 4200, secs: 200 });
await call("/v1/daily", { id: e.id, token: e.token, day, lang: "en", rounds: 12, points: 99999, secs: 100 });
r = await call("/v1/daily", { id: a.id, token: a.token, day, lang: "de" });
ok(r.total === 3 && r.top.map((x) => x.name).join(",") === "Bruno,Chris,Lena" && r.me.rank === 3, `Reihenfolge: Runden, dann Punkte, dann Zeit (${r.top.map((x) => x.name)})`);
ok(r.top[2].me === true && r.top[0].me === undefined && r.top[0].country === "AT", "Eigene Zeile markiert, Flagge dabei");
r = await call("/v1/daily", { id: a.id, token: a.token, day, lang: "de", rounds: 12, points: 99999, secs: 10 });
ok(r.me.rounds === 7 && r.me.rank === 3, "Nur der erste Versuch zählt");
r = await call("/v1/daily", { id: a.id, token: a.token, day, lang: "de", country: "DE" });
ok(r.total === 2 && r.me.rank === 2, "Filter Land: nur Deutschland");
ok((await call("/v1/daily", { id: a.id, token: a.token, day: "2026-09-01", lang: "de", rounds: 3, points: 10, secs: 10 })).error === "day", "Alter Tag wird abgelehnt");
ok(JSON.stringify(r).indexOf(a.id) < 0 && JSON.stringify(r).indexOf("token") < 0, "Keine geheimen IDs in der Rangliste");

console.log("Wochen-Liga");
const ps = [a, b, c];
for (let i = 0; i < 32; i++) ps.push(await reg("Spieler" + i));
for (let i = 0; i < ps.length; i++) await call("/v1/xp", { id: ps[i].id, token: ps[i].token, xp: 100 + i * 10 });
r = await call("/v1/league", { id: a.id, token: a.token });
ok(r.joined && r.members.length === 30 && r.tier === 0, `Gruppe mit 30 Spielern (${r.members.length})`);
const r2 = await call("/v1/league", { id: ps[34].id, token: ps[34].token });
ok(r2.members.length === 5, `Spieler 31–35 in einer neuen Gruppe (${r2.members.length})`);
r = await call("/v1/xp", { id: a.id, token: a.token, xp: 5000 });
ok(r.added === 5000 && r.members[0].me === true, "XP zählen, Lena jetzt Platz 1");
await call("/v1/xp", { id: a.id, token: a.token, xp: 5000 });
r = await call("/v1/xp", { id: a.id, token: a.token, xp: 5000 });
ok(r.added === 2000 - 100 + 100 - 0 || r.added < 5000, `Tages-Obergrenze für XP (${r.added})`);
ok((await call("/v1/xp", { id: a.id, token: a.token, xp: 999999 })).error === "xp", "Zu viele XP auf einmal → abgelehnt");
ok(r.endsAt === weekEnd(NOW) && r.week === "2026-W43", `Woche ${r.week}, Ende Montag 0 Uhr UTC`);

console.log("Wochenwechsel");
NOW = Date.UTC(2026, 9, 26, 9); // Montag der nächsten Woche
r = await call("/v1/league", { id: a.id, token: a.token });
ok(r.result && r.result.rank === 1 && r.result.newTier === 1 && r.tier === 1, `Platz 1 → Aufstieg in Silber (${JSON.stringify(r.result)})`);
ok(!r.joined && r.week === "2026-W44", "Neue Woche: noch nicht dabei");
const last = await call("/v1/league", { id: ps[2].id, token: ps[2].token }); // Chris: xp 120 → Platz 29 von 30
ok(last.result && last.result.newTier === 0 && last.result.rank > 25, `Letzte Plätze: kein Abstieg unter Bronze (${JSON.stringify(last.result)})`);
ok(r.result.crowns === 12 && r.mine.trophies["0"].join() === "1,0,0" && r.mine.bestTier === 1 && r.mine.weeks === 1, `Platz 1: 12 Kronen, Gold-Pokal in Bronze, höchste Liga Silber (${JSON.stringify(r.mine)})`);
ok(last.result.crowns === 1, `Hintere Plätze: 1 Krone (${last.result.crowns})`);
const sec = await call("/v1/league", { id: ps[34 - 5].id, token: ps[34 - 5].token });
await call("/v1/profile", { id: a.id, token: a.token, level: 26, bestWord: "Abenteuer", bestScore: 2910, look: { char: 16, nfx: "feuer", dance: "salto" },
  stats: { ach: 14, achTotal: 60, duels: 9, duelWins: 6, record: 11, showcase: ["wort7", "boss1", "palindrom", "zuviel"], evil: "<b>" } });
const pc = await call("/v1/player", { id: b.id, token: b.token, target: a.pub });
ok(pc.ok && pc.player.level === 26 && pc.player.bestWord === "ABENTEUER" && pc.player.trophies["0"][0] === 1 && pc.player.look.nfx === "feuer" && pc.player.stats.duelWins === 6 && pc.player.stats.showcase.length === 4 && !("evil" in pc.player.stats), `Profilkarte: Stufe, bestes Wort, Pokale, Namenseffekt (${JSON.stringify(pc.player)})`);
ok((await call("/v1/player", { id: b.id, token: b.token, target: "gibtsnicht" })).error === "target", "Unbekannter Spieler → Fehler");
let cl = await call("/v1/league/claim", { id: a.id, token: a.token, week: "2026-W43" });
ok(cl.claimed === true, "Belohnung abholen");
cl = await call("/v1/league/claim", { id: a.id, token: a.token, week: "2026-W43" });
ok(cl.claimed === false && (await call("/v1/league", { id: a.id, token: a.token })).result === null, "Belohnung nur einmal");
r = await call("/v1/xp", { id: a.id, token: a.token, xp: 50 });
ok(r.joined && r.tier === 1 && r.members.length === 1, "Neue Woche in der Silber-Liga");

console.log("Online-Duelle");
{
  const [x, y, z] = [ps[10], ps[11], ps[12]];
  const st = async (p, len = 5) => (await call("/v1/match/start", { id: p.id, token: p.token, len })).match;
  const sub = async (p, mid, points, secs, rounds = 5) => call("/v1/match/submit", { id: p.id, token: p.token, mid, points, secs, rounds });
  const m1 = await st(x);
  ok(m1.role === "a" && m1.fresh && m1.seed > 0, "Kein offenes Duell → neues Duell, ich spiele zuerst");
  const m1b = await st(y);
  ok(m1b.role === "a" && m1b.id !== m1.id, "Duell, das noch gespielt wird, wird nicht vergeben");
  let s1 = await sub(x, m1.id, 900, 200);
  ok(s1.ok && s1.match.status === "open", "Ergebnis von A → Duell wartet auf Gegner");
  ok((await sub(x, m1.id, 9999, 1)).error === "state", "Zweites Ergebnis wird abgelehnt");
  const m2 = await st(x, 5);
  ok(m2.id !== m1.id, "Nicht gegen sich selbst");
  const mz = await st(z, 5);
  ok(mz.id === m1.id && mz.role === "b" && mz.seed === m1.seed && mz.opp.name === x.name, `B bekommt dieselben Karten (${mz.opp && mz.opp.name})`);
  ok(mz.opp.points === undefined, "Punkte des Gegners erst nach dem eigenen Spiel");
  const s2 = await sub(z, m1.id, 1200, 300);
  ok(s2.ok && s2.match.status === "done" && s2.match.delta === 12 && s2.match.opp.points === 900 && s2.rating === 1012, `Sieg: +12 Wertung (${JSON.stringify(s2.match.delta)})`);
  const lx = await call("/v1/match/list", { id: x.id, token: x.token });
  const d = lx.matches.find((m) => m.id === m1.id);
  ok(d && d.delta === -12 && !d.seen && d.opp.points === 1200 && lx.rating === 988 && lx.duels === 1 && lx.wins === 0, `A sieht Ergebnis und Wertung (${lx.rating})`);
  await call("/v1/match/seen", { id: x.id, token: x.token, mid: m1.id });
  ok((await call("/v1/match/list", { id: x.id, token: x.token })).matches.find((m) => m.id === m1.id).seen, "Als gesehen markiert");
  // Abgebrochen: B spielt nicht zu Ende → nach 2 Stunden wieder frei
  await sub(y, m1b.id, 500, 100);
  const c1 = await st(z, 5);
  ok(c1.id === m1b.id || c1.id === m2.id, "Nächstes offenes Duell");
  const keep = NOW; NOW += 3 * 3600000;
  const other = c1.id === m1b.id ? m1b : m2; // anderes Duell wurde noch nicht gespielt
  const c2 = await st(ps[13], 5);
  ok(c2.id === c1.id || c2.id === other.id, "Liegengebliebenes Duell geht nach 2 h an andere");
  NOW = keep;
  // Revanche
  const ch = await call("/v1/match/challenge", { id: z.id, token: z.token, target: x.pub, len: 3 });
  ok(ch.ok && ch.match.len === 3 && ch.match.challenge, "Revanche angelegt");
  await sub(z, ch.match.id, 700, 90, 3);
  ok((await st(ps[14], 3)).id !== ch.match.id, "Herausforderung geht nicht an Fremde");
  const inv = (await call("/v1/match/list", { id: x.id, token: x.token })).matches.find((m) => m.id === ch.match.id);
  ok(inv && inv.role === "invite" && inv.opp.name === z.name, "Herausgeforderter sieht die Einladung");
  const acc = await call("/v1/match/accept", { id: x.id, token: x.token, mid: ch.match.id });
  ok(acc.ok && acc.match.seed === ch.match.seed && acc.match.role === "b", "Revanche angenommen");
  const s3 = await sub(x, ch.match.id, 700, 80, 3);
  ok(s3.match.delta > 0, `Gleiche Punkte → schneller gewinnt (${s3.match.delta})`);
  const card = await call("/v1/player", { id: y.id, token: y.token, target: x.pub });
  ok(card.player.rating === lx.rating + s3.match.delta && card.player.onlineDuels === 2 && card.player.onlineWins === 1, `Profilkarte: Wertung und Online-Duelle (${card.player.rating})`);
  ok((await call("/v1/match/submit", { id: y.id, token: y.token, mid: m1.id, points: 1, secs: 1, rounds: 1 })).error === "state", "Fremdes Duell → abgelehnt");
}

console.log("Ergebnis-Prüfung");
{
  const wf = join(here, "..", "..", "public", "words.txt"); // nur im App-Projekt vorhanden
  if (existsSync(wf)) ok(readFileSync(wf, "utf8").split("\n").filter((w, i) => w && i % 97 === 0).every((w) => inDict("de", w)), "Alle Wörter des Wörterbuchs werden erkannt");
  let fp = 0; for (let i = 0; i < 2000; i++) fp += inDict("de", "QX" + i.toString(36).toUpperCase() + "ZK") ? 1 : 0;
  ok(fp < 40, `Falsch erkannt: ${fp} von 2000 erfundenen Wörtern`);
  ok(inDict("fr", "ABAISSA") && !inDict("de", "ABAISSA") && inDict("en", "HOUSE"), "Je Sprache eigenes Wörterbuch");
  // Protokoll bauen: [Runde, [Wörter], Boss-Regeln]
  const mk = (plan, lang = "de") => {
    const log = []; let rw = 0;
    for (const [r, ws, b = []] of plan) ws.forEach((w, i) => {
      const e = { r, w, c: w, j: [], e: {}, b, f: i === 0 ? 1 : 0, l: 0, d: 0, m: 5, ws: i, rw: rw++, sw: 0, cap: 0 };
      e.p = scoreCore(w, [...w], [], {}, { isFirstPlay: !!e.f, isLastPlay: false, wordsSoFar: i, roundNum: r, moneyNow: 5, runWordsNow: e.rw, bossRules: b }, LETTER_VALS[lang]).total;
      log.push(e);
    });
    return log;
  };
  const plan = [[1, ["GARTEN"]], [2, ["GARTEN"]], [3, ["GARTEN", "GARTEN"], ["eile"]], [4, ["HAUS"]]];
  const good = mk(plan), pts = good.reduce((a, x) => a + x.p, 0);
  ok(verifyLog(good, { lang: "de", rounds: 3, points: pts, secs: 60 }) === null, `Ehrliches Spiel: in Ordnung (${pts} Punkte)`);
  const bad = (f, res = {}) => { const l = JSON.parse(JSON.stringify(good)); f(l); return verifyLog(l, { lang: "de", rounds: 3, points: l.reduce((a, x) => a + x.p, 0), secs: 60, ...res }); };
  ok(verifyLog(null, { lang: "de", rounds: 3, points: pts, secs: 60 }) === "nolog", "Ohne Protokoll: auffällig");
  ok(bad((l) => { l[0].w = l[0].c = "GXRTEN"; }) === "dict:GXRTEN", "Wort nicht im Wörterbuch");
  ok(bad((l) => { l[1].p += 500; }).startsWith("score"), "Punkte geschönt");
  ok(bad((l) => { l[0].j = ["wortgott", "echo", "spiegel"]; l[0].p = scoreCore("GARTEN", [..."GARTEN"], l[0].j, {}, { isFirstPlay: true, bossRules: [] }, LETTER_VALS.de).total; }) === null, "Joker mitgerechnet: in Ordnung");
  ok(bad((l) => { l[0].j = ["a", "b", "c", "d", "e", "f"]; }) === "jokers", "Mehr als 5 Joker");
  ok(bad((l) => { l[0].b = ["mauer"]; }) === "bossround", "Boss in Runde 1");
  ok(bad((l) => { l[2].b = l[3].b = []; }) === "bossround", "Runde 3 ohne Boss");
  ok(bad(() => {}, { rounds: 4 }) === "target", "Mehr Runden behauptet als geschafft");
  ok(bad(() => {}, { points: pts + 1 }) === "sum", "Summe stimmt nicht");
  ok(bad(() => {}, { secs: 3 }) === "fast", "Unmenschlich schnell");
  ok(bad((l) => { l[0].c = "GAR★EN"; l[0].p = scoreCore("GARTEN", [..."GAR★EN"], [], {}, { isFirstPlay: true, bossRules: [] }, LETTER_VALS.de).total; }) === null && bad((l) => { l[0].c = "HAUSEN"; }) === "letters", "★ erlaubt, falsche Buchstaben nicht");
  ok(bad((l) => { l[0].l = 1; l.splice(1, 0, { ...l[0], ws: 1, rw: 1, f: 0, l: 0 }); for (let i = 2; i < l.length; i++) l[i].rw = i; }) === "afterlast", "Nach dem letzten Zug kein Wort mehr");
  ok(verifyLog(mk([[1, ["MAISON"]], [2, ["MAISON"]]], "fr"), { lang: "fr", rounds: 2, points: mk([[1, ["MAISON"]], [2, ["MAISON"]]], "fr").reduce((a, x) => a + x.p, 0), secs: 30 }) === null, "Französisch mit eigenen Buchstabenwerten");

  env.VERIFY = undefined;
  const day2 = new Date(NOW).toISOString().slice(0, 10), [h, s] = [await reg("Ehrlich"), await reg("Schummler")];
  await call("/v1/daily", { id: h.id, token: h.token, day: day2, lang: "de", rounds: 3, points: pts, secs: 60, log: good });
  r = await call("/v1/daily", { id: s.id, token: s.token, day: day2, lang: "de", rounds: 30, points: 9999999, secs: 5 });
  ok(r.me.rank === 1 && r.top[0].me === true, "Schummler sieht sich selbst auf Platz 1");
  const viewH = await call("/v1/daily", { id: h.id, token: h.token, day: day2, lang: "de" });
  ok(!viewH.top.some((x) => x.name === "Schummler") && viewH.top.some((x) => x.name === "Ehrlich" && x.me), "Andere sehen den Schummler nicht, ehrliches Ergebnis zählt");
  const fl = await env.DB.prepare("SELECT reason FROM flags WHERE player = ?").bind(s.id).first();
  ok(fl && fl.reason === "nolog", `Grund gemerkt (${fl && fl.reason})`);
  // Duell: B schummelt → keine Wertung
  const [da, dbb] = [await reg("DuellA"), await reg("DuellB")];
  const md = (await call("/v1/match/start", { id: da.id, token: da.token, len: 3 })).match;
  const dl = mk([[1, ["GARTEN"]], [2, ["GARTEN"]], [3, ["GARTEN", "GARTEN"], ["eile"]]]), dp = dl.reduce((a, x) => a + x.p, 0);
  const sa = await call("/v1/match/submit", { id: da.id, token: da.token, mid: md.id, points: dp, secs: 90, rounds: 3, log: dl });
  ok(sa.ok && sa.match.status === "open", "A: ehrliches Duell-Ergebnis");
  const mb = (await call("/v1/match/start", { id: dbb.id, token: dbb.token, len: 3 })).match;
  const sb = await call("/v1/match/submit", { id: dbb.id, token: dbb.token, mid: mb.id, points: 99999, secs: 90, rounds: 3, log: dl });
  ok(mb.id === md.id && sb.ok && sb.match.delta === null && sb.rating === 1000, `B schummelt: Duell ohne Wertung (${sb.match.delta})`);
  const la = (await call("/v1/match/list", { id: da.id, token: da.token }));
  ok(la.rating === 1000 && la.duels === 0, "A verliert keine Wertung");
  // A schummelt → Duell wird keinem Gegner gegeben
  const mc = (await call("/v1/match/start", { id: da.id, token: da.token, len: 3 })).match;
  await call("/v1/match/submit", { id: da.id, token: da.token, mid: mc.id, points: 99999, secs: 90, rounds: 3 });
  const other = (await call("/v1/match/start", { id: h.id, token: h.token, len: 3 })).match;
  ok(other.id !== mc.id && other.role === "a", "Auffälliges Duell bekommt keinen Gegner");
  env.VERIFY = "off";
}

console.log("Freunde");
{
  const [f1, f2, f3] = [await reg("Fritzi"), await reg("Fritz"), await reg("Fiona", "en", "GB")];
  ok(f1.tag >= 1000 && f1.tag <= 9999, `Freundescode Fritzi#${f1.tag}`);
  const sr = await call("/v1/friends/search", { id: f1.id, token: f1.token, q: "fri" });
  ok(sr.players.length === 1 && sr.players[0].name === "Fritz" && sr.players[0].tag === f2.tag, "Suche „fri“ findet Fritz (nicht sich selbst, nicht andere Sprachen)");
  ok((await call("/v1/friends/search", { id: f1.id, token: f1.token, q: "%" })).players.length === 0, "Platzhalter in der Suche wirken nicht");
  let fr = await call("/v1/friends/add", { id: f1.id, token: f1.token, code: `fritz#${f2.tag}` });
  ok(fr.ok && fr.friends.length === 1 && fr.friends[0].name === "Fritz", "Hinzufügen per Freundescode (Groß/klein egal)");
  ok((await call("/v1/friends", { id: f2.id, token: f2.token })).friends[0].name === "Fritzi", "Freundschaft gilt in beide Richtungen");
  ok((await call("/v1/friends/add", { id: f1.id, token: f1.token, code: "Fritz#0000" })).error === "target", "Falscher Code → Fehler");
  await call("/v1/friends/add", { id: f1.id, token: f1.token, target: f3.pub });
  ok((await call("/v1/match/challenge", { id: f1.id, token: f1.token, target: f3.pub, len: 3 })).error === "lang", "Duell nur in derselben Sprache");
  const ch = await call("/v1/match/challenge", { id: f1.id, token: f1.token, target: f2.pub, len: 3 });
  await call("/v1/match/submit", { id: f1.id, token: f1.token, mid: ch.match.id, points: 500, secs: 60, rounds: 3 });
  await call("/v1/match/accept", { id: f2.id, token: f2.token, mid: ch.match.id });
  await call("/v1/match/submit", { id: f2.id, token: f2.token, mid: ch.match.id, points: 400, secs: 60, rounds: 3 });
  fr = await call("/v1/friends", { id: f1.id, token: f1.token });
  const fz = fr.friends.find((x) => x.name === "Fritz");
  ok(fz.w === 1 && fz.l === 0 && (await call("/v1/friends", { id: f2.id, token: f2.token })).friends[0].l === 1, "Bilanz unter Freunden: 1 : 0");
  const ren = await call("/v1/profile", { id: f2.id, token: f2.token, name: "Fritzi" });
  ok(ren.ok && (ren.tag !== f1.tag), `Umbenennen auf einen vergebenen Namen: neuer Code (${ren.tag})`);
  fr = await call("/v1/friends/remove", { id: f1.id, token: f1.token, target: f2.pub });
  ok(fr.friends.length === 1 && (await call("/v1/friends", { id: f2.id, token: f2.token })).friends.length === 0, "Entfernen: auf beiden Seiten weg");
}

console.log("Wort-Arena");
{
  const [a1, a2] = [await reg("Arena1"), await reg("Arena2")];
  let o = await call("/v1/arena/opponent", { id: a1.id, token: a1.token, wins: 0 });
  ok(o.ok && o.opp === null, "Leerer Pool: kein Gegner (App nimmt dann einen Computer-Gegner)");
  for (const [w, pts] of [[0, 300], [1, 500], [5, 1500]]) await call("/v1/arena/submit", { id: a2.id, token: a2.token, wins: w, seed: 1000 + w, points: pts, secs: 60, rounds: 3 });
  o = await call("/v1/arena/opponent", { id: a1.id, token: a1.token, wins: 5 });
  ok(o.opp && o.opp.wins === 5 && o.opp.seed === 1005 && o.opp.name === "Arena2" && o.opp.points === 1500, `Gegner mit ähnlich vielen Siegen (${JSON.stringify(o.opp && [o.opp.wins, o.opp.name])})`);
  o = await call("/v1/arena/opponent", { id: a1.id, token: a1.token, wins: 0, skip: [] });
  ok(o.opp && o.opp.wins <= 1, "Bei 0 Siegen: Gegner mit 0–1 Siegen");
  ok((await call("/v1/arena/opponent", { id: a2.id, token: a2.token, wins: 0 })).opp === null, "Nie gegen sich selbst");
  const sk = await call("/v1/arena/opponent", { id: a1.id, token: a1.token, wins: 5, skip: [o.opp.rid, (await call("/v1/arena/opponent", { id: a1.id, token: a1.token, wins: 5 })).opp.rid] });
  ok(!sk.opp || sk.opp.wins !== 5, "Schon gespielte Gegner werden übersprungen");
}

console.log("Melden und Löschen");
for (const x of [b, c, ps[5]]) await call("/v1/report", { id: x.id, token: x.token, target: a.pub });
r = await call("/v1/league", { id: ps[6].id, token: ps[6].token });
const dd = await call("/v1/daily", { id: b.id, token: b.token, day: "2026-10-26", lang: "de" });
const all = await call("/v1/daily", { id: b.id, token: b.token, day, lang: "de" });
NOW = Date.UTC(2026, 9, 21, 12);
const allNow = await call("/v1/daily", { id: b.id, token: b.token, day, lang: "de" });
ok(allNow.top.find((x) => x.pub === a.pub).name === null, "Nach 3 Meldungen: Name ausgeblendet");
await call("/v1/profile", { id: a.id, token: a.token, name: "Lena Neu" });
ok((await call("/v1/daily", { id: b.id, token: b.token, day, lang: "de" })).top.find((x) => x.pub === a.pub).name === "Lena Neu", "Neuer Name wird wieder gezeigt");
ok((await call("/v1/delete", { id: a.id, token: a.token })).ok, "Daten löschen");
ok((await call("/v1/league", { id: a.id, token: a.token })).error === "auth" && (await call("/v1/daily", { id: b.id, token: b.token, day, lang: "de" })).total === 2, "Spieler und Einträge weg");

console.log("Aufräumen");
const cnt = async (t) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first()).n;
const before = await cnt("daily");
await cleanup(env, Date.UTC(2027, 5, 1));
ok((await cnt("daily")) === before, "Nach 7 Monaten bleibt alles");
await cleanup(env, Date.UTC(2027, 11, 1));
ok((await cnt("daily")) === 0 && (await cnt("league_members")) === 0 && (await cnt("league_results")) === 0, "Nach über 12 Monaten: alte Ergebnisse gelöscht");
console.log(weekOf(Date.UTC(2026, 11, 31)), weekOf(Date.UTC(2027, 0, 4)));
console.log("FEHLER:", errors.length ? errors : "keine");
