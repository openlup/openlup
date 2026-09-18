import type { CreateQuoteRequest } from "../../../src/domains/commerce/contracts.js";

interface ClientRow {
  id: string;
  email: string | null;
  created_at?: string | null;
}

interface ClientQuery {
  select(columns: string): ClientQuery;
  eq(column: string, value: unknown): ClientQuery;
  ilike(column: string, pattern: string): ClientQuery;
  order(column: string, options?: { ascending?: boolean }): ClientQuery;
  limit(count: number): ClientQuery;
  maybeSingle(): PromiseLike<{ data: ClientRow | null; error: unknown }>;
  then<TResult1 = { data: ClientRow[] | null; error: unknown }, TResult2 = never>(
    onfulfilled?: ((value: { data: ClientRow[] | null; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2>;
}

export interface QuoteCustomerEligibilityClient {
  from(table: "clients"): ClientQuery;
}

export interface QuoteCustomerEligibilityResolution {
  clientId: string | null;
  source: "anonymous" | "resolved_client";
  /**
   * How the client was matched to the typed email:
   *  - `"exact"` — the typed email equals the client's stored email. Only this
   *    match, together with paid-order history, may surface returning-buyer
   *    recognition to an unauthenticated visitor.
   *  - `"plus_normalized"` — matched only after stripping a `+tag` alias
   *    (`base+tag@` → `base@`). Used for first-order anti-farming eligibility
   *    demotion, but MUST NOT be reported as returning-buyer recognition.
   *  - `null` — no client matched.
   */
  matchKind: "exact" | "plus_normalized" | null;
}

export async function resolveQuoteCustomerEligibility(
  client: QuoteCustomerEligibilityClient,
  request: CreateQuoteRequest,
): Promise<QuoteCustomerEligibilityResolution> {
  const email = quoteEligibilityEmail(request);
  if (!email) return { clientId: null, source: "anonymous", matchKind: null };

  const exact = await client
    .from("clients")
    .select("id,email,created_at")
    .eq("email", email)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (exact.error) throw exact.error instanceof Error ? exact.error : new Error("quote_client_exact_lookup_failed");
  if (exact.data?.id) {
    return { clientId: exact.data.id, source: "resolved_client", matchKind: "exact" };
  }

  // Plus-normalized fallback exists ONLY for first-order anti-farming: a guest
  // typing `base+tag@` still demotes the first-order discount against `base@`'s
  // paid history. It is tagged `plus_normalized` so the recognition banner never
  // treats it as an exact returning-buyer match.
  const plusNormalized = plusNormalizeEmail(email);
  const candidates = await queryPlusCandidates(client, plusNormalized);
  const match = candidates.find((row) => plusNormalizeEmail(row.email ?? "") === plusNormalized);
  return match?.id
    ? { clientId: match.id, source: "resolved_client", matchKind: "plus_normalized" }
    : { clientId: null, source: "anonymous", matchKind: null };
}

function quoteEligibilityEmail(request: CreateQuoteRequest): string | null {
  const context = request.customerEligibilityContext;
  return context?.email ?? context?.contactEmail ?? null;
}

/**
 * `base+tag@d` -> `base@d`. Exported so proofs can assert against the SAME
 * normalizer the anti-farming fallback below uses, rather than a copy of it.
 */
export function plusNormalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0) return normalized;
  const local = normalized.slice(0, at).replace(/\+.*/, "");
  return `${local}${normalized.slice(at)}`;
}

async function queryPlusCandidates(
  client: QuoteCustomerEligibilityClient,
  plusNormalized: string,
): Promise<ClientRow[]> {
  const at = plusNormalized.lastIndexOf("@");
  if (at <= 0) return [];
  const local = plusNormalized.slice(0, at);
  const domain = plusNormalized.slice(at + 1);
  const { data, error } = await client
    .from("clients")
    .select("id,email,created_at")
    .ilike("email", `${escapeLike(local)}%@${escapeLike(domain)}`)
    .order("created_at", { ascending: true })
    .limit(25);
  if (error) throw error instanceof Error ? error : new Error("quote_client_plus_lookup_failed");
  return Array.isArray(data) ? data : [];
}

function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}
