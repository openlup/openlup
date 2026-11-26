import { documentationGit, readDocumentationObjects } from "../documentation-git.ts";
import { sqlSha256, type PlatformSqlToken } from "./types.ts";

/** Split top-level SQL only. Comments, quoted literals and dollar bodies cannot introduce statements. */
// Native admission opts into ASCII structure without changing older splitter modes.
export function sqlStatements(sql: string, dump = false, creation = false, asciiStructure = false): string[] {
  const statements: string[] = [];
  let start = -1;
  for (let index = 0; index < sql.length;) {
    if (creation && sql.charCodeAt(index) > 0x7f) throw new Error("reviewed portable creation refuses non-ASCII outside strings, comments and dollar bodies");
    if (asciiStructure && sql.charCodeAt(index) > 0x7f) throw new Error("reviewed native store refuses non-ASCII outside strings, comments and dollar bodies");
    if (/\s/u.test(sql[index]!)) { index++; continue; }
    if (dump && start < 0 && sql[index] === "\\") {
      const command = /^\\(?:un)?restrict [A-Za-z0-9]+(?:\r?\n|$)/u.exec(sql.slice(index))?.[0];
      if (!command) throw new Error("reviewed replacement baseline has an unsupported dump command");
      index += command.length; continue;
    }
    if (sql.startsWith("--", index)) { const end = sql.indexOf("\n", index); index = end < 0 ? sql.length : end; continue; }
    if (sql.startsWith("/*", index)) {
      let depth = 1; index += 2;
      while (index < sql.length && depth) {
        if (sql.startsWith("/*", index)) {
          if (creation) throw new Error("reviewed portable creation refuses nested block comments");
          depth++; index += 2;
        }
        else if (sql.startsWith("*/", index)) { depth--; index += 2; }
        else index++;
      }
      if (depth) throw new Error("reviewed replacement SQL has an unterminated comment");
      continue;
    }
    if (start < 0) start = index;
    if (creation && (sql[index] === "\\" || (/^(?:E'|U&['"])/iu.test(sql.slice(index)) && !/[A-Za-z0-9_$]/u.test(sql[index - 1] ?? "")))) throw new Error("reviewed portable creation refuses backslashes and escape strings outside dollar bodies");
    const quote = sql[index];
    if (quote === "'" || quote === '"') {
      index++; let closed = false;
      while (index < sql.length) {
        if (creation && quote === '"' && sql.charCodeAt(index) > 0x7f) throw new Error("reviewed portable creation refuses non-ASCII identifiers");
        if (asciiStructure && quote === '"' && sql.charCodeAt(index) > 0x7f) throw new Error("reviewed native store refuses non-ASCII identifiers");
        if (creation && (sql[index] === "\n" || (quote === '"' && /[;$]/u.test(sql[index]!)))) throw new Error("reviewed portable creation refuses multiline quotes and statement or dollar delimiters in identifiers");
        if (sql[index] === "\\") {
          if (creation) throw new Error("reviewed portable creation refuses backslashes outside dollar bodies");
          // PostgreSQL ends a standard literal at the quote after a backslash, so a candidate's escape reading would split statements differently.
          if (asciiStructure && !dump) throw new Error("reviewed native store refuses backslashes in quoted literals and identifiers");
          index += 2; continue;
        }
        if (sql[index++] === quote) { if (sql[index] === quote) { index++; continue; } closed = true; break; }
      }
      if (!closed) throw new Error("reviewed replacement SQL has an unterminated literal");
      continue;
    }
    const tag = sql[index] === "$" && (!asciiStructure || !/[A-Za-z0-9_$\u0080-\uffff]/u.test(sql[index - 1] ?? "")) ? /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(sql.slice(index))?.[0] : undefined;
    // The pinned files open bodies only as AS $$. PostgreSQL includes an
    // identifier-adjacent dollar in that identifier, so never guess here.
    if (creation && sql[index] === "$" && (tag !== "$$" || !/(?:^|[^A-Za-z0-9_$])AS[ \t\n]+$/iu.test(sql.slice(0, index)))) throw new Error("reviewed portable creation requires dollar bodies immediately after AS and whitespace");
    if (tag) {
      const end = sql.indexOf(tag, index + tag.length);
      if (end < 0) throw new Error("reviewed replacement SQL has an unterminated body");
      index = end + tag.length; continue;
    }
    if (sql[index++] === ";") { statements.push(sql.slice(start, index)); start = -1; }
  }
  if (start >= 0) throw new Error("reviewed replacement SQL requires terminated statements");
  return statements;
}

// Memoize immutable prefix Buffer splits by Buffer identity, with a bounded content-addressed
// fallback so identical Git blobs read across calls (e.g. the baseline dump) are parsed once.
const dumpSqlStatementsCache = new WeakMap<Buffer, readonly string[]>();
const asciiDumpSqlStatementsCache = new WeakMap<Buffer, readonly string[]>();
const dumpSqlStatementsByHash = new Map<string, readonly string[]>();
export const MAX_SQL_STATEMENT_CACHE_ENTRIES = 1024;
export function cachedDumpSqlStatements(bytes: Buffer, asciiStructure = false): readonly string[] {
  const cache = asciiStructure ? asciiDumpSqlStatementsCache : dumpSqlStatementsCache;
  let statements = cache.get(bytes);
  if (!statements) {
    const key = `${asciiStructure ? "a" : "d"}:${sqlSha256(bytes)}`;
    statements = dumpSqlStatementsByHash.get(key);
    if (!statements) {
      statements = sqlStatements(bytes.toString("utf8"), true, false, asciiStructure);
      if (dumpSqlStatementsByHash.size >= MAX_SQL_STATEMENT_CACHE_ENTRIES) dumpSqlStatementsByHash.clear();
      dumpSqlStatementsByHash.set(key, statements);
    }
    cache.set(bytes, statements);
  }
  return statements;
}

export type CreateFunctionIndex = {
  readonly allCreateFunctions: readonly string[];
  readonly byName: ReadonlyMap<string, readonly string[]>;
  readonly exactStatements: ReadonlySet<string>;
};
const createFunctionIndexCache = new WeakMap<Buffer, CreateFunctionIndex>();
const createFunctionIndexByHash = new Map<string, CreateFunctionIndex>();
export function cachedCreateFunctionIndex(bytes: Buffer): CreateFunctionIndex {
  let index = createFunctionIndexCache.get(bytes);
  if (!index) {
    const key = sqlSha256(bytes);
    index = createFunctionIndexByHash.get(key);
    if (!index) {
      const statements = cachedDumpSqlStatements(bytes);
      const allCreateFunctions: string[] = [];
      const byName = new Map<string, string[]>();
      const exactStatements = new Set<string>();
      for (const statement of statements) {
        exactStatements.add(statement);
        if (!/^CREATE(?: OR REPLACE)? FUNCTION\s/iu.test(statement)) continue;
        allCreateFunctions.push(statement);
        const prefix = /^CREATE(?: OR REPLACE)? FUNCTION ((?:public|private)\.[a-z_][a-z0-9_]*)\s*\(/iu.exec(statement);
        if (prefix) {
          const name = prefix[1]!.toLowerCase();
          const list = byName.get(name);
          if (list) list.push(statement);
          else byName.set(name, [statement]);
        }
      }
      index = { allCreateFunctions, byName, exactStatements };
      if (createFunctionIndexByHash.size >= MAX_SQL_STATEMENT_CACHE_ENTRIES) createFunctionIndexByHash.clear();
      createFunctionIndexByHash.set(key, index);
    }
    createFunctionIndexCache.set(bytes, index);
  }
  return index;
}

export function qualifiedFunctionIdentity(statement: string): string | null {
  const header = /^CREATE(?: OR REPLACE)? FUNCTION ((?:public|acquisition_private)\.[a-z_][a-z0-9_]*)\(([\s\S]*?)\)\s+RETURNS\s/iu.exec(statement);
  if (!header) return null;
  const args = header[2]!.trim();
  const types = args ? args.split(",").map(argument => {
    const match = /^(?:[a-z_][a-z0-9_]*\s+)?(uuid|text|jsonb|integer|bigint|boolean|timestamptz)$/iu.exec(argument.trim());
    if (!match) throw new Error("qualified owner path forward has an unsupported function identity");
    return match[1]!.toLowerCase();
  }) : [];
  return `${header[1]!.toLowerCase()}(${types.join(",")})`;
}

/** Account for structural parentheses first; every remaining identifier before `(` is an expression. */
function expandOnlyExpressions(tokens: string[]): boolean {
  const calls = new Set(["BTRIM", "GEN_RANDOM_UUID", "JSONB_TYPEOF", "LENGTH", "LOWER", "NOW", "TRANSLATE", "CHAR_LENGTH", "CLOCK_TIMESTAMP", "OCTET_LENGTH"]);
  const constructs = new Set(["IN", "AND", "OR", "NOT", "COALESCE", "NULLIF", "CAST"]);
  const modifiers = new Set(["NUMERIC", "DECIMAL", "VARCHAR", "CHAR", "CHARACTER", "BIT", "VARBIT", "TIMESTAMP", "TIMESTAMPTZ", "TIME", "TIMETZ", "INTERVAL"]);
  const identifier = (token = "") => /^[A-Z_][A-Z0-9_]*$/u.test(token) || token.startsWith('"');
  const structural = new Set<number>(), qualified = new Set<number>(), arrays = new Set<number>(), closing = new Map<number, number>();
  const stack: number[] = [];
  for (const [index, token] of tokens.entries()) {
    // Refuse constructors/subscripts before any comma splitter; only empty type brackets remain.
    if ((token === "[" && tokens[index + 1] !== "]") || (token === "]" && tokens[index - 1] !== "[")) return false;
    if (token === "(") stack.push(index);
    if (token === ")") { const open = stack.pop(); if (open === undefined) return false; closing.set(open, index); }
  }
  if (stack.length) return false;
  // Object/column type names are outside expression regions. Preserve their dots separately.
  const nameEnd = (start: number) => {
    if (!identifier(tokens[start])) return -1;
    let end = start + 1;
    while (tokens[end] === ".") {
      if (!identifier(tokens[end + 1])) return -1;
      qualified.add(end); end += 2;
    }
    return end;
  };
  const typeModifier = (start: number) => {
    let end = nameEnd(start);
    if (end < 0) return false;
    if (tokens[end] === "(" && modifiers.has(tokens[end - 1]!) && (end === start + 1 || (end === start + 3 && tokens[start] === "PG_CATALOG"))) {
      structural.add(end);
      if (!tokens.slice(end + 1, closing.get(end)).every((token) => token === "<literal>" || token === ",")) return false;
      end = closing.get(end)! + 1;
    }
    if (tokens[end] === "(") return false;
    while (tokens[end] === "[" && tokens[end + 1] === "]") { arrays.add(end); arrays.add(end + 1); end += 2; }
    return true;
  };
  const indexStatement = tokens[1] === "INDEX" || (tokens[1] === "UNIQUE" && tokens[2] === "INDEX");
  let open: number;
  if (indexStatement) {
    const object = tokens[1] === "UNIQUE" ? 3 : 2;
    const on = nameEnd(tokens.slice(object, object + 3).join(" ") === "IF NOT EXISTS" ? object + 3 : object);
    if (on < 0 || tokens[on] !== "ON") return false;
    open = nameEnd(on + 1);
    if (open < 0) return false;
    if (tokens[open] === "USING") {
      if (!identifier(tokens[open + 1])) return false;
      open += 2;
    }
  } else if (tokens[0] === "CREATE") {
    open = nameEnd(tokens.slice(2, 5).join(" ") === "IF NOT EXISTS" ? 5 : 2);
  } else {
    const add = nameEnd(2);
    if (add < 0 || tokens[add] !== "ADD") return false;
    open = -1;
  }
  if (tokens[0] === "CREATE" && (open < 0 || tokens[open] !== "(")) return false;
  if (open >= 0) structural.add(open);

  if (indexStatement) {
    const end = closing.get(open);
    if (end === undefined) return false;
    // A key is one column, call or parenthesized expression, followed only by ordering.
    for (let start = open + 1; start < end;) {
      let keyEnd = start + 1;
      if (tokens[start] === "(") keyEnd = closing.get(start)! + 1;
      else {
        while (tokens[keyEnd] === ".") keyEnd += 2;
        if (tokens[keyEnd] === "(") keyEnd = closing.get(keyEnd)! + 1;
        else if (!identifier(tokens[start])) return false;
      }
      let next = keyEnd;
      while (next < end && tokens[next] !== ",") next++;
      if (!/^(?:(?:ASC|DESC)(?: |$))?(?:NULLS (?:FIRST|LAST))?$/u.test(tokens.slice(keyEnd, next).join(" "))) return false;
      start = next + 1;
    }
    // INCLUDE column lists and storage parameters are structural, not calls.
    let suffix = end + 1;
    for (const clause of ["INCLUDE", "WITH"]) {
      if (tokens[suffix] !== clause) continue;
      if (tokens[suffix + 1] !== "(") return false;
      structural.add(suffix + 1);
      const close = closing.get(suffix + 1)!;
      if (clause === "INCLUDE" && !/^[A-Z_][A-Z0-9_]*(?: , [A-Z_][A-Z0-9_]*)*$/u.test(tokens.slice(suffix + 2, close).map((token) => token.startsWith('"') ? token.slice(1, -1) : token).join(" "))) return false;
      suffix = close + 1;
    }
    if (suffix < tokens.length && tokens[suffix] !== "WHERE") return false;
  } else {
    const end = open >= 0 ? closing.get(open) : tokens.length;
    if (end === undefined) return false;
    for (let start = open >= 0 ? open + 1 : nameEnd(2); start < end;) {
      let next = start;
      while (next < end && tokens[next] !== ",") next = tokens[next] === "(" ? closing.get(next)! + 1 : next + 1;
      let column = start;
      if (open < 0) {
        if (tokens[column++] !== "ADD") return false;
        if (tokens[column] === "COLUMN") column++;
        if (tokens.slice(column, column + 3).join(" ") === "IF NOT EXISTS") column += 3;
      }
      const constraint = ["CONSTRAINT", "PRIMARY", "FOREIGN", "UNIQUE", "CHECK"].includes(tokens[column]!);
      if (!constraint && (!identifier(tokens[column]) || !typeModifier(column + 1))) return false;
      // Start after the column/type or constraint name, never at a keyword-shaped column name.
      let index = constraint ? column : nameEnd(column + 1);
      if (tokens[index] === "CONSTRAINT") {
        if (!identifier(tokens[index + 1])) return false;
        index += 2;
      }
      for (; index < next; index++) {
        const token = tokens[index];
        if (token === "REFERENCES") {
          const targetEnd = nameEnd(index + 1);
          if (targetEnd < 0) return false;
          if (tokens[targetEnd] === "(") structural.add(targetEnd);
          index = targetEnd - 1;
        }
        if ((token === "CHECK" || token === "UNIQUE" || (token === "KEY" && ["PRIMARY", "FOREIGN"].includes(tokens[index - 1]!))) && tokens[index + 1] === "(") structural.add(index + 1);
        if (token === "GENERATED") {
          const as = tokens[index + 1] === "ALWAYS" ? index + 2 : tokens.slice(index + 1, index + 3).join(" ") === "BY DEFAULT" ? index + 3 : -1;
          if (as < 0 || tokens[as] !== "AS") return false;
          const expression = tokens[as + 1] === "IDENTITY" ? as + 2 : as + 1;
          if (tokens[expression] === "(") structural.add(expression);
          index = expression - 1;
        }
        if (token === "(") index = closing.get(index)!;
      }
      start = next + 1;
    }
  }
  for (const [index, token] of tokens.entries()) {
    if ((token === "[" || token === "]") && !arrays.has(index)) return false;
    if (token === "CAST" && tokens[index + 1] === "(") {
      const end = closing.get(index + 1)!;
      let as = index + 2;
      while (as < end && tokens[as] !== "AS") as = tokens[as] === "(" ? closing.get(as)! + 1 : as + 1;
      if (as === end) return false;
      if (tokens[as + 2] === "." && (tokens[as + 1] !== "PG_CATALOG" || tokens[as + 4] === ".")) return false;
      if (!typeModifier(as + 1)) return false;
    }
    if (token === "." && !qualified.has(index) && !(tokens[index - 1] === "PG_CATALOG" && calls.has(tokens[index + 1]!) && tokens[index + 2] === "(" && tokens[index - 2] !== ".")) return false;
    if (token !== "(" || structural.has(index) || !identifier(tokens[index - 1])) continue;
    const previous = tokens[index - 1]!;
    if (!calls.has(previous) && !(tokens[index - 2] !== "." && constructs.has(previous))) return false;
  }
  return true;
}

/** A deliberately bounded SQL admission check, not a general SQL interpreter.
 * Refuses control characters other than tab and line feed (PostgreSQL also ends a `--` comment at a carriage return, so no classifier models line ends differently); procedural/dynamic SQL also refuses.
 * Existing SQL is frozen, so only new forwards pass through this predicate.
 */
// The existing expand-only lexer also supplies native identity reads. Its original
// modes retain their refusals; native mode additionally skips opaque dollar bodies.
export function platformSqlTokens(sql: string, reviewedCreationTable = false, native = false): { tokens: PlatformSqlToken[]; complete: boolean } {
  const tokens: PlatformSqlToken[] = [];
  if (Buffer.from(sql, "utf8").some((byte) => (byte < 0x20 && byte !== 0x09 && byte !== 0x0a) || byte === 0x7f)) return { tokens, complete: false };
  for (let index = 0; index < sql.length;) {
    const start = index, rest = sql.slice(index);
    // PostgreSQL treats non-ASCII bytes as identifier characters, not separators.
    if (!reviewedCreationTable && rest.charCodeAt(0) > 0x7f) return { tokens, complete: false };
    if ((reviewedCreationTable ? /^\s/u : /^[ \t\n]/u).test(rest)) { index++; continue; }
    if (rest.startsWith("--")) { const end = sql.indexOf("\n", index); index = end < 0 ? sql.length : end; continue; }
    if (rest.startsWith("/*")) {
      let depth = 1; index += 2;
      while (index < sql.length && depth) {
        if (sql.startsWith("/*", index)) { depth++; index += 2; }
        else if (sql.startsWith("*/", index)) { depth--; index += 2; }
        else index++;
      }
      if (depth) return { tokens, complete: false };
      continue;
    }
    if (rest[0] === "'" || rest[0] === '"') {
      const quote = rest[0]; let value = "", closed = false; index++;
      while (index < sql.length) {
        if (!reviewedCreationTable && quote === '"' && sql.charCodeAt(index) > 0x7f) return { tokens, complete: false };
        if (sql[index] === "\\") return { tokens, complete: false }; // Refuse escape-string ambiguity.
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) { value += quote; index += 2; continue; }
          index++; closed = true; break;
        }
        value += sql[index++];
      }
      if (!closed) return { tokens, complete: false };
      if (!reviewedCreationTable && quote === '"' && value === ";") return { tokens, complete: false }; // Preserve the original delimiter refusal.
      tokens.push({ kind: quote === "'" ? "string" : "quoted", value, start, end: index }); continue;
    }
    if (native && rest[0] === "$" && !/[A-Za-z0-9_$\u0080-\uffff]/u.test(sql[index - 1] ?? "")) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(rest)?.[0];
      const end = tag ? sql.indexOf(tag, index + tag.length) : -1;
      if (!tag || end < 0) return { tokens, complete: false };
      index = end + tag.length; tokens.push({ kind: "string", value: sql.slice(start + tag.length, end), start, end: index }); continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(rest)?.[0];
    if (word) { index += word.length; tokens.push({ kind: "word", value: word, start, end: index }); continue; }
    const number = /^[0-9]+(?:\.[0-9]+)?/u.exec(rest)?.[0];
    if (number) { index += number.length; tokens.push({ kind: "number", value: number, start, end: index }); continue; }
    if (!native && !";.,()+-=[]".includes(rest[0]!) && !(reviewedCreationTable && "<>:~".includes(rest[0]!))) return { tokens, complete: false };
    index++; tokens.push({ kind: "symbol", value: rest[0]!, start, end: index });
  }
  return { tokens, complete: true };
}

export function isExpandOnlyPlatformForward(sql: string, reviewedCreationTable = false): boolean {
  return expandOnlyPlatformForward(sql, reviewedCreationTable, false);
}
// Only this complete new-table statement gains RESTRICT and the self-link inequality.
// Token kinds remain distinct: quoted names and literals cannot impersonate syntax.
export function nativeCatalogSuccessorsCreation(sql: string): boolean {
  const parsed = platformSqlTokens(sql, false, true);
  const shape = "CREATE TABLE PUBLIC . CATALOG_SKU_SUCCESSORS ( PREDECESSOR_SKU_ID UUID NOT NULL REFERENCES PUBLIC . CATALOG_SKUS ( ID ) ON DELETE RESTRICT , SUCCESSOR_SKU_ID UUID NOT NULL REFERENCES PUBLIC . CATALOG_SKUS ( ID ) ON DELETE RESTRICT , PUBLICATION_ID UUID NOT NULL REFERENCES PUBLIC . CATALOG_PUBLICATIONS ( ID ) ON DELETE RESTRICT , PRIMARY KEY ( PREDECESSOR_SKU_ID , SUCCESSOR_SKU_ID ) , CHECK ( PREDECESSOR_SKU_ID < > SUCCESSOR_SKU_ID ) ) ;";
  return parsed.complete && parsed.tokens.every(token => token.kind === "word" || token.kind === "symbol")
    && parsed.tokens.map(token => token.value.toUpperCase()).join(" ") === shape;
}
// Complete successor storage declarations; this control installs none of them.
// Strings and numbers remain byte-exact; only unquoted SQL words fold case.
export const NATIVE_SUCCESSOR_TABLE_SQL: Readonly<Record<string, string>> = {
  "public.subscription_successor_proposals": `CREATE TABLE public.subscription_successor_proposals (
 id uuid PRIMARY KEY,
 subscription_id uuid NOT NULL REFERENCES public.subscriptions(id) ON DELETE RESTRICT,
 client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
 predecessor_sku_id uuid NOT NULL REFERENCES public.catalog_skus(id) ON DELETE RESTRICT,
 successor_sku_id uuid NOT NULL REFERENCES public.catalog_skus(id) ON DELETE RESTRICT,
 publication_id uuid NOT NULL REFERENCES public.catalog_publications(id) ON DELETE RESTRICT,
 source_binding jsonb NOT NULL CHECK (jsonb_typeof(source_binding) = 'object'),
 template_version integer NOT NULL CHECK (template_version BETWEEN 1 AND 2147483647),
 lane text NOT NULL CHECK (length(btrim(lane)) BETWEEN 1 AND 80),
 action text NOT NULL CHECK (length(btrim(action)) BETWEEN 1 AND 80),
 request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object'),
 preview jsonb NOT NULL CHECK (jsonb_typeof(preview) = 'object'),
 quote_hash text NOT NULL CHECK (length(quote_hash) = 64 AND translate(quote_hash,'abcdef0123456789','') = ''),
 expires_at timestamptz NOT NULL,
 original_case_id uuid REFERENCES public.subscription_stock_wait_cases(id) ON DELETE RESTRICT,
 original_operation_id uuid REFERENCES public.subscription_renewal_operations(id) ON DELETE RESTRICT,
 state text NOT NULL DEFAULT 'offered' CHECK (state IN ('offered','accepted','declined','expired')),
 consent jsonb,
 accepted_receipt jsonb,
 terminal_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);`,
  "public.subscription_successor_operations_v2": `CREATE TABLE public.subscription_successor_operations_v2 (
 id uuid PRIMARY KEY,
 root_operation_id uuid NOT NULL REFERENCES public.subscription_renewal_operations(id) ON DELETE RESTRICT,
 proposal_id uuid NOT NULL UNIQUE REFERENCES public.subscription_successor_proposals(id) ON DELETE RESTRICT,
 predecessor_generation_id uuid REFERENCES public.subscription_successor_operations_v2(id) ON DELETE RESTRICT,
 subscription_id uuid NOT NULL REFERENCES public.subscriptions(id) ON DELETE RESTRICT,
 scheduled_at timestamptz NOT NULL,
 cycle_number integer NOT NULL CHECK (cycle_number BETWEEN 1 AND 2147483647),
 identity_key text NOT NULL UNIQUE CHECK (length(identity_key) BETWEEN 48 AND 240),
 operation_fingerprint text NOT NULL CHECK (length(operation_fingerprint) = 64 AND translate(operation_fingerprint,'abcdef0123456789','') = ''),
 due_snapshot jsonb NOT NULL CHECK (jsonb_typeof(due_snapshot) = 'object'),
 cycle_snapshot jsonb NOT NULL CHECK (jsonb_typeof(cycle_snapshot) = 'object'),
 state text NOT NULL CHECK (state IN ('claimed','reserved','attempt_prepared','succeeded','refused')),
 claim_token uuid NOT NULL,
 claim_generation bigint NOT NULL DEFAULT 1 CHECK (claim_generation BETWEEN 1 AND 9223372036854775807),
 claimed_by text NOT NULL CHECK (length(btrim(claimed_by)) BETWEEN 1 AND 240),
 claimed_at timestamptz NOT NULL,
 lease_expires_at timestamptz NOT NULL,
 attempt_prepared_at timestamptz,
 external_attempt_ref text,
 external_attempt_acknowledged_at timestamptz,
 terminal_outcome text,
 terminal_reason text,
 terminal_at timestamptz,
 outcomes jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(outcomes) = 'array'),
 superseded_by_proposal_id uuid REFERENCES public.subscription_successor_proposals(id) ON DELETE RESTRICT,
 cycle_id uuid UNIQUE REFERENCES public.subscription_cycles(id) ON DELETE RESTRICT,
 order_id uuid UNIQUE REFERENCES public.commerce_orders(id) ON DELETE RESTRICT,
 settlement_intent_id uuid UNIQUE REFERENCES public.commerce_settlement_intents(id) ON DELETE RESTRICT,
 fulfillment_id uuid UNIQUE REFERENCES public.fulfillment_shipments(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);`,
  "public.subscription_successor_wait_cases_v2": `CREATE TABLE public.subscription_successor_wait_cases_v2 (
 id uuid PRIMARY KEY,
 root_case_id uuid NOT NULL REFERENCES public.subscription_stock_wait_cases(id) ON DELETE RESTRICT,
 operation_id uuid NOT NULL UNIQUE REFERENCES public.subscription_successor_operations_v2(id) ON DELETE RESTRICT,
 subscription_id uuid NOT NULL REFERENCES public.subscriptions(id) ON DELETE RESTRICT,
 client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
 scheduled_at timestamptz NOT NULL,
 cycle_number integer NOT NULL CHECK (cycle_number BETWEEN 1 AND 2147483647),
 state text NOT NULL CHECK (state IN ('waiting','stock_secured','resumed','closed')),
 due_snapshot jsonb NOT NULL CHECK (jsonb_typeof(due_snapshot) = 'object'),
 cycle_snapshot jsonb NOT NULL CHECK (jsonb_typeof(cycle_snapshot) = 'object'),
 fingerprint text NOT NULL CHECK (length(fingerprint) = 64 AND translate(fingerprint,'abcdef0123456789','') = ''),
 identity_key text NOT NULL,
 deficits jsonb NOT NULL CHECK (jsonb_typeof(deficits) = 'array'),
 notice_messages jsonb NOT NULL DEFAULT '{}',
 refusal_observations jsonb NOT NULL DEFAULT '[]',
 cycle_id uuid REFERENCES public.subscription_cycles(id) ON DELETE RESTRICT,
 order_id uuid REFERENCES public.commerce_orders(id) ON DELETE RESTRICT,
 fulfillment_id uuid REFERENCES public.fulfillment_shipments(id) ON DELETE RESTRICT,
 opened_at timestamptz NOT NULL DEFAULT now(),
 last_checked_at timestamptz NOT NULL DEFAULT now(),
 last_selected_at timestamptz,
 stock_secured_at timestamptz,
 resumed_at timestamptz,
 closed_at timestamptz,
 block_reason text,
 superseded_by_proposal_id uuid REFERENCES public.subscription_successor_proposals(id) ON DELETE RESTRICT
);`,
  "public.subscription_successor_reservations_v2": `CREATE TABLE public.subscription_successor_reservations_v2 (
 id uuid PRIMARY KEY,
 operation_id uuid NOT NULL UNIQUE REFERENCES public.subscription_successor_operations_v2(id) ON DELETE RESTRICT,
 operation_fingerprint text NOT NULL CHECK (length(operation_fingerprint) = 64 AND translate(operation_fingerprint,'abcdef0123456789','') = ''),
 source_key text NOT NULL CHECK (length(btrim(source_key)) BETWEEN 1 AND 120),
 lines jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array'),
 status text NOT NULL CHECK (status IN ('held','committed','consumed','released','expired')),
 expires_at timestamptz,
 terminal_reason text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);`,
};
export function nativeSuccessorStorageCreation(sql: string): boolean {
  const parsed = platformSqlTokens(sql, false, true);
  const canonicalTokens = (tokens: PlatformSqlToken[]) => JSON.stringify(tokens.map(token => [token.kind, token.kind === "word" ? token.value.toUpperCase() : token.value]));
  return parsed.complete && Object.values(NATIVE_SUCCESSOR_TABLE_SQL).some(shape => canonicalTokens(parsed.tokens) === canonicalTokens(platformSqlTokens(shape, false, true).tokens));
}
export function expandOnlyPlatformForward(sql: string, reviewedCreationTable: boolean, newTableForeignKeyActions: boolean): boolean {
  const successors = newTableForeignKeyActions && (nativeCatalogSuccessorsCreation(sql) || nativeSuccessorStorageCreation(sql));
  const parsed = platformSqlTokens(sql, reviewedCreationTable, successors);
  if (!parsed.complete) return false;
  const tokens = parsed.tokens.map(token => token.kind === "string" || token.kind === "number" ? "<literal>" : token.kind === "quoted" ? reviewedCreationTable ? token.value.toUpperCase() : `"${token.value.toUpperCase()}"` : token.value.toUpperCase());
  const statements: string[][] = [[]];
  for (const token of tokens) { if (token === ";") statements.push([]); else statements.at(-1)!.push(token); }
  const nonempty = statements.filter((statement) => statement.length);
  return nonempty.length > 0 && nonempty.every((quoted) => {
    const statement = reviewedCreationTable ? quoted : quoted.map((token) => token.startsWith('"') ? token.slice(1, -1) : token);
    const text = statement.join(" ");
    if (!reviewedCreationTable) {
      if (quoted.includes("OPERATOR") || quoted.some((token, index) => token === "OWNED" && quoted[index + 1] === "BY")) return false;
      if (/^INSERT INTO /u.test(text)) {
        const values = quoted.indexOf("VALUES"), conflict = quoted.indexOf("ON", values);
        if (!/^INSERT INTO [A-Z_][A-Z0-9_]*(?: \. [A-Z_][A-Z0-9_]*)*(?: \( [A-Z_][A-Z0-9_]*(?: , [A-Z_][A-Z0-9_]*)* \))? VALUES$/u.test(quoted.slice(0, values + 1).join(" "))) return false;
        if (!/ ON CONFLICT(?: \( [A-Z_][A-Z0-9_]*(?: , [A-Z_][A-Z0-9_]*)* \)| ON CONSTRAINT [A-Z_][A-Z0-9_]*)? DO NOTHING$/u.test(quoted.join(" "))) return false;
        if (!quoted.slice(values + 1, conflict).every((token) => ["<literal>", "TRUE", "FALSE", "NULL", "(", ")", ",", "+", "-"].includes(token))) return false;
      }
      if (/^CREATE SCHEMA /u.test(text) && !/^CREATE SCHEMA (?:IF NOT EXISTS )?[A-Z_][A-Z0-9_]*$/u.test(quoted.join(" "))) return false;
      if (/^(?:CREATE (?:UNIQUE )?(?:TABLE|INDEX)|ALTER TABLE) /u.test(text)) {
        // No evaluated forward uses LIKE, including its expression-operator form.
        if (quoted.includes("LIKE") || quoted.some((token, index) => token === "PARTITION" && quoted[index + 1] === "OF")) return false;
        if (!expandOnlyExpressions(quoted)) return false;
        let depth = 0;
        for (const token of quoted) {
          if (token === "(") depth++;
          if (token === ")") depth--;
          if (quoted[0] === "CREATE" && quoted[1] === "TABLE" && depth === 0 && token === "AS") return false;
        }
      } else if (quoted.includes("[") || quoted.includes("]")) return false;
    }
    // Base admission remains unchanged; the expand-only checks above only add refusals.
    // Pinned new tables use scalar operators/casts and these foreign-key actions.
    // Mask only those actions, leaving standalone DELETE/SET and every other refusal intact.
    const checked = (reviewedCreationTable || newTableForeignKeyActions) && /^CREATE TABLE /u.test(text) ? text.replace(successors ? / ON DELETE RESTRICT(?= |$)/gu : / ON DELETE (?:CASCADE|SET NULL)(?= |$)/gu, "").split(" ") : statement;
    if (checked.some((token) => ["DROP", "TRUNCATE", "RENAME", "OWNER", "SET", "APP", "DELETE", "UPDATE", "REPLACE", "SELECT", "EXECUTE", "CALL", "DETACH", "ATTACH", "INHERIT", "INHERITS", "DISABLE", "ENABLE", "VALIDATE", "AUTHORIZATION"].includes(token))) return false;
    if (text === "BEGIN" || text === "COMMIT") return true;
    if (/^INSERT INTO /u.test(text)) {
      const values = statement.indexOf("VALUES"), conflict = statement.indexOf("ON", values);
      if (values < 0 || conflict < 0 || !/ ON CONFLICT(?: \( [A-Z_][A-Z0-9_]*(?: , [A-Z_][A-Z0-9_]*)* \)| ON CONSTRAINT [A-Z_][A-Z0-9_]*)? DO NOTHING$/u.test(text)) return false;
      // Seed values are literals only; no subquery, function or dynamic execution.
      return statement.slice(values + 1, conflict).every((token) => ["<literal>", "TRUE", "FALSE", "NULL", "(", ")", ",", "+", "-"].includes(token)) && statement.filter((token) => token === "DO").length === 1;
    }
    if (statement.includes("DO")) return false;
    if (/^CREATE (?:UNIQUE )?(?:TABLE|INDEX|TYPE|SEQUENCE|SCHEMA) /u.test(text)) return !statement.includes("ALTER") && statement.filter((token) => token === "CREATE").length === 1;
    if (/^ALTER TABLE /u.test(text)) {
      const add = statement.indexOf("ADD");
      if (add <= 2 || statement.slice(2, add).includes(",") || statement.filter((token) => token === "ALTER").length !== 1) return false;
      let depth = 0;
      for (let index = add; index < statement.length; index++) {
        if (statement[index] === "(") depth++;
        if (statement[index] === ")") depth--;
        if (depth < 0 || (depth === 0 && statement[index] === "," && statement[index + 1] !== "ADD")) return false;
      }
      return depth === 0;
    }
    return false;
  });
}

export const git = (root: string, args: string[]) => documentationGit(root, args);
export function blob(root: string, revision: string, path: string): Buffer | undefined {
  const listing = git(root, ["ls-tree", "-z", revision, "--", path]).toString("utf8");
  if (!listing) return undefined;
  const match = /^100644 blob ([a-f0-9]{40})\t[^\0]+\0$/u.exec(listing);
  if (!match) throw new Error(`reviewed replacement requires a regular file: ${path}`);
  return git(root, ["cat-file", "blob", match[1]!]);
}

export function headerAttributes(statement: string): string {
  const opening = /\bAS (\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)/u.exec(statement);
  if (!opening) throw new Error("reviewed replacement runtime requires a dollar body");
  const closing = statement.indexOf(opening[1]!, opening.index + opening[0].length);
  if (closing < 0 || !/^\s*;\s*$/u.test(statement.slice(closing + opening[1]!.length))) throw new Error("reviewed replacement runtime refuses attributes after its dollar body");
  return statement.slice(0, opening.index).replace(/^CREATE OR REPLACE /u, "CREATE ");
}

export function readPrecedingBlobs(root: string, revision: string, directory: string, beforePath: string, sqlOnly: boolean): { path: string; bytes: Buffer }[] {
  const entries = git(root, ["ls-tree", "-rz", "--full-tree", revision, "--", directory]).toString("utf8").split("\0").filter(Boolean);
  const preceding = entries.flatMap(entry => {
    const priorPath = entry.slice(entry.indexOf("\t") + 1);
    if ((sqlOnly && !priorPath.endsWith(".sql")) || priorPath >= beforePath) return [];
    const regular = /^100644 blob ([a-f0-9]{40})\t/u.exec(entry);
    if (!regular) throw new Error(`reviewed replacement requires a regular file: ${priorPath}`);
    return [{ path: priorPath, oid: regular[1]! }];
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const sources = readDocumentationObjects(root, preceding.map(source => source.oid));
  return preceding.map((source, index) => ({ path: source.path, bytes: sources[index]! }));
}

// PostgreSQL treats non-ASCII separator lookalikes as identifier characters.
// Do not erase them as JavaScript whitespace or fold them into an ASCII name.
export const nativeStoreTrim = (value: string): string => value.replace(/^[ \t\n]+|[ \t\n]+$/gu, "");
export const nativeStoreAscii = (value: string): boolean => [...value].every(character => character.charCodeAt(0) <= 0x7f);
// Separate actual parameters; commas in defaults never create argument types.
export function nativeStoreArguments(args: string): string[] {
  const result: string[] = [], nesting: string[] = [];
  let start = 0;
  for (let index = 0; index < args.length;) {
    const quote = args[index];
    if (quote === "'" || quote === '"') {
      index++; let closed = false;
      while (index < args.length) {
        if (args[index] === "\\") throw new Error("reviewed native store unsupported argument escape");
        if (args[index++] === quote) { if (args[index] === quote) { index++; continue; } closed = true; break; }
      }
      if (!closed) throw new Error("reviewed native store unterminated argument literal");
      continue;
    }
    if (args.startsWith("--", index)) { const end = args.indexOf("\n", index); index = end < 0 ? args.length : end; continue; }
    if (args.startsWith("/*", index)) {
      let depth = 1; index += 2;
      while (index < args.length && depth) {
        if (args.startsWith("/*", index)) { depth++; index += 2; }
        else if (args.startsWith("*/", index)) { depth--; index += 2; }
        else index++;
      }
      if (depth) throw new Error("reviewed native store unterminated argument comment");
      continue;
    }
    const tag = args[index] === "$" && !/[A-Za-z0-9_$\u0080-\uffff]/u.test(args[index - 1] ?? "") ? /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(args.slice(index))?.[0] : undefined;
    if (tag) {
      const end = args.indexOf(tag, index + tag.length);
      if (end < 0) throw new Error("reviewed native store unterminated argument dollar literal");
      index = end + tag.length; continue;
    }
    const token = args[index]!;
    if (token === "(" || token === "[") nesting.push(token);
    if ((token === ")" || token === "]") && nesting.pop() !== (token === ")" ? "(" : "[")) throw new Error("reviewed native store unbalanced argument default");
    if (token === "," && !nesting.length) { result.push(args.slice(start, index)); start = index + 1; }
    index++;
  }
  if (nesting.length) throw new Error("reviewed native store unbalanced argument default");
  result.push(args.slice(start)); return result;
}
// This reader belongs only to the closed class. Earlier identity readers retain
// their issued restrictions; a parseable type never authorizes a signature.
export function nativeStoreIdentity(name: string, args: string): string {
  if (!nativeStoreAscii(name)) throw new Error("reviewed native store non-ASCII function identity refused");
  const types = nativeStoreTrim(args) ? nativeStoreArguments(args).map(argument => {
    if (/^(?:IN|OUT|INOUT|VARIADIC)\b/iu.test(nativeStoreTrim(argument))) throw new Error("reviewed native store unsupported argument mode");
    const match = /^(?:[a-z_][a-z0-9_]*[ \t\n]+)?((?:uuid|text|jsonb|integer|bigint|boolean|timestamptz|bool|int|int4|int8|timestamp[ \t\n]+with[ \t\n]+time[ \t\n]+zone|[a-z_][a-z0-9_]*[ \t\n]*\.[ \t\n]*[a-z_][a-z0-9_]*)(?:[ \t\n]*\[[ \t\n]*\])*)(?:[ \t\n]+DEFAULT[ \t\n]+[\s\S]+)?$/iu.exec(nativeStoreTrim(argument));
    if (!match || !nativeStoreAscii(match[1]!)) throw new Error("reviewed native store unsupported argument identity");
    const type = match[1]!.toLowerCase().replace(/[ \t\n]+/gu, " ").replace(/[ \t\n]*\.[ \t\n]*/gu, ".").replace(/(?:[ \t\n]*\[[ \t\n]*\])+$/u, "[]");
    const array = type.endsWith("[]") ? "[]" : "", scalar = array ? type.slice(0, -2) : type;
    const aliases: Record<string, string> = { bool: "boolean", int: "integer", int4: "integer", int8: "bigint", "timestamp with time zone": "timestamptz" };
    const builtin = scalar.replace(/^pg_catalog\./u, "");
    return `${["uuid", "text", "jsonb", "integer", "bigint", "boolean", "timestamptz", ...Object.keys(aliases)].includes(builtin) ? aliases[builtin] ?? builtin : scalar}${array}`;
  }) : [];
  return `${name.toLowerCase()}(${types.join(",")})`;
}

