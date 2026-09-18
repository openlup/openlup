import { foldShellVariableIndirection } from "./neutrality-shell-fold.ts";

export type NeutralityRule = {
  id: string;
  category: string;
  mode: "identifier" | "literal" | "environment-prefix" | "environment-key" | "token";
  terms: string[];
};

export type SourceNeutralityPolicy = {
  productionScope: { activeClasses: string[] };
  rules: NeutralityRule[];
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isIdentifierComponent(source: string, match: RegExpMatchArray, allowAcronymPrefix = false): boolean {
  const index = match.index ?? 0;
  const before = source[index - 1] ?? "";
  const after = source[index + match[0].length] ?? "";
  const start = !/[A-Za-z0-9]/.test(before)
    || (/[a-z0-9]/.test(before) && /[A-Z]/.test(match[0]))
    || (allowAcronymPrefix && /^[A-Z]+$/.test(match[0]) && /[A-Z]/.test(before));
  const rest = source.slice(index + match[0].length);
  const end = !/[A-Za-z0-9]/.test(match[0][match[0].length - 1] ?? "") || !/[A-Za-z0-9]/.test(after)
    || (/[A-Z]/.test(after) && /[a-z]/.test(match[0]))
    || (/^[A-Z]+$/.test(match[0]) && /^[A-Z][a-z]/.test(rest));
  return start && end;
}

type StaticAtom = { end: number; value: string };

function staticAtom(source: string, start: number): StaticAtom | null {
  const quote = source[start];
  if (quote !== "'" && quote !== '"' && quote !== "`") return null;
  let value = "";
  for (let index = start + 1; index < source.length; index += 1) {
    if (quote === "`" && source[index] === "$" && source[index + 1] === "{") return null;
    if (source[index] === "\\") {
      value += source.slice(index, index + 2);
      index += 1;
      continue;
    }
    if (source[index] === quote) return { end: index + 1, value };
    if (/\r|\n/.test(source[index])) return null;
    value += source[index];
  }
  return null;
}

function skipSpace(source: string, index: number): number {
  while (/\s/.test(source[index] ?? "")) index += 1;
  return index;
}

function staticLiteralCall(source: string, receiverEnd: number, name: string): { argument: StaticAtom; end: number } | null {
  const dot = skipSpace(source, receiverEnd);
  const method = skipSpace(source, dot + 1);
  const open = skipSpace(source, method + name.length);
  if (source[dot] !== "." || source.slice(method, method + name.length) !== name || source[open] !== "(") return null;
  const argument = staticAtom(source, skipSpace(source, open + 1));
  if (!argument) return null;
  const close = skipSpace(source, argument.end);
  return source[close] === ")" ? { argument, end: close + 1 } : null;
}

const CONSTANT_DECLARATION = /(?:^|[^A-Za-z0-9_$.])const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?=["'`])/g;
// Sticky, so neither helper has to slice the remaining file at every candidate.
const CONTINUES_CONCATENATION = /\s*(?:\+|\.\s*concat\b)/y;
const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/y;

function stickyMatch(pattern: RegExp, source: string, index: number): string | null {
  pattern.lastIndex = index;
  return pattern.exec(source)?.[0] ?? null;
}

/**
 * Single-file constant table for template interpolation, deliberately without scope analysis:
 * `const NAME = "literal"` only, one flat namespace, and any name declared twice with different
 * values is dropped rather than guessed. An initializer that continues as a concatenation is
 * skipped here and picked up on the next normalization pass, once it is a single atom.
 */
function staticConstants(source: string): Map<string, string> {
  const constants = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const match of source.matchAll(CONSTANT_DECLARATION)) {
    const name = match[1];
    const atom = staticAtom(source, (match.index ?? 0) + match[0].length);
    if (!atom || stickyMatch(CONTINUES_CONCATENATION, source, atom.end) !== null) { ambiguous.add(name); continue; }
    if (constants.get(name) !== undefined && constants.get(name) !== atom.value) ambiguous.add(name);
    constants.set(name, atom.value);
  }
  for (const name of ambiguous) constants.delete(name);
  return constants;
}

/**
 * A template whose every `${...}` resolves to a static string is the same literal written with
 * extra punctuation, so it is folded before matching. Returns null for a template with no
 * interpolation (`staticAtom` already owns that case) and for any interpolation that is not a
 * string literal or a file-local string constant, so a genuinely dynamic template stays untouched.
 */
function staticTemplate(source: string, start: number, constants: Map<string, string>): StaticAtom | null {
  if (source[start] !== "`") return null;
  let value = "";
  let interpolated = false;
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") { value += source.slice(index, index + 2); index += 1; continue; }
    if (source[index] === "`") return interpolated ? { end: index + 1, value } : null;
    if (source[index] === "$" && source[index + 1] === "{") {
      const open = skipSpace(source, index + 2);
      const atom = staticAtom(source, open);
      const name = atom ? null : stickyMatch(IDENTIFIER, source, open);
      const resolved = atom ? atom.value : name === null ? undefined : constants.get(name);
      const close = skipSpace(source, atom ? atom.end : open + (name?.length ?? 0));
      if (resolved === undefined || source[close] !== "}") return null;
      value += resolved;
      interpolated = true;
      index = close;
      continue;
    }
    value += source[index];
  }
  return null;
}

