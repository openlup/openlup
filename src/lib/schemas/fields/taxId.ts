/**
 * What a tax id says about the document that must be issued for it.
 *
 * `governmentClearanceRequired` was `ksefRequired` until E2-F4. Continuous
 * transaction control is a general capability with several national
 * implementations — one country clears through KSeF, another through SDI, a
 * third through CFDI — and the flag that says "a tax authority must clear this
 * document" belongs to none of them. The provider adapters keep their own
 * national names; this decision does not.
 */
export type InvoiceRoutingDecision =
  | {
      ok: true;
      documentKind: "b2c_named" | "b2b_vat";
      normalizedTaxId: string | null;
      governmentClearanceRequired: boolean;
    }
  | {
      ok: false;
      // `invalid_tax_id` is a persisted `blocked_reason` and an alerting key, so
      // it is a database-side name as much as a domain one. The second reason
      // belongs to the neutral router, which cannot judge a tax id at all.
      reason: "invalid_tax_id" | "tax_id_routing_not_configured";
      normalizedTaxId: string;
    };

export function normalizePolishNip(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  const withoutCountryPrefix = trimmed.replace(/^\s*PL[\s-]*/i, "");
  const digits = withoutCountryPrefix.replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}

export function formatPolishNip(value: string | null | undefined): string | null {
  const digits = normalizePolishNip(value);
  if (!digits) return null;
  if (digits.length !== 10) return digits;
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6, 8)}-${digits.slice(8)}`;
}

export function isValidPolishNip(value: string | null | undefined): boolean {
  const digits = normalizePolishNip(value);
  if (!digits || !/^\d{10}$/.test(digits)) return false;
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const checksum = weights.reduce((sum, weight, index) => sum + weight * Number(digits[index]), 0) % 11;
  return checksum !== 10 && checksum === Number(digits[9]);
}

export function routeInvoiceByTaxId(taxId: string | null | undefined): InvoiceRoutingDecision {
  const normalizedTaxId = normalizePolishNip(taxId);
  if (!normalizedTaxId) {
    return {
      ok: true, documentKind: "b2c_named", normalizedTaxId: null, governmentClearanceRequired: false,
    };
  }
  if (!isValidPolishNip(normalizedTaxId)) {
    return { ok: false, reason: "invalid_tax_id", normalizedTaxId };
  }
  return { ok: true, documentKind: "b2b_vat", normalizedTaxId, governmentClearanceRequired: true };
}

export function normalizeOptionalPolishNipForStorage(value: string | null | undefined): string | null {
  const normalizedTaxId = normalizePolishNip(value);
  if (!normalizedTaxId) return null;
  if (!isValidPolishNip(normalizedTaxId)) {
    throw new Error("invalid_polish_nip");
  }
  return normalizedTaxId;
}
