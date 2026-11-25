import { nativeStoreIdentity } from "./sql-tokenizer.ts";
import { sqlSha256 } from "./types.ts";

// Already-landed open-class forwards whose immutable historical bytes predate the trailing pg_temp rule.
// Keyed by exact path and file SHA-256 so only those frozen historical blobs are grandfathered.
const HISTORICAL_SECURITY_DEFINER_FORWARDS = new Map<string, string>([
  [
    "db/platform/migrations/20261106050000_customer_command_key_isolation.sql",
    "c8ab11f943b18dcbb57c50f9aa51dd7f181b59374b3fc1ba0c1e4548d50404a4",
  ],
  ["db/platform/migrations/20261106100000_subscription_lifecycle_closure.sql", "ba8067a2d8b18f95eb4a446a8a08ca8e1f49fe05d759e925145a0d0f7e089874"],
  ["db/platform/migrations/20261110115000_customer_checkout_links.sql", "00f62af7a95ab3989418e9cbe110bda7f52ead7a93db2f995c95f4aa4c0a0bdf"],
  ["db/platform/migrations/20261122190000_subscription_cadence_bound.sql", "84d2313165d7408bdb439f474f1c70107aa46ee170ead65a13f79b249fdae0a8"],
  ["supabase/migrations/20261123144000_checkout_account_ownership.sql", "1c763114dd44e1c2226dce3dc8dc19da1b1d12d03dabfe87a291c544eaa3d1a4"],
]);
export const isGrandfatheredSecurityDefinerForward = (path: string, bytes: Buffer): boolean => HISTORICAL_SECURITY_DEFINER_FORWARDS.get(path) === sqlSha256(bytes);

export type SecurityDefinerToken = {
  kind: "word" | "quoted" | "string" | "escape-string" | "unicode-escape" | "dollar-string" | "param" | "number" | "symbol";
  value: string;
  start: number;
  end: number;
};

const secWord = (tokens: readonly SecurityDefinerToken[], index: number, expected: string): boolean =>
  tokens[index]?.kind === "word" && tokens[index]!.value.toUpperCase() === expected;
const secSymbol = (tokens: readonly SecurityDefinerToken[], index: number, expected: string): boolean =>
  tokens[index]?.kind === "symbol" && tokens[index]!.value === expected;
const secIdentifier = (token: SecurityDefinerToken | undefined): string | null =>
  token?.kind === "word" ? token.value.toLowerCase() : token?.kind === "quoted" ? token.value : null;
function secQualified(tokens: readonly SecurityDefinerToken[], start: number): { name: string; next: number } | null {
  const schema = secIdentifier(tokens[start]), name = secIdentifier(tokens[start + 2]);
  return schema !== null && name !== null && secSymbol(tokens, start + 1, ".") && !secSymbol(tokens, start + 3, ".") ? { name: `${schema}.${name}`, next: start + 3 } : null;
}

/**
 * Advances past PostgreSQL `quotecontinue` whitespace/comments after a closing single quote.
 * Matches PostgreSQL `scan.l`: a string literal continues only across spaces/tabs/`\n` and
 * `--...\n` line comments containing at least one newline, immediately followed by `'`.
 */
function readQuoteContinue(source: string, index: number): number | null {
  let cursor = index;
  let sawNewline = false;
  while (cursor < source.length) {
    const ch = source[cursor]!;
    if (ch === " " || ch === "\t") { cursor++; continue; }
    if (ch === "\n") { sawNewline = true; cursor++; continue; }
    if (source.startsWith("--", cursor)) {
      const end = source.indexOf("\n", cursor);
      if (end < 0) return null;
      sawNewline = true;
      cursor = end + 1;
      continue;
    }
    break;
  }
  return sawNewline && source[cursor] === "'" ? cursor : null;
}