/** Resolves only static quote/backtick atoms and statically resolvable template interpolation. */
export function normalizeStaticNeutralityConcatenations(source: string): string {
  let normalized = source;
  for (let pass = 0; pass < 4; pass += 1) {
    const constants = staticConstants(normalized);
    let output = "";
    let changed = false;
    for (let index = 0; index < normalized.length;) {
      const template = staticTemplate(normalized, index, constants);
      if (template) {
        output += `"${template.value}"`;
        index = template.end;
        changed = true;
        continue;
      }
      if (normalized[index] === "[") {
        const values: string[] = [];
        let cursor = skipSpace(normalized, index + 1);
        let atom = staticAtom(normalized, cursor);
        while (atom) {
          values.push(atom.value);
          cursor = skipSpace(normalized, atom.end);
          if (normalized[cursor] !== ",") break;
          cursor = skipSpace(normalized, cursor + 1);
          atom = staticAtom(normalized, cursor);
        }
        const close = skipSpace(normalized, cursor);
        const join = normalized[close] === "]" ? staticLiteralCall(normalized, close + 1, "join") : null;
        if (values.length && join?.argument.value === "") {
          output += `"${values.join("")}"`;
          index = join.end;
          changed = true;
          continue;
        }
      }
      const left = staticAtom(normalized, index);
      if (left) {
        const concat = staticLiteralCall(normalized, left.end, "concat");
        if (concat) {
          output += `"${left.value}${concat.argument.value}"`;
          index = concat.end;
          changed = true;
          continue;
        }
        const plus = skipSpace(normalized, left.end);
        if (normalized[plus] === "+") {
          const right = staticAtom(normalized, skipSpace(normalized, plus + 1));
          if (right) {
            output += `"${left.value}${right.value}"`;
            index = right.end;
            changed = true;
            continue;
          }
        }
      }
      output += normalized[index++];
    }
    if (!changed) break;
    normalized = output;
  }
  return normalized;
}

export { foldShellVariableIndirection as normalizeShellVariableIndirection };

export type NeutralityScanOptions = {
  /** Fold shell literal-assignment indirection before matching; set for `.sh` sources only. */
  shell?: boolean;
};

