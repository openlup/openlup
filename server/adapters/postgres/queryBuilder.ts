// Vanilla-Postgres query-builder shim (Platform Portability, W10).
//
// Option A (approved): a SCOPED, injection-safe builder that emulates ONLY the supabase-js methods
// the 6 existing gateway consumers actually call — never a full PostgREST reimplementation. It
// translates a builder chain into a single PARAMETERIZED `pg` query ($1,$2,…). Values are never
// string-interpolated and identifiers are allowlist-validated; both invariants live in the pure SQL
// layer (queryBuilderSql.ts), which this file composes.
//
// Result semantics mirror PostgREST for the methods used:
//   - default (await builder)            -> { data: Row[], error }
//   - .maybeSingle()                     -> { data: Row | null, error } (0/1 row; >1 is an error)
//   - .single()                          -> { data: Row, error }       (exactly 1 row; else error)
//   - .range(from,to)/.limit(n)          -> LIMIT/OFFSET, returns { data: Row[], error }
//   - .select(c, {count:"exact"[,head]}) -> { data, count } from a separate aggregate; head omits rows
//   - .insert(v).select(c).maybeSingle() -> INSERT ... RETURNING c, single row
//   - .update(v)...                      -> UPDATE ... [RETURNING c]
//   - error.code carries the pg SQLSTATE (e.g. 23505 unique-violation) so consumers' code-based
//     branches (idempotency replay) keep working unchanged.
//
// The shim is constructed over a SINGLE acquired pg client (one per asActor/asService tx in the
// DataGatewayPort), so every query here runs inside that request's transaction with its RLS GUCs set.

import type { PoolClient } from "pg";

import {
  ParamAccumulator,
  joinParts,
  quoteIdent,
  rangeNotSatisfiable,
  renderColumns,
  renderCountQuery,
  renderFilter,
  renderInsertStatement,
  toShimError,
  unwrapRpcRows,
  type Filter,
  type OrderBy,
  type PgQueryExecutor,
  type PgShimError,
  type PgShimResult,
} from "./queryBuilderSql.js";

// Re-export the result/error/executor shapes so consumers import them from the builder entrypoint.
export type { PgQueryExecutor, PgShimError, PgShimResult };

interface BuilderState {
  table: string;
  mode: "select" | "insert" | "update";
  columns: string; // RETURNING / SELECT projection
  filters: Filter[];
  orders: OrderBy[];
  limit: number | null;
  offset: number | null;
  insertRows: Array<Record<string, unknown>> | null;
  updateValues: Record<string, unknown> | null;
  exactCount: boolean;
  head: boolean;
  rangeRequested: boolean;
}

/**
 * Builder over one pg client. Chainable + awaitable (PromiseLike). Every value flows through a param
 * accumulator, so the rendered SQL contains only $N placeholders for values.
 */
export class PgQueryBuilder<T = unknown> implements PromiseLike<PgShimResult<T>> {
  private state: BuilderState;

  constructor(
    private readonly client: PgQueryExecutor,
    table: string,
  ) {
    this.state = {
      table,
      mode: "select",
      columns: "*",
      filters: [],
      orders: [],
      limit: null,
      offset: null,
      insertRows: null,
      updateValues: null,
      exactCount: false,
      head: false,
      rangeRequested: false,
    };
  }

  select(columns: string, options?: { count?: string; head?: boolean }): this {
    this.state.columns = columns;
    this.state.exactCount = options?.count === "exact";
    this.state.head = options?.head === true;
    return this;
  }

  insert(values: Record<string, unknown> | Array<Record<string, unknown>>): this {
    this.state.mode = "insert";
    this.state.insertRows = Array.isArray(values) ? values : [values];
    return this;
  }

  update(values: Record<string, unknown>): this {
    this.state.mode = "update";
    this.state.updateValues = values;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.state.filters.push({ kind: "eq", column, value });
    return this;
  }

  gt(column: string, value: unknown): this {
    this.state.filters.push({ kind: "gt", column, value });
    return this;
  }

  gte(column: string, value: unknown): this {
    this.state.filters.push({ kind: "gte", column, value });
    return this;
  }

  lte(column: string, value: unknown): this {
    this.state.filters.push({ kind: "lte", column, value });
    return this;
  }

  in(column: string, values: unknown[]): this {
    this.state.filters.push({ kind: "in", column, values });
    return this;
  }

  is(column: string, value: unknown): this {
    this.state.filters.push({ kind: "is", column, value });
    return this;
  }

  ilike(column: string, value: string): this {
    this.state.filters.push({ kind: "ilike", column, value });
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.state.orders.push({ column, ascending: options?.ascending !== false });
    return this;
  }

  limit(count: number): this {
    this.state.limit = count;
    return this;
  }

  range(from: number, to: number): Promise<PgShimResult<T>> {
    // PostgREST range is inclusive on both ends → LIMIT (to-from+1) OFFSET from.
    this.state.offset = from;
    this.state.limit = to - from + 1;
    this.state.rangeRequested = true;
    return this.run("many");
  }

  async maybeSingle(): Promise<PgShimResult<T>> {
    return this.run("maybe");
  }

  async single(): Promise<PgShimResult<T>> {
    return this.run("single");
  }

