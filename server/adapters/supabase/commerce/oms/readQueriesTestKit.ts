import type {
  CommerceOmsClient,
  SupabaseQueryBuilder,
  SupabaseQueryResult,
} from "./types.js";

export class FakeOmsClient implements CommerceOmsClient {
  readonly filters: Array<{ table: string; kind: string; column: string; value: unknown }> = [];
  readonly rangeCalls: Array<{ table: string; from: number; to: number }> = [];
  readonly rpcCalls: Array<{ functionName: string; args: Record<string, unknown> }> = [];
  readonly selects: Array<{ table: string; columns: string }> = [];
  readonly tablesRead: string[] = [];

  constructor(private readonly options: {
    rpcData: unknown;
    rpcDataByFunction?: Record<string, unknown>;
    rows: Record<string, unknown[]>;
    selectErrors?: Array<{ table: string; whenColumnsInclude: string; error: { code?: string; message?: string; details?: string; hint?: string } }>;
  }) {}

  from(table: string): SupabaseQueryBuilder {
    this.tablesRead.push(table);
    return new FakeQueryBuilder(this, table);
  }

  rpc(functionName: string, args: Record<string, unknown>) {
    this.rpcCalls.push({ functionName, args });
    const data = this.options.rpcDataByFunction?.[functionName] ?? (functionName === "commerce_oms_resolve_delivery_contact_v1"
      ? {
        resolutionVersion: 1,
        scope: "missing",
        baseline: null,
        contact: null,
        contactDigest: null,
      }
      : this.options.rpcData);
    return Promise.resolve({ data, error: null });
  }

  rowsFor(table: string): unknown[] {
    return this.options.rows[table] ?? [];
  }

  selectErrorFor(table: string, columns: string) {
    return this.options.selectErrors?.find(
      (entry) => entry.table === table && columns.includes(entry.whenColumnsInclude),
    )?.error ?? null;
  }
}

class FakeQueryBuilder implements SupabaseQueryBuilder {
  private filters: Array<{ kind: string; column: string; value: unknown }> = [];
  private selectedColumns = "*";

  constructor(private readonly client: FakeOmsClient, private readonly table: string) {}

  select(columns = "*"): SupabaseQueryBuilder {
    this.selectedColumns = columns;
    this.client.selects.push({ table: this.table, columns });
    return this;
  }

  order(): SupabaseQueryBuilder {
    return this;
  }

  eq(column: string, value: unknown): SupabaseQueryBuilder {
    return this.addFilter("eq", column, value);
  }

  in(column: string, value: unknown[]): SupabaseQueryBuilder {
    return this.addFilter("in", column, value);
  }

  is(column: string, value: unknown): SupabaseQueryBuilder {
    return this.addFilter("is", column, value);
  }

  gte(column: string, value: unknown): SupabaseQueryBuilder {
    return this.addFilter("gte", column, value);
  }

  lte(column: string, value: unknown): SupabaseQueryBuilder {
    return this.addFilter("lte", column, value);
  }

  ilike(column: string, value: string): SupabaseQueryBuilder {
    return this.addFilter("ilike", column, value);
  }

  insert(): SupabaseQueryBuilder {
    return this;
  }

  update(): SupabaseQueryBuilder {
    return this;
  }

  range(from: number, to: number) {
    this.client.rangeCalls.push({ table: this.table, from, to });
    return Promise.resolve(this.result());
  }

  maybeSingle() {
    const error = this.client.selectErrorFor(this.table, this.selectedColumns);
    if (error) return Promise.resolve({ data: null, error });
    const rows = this.result().data;
    if (rows.length > 1) {
      return Promise.resolve({
        data: null,
        error: {
          code: "PGRST116",
          message: "JSON object requested, multiple (or no) rows returned",
          details: "Results contain more than 1 row",
        },
      });
    }
    return Promise.resolve({ data: rows[0] ?? null, error: null });
  }

  then<TResult1 = SupabaseQueryResult, TResult2 = never>(
    onfulfilled?: ((value: SupabaseQueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.result()).then(onfulfilled, onrejected);
  }

  private addFilter(kind: string, column: string, value: unknown): SupabaseQueryBuilder {
    this.filters.push({ kind, column, value });
    this.client.filters.push({ table: this.table, kind, column, value });
    return this;
  }

  private result(): SupabaseQueryResult & { data: unknown[] } {
    const error = this.client.selectErrorFor(this.table, this.selectedColumns);
    if (error) {
      return {
        data: [],
        error,
        count: null,
      };
    }
    return {
      data: this.client.rowsFor(this.table).filter((row) => this.matches(row)),
      error: null,
      count: null,
    };
  }

  private matches(row: unknown): boolean {
    if (!isRecord(row)) return false;
    return this.filters.every((filter) => {
      if (filter.kind === "in") {
        return Array.isArray(filter.value) && filter.value.includes(row[filter.column]);
      }
      if (filter.kind === "eq") return row[filter.column] === filter.value;
      if (filter.kind === "is") return row[filter.column] === filter.value;
      return true;
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
