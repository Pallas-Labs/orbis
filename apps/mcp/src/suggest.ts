// The nearest names to a typo, for Orbis Code Mode's `NotFound` and missing-function errors.

/** Edit distance between `a` and `b`, by one row of the Levenshtein table. */
const distance = (a: string, b: string): number => {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j] ?? 0;
      row[j] = Math.min(
        above + 1,
        (row[j - 1] ?? 0) + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      previous = above;
    }
  }
  return row[b.length] ?? 0;
};

/**
 * At most `max` of `candidates` near `word`: one that contains it or that it contains, or one within
 * a third of its length in edits (at least 2), nearest first.
 */
export const suggest = (
  word: string,
  candidates: readonly string[],
  max = 5
): string[] => {
  const lower = word.toLowerCase();
  const budget = Math.max(2, Math.floor(lower.length / 3));
  return [...new Set(candidates)]
    .map((candidate) => {
      const other = candidate.toLowerCase();
      const near =
        lower.length > 0 && (other.includes(lower) || lower.includes(other));
      return { candidate, cost: near ? 0 : distance(lower, other) };
    })
    .filter(({ cost }) => cost <= budget)
    .toSorted((a, b) => a.cost - b.cost)
    .slice(0, max)
    .map(({ candidate }) => candidate);
};
