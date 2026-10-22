// Punkte für ein Wort – dieselbe Rechnung in der App und auf dem Server (server/src/score.js ist eine Kopie, Prüfung der Online-Ergebnisse).
// chs: gelegte Zeichen (★ = Joker-Stein), jkIds: aktive Joker, enh: Veredelungen je Buchstabe, opts.bossRules: Regeln des Bosses.
const VOWELS = new Set(["A", "E", "I", "O", "U", "Ä", "Ö", "Ü"]);
const EXOT_LETTERS = new Set(["J", "Q", "V", "X", "Y"]);
// Buchstabenwerte je Sprache
export const LETTER_VAL_DE = {
  E: 1, N: 1, S: 1, I: 1, R: 1, T: 1, U: 1, A: 1, D: 1,
  H: 2, G: 2, L: 2, O: 2, M: 3, B: 3, W: 3, Z: 3,
  C: 4, F: 4, K: 4, P: 4, "Ä": 6, J: 6, "Ü": 6, V: 6, "Ö": 8, X: 8, Q: 10, Y: 10, "★": 0,
};
export const LETTER_VAL_EN = {
  E: 1, A: 1, I: 1, O: 1, N: 1, R: 1, T: 1, L: 1, S: 1, U: 1, D: 2, G: 2,
  B: 3, C: 3, M: 3, P: 3, F: 4, H: 4, V: 4, W: 4, Y: 4, K: 5, J: 8, X: 8, Q: 10, Z: 10, "★": 0,
};
export const LETTER_VAL_ES = {
  A: 1, E: 1, O: 1, I: 1, S: 1, N: 1, R: 1, U: 1, L: 1, T: 1, D: 2, G: 2, C: 3, B: 3, M: 3, P: 3,
  H: 4, F: 4, V: 4, Y: 4, Q: 5, J: 8, "Ñ": 8, X: 8, K: 8, W: 8, Z: 10, "★": 0,
};
export const LETTER_VAL_FR = {
  E: 1, A: 1, I: 1, N: 1, O: 1, R: 1, S: 1, T: 1, U: 1, L: 1, D: 2, G: 2, M: 2, B: 3, C: 3, P: 3,
  F: 4, H: 4, V: 4, J: 8, Q: 8, K: 10, W: 10, X: 10, Y: 10, Z: 10, "★": 0,
};
export const LETTER_VAL_PT = {
  A: 1, E: 1, I: 1, O: 1, S: 1, U: 1, M: 1, R: 1, T: 1, D: 2, L: 2, C: 2, P: 2, N: 3, B: 3, "Ç": 3,
  F: 4, G: 4, H: 4, V: 4, J: 5, Q: 6, X: 8, Z: 8, "★": 0,
};
export const LETTER_VALS = { de: LETTER_VAL_DE, en: LETTER_VAL_EN, es: LETTER_VAL_ES, fr: LETTER_VAL_FR, pt: LETTER_VAL_PT };

