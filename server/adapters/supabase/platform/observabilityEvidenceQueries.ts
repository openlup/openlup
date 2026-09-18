// Generic Supabase query plumbing for the observability evidence port — kept
// separate from the snapshot-building logic so the port stays under the LOC cap.

export type QueryResult<T> = PromiseLike<{ data: T[] | null; error: { message?: string } | null; count?: number | null }>;
export type SupabaseQuery<T> = QueryResult<T> & Record<"eq" | "gte" | "in" | "limit" | "lte" | "not" | "order" | "range" | "select", (...args: unknown[]) => SupabaseQuery<T>>;
export type SupabaseObservabilityClient = { from: <T = Record<string, unknown>>(table: string) => SupabaseQuery<T> };
/** Neutral name for the same client, so evidence reads elsewhere do not each restate a vendor-named type. */
export type ObservabilityEvidenceClient = SupabaseObservabilityClient;

export async function selectRows<T>(query: QueryResult<T>, label: string): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message ?? "query failed"}`);
  return data ?? [];
}

export async function selectCount(query: QueryResult<unknown>, label: string): Promise<number> {
  const { count, error } = await query;
  if (error) throw new Error(`${label}: ${error.message ?? "query failed"}`);
  return count ?? 0;
}

export async function selectAllRows<T>(
  page: (from: number, to: number) => QueryResult<T>,
  label: string,
  pageSize = 500,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const current = await selectRows(page(from, from + pageSize - 1), label);
    rows.push(...current);
    if (current.length < pageSize) return rows;
  }
}
