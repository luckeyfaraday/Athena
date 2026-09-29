// Fuzzy matching for the command palette. Pure: no DOM or React.
//
// fuzzyScore finds the best-scoring subsequence of `query` in `text`. Matches
// earn more at the start of the text, at word starts (after a separator or a
// camelCase boundary) and in consecutive runs; skipped characters and long
// texts cost a little. Scores only compare meaningfully for the same query.

export type FuzzyMatch = { score: number; indices: number[] };

const MATCH_SCORE = 1;
const PREFIX_BONUS = 8;
const WORD_START_BONUS = 6;
const CAMEL_BONUS = 5;
const DIGIT_BONUS = 2;
const CONSECUTIVE_BONUS = 4;
const GAP_PENALTY = 0.4;
const LEADING_PENALTY = 0.2;
const MAX_LEADING_PENALTY = 3;
const LENGTH_PENALTY = 0.02;
const EXACT_BONUS = 12;

const separators = new Set([" ", "-", "_", "/", "\\", ".", ":", ",", "(", "[", "·", "…"]);

function isUpper(char: string): boolean {
  return char !== char.toLowerCase() && char === char.toUpperCase();
}

function isLower(char: string): boolean {
  return char !== char.toUpperCase() && char === char.toLowerCase();
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function boundaryBonus(text: string, index: number): number {
  if (index === 0) return PREFIX_BONUS;
  const previous = text[index - 1];
  const current = text[index];
  if (separators.has(previous)) return WORD_START_BONUS;
  if (isLower(previous) && isUpper(current)) return CAMEL_BONUS;
  if (isDigit(current) && !isDigit(previous)) return DIGIT_BONUS;
  return 0;
}

export function fuzzyScore(query: string, text: string): FuzzyMatch | null {
  const needle = query.toLowerCase();
  if (!needle) return { score: 0, indices: [] };
  const haystack = text.toLowerCase();
  const n = needle.length;
  const m = haystack.length;
  if (n > m) return null;

  // best[j]: best score with the current query char placed at text position j.
  let previous = new Float64Array(m).fill(-Infinity);
  const backtrack: Int32Array[] = [];
  for (let i = 0; i < n; i += 1) {
    const current = new Float64Array(m).fill(-Infinity);
    const from = new Int32Array(m).fill(-1);
    // Best previous placement at k <= j - 2, already charged for the gap to j.
    let gapBest = -Infinity;
    let gapArg = -1;
    for (let j = 0; j < m; j += 1) {
      if (i > 0 && j >= 2) {
        const decayed = gapBest - GAP_PENALTY;
        const candidate = previous[j - 2] - GAP_PENALTY;
        if (candidate >= decayed) {
          gapBest = candidate;
          gapArg = j - 2;
        } else {
          gapBest = decayed;
        }
      }
      if (haystack[j] !== needle[i]) continue;
      const bonus = MATCH_SCORE + boundaryBonus(text, j);
      if (i === 0) {
        current[j] = bonus - Math.min(MAX_LEADING_PENALTY, LEADING_PENALTY * j);
        continue;
      }
      let best = -Infinity;
      let arg = -1;
      if (j >= 1 && previous[j - 1] > -Infinity) {
        best = previous[j - 1] + CONSECUTIVE_BONUS;
        arg = j - 1;
      }
      if (gapBest > best) {
        best = gapBest;
        arg = gapArg;
      }
      if (best === -Infinity) continue;
      current[j] = best + bonus;
      from[j] = arg;
    }
    backtrack.push(from);
    previous = current;
  }

  let end = -1;
  let endScore = -Infinity;
  for (let j = 0; j < m; j += 1) {
    if (previous[j] > endScore) {
      endScore = previous[j];
      end = j;
    }
  }
  if (end < 0) return null;

  const indices = new Array<number>(n);
  let position = end;
  for (let i = n - 1; i >= 0; i -= 1) {
    indices[i] = position;
    position = backtrack[i][position];
  }
  const score = endScore - LENGTH_PENALTY * (m - n) + (haystack === needle ? EXACT_BONUS : 0);
  return { score, indices };
}

export type RankableCommand = {
  title: string;
  subtitle?: string;
  group?: string;
  keywords?: readonly string[];
};

export type RankedCommand<T> = {
  command: T;
  score: number;
  // Matched character positions in the title, sorted, for highlighting.
  titleIndices: number[];
};

const TITLE_WEIGHT = 1;
const KEYWORD_WEIGHT = 0.75;
const SUBTITLE_WEIGHT = 0.5;
const GROUP_WEIGHT = 0.4;
const PHRASE_BONUS = 6;

export function queryWords(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

// Every word of the query must match some field (title, keywords, subtitle or
// group); each word contributes its best weighted field score. Ties keep the
// input order.
export function rankCommands<T extends RankableCommand>(
  query: string,
  commands: readonly T[],
  limit = Number.POSITIVE_INFINITY,
): RankedCommand<T>[] {
  const words = queryWords(query);
  if (words.length === 0) {
    return commands.slice(0, limit).map((command) => ({ command, score: 0, titleIndices: [] }));
  }
  const phrase = words.join(" ");
  const ranked: Array<RankedCommand<T> & { order: number }> = [];
  commands.forEach((command, order) => {
    let total = 0;
    const titleIndices = new Set<number>();
    for (const word of words) {
      let best = -Infinity;
      let bestTitleIndices: number[] | null = null;
      const title = fuzzyScore(word, command.title);
      if (title) {
        best = title.score * TITLE_WEIGHT;
        bestTitleIndices = title.indices;
      }
      for (const keyword of command.keywords ?? []) {
        const match = fuzzyScore(word, keyword);
        if (match && match.score * KEYWORD_WEIGHT > best) {
          best = match.score * KEYWORD_WEIGHT;
          bestTitleIndices = null;
        }
      }
      if (command.subtitle) {
        const match = fuzzyScore(word, command.subtitle);
        if (match && match.score * SUBTITLE_WEIGHT > best) {
          best = match.score * SUBTITLE_WEIGHT;
          bestTitleIndices = null;
        }
      }
      if (command.group) {
        const match = fuzzyScore(word, command.group);
        if (match && match.score * GROUP_WEIGHT > best) {
          best = match.score * GROUP_WEIGHT;
          bestTitleIndices = null;
        }
      }
      if (best === -Infinity) return;
      total += best;
      for (const index of bestTitleIndices ?? []) titleIndices.add(index);
    }
    if (words.length > 1 && command.title.toLowerCase().includes(phrase)) total += PHRASE_BONUS;
    ranked.push({ command, score: total, titleIndices: [...titleIndices].sort((a, b) => a - b), order });
  });
  ranked.sort((a, b) => b.score - a.score || a.order - b.order);
  return ranked.slice(0, limit).map(({ command, score, titleIndices }) => ({ command, score, titleIndices }));
}
