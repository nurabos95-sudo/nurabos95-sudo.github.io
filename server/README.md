# Wortpoker online – Server

Ein kleiner Cloudflare Worker mit D1-Datenbank (SQLite) für:

- **Tages-Rangliste**: erster Versuch der Tages-Challenge, je Sprache, Filter nach Land
- **Wochen-Liga**: Gruppen mit 30 Spielern je Sprache und Stufe (Bronze bis Diamant), die Top 7 steigen auf, die letzten 5 ab; Platz 1–3 bekommen Münzen
- Namen prüfen (Sperrliste), Namen melden (3 Meldungen → ausgeblendet), alle Daten eines Spielers löschen

Gespeichert werden nur Spielername, Flagge, Figur, Punkte und XP – kein Konto, keine E-Mail, keine IP-Adresse.

## Kosten

Die kostenlose Cloudflare-Stufe reicht für rund 2.000 Spieler pro Tag. Danach kostet der bezahlte Plan 5 $ im Monat, das reicht für etwa 100.000 Spieler pro Tag.

## Einmal einrichten (machst du, Claude darf keine Konten anlegen)

1. Lege ein kostenloses Konto auf **cloudflare.com** an.
2. Öffne im Cloudflare-Dashboard links **Workers & Pages** einmal. Dabei bekommst du deine Adresse `….workers.dev`.
3. Notiere die **Account-ID**. Sie steht rechts auf der Übersichtsseite von Workers & Pages.
4. Lege einen **API-Token** an: Profil → API Tokens → Create Token → „Custom token“ mit diesen Berechtigungen:
   - Account → **Workers Scripts** → Edit
   - Account → **D1** → Edit
   - Account → **Account Settings** → Read
5. Trage beides in GitHub ein, im Repository `nurabos95-sudo.github.io` → Settings → Secrets and variables → Actions → **New repository secret**:
   - `CLOUDFLARE_API_TOKEN` = der Token
   - `CLOUDFLARE_ACCOUNT_ID` = die Account-ID
6. Starte unter GitHub → **Actions** → „Online-Server hochladen“ → **Run workflow**.

Der Workflow erledigt dann alles selbst:

- Er testet den Server.
- Er legt die Datenbank an.
- Er lädt den Worker hoch.
- Er schreibt die Server-Adresse in `online.json` auf der Webseite.

Die App liest die Adresse dort. Dafür braucht es kein App-Update.

## Lokal testen (ohne Cloudflare)

```
node --experimental-sqlite server/test/run.mjs        # Server-Tests
node --experimental-sqlite server/test/serve.mjs 8787 # Testserver; in der App: localStorage „wp-online-api“ = http://localhost:8787
python3 tools/test_online.py                          # App + Server zusammen
```

## Schnittstelle (alles POST mit JSON)

| Pfad | Zweck |
|---|---|
| `/v1/register` | `{name, lang, country, gold, look}` → `{id, token, pub}` |
| `/v1/profile` | Name, Flagge, Figur, Goldpfad aktualisieren |
| `/v1/daily` | `{day, lang, rounds?, points?, secs?, country?}` → Rangliste (Top 50 + eigener Platz) |
| `/v1/xp` | `{xp}` → XP für die Wochen-Liga, Antwort wie `/v1/league` |
| `/v1/league` | eigene Gruppe, Stufe, Ende der Woche, Ergebnis der letzten Woche |
| `/v1/league/claim` | `{week}` → Belohnung der letzten Woche abholen (einmal) |
| `/v1/report` | `{target: pub}` → Namen melden |
| `/v1/delete` | alle Daten des Spielers löschen |

Alle Anfragen außer `register` brauchen `id` und `token`. Grenzen: höchstens 5.000 XP pro Anfrage und 12.000 XP pro Tag.

Bei der Tages-Challenge zählt nur der erste Versuch des Tages, und es geht nur um heute (±1 Tag wegen der Zeitzonen).

Noch offen für später: Der Server rechnet die Punkte nicht selbst nach (geplant mit den Zufallsduellen).
