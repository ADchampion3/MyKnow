const WORD_RE = /[\p{L}\p{N}]/u;
const HAN_RE = /\p{Script=Han}/u;
const unique = (values) => [...new Set(values)];

const scanText = (value) => {
  const words = [];
  const hanRuns = [];
  let word = "";
  let han = "";
  const finishWord = () => { if (word) { words.push(word); word = ""; } };
  const finishHan = () => { if (han) { hanRuns.push(han); han = ""; } };
  for (const character of Array.from(String(value || "").normalize("NFKC").toLocaleLowerCase())) {
    if (HAN_RE.test(character)) { finishWord(); han += character; continue; }
    finishHan();
    if (WORD_RE.test(character)) word += character;
    else finishWord();
  }
  finishWord();
  finishHan();
  const cjkBigrams = hanRuns.flatMap((run) => {
    const characters = Array.from(run);
    if (characters.length === 1) return characters;
    return characters.slice(0, -1).map((character, index) => character + characters[index + 1]);
  });
  return { words, hanRuns, cjkBigrams };
};

export const tokenizeText = (value) => {
  const parsed = scanText(value);
  return { words: unique(parsed.words), hanRuns: parsed.hanRuns, cjkBigrams: unique(parsed.cjkBigrams) };
};

export const tokenizeParts = (value) => {
  const parsed = scanText(value);
  return [...parsed.words, ...parsed.cjkBigrams];
};