function readSingleQuotedLiteral(
  source: string,
  firstQuoteIndex: number,
  mode: "standard" | "escape" | "unicode",
  ctx: string,
): { value: string; end: number } {
  const label = mode === "escape" ? "escape string" : mode === "unicode" ? "Unicode escape literal" : "string literal";
  let value = "";
  let index = firstQuoteIndex;
  for (;;) {
    index++; // consume opening single quote
    let closed = false;
    while (index < source.length) {
      if (mode === "escape" && source[index] === "\\") {
        if (index + 1 >= source.length) throw new Error(`SECURITY DEFINER check found unterminated ${label}${ctx}`);
        value += source[index + 1]!;
        index += 2;
        continue;
      }
      if (source[index] === "'") {
        if (source[index + 1] === "'") { value += "'"; index += 2; continue; }
        index++; closed = true; break;
      }
      value += source[index++];
    }
    if (!closed) throw new Error(`SECURITY DEFINER check found unterminated ${label}${ctx}`);
    const continued = readQuoteContinue(source, index);
    if (continued === null) return { value, end: index };
    index = continued;
  }
}

/**
 * Finds the matching `END` for a `BEGIN ATOMIC` compound SQL body starting at `beginIndex`.
 * PostgreSQL `compound_stmt` (`BEGIN ATOMIC stmtmulti END`) does not have standalone nested
 * `BEGIN ATOMIC` blocks, and every inner statement ends with `;`. Thus the closing `END` at
 * `parenDepth === 0` is always either immediately at `beginIndex + 2` (empty `BEGIN ATOMIC END`)
 * or immediately preceded by `;`. Nested routine DDL inside `BEGIN ATOMIC` is refused.
 */
function findAtomicBodyEnd(tokens: readonly SecurityDefinerToken[], beginIndex: number, ctx: string, requireComplete = false): number {
  let parenDepth = 0;
  let atInnerStmtStart = true;
  for (let i = beginIndex + 2; i < tokens.length; i++) {
    if (secSymbol(tokens, i, "(")) { parenDepth++; atInnerStmtStart = false; continue; }
    if (secSymbol(tokens, i, ")")) {
      if (parenDepth > 0) parenDepth--;
      else if (requireComplete) throw new Error(`remove the unmatched closing parenthesis${ctx}`);
      continue;
    }
    if (parenDepth !== 0) continue;
    if (secWord(tokens, i, "END") && (i === beginIndex + 2 || secSymbol(tokens, i - 1, ";"))) {
      return i;
    }
    if (atInnerStmtStart) {
      if (secSymbol(tokens, i, ";")) continue;
      const innerCreate = secWord(tokens, i, "CREATE");
      const innerKindIdx = innerCreate && secWord(tokens, i + 1, "OR") && secWord(tokens, i + 2, "REPLACE") ? i + 3 : i + 1;
      const innerRoutineDdl = (innerCreate && (secWord(tokens, innerKindIdx, "FUNCTION") || secWord(tokens, innerKindIdx, "PROCEDURE")))
        || (secWord(tokens, i, "ALTER") && (secWord(tokens, i + 1, "FUNCTION") || secWord(tokens, i + 1, "PROCEDURE") || secWord(tokens, i + 1, "ROUTINE")));
      if (innerRoutineDdl) {
        throw new Error(`nested routine DDL inside BEGIN ATOMIC is not permitted; declare each routine as a top-level statement${ctx}`);
      }
      atInnerStmtStart = false;
    } else if (secSymbol(tokens, i, ";")) {
      atInnerStmtStart = true;
    }
  }
  return -1;
}

