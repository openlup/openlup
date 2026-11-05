export interface PackageEditErrorMapping {
  status: 400 | 409 | 503; code: "BAD_REQUEST" | "CONFLICT" | "UPSTREAM_UNAVAILABLE"; message: string; reason?: string;
}
/** Raw preview-ledger errors use the generic upstream path; apply admits durable domain tokens. */
export function mapPackageEditError(error: unknown, phase: "preview" | "apply"): PackageEditErrorMapping {
  const message = error instanceof Error ? error.message : phase === "apply" && error && typeof error === "object" && "message" in error
    ? String(error.message) : String(error);
  if (message.startsWith("subscription_reprice_") && !message.endsWith("_unavailable") && !message.endsWith("_undefined")) {
    return { status: 400, code: "BAD_REQUEST", message: message === "subscription_reprice_quote_not_accepted"
      ? "subscription_quote_not_accepted" : "subscription_edit_reprice_failed", reason: message };
  }
  const durable = /(subscription_(?:edit|command|lifecycle)_(?:quote_|stale_|window_|below_|payment_|forbidden|not_found|invalid_|unsupported_|idempotency_|renewal_terms_missing)[a-z_]*)/u.exec(message);
  if (phase === "apply" && durable) {
    return { status: 409, code: "CONFLICT", message: "Customer subscription action is not allowed", reason: durable[1] };
  }
  return { status: 503, code: "UPSTREAM_UNAVAILABLE", message: phase === "preview" ? "Customer subscription preview failed" : "Customer subscription action failed" };
}
