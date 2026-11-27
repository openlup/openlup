// Transaction-aware SQL lock-safety rules for newly appended forward migrations.
//
// OpenLup's PostgreSQL migration runner executes every migration unit inside a
// transaction block (`BEGIN ... COMMIT`), so `CREATE INDEX CONCURRENTLY` cannot
// run inside a forward unit. These rules therefore never demand `CONCURRENTLY`;
// instead they require bounded lock waits (`SET LOCAL lock_timeout` / `SET lock_timeout`),
// expand-and-contract column additions, `NOT VALID` constraints, and partial indexes
// (`WHERE`) or explicit `-- lock-safety: <reason>` justifications on hot tables.

export const HOT_PRODUCTION_TABLES: ReadonlySet<string> = new Set([
  "commerce_orders",
  "subscriptions",
  "outbox_events",
  "fulfillment_shipments",
]);

export type LockSafetyRuleId =
  | "hot_table_add_column_not_null_without_default"
  | "hot_table_add_constraint_without_not_valid"
  | "hot_table_missing_lock_timeout"
  | "hot_table_index_without_partial_or_annotation";

export interface LockSafetyViolation {
  rule: LockSafetyRuleId;
  table: string;
  message: string;
}

type SqlToken = {
  kind: "word" | "quoted" | "string" | "dollar" | "number" | "symbol";
  value: string;
};

type ParsedStatement = {
  tokens: SqlToken[];
  annotated: boolean;
};

const LOCK_SAFETY_ANNOTATION = /^--[ \t]*lock-safety:[ \t]*\S/iu;
const ZERO_TIMEOUT_LITERAL = /^0+(?:\.0+)?(?:us|ms|s|min|h|d)?$/iu;
const NON_COLUMN_ADD_KEYWORDS = new Set([
  "CONSTRAINT",
  "CHECK",
  "FOREIGN",
  "PRIMARY",
  "UNIQUE",
  "EXCLUDE",
]);

const isWord = (tokens: readonly SqlToken[], index: number, expected: string): boolean =>
  tokens[index]?.kind === "word" && tokens[index]!.value.toUpperCase() === expected;

const isSymbol = (tokens: readonly SqlToken[], index: number, expected: string): boolean =>
  tokens[index]?.kind === "symbol" && tokens[index]!.value === expected;

const identifierName = (token: SqlToken | undefined): string | null => {
  if (!token) return null;
  if (token.kind === "word") return token.value.toLowerCase();
  if (token.kind === "quoted") return token.value;
  return null;
};

function parseStatements(sql: string): ParsedStatement[] {
  const statements: ParsedStatement[] = [];
  let tokens: SqlToken[] = [];
  let annotated = false;
  let parenDepth = 0;

  for (let index = 0; index < sql.length;) {
    const ch = sql[index]!;
    if (/\s/u.test(ch)) {
      index++;
      continue;
    }
    if (sql.startsWith("--", index)) {
      const end = sql.indexOf("\n", index);
      const comment = end < 0 ? sql.slice(index) : sql.slice(index, end);
      if (LOCK_SAFETY_ANNOTATION.test(comment)) annotated = true;
      index = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith("/*", index)) {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql.startsWith("/*", index)) { depth++; index += 2; }
        else if (sql.startsWith("*/", index)) { depth--; index += 2; }
        else index++;
      }
      continue;
    }
    if ((ch === "E" || ch === "e") && sql[index + 1] === "'" && !/[A-Za-z0-9_$]/u.test(sql[index - 1] ?? "")) {
      index += 2;
      let value = "";
      while (index < sql.length) {
        if (sql[index] === "\\") {
          value += sql[index + 1] ?? "";
          index += 2;
          continue;
        }
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") { value += "'"; index += 2; continue; }
          index++;
          break;
        }
        value += sql[index++];
      }
      tokens.push({ kind: "string", value });
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      index++;
      let value = "";
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) { value += quote; index += 2; continue; }
          index++;
          break;
        }
        value += sql[index++];
      }
      tokens.push({ kind: quote === "'" ? "string" : "quoted", value });
      continue;
    }
    if (ch === "$" && !/[A-Za-z0-9_$\u0080-\uffff]/u.test(sql[index - 1] ?? "")) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(sql.slice(index))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, index + tag.length);
        if (end < 0) {
          tokens.push({ kind: "dollar", value: sql.slice(index + tag.length) });
          index = sql.length;
        } else {
          tokens.push({ kind: "dollar", value: sql.slice(index + tag.length, end) });
          index = end + tag.length;
        }
        continue;
      }
    }
    const word = /^[A-Za-z_][A-Za-z0-9_$]*/u.exec(sql.slice(index))?.[0];
    if (word) {
      tokens.push({ kind: "word", value: word });
      index += word.length;
      continue;
    }
    const number = /^[0-9]+(?:\.[0-9]+)?/u.exec(sql.slice(index))?.[0];
    if (number) {
      tokens.push({ kind: "number", value: number });
      index += number.length;
      continue;
    }
    index++;
    if (ch === "(") parenDepth++;
    else if (ch === ")" && parenDepth > 0) parenDepth--;
    if (ch === ";" && parenDepth === 0) {
      if (tokens.length > 0) statements.push({ tokens, annotated });
      tokens = [];
      annotated = false;
      continue;
    }
    tokens.push({ kind: "symbol", value: ch });
  }
  if (tokens.length > 0) statements.push({ tokens, annotated });
  return statements;
}

