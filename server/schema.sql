-- Wortpoker online: Datenbank (Cloudflare D1 = SQLite). Einmal anlegen: wrangler d1 execute wortpoker --remote --file=schema.sql
-- Gespeichert wird nur, was die Ranglisten brauchen: Spielername, Flagge, Figur, Punkte. Kein Konto, keine E-Mail, keine IP.

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,            -- geheime Spieler-ID (nur das Gerät kennt sie)
  pub TEXT UNIQUE NOT NULL,       -- öffentliche Kurz-ID (für Melden)
  token_hash TEXT NOT NULL,       -- SHA-256 des Geräte-Schlüssels
  name TEXT NOT NULL,
  lang TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT '',
  gold INTEGER NOT NULL DEFAULT 0, -- Goldpfad: Name in Gold
  look TEXT NOT NULL DEFAULT '{}', -- Figur (kleines JSON)
  tier INTEGER NOT NULL DEFAULT 0, -- Liga: 0 Bronze … 6 Diamant
  hidden INTEGER NOT NULL DEFAULT 0, -- nach Meldungen: Name ausgeblendet
  created INTEGER NOT NULL,
  trophies TEXT NOT NULL DEFAULT '{}', -- Liga-Pokale: {"Stufe": [Gold, Silber, Bronze]}
  best_tier INTEGER NOT NULL DEFAULT 0, -- höchste erreichte Liga
  weeks INTEGER NOT NULL DEFAULT 0,     -- Liga-Wochen mit Platzierung
  level INTEGER NOT NULL DEFAULT 1,     -- Spieler-Stufe (für die Profilkarte)
  best_word TEXT NOT NULL DEFAULT '',   -- bestes Wort
  best_score INTEGER NOT NULL DEFAULT 0,
  stats TEXT NOT NULL DEFAULT '{}',     -- Profil: Erfolge, Duelle, Rekorde, Vitrine (3 Lieblings-Erfolge)
  rating INTEGER NOT NULL DEFAULT 1000, -- Duell-Wertung (Elo)
  duels INTEGER NOT NULL DEFAULT 0, duel_wins INTEGER NOT NULL DEFAULT 0,
  tag INTEGER NOT NULL DEFAULT 0        -- Freundescode: Name#tag (4 Ziffern)
);
CREATE INDEX IF NOT EXISTS player_name ON players (lang, name COLLATE NOCASE);

-- Tages-Challenge: nur der erste Versuch des Tages zählt
CREATE TABLE IF NOT EXISTS daily (
  day TEXT NOT NULL, lang TEXT NOT NULL, player TEXT NOT NULL,
  rounds INTEGER NOT NULL, points INTEGER NOT NULL, secs INTEGER NOT NULL, at INTEGER NOT NULL,
  flag INTEGER NOT NULL DEFAULT 0,   -- 1 = Prüfung fehlgeschlagen: nur der Spieler selbst sieht das Ergebnis
  PRIMARY KEY (day, lang, player)
);
CREATE INDEX IF NOT EXISTS daily_rank ON daily (day, lang, rounds DESC, points DESC, secs ASC);

-- Wochen-Liga: Gruppen à 30 Spieler je Sprache und Liga-Stufe
CREATE TABLE IF NOT EXISTS league_members (
  week TEXT NOT NULL, player TEXT NOT NULL, lang TEXT NOT NULL, tier INTEGER NOT NULL, grp TEXT NOT NULL,
  xp INTEGER NOT NULL DEFAULT 0, last_at INTEGER NOT NULL,
  PRIMARY KEY (week, player)
);
CREATE INDEX IF NOT EXISTS league_grp ON league_members (week, grp, xp DESC);
CREATE INDEX IF NOT EXISTS league_bucket ON league_members (week, lang, tier);

CREATE TABLE IF NOT EXISTS league_results (
  week TEXT NOT NULL, player TEXT NOT NULL, tier INTEGER NOT NULL, grp TEXT NOT NULL,
  rank INTEGER NOT NULL, size INTEGER NOT NULL, new_tier INTEGER NOT NULL, claimed INTEGER NOT NULL DEFAULT 0,
  crowns INTEGER NOT NULL DEFAULT 0, -- Kronen für Wenzels Schatzkammer
  PRIMARY KEY (week, player)
);

-- Obergrenze für XP pro Tag (gegen Unsinn)
CREATE TABLE IF NOT EXISTS xp_days (player TEXT NOT NULL, day TEXT NOT NULL, xp INTEGER NOT NULL, PRIMARY KEY (player, day));

CREATE TABLE IF NOT EXISTS reports (reporter TEXT NOT NULL, target TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (reporter, target));

-- Online-Duelle gegen Fremde: gleiche Karten (seed), nacheinander gespielt wie bei Quizduell
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY, seed INTEGER NOT NULL, len INTEGER NOT NULL, lang TEXT NOT NULL,
  status TEXT NOT NULL,              -- playing_a (A spielt) → open (wartet auf B) → claimed (B spielt) → done
  a TEXT NOT NULL, b TEXT, target TEXT, a_rating INTEGER NOT NULL DEFAULT 1000,
  a_points INTEGER, a_secs INTEGER, a_rounds INTEGER, b_points INTEGER, b_secs INTEGER, b_rounds INTEGER,
  a_delta INTEGER, b_delta INTEGER, a_seen INTEGER NOT NULL DEFAULT 0, b_seen INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL, claimed INTEGER, finished INTEGER,
  a_flag INTEGER NOT NULL DEFAULT 0, b_flag INTEGER NOT NULL DEFAULT 0 -- Prüfung fehlgeschlagen → keine Wertung
);
CREATE INDEX IF NOT EXISTS match_open ON matches (status, lang, len, created);
CREATE INDEX IF NOT EXISTS match_a ON matches (a, created);
CREATE INDEX IF NOT EXISTS match_b ON matches (b, created);
CREATE INDEX IF NOT EXISTS match_t ON matches (target, status);

-- Freunde (immer in beide Richtungen gespeichert), mit Bilanz der Duelle seit der Freundschaft
CREATE TABLE IF NOT EXISTS friends (player TEXT NOT NULL, friend TEXT NOT NULL, created INTEGER NOT NULL,
  w INTEGER NOT NULL DEFAULT 0, l INTEGER NOT NULL DEFAULT 0, t INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (player, friend));

-- Auffällige Ergebnisse (zum Nachsehen, ob die Prüfung zu streng ist)
CREATE TABLE IF NOT EXISTS flags (player TEXT NOT NULL, kind TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
