const WORD_RE = /[\p{L}\p{N}]/u;
const HAN_RE = /\p{Script=Han}/u;
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const unique = (values) => [...new Set(values)];

export const codePointLength = (value) => Array.from(String(value || "")).length;
export const utf8ByteLength = (value) => new TextEncoder().encode(String(value || "")).length;

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

export const estimateTokens = (value) => {
  const characters = Array.from(String(value || ""));
  let total = 0;
  let index = 0;
  while (index < characters.length) {
    const character = characters[index];
    if (HAN_RE.test(character)) {
      total += 1;
      index += 1;
      continue;
    }
    if (EMOJI_RE.test(character)) {
      total += 2;
      index += 1;
      continue;
    }
    if (WORD_RE.test(character)) {
      let end = index + 1;
      while (end < characters.length && WORD_RE.test(characters[end]) && !HAN_RE.test(characters[end]) && !EMOJI_RE.test(characters[end])) end += 1;
      total += Math.max(1, Math.ceil((end - index) / 4));
      index = end;
      continue;
    }
    if (/\s/u.test(character)) {
      let end = index + 1;
      while (end < characters.length && /\s/u.test(characters[end])) end += 1;
      total += 1;
      index = end;
      continue;
    }
    total += 1;
    index += 1;
  }
  return total;
};

export const normalizeTokenCounter = (value) => {
  const countTokens = typeof value === "function" ? value : typeof value?.countTokens === "function" ? value.countTokens.bind(value) : null;
  if (typeof countTokens !== "function") return null;
  const name = String(value?.name || value?.id || "provider-tokenizer").trim() || "provider-tokenizer";
  return {
    name,
    countTokens(text) {
      const count = countTokens(String(text || ""));
      if (!Number.isInteger(count) || count < 0) throw Object.assign(new Error(`${name} returned an invalid token count`), { code: "TOKENIZER_INVALID" });
      return count;
    }
  };
};
