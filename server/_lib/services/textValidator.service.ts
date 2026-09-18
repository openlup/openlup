export interface TextValidationResult {
  ok: boolean;
  matched: string[];
  missing: string[];
  score: number;
}

// Per expected string, accept a match if Levenshtein distance to any detected
// string is <= MAX_DISTANCE characters. Tightened just enough to allow small AI
// jitter (e.g., "70 %" vs "70%") but reject material drift ("Baca białkowa 86%"
// vs "Baza białkowa 96%", which is distance 3).
const MAX_DISTANCE = 2;
const ACCEPTANCE_THRESHOLD = 0.85;

export const textValidator = {
  validate(detected: string[], expected: string[]): TextValidationResult {
    const matched: string[] = [];
    const missing: string[] = [];
    const normalize = (s: string): string => s.trim().toLowerCase();
    const detectedNormalized = detected.map(normalize);
    for (const exp of expected) {
      const target = normalize(exp);
      const hit = detectedNormalized.some((d) => levenshtein(d, target) <= MAX_DISTANCE);
      if (hit) matched.push(exp);
      else missing.push(exp);
    }
    const score = expected.length === 0 ? 1 : matched.length / expected.length;
    return { ok: score >= ACCEPTANCE_THRESHOLD, matched, missing, score };
  },
};

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev: number[] = new Array(b.length + 1);
  const curr: number[] = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}
