// Compact, human-friendly order reference shared across every customer-facing
// surface (emails, thank-you page, account order history, payment screens).
//
// Lives in `src/lib` (not `src/domains/commerce`) on purpose: it is a pure string
// formatter with no commerce coupling, and the account UI must be able to import
// it without tripping the hidden-commerce-UI guardrail.
//
// Order ids arrive as a UUID or the "order_<uuid>" form (the outbox payload's
// orderId, and the recap/`order=` ref). A full UUID reads as a spam signal in a
// subject line, truncates badly on mobile, and is meaningless to a customer. We
// surface the first 8 UUID hex chars with a selected presentation prefix — short, stable, and
// enough for a customer or support to correlate a message with the order —
// without changing technical ids. Single source of truth so the reference the
// customer sees is byte-identical across the email and the site.

const DEFAULT_REFERENCE_PREFIX = "OPENLUP";

export function formatCustomerOrderReference(orderIdOrRef: string, prefix = DEFAULT_REFERENCE_PREFIX): string {
  const normalizedPrefix = prefix.trim().toUpperCase() || DEFAULT_REFERENCE_PREFIX;
  // Idempotent for the selected prefix. A public composition may deliberately
  // re-present an existing OPENLUP reference without changing its technical suffix.
  const trimmed = orderIdOrRef.trim();
  if (trimmed.toUpperCase().startsWith(`${normalizedPrefix}-`)) return trimmed.toUpperCase();
  if (trimmed.toUpperCase().startsWith(`${DEFAULT_REFERENCE_PREFIX}-`)) {
    return `${normalizedPrefix}-${trimmed.slice(`${DEFAULT_REFERENCE_PREFIX}-`.length).toUpperCase()}`;
  }
  const bare = trimmed.replace(/^order_/, "").replace(/-/g, "");
  const ref = bare.slice(0, 8).toUpperCase();
  return ref ? `${normalizedPrefix}-${ref}` : normalizedPrefix;
}