function readHotTableName(tokens: readonly SqlToken[], start: number): { table: string; next: number } | null {
  const parts: string[] = [];
  let cursor = start;
  const first = identifierName(tokens[cursor]);
  if (first === null) return null;
  parts.push(first);
  cursor++;
  while (isSymbol(tokens, cursor, ".")) {
    const nextPart = identifierName(tokens[cursor + 1]);
    if (nextPart === null) return null;
    parts.push(nextPart);
    cursor += 2;
  }
  if (parts.length > 3) return null;
  const table = parts.at(-1)!;
  const schema = parts.length >= 2 ? parts.at(-2)! : "public";
  if (schema !== "public" || !HOT_PRODUCTION_TABLES.has(table)) return null;
  return { table, next: cursor };
}

function splitTopLevelActions(tokens: readonly SqlToken[]): SqlToken[][] {
  const actions: SqlToken[][] = [];
  let current: SqlToken[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (token.kind === "symbol" && token.value === "(") depth++;
    else if (token.kind === "symbol" && token.value === ")" && depth > 0) depth--;
    else if (token.kind === "symbol" && token.value === "," && depth === 0) {
      if (current.length > 0) actions.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) actions.push(current);
  return actions;
}

function updateLockTimeoutState(tokens: readonly SqlToken[], current: boolean): boolean {
  if (isWord(tokens, 0, "RESET")) {
    const target = identifierName(tokens[1]);
    if (target === "lock_timeout" || isWord(tokens, 1, "ALL")) return false;
    return current;
  }
  if (!isWord(tokens, 0, "SET")) return current;
  const paramIndex = isWord(tokens, 1, "LOCAL") || isWord(tokens, 1, "SESSION") ? 2 : 1;
  if (identifierName(tokens[paramIndex]) !== "lock_timeout") return current;
  if (!isSymbol(tokens, paramIndex + 1, "=") && !isWord(tokens, paramIndex + 1, "TO")) return current;
  const valueTokens = tokens.slice(paramIndex + 2);
  if (valueTokens.length === 0) return current;
  if (valueTokens.length === 1 && isWord(valueTokens, 0, "DEFAULT")) return false;
  const first = valueTokens[0]!;
  if ((first.kind === "string" || first.kind === "number") && ZERO_TIMEOUT_LITERAL.test(first.value.trim())) {
    return false;
  }
  return true;
}

function hasTopLevelWordSequence(tokens: readonly SqlToken[], words: readonly string[]): boolean {
  let depth = 0;
  const topLevel: SqlToken[] = [];
  for (const token of tokens) {
    if (token.kind === "symbol" && token.value === "(") { depth++; continue; }
    if (token.kind === "symbol" && token.value === ")") { if (depth > 0) depth--; continue; }
    if (depth === 0) topLevel.push(token);
  }
  for (let i = 0; i <= topLevel.length - words.length; i++) {
    if (words.every((word, offset) => isWord(topLevel, i + offset, word))) return true;
  }
  return false;
}

/**
 * Evaluates transaction-aware lock-safety rules against one newly added SQL forward migration.
 * Never run this retroactively over historical migrations; callers must pass newly appended files only.
 */
export function evaluateMigrationLockSafety(sql: string | Buffer, path?: string): LockSafetyViolation[] {
  const source = typeof sql === "string" ? sql : sql.toString("utf8");
  const ctx = path ? ` (${path})` : "";
  const statements = parseStatements(source);
  const violations: LockSafetyViolation[] = [];
  let lockTimeoutActive = false;

  for (const statement of statements) {
    const { tokens, annotated } = statement;
    lockTimeoutActive = updateLockTimeoutState(tokens, lockTimeoutActive);

    if (isWord(tokens, 0, "ALTER") && isWord(tokens, 1, "TABLE")) {
      let cursor = 2;
      if (isWord(tokens, cursor, "IF") && isWord(tokens, cursor + 1, "EXISTS")) cursor += 2;
      if (isWord(tokens, cursor, "ONLY")) cursor += 1;
      const hot = readHotTableName(tokens, cursor);
      if (!hot) continue;

      if (!lockTimeoutActive) {
        violations.push({
          rule: "hot_table_missing_lock_timeout",
          table: hot.table,
          message: `lock-safety: ALTER TABLE public.${hot.table} requires SET LOCAL lock_timeout (or SET lock_timeout) earlier in the migration to bound lock waits${ctx}`,
        });
      }

      const actions = splitTopLevelActions(tokens.slice(hot.next));
      for (const action of actions) {
        if (!isWord(action, 0, "ADD")) continue;

        // Rule (b): ADD CONSTRAINT <name> CHECK|FOREIGN KEY or unnamed ADD CHECK|FOREIGN KEY without NOT VALID.
        let constraintKind: "CHECK" | "FOREIGN KEY" | null = null;
        if (isWord(action, 1, "CONSTRAINT") && identifierName(action[2]) !== null) {
          if (isWord(action, 3, "CHECK")) constraintKind = "CHECK";
          else if (isWord(action, 3, "FOREIGN") && isWord(action, 4, "KEY")) constraintKind = "FOREIGN KEY";
        } else if (isWord(action, 1, "CHECK")) {
          constraintKind = "CHECK";
        } else if (isWord(action, 1, "FOREIGN") && isWord(action, 2, "KEY")) {
          constraintKind = "FOREIGN KEY";
        }

        if (constraintKind !== null) {
          const hasNotValid = hasTopLevelWordSequence(action, ["NOT", "VALID"]);
          if (!hasNotValid && !annotated) {
            violations.push({
              rule: "hot_table_add_constraint_without_not_valid",
              table: hot.table,
              message: `lock-safety: ALTER TABLE public.${hot.table} ADD CONSTRAINT (${constraintKind}) without NOT VALID scans a hot table under lock; add NOT VALID (and validate in a separate step) or precede the statement with -- lock-safety: <reason>${ctx}`,
            });
          }
          continue;
        }

        // Rule (a): ADD [COLUMN] [IF NOT EXISTS] <col> ... NOT NULL without DEFAULT.
        const explicitColumn = isWord(action, 1, "COLUMN");
        const firstAfterAdd = action[1];
        const isColumnAdd = explicitColumn
          || (firstAfterAdd !== undefined
            && !(firstAfterAdd.kind === "word" && NON_COLUMN_ADD_KEYWORDS.has(firstAfterAdd.value.toUpperCase())));
        if (!isColumnAdd) continue;

        let colIndex = explicitColumn ? 2 : 1;
        if (isWord(action, colIndex, "IF") && isWord(action, colIndex + 1, "NOT") && isWord(action, colIndex + 2, "EXISTS")) {
          colIndex += 3;
        }
        const colName = identifierName(action[colIndex]) ?? "<column>";
        const columnTail = action.slice(colIndex + 1);
        const hasNotNull = hasTopLevelWordSequence(columnTail, ["NOT", "NULL"]);
        const hasDefault = hasTopLevelWordSequence(columnTail, ["DEFAULT"])
          || hasTopLevelWordSequence(columnTail, ["GENERATED"]);
        if (hasNotNull && !hasDefault) {
          violations.push({
            rule: "hot_table_add_column_not_null_without_default",
            table: hot.table,
            message: `lock-safety: ALTER TABLE public.${hot.table} ADD COLUMN ${colName} NOT NULL without DEFAULT is refused; use expand-and-contract (nullable column + backfill + NOT VALID constraint) or supply a DEFAULT${ctx}`,
          });
        }
      }
      continue;
    }

    const isCreateIndex = isWord(tokens, 0, "CREATE")
      && (isWord(tokens, 1, "INDEX") || (isWord(tokens, 1, "UNIQUE") && isWord(tokens, 2, "INDEX")));
    if (isCreateIndex) {
      let depth = 0;
      let onIndex = -1;
      for (let i = 2; i < tokens.length; i++) {
        if (isSymbol(tokens, i, "(")) depth++;
        else if (isSymbol(tokens, i, ")") && depth > 0) depth--;
        else if (depth === 0 && isWord(tokens, i, "ON")) {
          onIndex = i;
          break;
        }
      }
      if (onIndex < 0) continue;
      let tableStart = onIndex + 1;
      if (isWord(tokens, tableStart, "ONLY")) tableStart += 1;
      const hot = readHotTableName(tokens, tableStart);
      if (!hot) continue;

      if (!lockTimeoutActive) {
        violations.push({
          rule: "hot_table_missing_lock_timeout",
          table: hot.table,
          message: `lock-safety: CREATE INDEX on hot table public.${hot.table} requires SET LOCAL lock_timeout (or SET lock_timeout) earlier in the migration to bound lock waits${ctx}`,
        });
      }
      const tail = tokens.slice(hot.next);
      const hasWhere = hasTopLevelWordSequence(tail, ["WHERE"]);
      if (!hasWhere && !annotated) {
        violations.push({
          rule: "hot_table_index_without_partial_or_annotation",
          table: hot.table,
          message: `lock-safety: CREATE INDEX on hot table public.${hot.table} runs inside a migration transaction; narrow it with a partial index WHERE clause or precede the statement with -- lock-safety: <reason> (do not use CONCURRENTLY inside transactional migrations)${ctx}`,
        });
      }
    }
  }

  return violations;
}

export function assertMigrationLockSafety(sql: string | Buffer, path?: string): void {
  const violations = evaluateMigrationLockSafety(sql, path);
  if (violations.length > 0) {
    throw new Error(violations.map(violation => violation.message).join("\n"));
  }
}