export const scoreCore = (word, chs, jkIds, enh, opts, LETTER_VAL) => {
  const { isLastPlay, isFirstPlay, wordsSoFar, moneyNow = 0, roundNum = 1, runWordsNow = 0, swapsNow = 0 } = opts;
  const rules = opts.bossRules || [];
  const bossHas = (_b, r) => rules.includes(r), activeBoss = null;
  const len = word.length;
  const has = (id) => jkIds.includes(id);
  const valMult = has("alchemist") ? 2 : 1;
  let chips = 0;
  let crystalMults = 0, goldCount = 0;
  const goldBonus = has("goldschmied") ? 25 : 10;
  const crystalFactor = has("diamant") ? 2 : 1.5;
  chs.forEach((ch, i) => {
    let v = (LETTER_VAL[ch] || 0) * valMult;
    const effCh = word[i];
    if (bossHas(activeBoss, "stumm") && VOWELS.has(effCh)) v = 0;
    if (bossHas(activeBoss, "stille")) v = Math.ceil(v / 2);
    if (bossHas(activeBoss, "dieb") && i === 0) v = 0;
    chips += v * 2;
    const e = enh[ch];
    if (e === "gold") { chips += goldBonus; goldCount++; }
    if (e === "kristall") crystalMults++;
  });
  chips += len * 3;
  let mult = Math.max(1, len - 2);
  const steps = [];
  if (goldCount) steps.push(`💛 +${goldCount * goldBonus}`);
  const vowels = word.split("").filter((ch) => VOWELS.has(ch)).length;
  const consonants = len - vowels;
  const counts = {};
  word.split("").forEach((ch) => (counts[ch] = (counts[ch] || 0) + 1));
  const hasDouble = Object.values(counts).some((n) => n >= 2);
  const hasUmlaut = /[ÄÖÜ]/.test(word);
  const isPalindrome = len >= 3 && word === word.split("").reverse().join("");

  const exotic = word.split("").some((ch) => EXOT_LETTERS.has(ch));
  // Chips
  if (has("glueck")) { chips += 20; steps.push("🍀 +20"); }
  if (has("kaefer")) { chips += 2 * len; steps.push(`🐞 +${2 * len}`); }
  if (has("edelstein") && counts["E"]) { chips += 8 * counts["E"]; steps.push(`💎 +${8 * counts["E"]}`); }
  if (has("dichter") && vowels && !bossHas(activeBoss, "stumm")) { chips += 5 * vowels; steps.push(`✒️ +${5 * vowels}`); }
  if (has("konsonant") && consonants) { chips += 4 * consonants; steps.push(`🗿 +${4 * consonants}`); }
  if (has("anlaut") && VOWELS.has(word[0])) { chips += 25; steps.push("🅰️ +25"); }
  if (has("endsilbe") && word[len - 1] === "N") { chips += 30; steps.push("🔚 +30"); }
  if (has("doppel") && hasDouble) { chips += 20; steps.push("👯 +20"); }
  if (has("vierer") && len === 4) { chips += 25; mult += 3; steps.push("🍱 +25 +3×"); }
  if (has("zwerg") && len === 5) { chips += 20; mult += 2; steps.push("🍄 +20 +2×"); }
  if (has("felsbrocken") && vowels === 1) { chips += 70; steps.push("🪨 +70"); }
  if (has("exot") && exotic) { chips += 60; steps.push("🦎 +60"); }
  if (has("morgen") && isFirstPlay) { chips += 40; steps.push("🌅 +40"); }
  // + Mult
  if (has("roman") && len >= 6) { mult += 3; steps.push("📚 +3×"); }
  if (has("mini") && len <= 4) { mult += 8; steps.push("🐜 +8×"); }
  if (has("sammler") && wordsSoFar > 0) { mult += wordsSoFar; steps.push(`🧺 +${wordsSoFar}×`); }
  if (has("professor") && vowels > 0) { mult += vowels; steps.push(`🎓 +${vowels}×`); }
  if (has("gierig") && moneyNow >= 3) { const g = Math.floor(moneyNow / 3); mult += g; steps.push(`🤑 +${g}×`); }
  if (has("kehraus") && swapsNow > 0) { mult += swapsNow; steps.push(`🧹 +${swapsNow}×`); }
  if (has("lernkurve") && runWordsNow >= 5) { const g = Math.floor(runWordsNow / 5); mult += g; steps.push(`📈 +${g}×`); }
  if (has("unendlich") && roundNum > 1) { mult += roundNum - 1; steps.push(`♾️ +${roundNum - 1}×`); }
  if (has("orchester") && jkIds.length > 1) { mult += 2 * (jkIds.length - 1); steps.push(`🎻 +${2 * (jkIds.length - 1)}×`); }
  // × Mult
  for (let i = 0; i < crystalMults; i++) mult = Math.round(mult * crystalFactor * 10) / 10;
  if (crystalMults) steps.push(`🔮 ×${Math.pow(crystalFactor, crystalMults).toFixed(1).replace(".", ",")}`);
  if (has("bibliothekar") && len >= 7) { mult *= 2; steps.push("🤓 ×2"); }
  if (has("eule") && vowels >= 3) { mult *= 1.5; steps.push("🦉 ×1,5"); }
  if (has("zwilling") && hasDouble) { mult *= 1.5; steps.push("♊ ×1,5"); }
  if (has("umlaut") && hasUmlaut) { mult *= 3; steps.push("🥨 ×3"); }
  if (has("schlange") && word[0] === "S") { mult *= 2; steps.push("🐍 ×2"); }
  if (has("mitte") && word[len - 1] === "T") { mult *= 2; steps.push("🎯 ×2"); }
  if (has("echo") && word[0] === word[len - 1]) { mult *= 3; steps.push("🔊 ×3"); }
  if (has("phoenix") && isFirstPlay) { mult *= 2; steps.push("🔥 ×2"); }
  if (has("endspurt") && isLastPlay) { mult *= 2; steps.push("🏁 ×2"); }
  if (has("wortgott")) { mult *= 2; steps.push("⚡ ×2"); }
  if (opts.duden) { mult *= 2; steps.push("📖 ×2"); }
  if (opts.secret && opts.secret === word) { mult *= 2; steps.push("🔎 ×2"); }
  else if (opts.theme && opts.theme.includes(word)) { mult *= 2; steps.push("🏷️ ×2"); }   // Wortreise: jedes Themenwort der Station
  if (has("spiegel")) { const f = isPalindrome ? 5 : 1.5; mult *= f; steps.push(`🪞 ×${String(f).replace(".", ",")}`); }
  mult = Math.round(mult * 10) / 10;
  let total = Math.round(chips * mult);
  if (opts.cap && total > opts.cap) { total = opts.cap; steps.push(`🍲 max ${opts.cap}`); }
  return { chips, mult, total, steps, isPalindrome };
};
