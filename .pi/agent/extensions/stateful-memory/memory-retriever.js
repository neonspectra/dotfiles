const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "i",
  "if",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "she",
  "that",
  "the",
  "their",
  "they",
  "this",
  "to",
  "we",
  "what",
  "when",
  "where",
  "who",
  "with",
  "you",
  "your",
]);

export function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token && !STOP_WORDS.has(token));
}

function recencyBoost(timestamp) {
  if (!timestamp) {
    return 0;
  }
  const parsed = Date.parse(timestamp.replace(" ", "T"));
  if (Number.isNaN(parsed)) {
    return 0;
  }
  const ageDays = Math.max(0, (Date.now() - parsed) / (1000 * 60 * 60 * 24));
  return 1 / (1 + ageDays);
}

export function scoreEntry(entry, queryTokens) {
  const entryTokens = new Set(tokenize(entry.text));
  const overlap = [...queryTokens].filter((token) => entryTokens.has(token))
    .length;
  const tagOverlap = entry.tags
    ? entry.tags.filter((tag) => queryTokens.has(tag.toLowerCase())).length
    : 0;

  if (overlap === 0 && tagOverlap === 0) {
    return 0;
  }

  return overlap + tagOverlap * 0.5 + recencyBoost(entry.timestamp) * 0.25;
}

export function findRelevantEntries(entries, query, { topK = 5, minScore = 0.25 } = {}) {
  const queryTokens = new Set(tokenize(query));

  if (queryTokens.size === 0) {
    return [];
  }

  const scored = entries
    .map((entry) => ({
      entry,
      score: scoreEntry(entry, queryTokens),
    }))
    .filter((item) => item.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return scored.map((item) => item.entry);
}
