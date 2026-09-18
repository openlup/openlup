// Shared resolution of the one-click unsubscribe link base. Every
// marketing-email composition root (review request/effects, abandoned cart,
// back-in-stock, reorder reminder) resolves it the same way, so it lives in one
// place instead of being re-derived (and potentially re-broken) per handler.
//
// The base is operator-supplied only, through `UNSUBSCRIBE_FUNCTIONS_BASE_URL`.
// Nothing here derives one from the project URL any more: a derived managed
// invoke base would mint a dead link since that function was retired in source,
// so only an application origin is accepted. An unset variable is a refusal
// (`unsubscribe_functions_base_url_required`) in
// `api/_cron/outboxMarketingReadiness.ts`, before any email is composed.

/**
 * Resolve an operator-supplied unsubscribe base at the provider boundary.
 * Only a bare HTTPS application origin is supported.
 */
export function resolveUnsubscribeBaseUrl(value: string): string | null {
  let base: URL;
  try {
    base = new URL(value);
  } catch {
    return null;
  }
  const isLegacyFunctionsHost = base.hostname.split(".").at(-3) === "functions";
  const isManagedHost = base.hostname === "supabase.co" || base.hostname.endsWith(".supabase.co");
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.hostname.endsWith(".") ||
    isLegacyFunctionsHost ||
    isManagedHost ||
    base.pathname !== "/"
  ) {
    return null;
  }
  return base.origin;
}

/** Resolve a validated base to the concrete endpoint used by the domain composer. */
export function resolveUnsubscribeEndpointUrl(baseUrl: string): string | null {
  return resolveUnsubscribeEndpoint(baseUrl)?.unsubscribeEndpointUrl ?? null;
}

export type UnsubscribeTarget = "application";

export interface ResolvedUnsubscribeEndpoint {
  unsubscribeEndpointUrl: string;
  target: UnsubscribeTarget;
}

/** Resolve a validated base to its concrete endpoint and named target. */
export function resolveUnsubscribeEndpoint(baseUrl: string): ResolvedUnsubscribeEndpoint | null {
  const resolvedBase = resolveUnsubscribeBaseUrl(baseUrl);
  if (!resolvedBase) return null;
  const endpoint = new URL(resolvedBase);
  endpoint.pathname = "/api/unsubscribe";
  return { unsubscribeEndpointUrl: endpoint.toString(), target: "application" };
}
