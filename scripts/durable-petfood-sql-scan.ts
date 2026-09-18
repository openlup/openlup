export type DurablePetfoodCandidate = { index: number; token: string; surface: string; pinSurface: string };

type Span = { label: string; name: string; kind: "function" | "table"; start: number; end: number; text: string };
type RawCandidate = DurablePetfoodCandidate;

const TOKEN_RE = /(?<![A-Za-z0-9])(?:kcal_per_[A-Za-z0-9_]+|recipe_mix|portion_mode|portionFactor|dailyKcal|daily_kcal|swap_recipe|update_recipe_mix|set_portion_mode|pet_type|recipe|portion|feeding|topper|kcal)(?![A-Za-z0-9])/gi;
const ENGINE_TABLE_RE = /^(?:public\.)?subscription[A-Za-z0-9_]*$/i;
const ENGINE_FUNCTION_RE = /^(?:public\.)?(?:customer_self_service[A-Za-z0-9_]*|subscription_[A-Za-z0-9_]*)$/i;

function normalizeName(name: string): string {
  return name.replaceAll('"', "").replace(/^public\./i, "").trim();
}

function statementEnd(code: string, start: number): number {
  const semicolon = code.indexOf(";", start);
  return semicolon === -1 ? code.length : semicolon + 1;
}

function functionEnd(code: string, start: number): number {
  const tail = code.slice(start);
  const asMatch = /\bas\s+(\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)/i.exec(tail);
  if (!asMatch?.index) return statementEnd(code, start);
  const bodyStart = start + asMatch.index + asMatch[0].length;
  const close = code.indexOf(asMatch[1], bodyStart);
  if (close < 0) return statementEnd(code, start);
  return statementEnd(code, close + asMatch[1].length);
}

