// Vanilla-Postgres query-builder SQL primitives (Platform Portability, W10).
//
// Extracted from queryBuilder.ts (300-LOC cap) — the pure, stateless SQL-fragment layer the builder
// composes: result/error shapes, the injection-safety chokepoint (ParamAccumulator), identifier
// quoting (allowlist), column projection, and filter rendering. VALUES ARE NEVER string-interpolated;
// they flow through ParamAccumulator as $N placeholders. Identifiers (table/column names) are validated
// against a strict allowlist regex and double-quoted, so they cannot smuggle SQL either.

/** PostgREST-shaped error the consumers narrow on (`.code`, `.message`, `.details`, `.hint`). */
export interface PgShimError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

export interface PgShimResult<T = unknown> {
  data: T;
  error: PgShimError | null;
  count?: number | null;
}

/** Minimal query surface we need from a pg client (Pool acquires a PoolClient per request). */
export interface PgQueryExecutor {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export type Filter =
  | { kind: "eq" | "gte" | "lte" | "gt"; column: string; value: unknown }
  | { kind: "in"; column: string; values: unknown[] }
  | { kind: "ilike"; column: string; value: string }
  | { kind: "is"; column: string; value: unknown };

export interface OrderBy {
  column: string;
  ascending: boolean;
}

// Identifiers (table + column names) are NEVER parameterizable in SQL, so they are validated against
// a strict allowlist and quoted. Consumers only ever pass static, code-literal identifiers; this
// guard turns any attempt to pass a crafted identifier into a thrown error rather than injected SQL.
const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/i;

export function quoteIdent(raw: string): string {
  if (!IDENTIFIER_RE.test(raw)) {
    throw new Error(`pg-shim: unsafe identifier ${JSON.stringify(raw)}`);
  }
  return `"${raw}"`;
}

// `select("a, b")` etc. — a comma list of identifiers or "*". Each segment is validated; "*" passes
// through. PostgREST embedding syntax (foo(bar)) is NOT used by any consumer, so it is rejected
// (fail-closed) rather than silently mistranslated.
export function renderColumns(columns: string): string {
  const trimmed = columns.trim();
  if (trimmed === "" || trimmed === "*") return "*";
  return trimmed
    .split(",")
    .map((c) => c.trim())
    .map((c) => (c === "*" ? "*" : quoteIdent(c)))
    .join(", ");
}

export function renderFilter(filter: Filter, params: ParamAccumulator): string {
  const col = quoteIdent(filter.column);
  switch (filter.kind) {
    case "eq":
      return `${col} = ${params.add(filter.value)}`;
    case "gt":
      return `${col} > ${params.add(filter.value)}`;
    case "gte":
      return `${col} >= ${params.add(filter.value)}`;
    case "lte":
      return `${col} <= ${params.add(filter.value)}`;
    case "ilike":
      return `${col} ILIKE ${params.add(filter.value)}`;
    case "in": {
      // Empty IN () is invalid SQL; PostgREST treats `.in([])` as matching nothing.
      if (filter.values.length === 0) return "false";
      const placeholders = filter.values.map((v) => params.add(v)).join(", ");
      return `${col} IN (${placeholders})`;
    }
    case "is":
      // .is(col, null) → IS NULL; .is(col, true/false) → IS TRUE/FALSE. Value is a literal keyword,
      // not user data (consumers only pass null/true/false), so it is rendered, not parameterized.
      if (filter.value === null) return `${col} IS NULL`;
      if (filter.value === true) return `${col} IS TRUE`;
      if (filter.value === false) return `${col} IS FALSE`;
      throw new Error("pg-shim: .is() only supports null/true/false");
  }
}

/**
 * PostgREST `count=exact` rendered as a SEPARATE aggregate over the same FROM/WHERE — deliberately
 * NOT a `COUNT(*) OVER()` folded into the row query. PostgREST's exact count ignores limit/offset,
 * and a window function emits no row at all for an empty page, so an offset past the end would
 * report 0 instead of the true total. Keeping it separate also leaves the row projection
 * byte-identical: there is no synthetic column to strip before cardinality shaping.
 */
export function renderCountQuery(table: string, filters: readonly Filter[], params: ParamAccumulator): string {
  const where = filters.length === 0
    ? ""
    : `WHERE ${filters.map((filter) => renderFilter(filter, params)).join(" AND ")}`;
  return joinParts([`SELECT count(*) AS exact_count FROM ${quoteIdent(table)}`, where]);
}

/**
 * PostgREST refuses an out-of-bounds page instead of answering an empty one -- but ONLY when it
 * knows the total, i.e. when an exact count was requested; without one it answers 200 and `[]`,
 * which is what this shim already did. The boundary is strict: offset === total is a legal empty
 * page, offset === total + 1 is not. Measured against PostgREST 14.10 before this was written,
 * including the `details` sentence, which carries the two numbers a caller pages on.
 */
export function rangeNotSatisfiable(offset: number | null, total: number | null): PgShimError | null {
  if (offset === null || total === null || offset <= total) return null;
  return {
    code: "PGRST103",
    message: "Requested range not satisfiable",
    details: `An offset of ${offset} was requested, but there are only ${total} rows.`,
  };
}

/**
 * INSERT ... VALUES ... RETURNING, with the column list taken from the FIRST row and every later
 * row required to carry the same key set. Deriving the columns from row 0 alone and binding the
 * rest positionally is how a batch used to lose a column silently: an extra key vanished, a missing
 * one bound NULL over a DEFAULT. PostgREST answers PGRST102 "All object keys must match" to exactly
 * this payload -- and keeps answering it under `Prefer: missing=default`, measured -- so the shim
 * refuses too. Refusal, not union: parity is the point, and this builder exposes no Prefer header
 * through which a caller could ask for anything else.
 */
export function renderInsertStatement(
  table: string,
  rows: readonly Record<string, unknown>[],
  projection: string,
  params: ParamAccumulator,
): string {
  if (rows.length === 0) throw new Error("pg-shim: insert requires at least one row");
  const columns = Object.keys(rows[0]!);
  const signature = [...columns].sort().join("\u0000");
  for (const row of rows) {
    if ([...Object.keys(row)].sort().join("\u0000") !== signature) {
      throw Object.assign(new Error("All object keys must match"), { code: "PGRST102" });
    }
  }
  const tuples = rows.map((row) => `(${columns.map((column) => params.add(row[column])).join(", ")})`).join(", ");
  return `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(", ")}) VALUES ${tuples} `
    + `RETURNING ${renderColumns(projection)}`;
}

// supabase-js rpc() returns the function's return value directly: a scalar/json function yields that
// value; a TABLE/SETOF function yields the row array. Heuristic mirrors that: 1 row × 1 column whose
// name equals the function → the scalar; otherwise the rows array (TABLE-returning).
export function unwrapRpcRows(rows: Record<string, unknown>[], functionName: string): unknown {
  if (rows.length === 1) {
    const keys = Object.keys(rows[0]);
    if (keys.length === 1 && keys[0] === functionName) return rows[0][functionName];
  }
  return rows;
}

/** Accumulates values and hands back $1,$2,… placeholders — the single injection-safety chokepoint. */
export class ParamAccumulator {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

export function joinParts(parts: string[]): string {
  return parts.filter((p) => p.trim() !== "").join(" ");
}

export function toShimError(error: unknown): PgShimError {
  const e = error as { code?: string; message?: string; detail?: string; hint?: string };
  return {
    code: e?.code,
    message: e?.message ?? "query failed",
    details: e?.detail,
    hint: e?.hint,
  };
}
