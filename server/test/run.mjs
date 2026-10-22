// Tests für den Worker (ohne Cloudflare): node --experimental-sqlite server/test/run.mjs
import { D1 } from "./d1shim.mjs";
import { handle, weekOf, weekEnd } from "../src/worker.js";
import { cleanName } from "../src/names.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const env = { DB: new D1(join(here, "..", "schema.sql")) };
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
let cl = await call("/v1/league/claim", { id: a.id, token: a.token, week: "2026-W43" });
ok(cl.claimed === true, "Belohnung abholen");
cl = await call("/v1/league/claim", { id: a.id, token: a.token, week: "2026-W43" });
ok(cl.claimed === false && (await call("/v1/league", { id: a.id, token: a.token })).result === null, "Belohnung nur einmal");
r = await call("/v1/xp", { id: a.id, token: a.token, xp: 50 });
ok(r.joined && r.tier === 1 && r.members.length === 1, "Neue Woche in der Silber-Liga");

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

console.log(weekOf(Date.UTC(2026, 11, 31)), weekOf(Date.UTC(2027, 0, 4)));
console.log("FEHLER:", errors.length ? errors : "keine");
