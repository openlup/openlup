export interface CommerceOmsClient {
  from(table: string): SupabaseQueryBuilder;
  rpc(functionName: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

export type CommerceOmsSupabaseClient = CommerceOmsClient;

export interface SupabaseQueryBuilder extends PromiseLike<SupabaseQueryResult> {
  select(columns: string, options?: Record<string, unknown>): SupabaseQueryBuilder;
  order(column: string, options?: Record<string, unknown>): SupabaseQueryBuilder;
  eq(column: string, value: unknown): SupabaseQueryBuilder;
  in(column: string, values: unknown[]): SupabaseQueryBuilder;
  gte(column: string, value: unknown): SupabaseQueryBuilder;
  lte(column: string, value: unknown): SupabaseQueryBuilder;
  ilike(column: string, value: string): SupabaseQueryBuilder;
  insert(values: Record<string, unknown> | Array<Record<string, unknown>>): SupabaseQueryBuilder;
  update(values: Record<string, unknown>): SupabaseQueryBuilder;
  range(from: number, to: number): PromiseLike<SupabaseQueryResult>;
  maybeSingle(): PromiseLike<SupabaseQueryResult>;
}

export interface SupabaseQueryResult {
  data: unknown;
  error: RpcError | null;
  count?: number | null;
}

export interface RpcError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

// Every read in this directory fans out to a follow-up query keyed on ids it just
// collected, so all three needed the same two steps: drop the rows that carry no
// id, and ask for each id once. `compact` was the wrong name for that - it also
// de-duplicates, which the trim-only helpers elsewhere deliberately do not.
export function distinctIds(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