  then<R1 = PgShimResult<T>, R2 = never>(
    onfulfilled?: ((value: PgShimResult<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.run("many").then(onfulfilled, onrejected);
  }

  private async run(cardinality: "many" | "maybe" | "single"): Promise<PgShimResult<T>> {
    try {
      const count = this.state.exactCount ? await this.runExactCount() : null;
      // A page past the end is a REFUSAL upstream, not an empty answer — but only once the total is
      // known, which is why this sits behind the count and not behind `.range()` itself.
      const unsatisfiable = this.state.rangeRequested ? rangeNotSatisfiable(this.state.offset, count) : null;
      if (unsatisfiable) return { data: [] as T, error: unsatisfiable, count: null };
      // head:true is a HEAD request: no body, so the client contract reports data:null and no row query.
      if (this.state.head) return { data: null as T, error: null, count };
      const { text, values } = this.compile();
      const { rows } = await this.client.query(text, values);
      // The client contract reports count: null unless a count was requested; `shape` must not invent one.
      return { ...this.shape(rows, cardinality), count };
    } catch (error) {
      return { data: (cardinality === "many" ? [] : null) as T, error: toShimError(error), count: null };
    }
  }

  private async runExactCount(): Promise<number> {
    const params = new ParamAccumulator();
    const { rows } = await this.client.query(renderCountQuery(this.state.table, this.state.filters, params), params.values);
    return Number(rows[0]?.exact_count ?? 0);
  }

  private shape(rows: Record<string, unknown>[], cardinality: "many" | "maybe" | "single"): PgShimResult<T> {
    if (cardinality === "many") {
      return { data: rows as T, error: null };
    }
    if (rows.length > 1) {
      // PostgREST returns 406 (PGRST116) when maybeSingle/single match multiple rows.
      return { data: null as T, error: { code: "PGRST116", message: "multiple rows returned" } };
    }
    if (cardinality === "single" && rows.length === 0) {
      return { data: null as T, error: { code: "PGRST116", message: "no rows returned" } };
    }
    return { data: (rows[0] ?? null) as T, error: null };
  }

  private compile(): { text: string; values: unknown[] } {
    const params = new ParamAccumulator();
    if (this.state.mode === "insert") return this.compileInsert(params);
    if (this.state.mode === "update") return this.compileUpdate(params);
    return this.compileSelect(params);
  }

  private compileSelect(params: ParamAccumulator): { text: string; values: unknown[] } {
    const parts = [`SELECT ${renderColumns(this.state.columns)} FROM ${quoteIdent(this.state.table)}`];
    parts.push(this.renderWhere(params));
    parts.push(this.renderOrder());
    parts.push(this.renderLimitOffset(params));
    return { text: joinParts(parts), values: params.values };
  }

  private compileInsert(params: ParamAccumulator): { text: string; values: unknown[] } {
    const text = renderInsertStatement(this.state.table, this.state.insertRows ?? [], this.state.columns, params);
    return { text, values: params.values };
  }

  private compileUpdate(params: ParamAccumulator): { text: string; values: unknown[] } {
    const values = this.state.updateValues ?? {};
    const assignments = Object.keys(values)
      .map((c) => `${quoteIdent(c)} = ${params.add(values[c])}`)
      .join(", ");
    if (assignments === "") throw new Error("pg-shim: update requires at least one column");
    const parts = [`UPDATE ${quoteIdent(this.state.table)} SET ${assignments}`];
    parts.push(this.renderWhere(params));
    const returning = this.state.columns && this.state.columns !== "*"
      ? `RETURNING ${renderColumns(this.state.columns)}`
      : "";
    if (returning) parts.push(returning);
    return { text: joinParts(parts), values: params.values };
  }

  private renderWhere(params: ParamAccumulator): string {
    if (this.state.filters.length === 0) return "";
    const clauses = this.state.filters.map((f) => renderFilter(f, params));
    return `WHERE ${clauses.join(" AND ")}`;
  }

  private renderOrder(): string {
    if (this.state.orders.length === 0) return "";
    const cols = this.state.orders
      .map((o) => `${quoteIdent(o.column)} ${o.ascending ? "ASC" : "DESC"}`)
      .join(", ");
    return `ORDER BY ${cols}`;
  }

  private renderLimitOffset(params: ParamAccumulator): string {
    const parts: string[] = [];
    if (this.state.limit !== null) parts.push(`LIMIT ${params.add(this.state.limit)}`);
    if (this.state.offset !== null) parts.push(`OFFSET ${params.add(this.state.offset)}`);
    return parts.join(" ");
  }
}

/** supabase-js-style client over one acquired pg client: `.from(t)` + `.rpc(fn, args)`. */
export class PgGatewayClient {
  constructor(private readonly client: PgQueryExecutor) {}

  query(text: string, values?: unknown[]) { return this.client.query(text, values); }

  from<T = Record<string, unknown>>(table: string): PgQueryBuilder<T> {
    return new PgQueryBuilder<T>(this.client, table);
  }

  async rpc(functionName: string, args: Record<string, unknown> = {}): Promise<PgShimResult> {
    try {
      const name = quoteIdent(functionName);
      const params = new ParamAccumulator();
      // Named-arg invocation: every existing RPC uses `p_*` named params. `name => $n` binds by name
      // so arg order is irrelevant and values are fully parameterized.
      const namedArgs = Object.keys(args)
        .map((key) => `${quoteIdent(key)} => ${params.add(args[key])}`)
        .join(", ");
      const text = `SELECT * FROM ${name}(${namedArgs})`;
      const { rows } = await this.client.query(text, params.values);
      // RPCs returning a scalar set-returning function expose the value under the function name;
      // a single-column single-row result unwraps to that value (matches supabase-js rpc shape).
      return { data: unwrapRpcRows(rows, functionName), error: null };
    } catch (error) {
      return { data: null, error: toShimError(error) };
    }
  }
}

export type { PoolClient };