function uniqueCandidates(candidates: RawCandidate[]): DurablePetfoodCandidate[] {
  const seen = new Set<string>();
  return candidates
    .sort((left, right) => left.index - right.index || left.surface.localeCompare(right.surface))
    .filter((candidate) => {
      const key = `${candidate.index}:${candidate.token.toLowerCase()}:${candidate.surface}:${candidate.pinSurface}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function petfoodMatches(text: string, offset: number, surface: string, pinSurface: string): RawCandidate[] {
  return [...text.matchAll(TOKEN_RE)].map((match) => ({
    index: offset + (match.index ?? 0),
    token: match[0],
    surface,
    pinSurface,
  }));
}

function hasPetfoodToken(text: string): boolean {
  TOKEN_RE.lastIndex = 0;
  const result = TOKEN_RE.test(text);
  TOKEN_RE.lastIndex = 0;
  return result;
}

function tableSpans(code: string): Span[] {
  const spans: Span[] = [];
  const tablePattern = '((?:"?public"?\\.)?"?[A-Za-z_][A-Za-z0-9_]*"?)';
  const createRe = new RegExp(`\\bcreate\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${tablePattern}`, "gi");
  for (const match of code.matchAll(createRe)) {
    const name = normalizeName(match[1]);
    if (ENGINE_TABLE_RE.test(name)) {
      const start = match.index ?? 0;
      const end = statementEnd(code, start);
      spans.push({ label: `table ${name}`, name, kind: "table", start, end, text: code.slice(start, end) });
    }
  }

  const alterRe = new RegExp(`\\balter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${tablePattern}`, "gi");
  for (const match of code.matchAll(alterRe)) {
    const name = normalizeName(match[1]);
    if (ENGINE_TABLE_RE.test(name)) {
      const start = match.index ?? 0;
      const end = statementEnd(code, start);
      spans.push({ label: `table ${name}`, name, kind: "table", start, end, text: code.slice(start, end) });
    }
  }
  return spans;
}

function functionSpans(code: string): Span[] {
  const spans: Span[] = [];
  const functionRe = /\bcreate\s+(?:or\s+replace\s+)?function\s+((?:"?public"?\.)?"?[A-Za-z_][A-Za-z0-9_]*"?)/gi;
  for (const match of code.matchAll(functionRe)) {
    const name = normalizeName(match[1]);
    if (ENGINE_FUNCTION_RE.test(name)) {
      const start = match.index ?? 0;
      const end = functionEnd(code, start);
      spans.push({ label: `function ${name}`, name, kind: "function", start, end, text: code.slice(start, end) });
    }
  }
  return spans;
}

function columnCandidates(span: Span): RawCandidate[] {
  const candidates: RawCandidate[] = [];
  const addColumnRe = /\badd\s+column\s+(?:if\s+not\s+exists\s+)?("[^"]+"|[A-Za-z_][A-Za-z0-9_]*)/gi;
  for (const match of span.text.matchAll(addColumnRe)) {
    const column = normalizeName(match[1]);
    candidates.push(...petfoodMatches(column, span.start + (match.index ?? 0), `${span.label} column identifier`, `${span.name}.${column}`));
  }

  const open = span.text.indexOf("(");
  const close = span.text.lastIndexOf(")");
  if (span.kind === "table" && /\bcreate\s+table\b/i.test(span.text) && open >= 0 && close > open) {
    const body = span.text.slice(open + 1, close);
    let cursor = 0;
    for (const rawLine of body.split("\n")) {
      const line = rawLine.trim();
      if (line && !/^(constraint|primary|foreign|unique|check|exclude)\b/i.test(line)) {
        const column = normalizeName(line.split(/\s+/)[0]?.replace(/,$/, "") ?? "");
        candidates.push(...petfoodMatches(column, span.start + open + 1 + cursor, `${span.label} column identifier`, `${span.name}.${column}`));
      }
      cursor += rawLine.length + 1;
    }
  }
  return candidates;
}

function balancedParenBodies(text: string, re: RegExp): Array<{ start: number; end: number; bodyStart: number; body: string }> {
  const bodies: Array<{ start: number; end: number; bodyStart: number; body: string }> = [];
  for (const match of text.matchAll(re)) {
    const open = text.indexOf("(", match.index ?? 0);
    if (open < 0) continue;
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === "(") depth += 1;
      if (text[i] === ")") depth -= 1;
      if (depth === 0) {
        bodies.push({ start: match.index ?? 0, end: i + 1, bodyStart: open + 1, body: text.slice(open + 1, i) });
        break;
      }
    }
  }
  return bodies;
}

function membershipCandidates(span: Span): RawCandidate[] {
  const candidates: RawCandidate[] = [];
  const checkRanges = balancedParenBodies(span.text, /\bcheck\s*\(/gi);
  for (const range of checkRanges) {
    candidates.push(...petfoodMatches(range.body, span.start + range.bodyStart, `${span.label} CHECK membership`, `${span.name}.check_membership`));
  }
  const inRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s+(?:not\s+)?in\s*\(([\s\S]*?)\)/gi;
  for (const match of span.text.matchAll(inRe)) {
    const start = match.index ?? 0;
    if (checkRanges.some((range) => start >= range.start && start < range.end)) continue;
    const param = span.kind === "function" ? normalizeName(match[1]) : "in_membership";
    candidates.push(...petfoodMatches(match[2], span.start + start, `${span.label} IN membership`, `${span.name}.${param}`));
  }
  return candidates;
}

function raiseCandidates(span: Span): RawCandidate[] {
  const candidates: RawCandidate[] = [];
  const raiseRe = /\braise\s+exception\s+'([^']+)'/gi;
  for (const match of span.text.matchAll(raiseRe)) {
    if (hasPetfoodToken(match[1])) {
      candidates.push({
        index: span.start + (match.index ?? 0),
        token: match[1],
        surface: `${span.label} RAISE EXCEPTION code`,
        pinSurface: `${span.name}.raise_exception`,
      });
    }
  }
  return candidates;
}

function eventTypeCandidates(code: string): RawCandidate[] {
  const candidates: RawCandidate[] = [];
  const literalRe = /'([^'\n]*subscription\.[^'\n]*)'/gi;
  for (const match of code.matchAll(literalRe)) {
    candidates.push(...petfoodMatches(match[1], match.index ?? 0, "subscription event_type literal", "event_type"));
  }
  return candidates;
}

function sizeConstraintPathCandidates(span: Span): RawCandidate[] {
  if (!/\bsize_constraint\b/i.test(span.text)) return [];
  const candidates: RawCandidate[] = [];
  const pathRe = /'\{([^'}]+)\}'/g;
  for (const match of span.text.matchAll(pathRe)) {
    candidates.push(...petfoodMatches(match[1], span.start + (match.index ?? 0), `${span.label} size_constraint path`, "subscriptions.size_constraint.key"));
  }
  return candidates;
}

export function findDurablePetfoodCandidates(code: string): DurablePetfoodCandidate[] {
  const spans = [...tableSpans(code), ...functionSpans(code)];
  return uniqueCandidates([
    ...eventTypeCandidates(code),
    ...spans.flatMap((span) => [
      ...columnCandidates(span),
      ...membershipCandidates(span),
      ...raiseCandidates(span),
      ...sizeConstraintPathCandidates(span),
    ]),
  ]);
}
