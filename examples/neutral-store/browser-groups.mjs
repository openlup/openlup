/** Later, more specific patterns take precedence; the remainder covers every other journey. */
export function journeySelections(patterns) {
  const any = values => values.map(value => `(?:${value})`).join('|');
  return [
    ...patterns.map((pattern, index) => [
      '--grep', pattern,
      ...(index + 1 < patterns.length ? ['--grep-invert', any(patterns.slice(index + 1))] : []),
    ]),
    ...(patterns.length ? [['--grep-invert', any(patterns)]] : [[]]),
  ];
}

// Add a specific group here; earlier groups and the remainder exclude it automatically.
export const browserJourneyGroups = journeySelections([
  'database subscription care',
  'portal ',
  'recovery extension ',
  'operator operations ',
]);
