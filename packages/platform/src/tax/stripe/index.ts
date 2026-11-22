import { taxCloseInputV1Schema, TAX_CALCULATION_CONTRACT_VERSION } from "../contracts/index.js";
import type { TaxCalculationPortV1, TaxUnavailable } from "../contracts/index.js";
import { invalid } from "../contracts/decode.js";
import { ref, scope } from "../contracts/schemas.js";
import { verifyTaxQuoteRequest } from "../digest.js";
import type { Client, Effects, StripeQuoteMarketPack } from "./effects.js";
import { quoteStripeTax } from "./quote.js";
import { assertClientScope, assertScope, commit, refuseError, reverse } from "./transactions.js";

export { makeStripeTaxRequestDigest } from "./effects.js";

const fiscalValidityUnavailable = (): TaxUnavailable => ({
  kind: "unavailable", code: "tax_fiscal_validity_unavailable", effect: "none",
});

/** Host-owned dependencies for one qualified account, mode, market and currency.
 * @beta
 * @experimental
 */
export interface StripeTaxAdapterOptions {
  readonly installationRef: string;
  readonly marketPack: StripeQuoteMarketPack;
  /**
   * Matches the provider SDK's Tax resources. Pass its calculations, registrations
   * and transactions resources directly with their verified account and mode in scope.
   */
  readonly client: Client;
  readonly effects: Effects;
  readonly now: () => Date;
}

/**
 * Compose an exclusive-tax adapter with an account-bound client and a pinned market pack.
 * The host records authoritative closes, verifies payments and serializes reporting reservations.
 * Quote evaluation keys have independent provider snapshots at each tax instant.
 * @beta
 * @experimental
 */
export function createStripeTaxAdapter(options: StripeTaxAdapterOptions): TaxCalculationPortV1 {
  const pinned = { ...options, marketPack: structuredClone(options.marketPack) };
  const pack = pinned.marketPack;
  scope(pack.scope, "/marketPack/scope");
  ref(pack.market, "/marketPack/market");
  ref(pinned.installationRef, "/installationRef");
  if (!/^[A-Z]{3}$/u.test(pack.currency)) invalid("/marketPack/currency", "Supply an uppercase three-letter currency code.");
  if (pack.scope.adapter !== "stripeTax" || pack.scope.adapterVersion !== "1") {
    invalid("/marketPack/scope", "Bind the market pack to the stripeTax adapter at version 1.", "tax_scope_mismatch");
  }
  assertClientScope(pinned);
  return {
    contractVersion: TAX_CALCULATION_CONTRACT_VERSION,
    capabilities: () => ({
      scope: { ...pack.scope }, markets: [pack.market], currencies: [pack.currency], bases: ["exclusive"],
      sourcing: [...new Set(pack.jurisdictions.map(row => row.sourcing))],
      evidence: { lines: true, delivery: true, fees: pack.fees.length > 0 }, registrations: "effective_intervals",
      validity: "probe_by_recalculation", calculationLifetimeMs: 90 * 24 * 60 * 60 * 1000,
      posting: "provider", reversals: ["full", "lines"], recovery: ["commit", "reverse"],
    }),
    quote: request => quoteStripeTax(pinned, request),
    async readFiscalValidity(request) {
      if (verifyTaxQuoteRequest(request)) return fiscalValidityUnavailable();
      return fiscalValidityUnavailable();
    },
    async closeCalculation(ref, reason, key) {
      try {
        const input = taxCloseInputV1Schema.parse({ ref, reason, key });
        assertScope(input.ref.scope, pack.scope, "/ref/scope");
        return { kind: "closed", ref: input.ref, key: input.key };
      } catch (error) {
        const refusal = refuseError(error);
        return refusal.field.startsWith("/reason") ? { ...refusal, code: "tax_close_not_eligible",
          remedy: "Supply authoritative evidence that the calculation is unused or the payment is unpaid. Reconcile unresolved payments first." } : refusal;
      }
    },
    commit: request => commit(pinned, request),
    reverse: request => reverse(pinned, request),
  };
}
