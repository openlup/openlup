/**
 * The part of a path that its own surface family did not already fix.
 *
 * A family is defined by its path prefixes, so every member necessarily repeats the prefix that
 * selected it. A counted term inside that prefix therefore measures membership, not coupling: it
 * is identical for every member, no neutralization work can remove it, and it grows by one with
 * each file added - a counter that only ever rises. Only what sits below the selector is a choice
 * the author made, so only that part is counted. The longest matching selector wins, so a nested
 * family does not keep the segment its parent already fixed.
 */
export const pathBelowFamilySelector = (path: string, prefixes: readonly string[]): string => {
  const longest = prefixes.filter((prefix) => path.startsWith(prefix)).sort((a, b) => b.length - a.length)[0];
  return longest ? path.slice(longest.length) : path;
};

export type FamilySelectors = { prefixes?: readonly string[]; rootFiles?: readonly string[]; excludePrefixes?: readonly string[] };

const longestMatch = (path: string, selectors: readonly string[] = []): number =>
  selectors.reduce((best, selector) => (path.startsWith(selector) && selector.length > best ? selector.length : best), 0);

/**
 * Whether one set of selectors claims a path - the single rule every partition, ownership and
 * publishability question in this repository resolves through.
 *
 * The longest matching selector decides, exactly as it decides which segment of a path a family
 * already fixed. An `excludePrefixes` entry carves a subtree out of the prefix that would otherwise
 * select it, and a strictly MORE specific prefix or exact path claims one member of that subtree
 * back - which is the only way to publish a single file out of a directory a family withholds
 * wholesale, and the reason this is a rule rather than an ordering convention.
 *
 * On a tie the exclusion wins, so a carve-out is never re-included by the very selector it carves,
 * and every exclusion that is not answered by a longer selector behaves exactly as it did before
 * this rule existed. Measured over the catalog at the time it was introduced: zero selection
 * changes across every tracked path and every family, and zero in the aggregated withholding form.
 */
export const selectsPath = (path: string, selectors: FamilySelectors): boolean => {
  const claimed = Math.max((selectors.rootFiles ?? []).includes(path) ? path.length : 0, longestMatch(path, selectors.prefixes));
  return claimed > 0 && claimed > longestMatch(path, selectors.excludePrefixes);
};
