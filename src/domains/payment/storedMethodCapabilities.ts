import type { PaymentMethodHealthExpectations } from "@openlup/core/payment";

/**
 * What each renewal rail expects of a STORED payment method, for the
 * client-visible surfaces that judge one.
 *
 * The reference adapters publish the same expectations inside their capability
 * descriptors, and that is where an unattended charge reads them from. This
 * lookup exists because the stored-method verdict is also rendered to the
 * customer (account status, subscription preview) by code that must not import a
 * server adapter, and those callers hold no injected registry: they are read
 * models several layers below their composition root. Injecting one through them
 * would be a wider change than the branch it replaces.
 *
 * The two declarations are held equal by a test that reads both
 * (`server/adapters/paymentProviderCapabilityRegistry.test.ts`), so a rail whose
 * adapter changes its expectations cannot silently keep the old customer-facing
 * verdict. Cross-domain consumers read this through `./contracts.js`, the
 * payment domain's public seam; nothing outside imports this module directly.
 */
const STORED_METHOD_EXPECTATIONS: Readonly<Record<string, PaymentMethodHealthExpectations>> = {
  stripe: { requiresCustomerRef: true, requiredMethodKind: null, requiresPayerContact: false },
  tpay: { requiresCustomerRef: false, requiredMethodKind: "blik_payid", requiresPayerContact: true },
};

/** Every provider kind whose stored methods this deployment can judge. */
export const storedMethodCapabilityKinds: readonly string[] = Object.keys(STORED_METHOD_EXPECTATIONS);

/**
 * The stored-method expectations for one provider kind, or null when the kind is
 * unknown — the caller must fail closed rather than guess a rail's rules.
 */
export function storedMethodExpectations(providerKind: string): PaymentMethodHealthExpectations | null {
  return STORED_METHOD_EXPECTATIONS[providerKind] ?? null;
}