/** Shared bounded source matcher used by repository and packed-artifact proofs. */
export function scanNeutralitySource(
  source: string,
  policy: SourceNeutralityPolicy,
  options: NeutralityScanOptions = {},
): Record<string, number> {
  const normalized = normalizeStaticNeutralityConcatenations(
    options.shell === true ? foldShellVariableIndirection(source) : source,
  );
  const counts: Record<string, number> = {};
  const active = new Set(policy.productionScope.activeClasses);
  const envRanges: Array<{ start: number; end: number }> = [];
  const activeRules = policy.rules.filter((rule) => active.has(rule.category));
  const envObject = String.raw`(?:process\s*(?:\?\.|\.)\s*env\??|import\s*\.\s*meta\s*(?:\?\.|\.)\s*env\??)`;
  for (const rule of activeRules.filter((item) => item.mode === "environment-key")) {
    const expression = rule.terms.map(escapeRegex).join("|");
    const envReadPattern = new RegExp(
      `(?:\\?\\.|\\.)\\s*(${expression})(?![A-Za-z0-9_])|\\[\\s*["'\\x60](${expression})["'\\x60]\\s*\\]`,
      "gi",
    );
    for (const match of normalized.matchAll(envReadPattern)) {
      counts[rule.category] = (counts[rule.category] ?? 0) + 1;
      envRanges.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
    }
    const destructurePattern = new RegExp(
      `\\{([^}]+)\\}\\s*=\\s*(?:${envObject}|[A-Za-z_$][A-Za-z0-9_$]*)`,
      "g",
    );
    for (const match of normalized.matchAll(destructurePattern)) {
      let hasEnvKey = false;
      for (const key of match[1].matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
        if (rule.terms.some((term) => key[0].toUpperCase() === term.toUpperCase())) {
          counts[rule.category] = (counts[rule.category] ?? 0) + 1;
          hasEnvKey = true;
        }
      }
      if (hasEnvKey) envRanges.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
    }
  }
  for (const rule of activeRules.filter((item) => item.mode === "environment-prefix")) {
    const envReadPattern = new RegExp(`${envObject}\\s*(?:\\?\\.|\\.)\\s*([A-Za-z_][A-Za-z0-9_]*)(?:\\s*)|${envObject}\\s*(?:\\?\\.|\\.)?\\s*\\[\\s*["'\\x60]([A-Za-z_][A-Za-z0-9_]*)["'\\x60]\\s*\\]`, "g");
    for (const match of normalized.matchAll(envReadPattern)) {
      const key = match[1] ?? match[2] ?? "";
      if (rule.terms.some((prefix) => key.toUpperCase().startsWith(prefix.toUpperCase()))) {
        counts[rule.category] = (counts[rule.category] ?? 0) + 1;
        envRanges.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
      }
    }
    const destructurePattern = new RegExp(`\\{([^}]+)\\}\\s*=\\s*${envObject}`, "g");
    for (const match of normalized.matchAll(destructurePattern)) {
      let hasEnvKey = false;
      for (const key of match[1].matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
        if (rule.terms.some((prefix) => key[0].toUpperCase().startsWith(prefix.toUpperCase()))) {
          counts[rule.category] = (counts[rule.category] ?? 0) + 1;
          hasEnvKey = true;
        }
      }
      if (hasEnvKey) envRanges.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
    }
  }
  for (const rule of activeRules.filter((item) => item.mode !== "environment-prefix" && item.mode !== "environment-key")) {
    const expression = rule.terms.map(escapeRegex).join("|");
    const pattern = new RegExp(expression, "gi");
    for (const match of normalized.matchAll(pattern)) {
      const index = match.index ?? 0;
      const isTailwindPaddingUtility = rule.category === "country"
        && match[0] === "pl"
        && /^-(?:\d|\[)/.test(normalized.slice(index + match[0].length));
      if (
        !isTailwindPaddingUtility
        && ((rule.mode !== "identifier" && rule.mode !== "token") || isIdentifierComponent(normalized, match, rule.mode === "identifier"))
        && !envRanges.some((range) => index >= range.start && index < range.end)
      ) {
        counts[rule.category] = (counts[rule.category] ?? 0) + 1;
      }
    }
  }
  return counts;
}
