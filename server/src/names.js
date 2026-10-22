// Spielernamen prüfen: Länge, erlaubte Zeichen und eine Sperrliste (Beleidigungen, Hetze, Sex, Nazi-Begriffe) in fünf Sprachen.
// Verglichen wird nach Vereinfachung: klein, ohne Akzente, Ziffern wie Buchstaben (0→o, 1→i, 3→e, 4→a, 5→s, 7→t), ohne Leer- und Sonderzeichen.
// Was durchrutscht, können Spieler melden (3 Meldungen → Name ausgeblendet).

const BLOCK = [
  // Deutsch
  "arschloch", "arsch", "wichser", "wixer", "hurensohn", "hure", "fotze", "schlampe", "nutte", "missgeburt", "spast", "spasti", "behindert",
  "schwuchtel", "kanake", "neger", "zigeuner", "judensau", "fick", "ficken", "fixer", "penner", "pisser", "titten", "muschi", "schwanz",
  "hitler", "heilhitler", "siegheil", "nazi", "ssbb", "hhbb", "sshh", "adolf", "kz", "holocaust", "auschwitz",
  // Englisch
  "fuck", "fuk", "shit", "bitch", "cunt", "dick", "cock", "pussy", "asshole", "bastard", "whore", "slut", "nigger", "nigga", "faggot", "fag",
  "retard", "rapist", "porn", "sex", "penis", "vagina", "kys", "killyourself",
  // Spanisch
  "puta", "puto", "mierda", "cabron", "pendejo", "gilipollas", "joder", "maricon", "zorra", "polla", "verga", "culero", "chinga",
  // Französisch
  "merde", "putain", "salope", "connard", "connasse", "encule", "pute", "bite", "couille", "nique", "batard",
  // Portugiesisch
  "caralho", "porra", "buceta", "viado", "foder", "fodase", "merda", "cuzao", "otario", "piroca",
];
// Wörter, die ein gesperrtes Stück enthalten, aber harmlos sind (z. B. „Reich“ in „Frankreich“, „Dick“ in „Dickens“)
const ALLOW = ["frankreich", "osterreich", "reichert", "dickens", "moby", "sussex", "essex", "middlesex", "scunthorpe", "cocktail", "hancock",
  "peacock", "hitchcock", "bitesize", "barsch", "marsch", "harsch", "arschbombe", "kzwei", "bastardo"];

const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b", "@": "a", $: "s", "!": "i" };
export const simplify = (s) =>
  String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ß/g, "ss")
    .replace(/[0-9@$!]/g, (c) => LEET[c] || c).replace(/[^a-z]/g, "");

// Gibt den bereinigten Namen zurück oder null, wenn er nicht geht
export function cleanName(raw) {
  const name = String(raw || "").replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 14) return null;
  // Buchstaben aller fünf Sprachen, Ziffern, Leerzeichen, Punkt, Bindestrich, Unterstrich
  if (!/^[\p{L}\p{N} ._-]+$/u.test(name)) return null;
  let s = simplify(name);
  for (const a of ALLOW) s = s.split(a).join("");
  if (BLOCK.some((b) => (b.length <= 3 ? s === b || s.startsWith(b) && s.length <= b.length + 2 : s.includes(b)))) return null;
  // auch rückwärts geschrieben
  const r = s.split("").reverse().join("");
  if (BLOCK.some((b) => b.length > 4 && r.includes(b))) return null;
  return name;
}
