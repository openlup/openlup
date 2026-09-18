import { createNoopPaymentExecutionAdapter } from "../../adapters/noop_payment/noopPaymentExecutionAdapter.js";
import type { PaymentExecutionPort } from "../../../src/domains/payment/ports.js";
import { type PaymentExecutionProvider } from "../../../src/domains/payment/types.js";

/**
 * Provider-neutral selection of a payment execution adapter (W11.0 seam).
 *
 * Today only no-op providers exist; real PSP adapters (stripe/tpay) plug in here
 * in W11.7 by mapping their `provider_kind` to a folder under `api/adapters/`.
 * Provider name strings stay confined to adapters + this registry, per the
 * repo's vendor-neutrality convention.
 */
export class UnknownPaymentProviderError extends Error {
  readonly providerKind: string;

  constructor(providerKind: string) {
    super(`Unknown payment execution provider: ${providerKind}`);
    this.name = "UnknownPaymentProviderError";
    this.providerKind = providerKind;
  }
}

/**
 * Thrown when a no-op (rehearsal) provider is requested where no-op settlement is
 * not allowed. No-op providers settle an order "paid" with NO real charge, so
 * they must never resolve in production.
 */
export class NoopSettlementNotAllowedError extends Error {
  readonly providerKind: string;

  constructor(providerKind: string) {
    super(`No-op payment settlement is not allowed here: ${providerKind}`);
    this.name = "NoopSettlementNotAllowedError";
    this.providerKind = providerKind;
  }
}

const NOOP_PROVIDERS = new Set<PaymentExecutionProvider>(["hidden_rehearsal", "noop_payment"]);

function isNoopProvider(providerKind: string): providerKind is PaymentExecutionProvider {
  return NOOP_PROVIDERS.has(providerKind as PaymentExecutionProvider);
}

export function getPaymentExecutionAdapter(
  providerKind: string,
  injectedAdapters: Record<string, PaymentExecutionPort>,
  noopAllowed: boolean,
): PaymentExecutionPort {
  const injected = injectedAdapters[providerKind];
  if (injected) return injected;
  if (isNoopProvider(providerKind)) {
    if (!noopAllowed) throw new NoopSettlementNotAllowedError(providerKind);
    return createNoopPaymentExecutionAdapter(providerKind);
  }
  throw new UnknownPaymentProviderError(providerKind);
}