export function tokenizeSecurityDefinerStatements(source: string, path?: string, { requireComplete = false } = {}): SecurityDefinerToken[][] {
  const ctx = path ? ` in ${path}` : "";
  const tokens: SecurityDefinerToken[] = [];
  const dollarTagPattern = /\$(?:[A-Za-z_\u{80}-\u{10ffff}][A-Za-z0-9_\u{80}-\u{10ffff}]*)?\$/uy;
  const paramPattern = /\$[0-9]+/uy;
  const wordPattern = /[A-Za-z_\u{80}-\u{10ffff}][A-Za-z0-9_$\u{80}-\u{10ffff}]*/uy;
  const numberPattern = /[0-9]+(?:\.[0-9]+)?/uy;
  const identCharPattern = /^[A-Za-z0-9_$\u{80}-\u{10ffff}]$/u;
  for (let index = 0; index < source.length;) {
    const start = index, ch = source[index]!;
    if (ch === " " || ch === "\t" || ch === "\n") { index++; continue; }
    if (source.startsWith("--", index)) {
      const end = source.indexOf("\n", index);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (source.startsWith("/*", index)) {
      let depth = 1; index += 2;
      while (index < source.length && depth > 0) {
        if (source.startsWith("/*", index)) { depth++; index += 2; }
        else if (source.startsWith("*/", index)) { depth--; index += 2; }
        else index++;
      }
      if (depth > 0) throw new Error(`SECURITY DEFINER check found unterminated block comment${ctx}`);
      continue;
    }
    const prevUnit = index > 0 ? source.charCodeAt(index - 1) : -1;
    const prevChar = index > 0
      ? (prevUnit >= 0xdc00 && prevUnit <= 0xdfff && index >= 2 ? source.slice(index - 2, index) : source[index - 1]!)
      : "";
    const prevIdent = prevChar !== "" && identCharPattern.test(prevChar);
    if (!prevIdent && (ch === "U" || ch === "u") && source[index + 1] === "&" && (source[index + 2] === "'" || source[index + 2] === '"')) {
      const quote = source[index + 2]!;
      if (quote === "'") {
        const literal = readSingleQuotedLiteral(source, index + 2, "unicode", ctx);
        index = literal.end;
        tokens.push({ kind: "unicode-escape", value: literal.value, start, end: index });
        continue;
      }
      let value = "", closed = false;
      index += 3;
      while (index < source.length) {
        if (source[index] === '"') {
          if (source[index + 1] === '"') { value += '"'; index += 2; continue; }
          index++; closed = true; break;
        }
        value += source[index++];
      }
      if (!closed) throw new Error(`SECURITY DEFINER check found unterminated Unicode escape literal${ctx}`);
      tokens.push({ kind: "unicode-escape", value, start, end: index });
      continue;
    }
    if (!prevIdent && (ch === "E" || ch === "e") && source[index + 1] === "'") {
      const literal = readSingleQuotedLiteral(source, index + 1, "escape", ctx);
      index = literal.end;
      tokens.push({ kind: "escape-string", value: literal.value, start, end: index });
      continue;
    }
    if (ch === "'") {
      const literal = readSingleQuotedLiteral(source, index, "standard", ctx);
      index = literal.end;
      tokens.push({ kind: "string", value: literal.value, start, end: index });
      continue;
    }
    if (ch === '"') {
      let value = "", closed = false;
      index++;
      while (index < source.length) {
        if (source[index] === '"') {
          if (source[index + 1] === '"') { value += '"'; index += 2; continue; }
          index++; closed = true; break;
        }
        value += source[index++];
      }
      if (!closed) throw new Error(`SECURITY DEFINER check found unterminated quoted identifier${ctx}`);
      tokens.push({ kind: "quoted", value, start, end: index });
      continue;
    }
    if (ch === "$") {
      let tag: string | undefined;
      if (!prevIdent) {
        dollarTagPattern.lastIndex = index;
        tag = dollarTagPattern.exec(source)?.[0];
      }
      if (tag) {
        const end = source.indexOf(tag, index + tag.length);
        if (end < 0) throw new Error(`SECURITY DEFINER check found unterminated dollar-quoted body${ctx}`);
        index = end + tag.length;
        tokens.push({ kind: "dollar-string", value: source.slice(start + tag.length, end), start, end: index });
        continue;
      }
      paramPattern.lastIndex = index;
      const param = paramPattern.exec(source)?.[0];
      if (param) {
        index += param.length;
        tokens.push({ kind: "param", value: param, start, end: index });
        continue;
      }
      index++;
      tokens.push({ kind: "symbol", value: "$", start, end: index });
      continue;
    }
    wordPattern.lastIndex = index;
    const word = wordPattern.exec(source)?.[0];
    if (word) {
      index += word.length;
      tokens.push({ kind: "word", value: word, start, end: index });
      continue;
    }
    numberPattern.lastIndex = index;
    const number = numberPattern.exec(source)?.[0];
    if (number) {
      index += number.length;
      tokens.push({ kind: "number", value: number, start, end: index });
      continue;
    }
    index++;
    tokens.push({ kind: "symbol", value: ch, start, end: index });
  }
  const statements: SecurityDefinerToken[][] = [];
  let current: SecurityDefinerToken[] = [];
  let parenDepth = 0;
  const inCreateRoutine = () => {
    const kindIdx = secWord(current, 1, "OR") && secWord(current, 2, "REPLACE") ? 3 : 1;
    return secWord(current, 0, "CREATE") && (secWord(current, kindIdx, "FUNCTION") || secWord(current, kindIdx, "PROCEDURE"));
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    current.push(token);
    if (token.kind === "symbol" && token.value === "(") { parenDepth++; continue; }
    if (token.kind === "symbol" && token.value === ")") {
      if (parenDepth > 0) parenDepth--;
      else if (requireComplete) throw new Error(`remove the unmatched closing parenthesis${ctx}`);
      continue;
    }
    if (parenDepth === 0) {
      if (inCreateRoutine() && secWord(tokens, i, "BEGIN") && secWord(tokens, i + 1, "ATOMIC")) {
        const end = findAtomicBodyEnd(tokens, i, ctx, requireComplete);
        if (end < 0 && requireComplete) throw new Error(`finish the BEGIN ATOMIC body with END and balance its parentheses${ctx}`);
        const stop = end >= 0 ? end : tokens.length - 1;
        for (let j = i + 1; j <= stop; j++) current.push(tokens[j]!);
        i = stop;
        continue;
      }
      if (token.kind === "symbol" && token.value === ";") {
        statements.push(current);
        current = [];
      }
    }
  }
  if (current.length > 0) {
    if (requireComplete) {
      if (parenDepth > 0) throw new Error(`close all parentheses before the statement terminator${ctx}`);
      throw new Error(`end the statement with a semicolon at depth zero${ctx}`);
    }
    statements.push(current);
  }
  return statements;
}

/** Every new SECURITY DEFINER function/procedure and routine ALTER search_path must pin pg_temp last. */
export function assertSecurityDefinerSearchPath(sql: string | Buffer, path?: string): void {
  const ctx = path ? ` in ${path}` : "";
  const rawBytes = typeof sql === "string" ? Buffer.from(sql, "utf8") : sql;
  if (rawBytes.some(byte => (byte < 0x20 && byte !== 0x09 && byte !== 0x0a) || byte === 0x7f)) {
    throw new Error(`SECURITY DEFINER check refuses control characters${ctx}`);
  }
  const source = typeof sql === "string" ? sql : sql.toString("utf8");
  for (const tokens of tokenizeSecurityDefinerStatements(source, path)) {
    const isCreate = secWord(tokens, 0, "CREATE");
    const isAlter = secWord(tokens, 0, "ALTER");
    const kindIndex = isCreate && secWord(tokens, 1, "OR") && secWord(tokens, 2, "REPLACE") ? 3 : 1;
    const isCreateRoutine = isCreate && (secWord(tokens, kindIndex, "FUNCTION") || secWord(tokens, kindIndex, "PROCEDURE"));
    const isAlterRoutine = isAlter && (secWord(tokens, 1, "FUNCTION") || secWord(tokens, 1, "PROCEDURE") || secWord(tokens, 1, "ROUTINE"));
    if (!isCreateRoutine && !isAlterRoutine) continue;
    const routineKind = tokens[kindIndex]!.value.toUpperCase();
    // Refuse Unicode-escape syntax anywhere in routine headers (outside dollar bodies and BEGIN ATOMIC bodies).
    let uDepth = 0;
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      if (token.kind === "symbol" && token.value === "(") { uDepth++; continue; }
      if (token.kind === "symbol" && token.value === ")") { if (uDepth > 0) uDepth--; continue; }
      if (uDepth === 0 && isCreateRoutine && secWord(tokens, index, "BEGIN") && secWord(tokens, index + 1, "ATOMIC")) {
        const end = findAtomicBodyEnd(tokens, index, ctx);
        if (end < 0) break;
        index = end;
        continue;
      }
      if (token.kind === "unicode-escape" || secWord(tokens, index, "UESCAPE")) {
        throw new Error(`SECURITY DEFINER check refuses Unicode escape syntax (U& / UESCAPE) in routine DDL${ctx}`);
      }
    }
    const nameStart = kindIndex + 1;
    const qualified = secQualified(tokens, nameStart);
    const unqualified = !qualified ? secIdentifier(tokens[nameStart]) : null;
    const fnName = qualified ? qualified.name : unqualified;
    const afterName = qualified ? qualified.next : unqualified !== null ? nameStart + 1 : -1;
    if (!fnName || afterName < 0) throw new Error(`SECURITY DEFINER check could not parse ${routineKind} signature${ctx}`);
    let attrStart = afterName;
    let signature = fnName;
    if (secSymbol(tokens, afterName, "(")) {
      let close = afterName, depth = 0;
      for (; close < tokens.length; close++) {
        if (secSymbol(tokens, close, "(")) depth++;
        if (secSymbol(tokens, close, ")") && --depth === 0) break;
      }
      if (close >= tokens.length) throw new Error(`SECURITY DEFINER check found unterminated parameter list for ${fnName}${ctx}`);
      const rawArgs = source.slice(tokens[afterName]!.end, tokens[close]!.start);
      try { signature = nativeStoreIdentity(fnName, rawArgs); }
      catch { signature = `${fnName}(${rawArgs.replace(/\s+/gu, " ").trim()})`; }
      attrStart = close + 1;
    } else if (isCreateRoutine) {
      throw new Error(`SECURITY DEFINER check could not parse ${routineKind} parameter list for ${fnName}${ctx}`);
    }
    let isSecurityDefiner = false;
    let resetsSearchPath = false;
    let hasSetSchemaLiteral = false;
    const searchPathClauses: boolean[] = [];
    const schemaLiteralKinds = new Set<SecurityDefinerToken["kind"]>(["string", "escape-string", "dollar-string", "unicode-escape"]);
    let attrDepth = 0;
    for (let index = attrStart; index < tokens.length; index++) {
      if (secSymbol(tokens, index, "(")) { attrDepth++; continue; }
      if (secSymbol(tokens, index, ")")) {
        if (--attrDepth < 0) throw new Error(`SECURITY DEFINER check found unbalanced parentheses in ${routineKind} ${signature}${ctx}`);
        continue;
      }
      if (attrDepth !== 0) continue;
      if (isCreateRoutine && secWord(tokens, index, "BEGIN") && secWord(tokens, index + 1, "ATOMIC")) {
        const end = findAtomicBodyEnd(tokens, index, ctx);
        if (end < 0) throw new Error(`SECURITY DEFINER check found unterminated BEGIN ATOMIC body for ${signature}${ctx}`);
        index = end;
        continue;
      }
      if (secWord(tokens, index, "SECURITY") && secWord(tokens, index + 1, "DEFINER")) {
        isSecurityDefiner = true;
        index++;
        continue;
      }
      if (secWord(tokens, index, "RESET")) {
        if (secWord(tokens, index + 1, "ALL")
          || secIdentifier(tokens[index + 1])?.toLowerCase() === "search_path"
          || (secSymbol(tokens, index + 2, ".") && secIdentifier(tokens[index + 3])?.toLowerCase() === "search_path")) {
          resetsSearchPath = true;
        }
        continue;
      }
      if (secWord(tokens, index, "SET")) {
        if (secWord(tokens, index + 1, "SCHEMA") && tokens[index + 2] !== undefined && schemaLiteralKinds.has(tokens[index + 2]!.kind)) {
          hasSetSchemaLiteral = true;
          index += 2;
          continue;
        }
        const directSearchPath = secIdentifier(tokens[index + 1])?.toLowerCase() === "search_path";
        const qualifiedSearchPath = !directSearchPath && secSymbol(tokens, index + 2, ".") && secIdentifier(tokens[index + 3])?.toLowerCase() === "search_path";
        if (qualifiedSearchPath) {
          searchPathClauses.push(false);
          continue;
        }
        if (directSearchPath) {
          let valid = false;
          if (secSymbol(tokens, index + 2, "=") || secWord(tokens, index + 2, "TO")) {
            const schemas: string[] = [];
            let cursor = index + 3;
            let malformed = false;
            if (secWord(tokens, cursor, "DEFAULT")) {
              malformed = true;
              cursor++;
            } else {
              for (;;) {
                const item = tokens[cursor];
                const schema = item?.kind === "word" ? item.value.toLowerCase()
                  : item?.kind === "quoted" || item?.kind === "string" ? item.value
                    : null;
                if (schema === null || schema === "") { malformed = true; break; }
                schemas.push(schema);
                cursor++;
                if (!secSymbol(tokens, cursor, ",")) break;
                cursor++;
              }
              if (tokens[cursor]?.kind === "string" || tokens[cursor]?.kind === "escape-string") malformed = true;
            }
            valid = !malformed
              && schemas.length > 0
              && schemas.at(-1) === "pg_temp"
              && schemas.slice(0, -1).every(entry => entry !== "pg_temp" && !/^pg_temp_\d+$/u.test(entry));
            index = cursor - 1;
          }
          searchPathClauses.push(valid);
        }
      }
    }
    if (attrDepth !== 0) throw new Error(`SECURITY DEFINER check found unbalanced parentheses in ${routineKind} ${signature}${ctx}`);
    if (isAlterRoutine) {
      if (resetsSearchPath) {
        throw new Error(`ALTER ${routineKind} ${signature} must not reset search_path (use SET search_path = pg_catalog, pg_temp for SECURITY DEFINER routines)`);
      }
      if (hasSetSchemaLiteral) {
        throw new Error(`ALTER ${routineKind} ${signature} must use explicit SET search_path = ..., pg_temp instead of SET SCHEMA literal`);
      }
      if (isSecurityDefiner && (searchPathClauses.length !== 1 || !searchPathClauses[0])) {
        throw new Error(`SECURITY DEFINER ${routineKind.toLowerCase()} ${signature} must place pg_temp last in SET search_path (for example: SET search_path = pg_catalog, pg_temp)`);
      }
      if (searchPathClauses.length > 0 && (searchPathClauses.length !== 1 || !searchPathClauses[0])) {
        throw new Error(`ALTER ${routineKind} ${signature} must place pg_temp last in SET search_path (for example: SET search_path = pg_catalog, pg_temp)`);
      }
      continue;
    }
    if (isSecurityDefiner && resetsSearchPath) {
      throw new Error(`SECURITY DEFINER ${routineKind.toLowerCase()} ${signature} must not reset search_path (use SET search_path = pg_catalog, pg_temp)`);
    }
    if (isSecurityDefiner && hasSetSchemaLiteral) {
      throw new Error(`SECURITY DEFINER ${routineKind.toLowerCase()} ${signature} must use explicit SET search_path = ..., pg_temp instead of SET SCHEMA literal`);
    }
    if (isSecurityDefiner && (searchPathClauses.length !== 1 || !searchPathClauses[0])) {
      throw new Error(`SECURITY DEFINER ${routineKind.toLowerCase()} ${signature} must place pg_temp last in SET search_path (for example: SET search_path = pg_catalog, pg_temp)`);
    }
  }
}
