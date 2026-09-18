// Composition of the payment capability descriptors the reference adapters
// publish (Provider Entry Gate, F1 — capability, not identity).
//
// Deliberately here and not in `server/runtime/`: this is the one module that
// must name every payment provider, and naming them is a reference-adapter
// concern. The public platform runtime is meant to receive a neutral
// `PaymentProviderCapabilityRegistry` rather than to enumerate providers
// itself. Nothing outside tests imports this yet; the renewal and dunning
// consumers arrive with the de-branching change.

import type {
  PaymentProviderCapabilityDescriptor,
  PaymentProviderCapabilityRegistry,
} from "@openlup/core/payment";
import { unattendedChargeCapability as offSessionCardCapability } from "./stripe/stripeAdapterFactory.js";
import { unattendedChargeCapability as recurringMandateCapability } from "./tpay/tpayAdapterFactory.js";

/**
 * Indexes descriptors by their own declared kind.
 *
 * Duplicate kinds throw rather than resolve last-write-wins: a registry that
 * silently drops one provider's capabilities would send every renewal for that
 * provider down another provider's rules.
 */
export function createPaymentProviderCapabilityRegistry(
  descriptors: readonly PaymentProviderCapabilityDescriptor[],
): PaymentProviderCapabilityRegistry {
  const byKind = new Map<string, PaymentProviderCapabilityDescriptor>();
  for (const descriptor of descriptors) {
    if (byKind.has(descriptor.providerKind)) {
      throw new Error(`duplicate payment provider capability: ${descriptor.providerKind}`);
    }
    byKind.set(descriptor.providerKind, descriptor);
  }
  return {
    get: (providerKind) => byKind.get(providerKind) ?? null,
    kinds: () => [...byKind.keys()],
  };
}

/** Every capability descriptor this deployment's payment adapters publish. */
export const paymentProviderCapabilityDescriptors: readonly PaymentProviderCapabilityDescriptor[] = [
  offSessionCardCapability,
  recurringMandateCapability,
];

export const paymentProviderCapabilityRegistry: PaymentProviderCapabilityRegistry =
  createPaymentProviderCapabilityRegistry(paymentProviderCapabilityDescriptors);

/**
 * The published descriptor for one kind, or a throw.
 *
 * For composition roots that hold a single row and cannot carry a preflight
 * block (release smoke, money-path rehearsal): charging a rail whose rules this
 * deployment cannot state is exactly the guess the capability contract exists to
 * prevent, so it fails closed and loudly instead.
 */
export function requirePaymentProviderCapability(providerKind: string): PaymentProviderCapabilityDescriptor {
  const capability = paymentProviderCapabilityRegistry.get(providerKind);
  if (!capability) throw new Error(`unknown payment provider capability: ${providerKind}`);
  return capability;
}
