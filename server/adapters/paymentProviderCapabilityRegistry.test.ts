import { describe, expect, it } from "vitest";

import {
  recoveryCaptureFlowCatalog,
  storedMethodCapabilityKinds,
  storedMethodExpectations,
} from "../../src/domains/payment/contracts.js";
import {
  createPaymentProviderCapabilityRegistry,
  paymentProviderCapabilityDescriptors,
  paymentProviderCapabilityRegistry,
  requirePaymentProviderCapability,
} from "./paymentProviderCapabilityRegistry.js";

describe("payment provider capability registry", () => {
  it("publishes every payment adapter this deployment can charge unattended", () => {
    // Catches an adapter silently dropping out of the registry, which would
    // otherwise look like "capability unknown" to every renewal. The kinds
    // themselves are pinned against each adapter's own emitted provider
    // identity by the unattended-charge conformance matrix, so restating them
    // here would only duplicate provider vocabulary.
    expect(paymentProviderCapabilityDescriptors).toHaveLength(2);
    expect(paymentProviderCapabilityRegistry.kinds())
      .toEqual(paymentProviderCapabilityDescriptors.map((descriptor) => descriptor.providerKind));
  });

  it("resolves every published descriptor by its own declared kind", () => {
    for (const descriptor of paymentProviderCapabilityDescriptors) {
      expect(paymentProviderCapabilityRegistry.get(descriptor.providerKind)).toBe(descriptor);
    }
  });

  it("returns null for an unknown provider kind instead of guessing one", () => {
    expect(paymentProviderCapabilityRegistry.get("not_a_registered_provider")).toBeNull();
  });

  it("throws rather than return an undescribable rail to a composition root", () => {
    // The smoke and rehearsal entrypoints hold one row and cannot record a
    // preflight block; charging a rail whose rules are unknown is the guess this
    // contract exists to prevent.
    expect(requirePaymentProviderCapability(paymentProviderCapabilityDescriptors[0]!.providerKind))
      .toBe(paymentProviderCapabilityDescriptors[0]);
    expect(() => requirePaymentProviderCapability("not_a_registered_provider"))
      .toThrow(/unknown payment provider capability/);
  });

  it("keeps the client-visible stored-method expectations equal to the published ones", () => {
    // The customer-facing verdict on a stored method is rendered by src/domains
    // code that must not import an adapter, so it reads its own copy of these
    // expectations. This is the only thing holding the two equal: a rail that
    // changes what it needs must change both, or fail here.
    expect([...storedMethodCapabilityKinds].sort())
      .toEqual([...paymentProviderCapabilityRegistry.kinds()].sort());
    for (const descriptor of paymentProviderCapabilityDescriptors) {
      expect(storedMethodExpectations(descriptor.providerKind)).toEqual(descriptor.methodHealth);
    }
  });

  it("keeps the client-visible capture-flow catalog equal to the published one", () => {
    // The payer-facing repair page renders one option per capture flow and, like
    // the stored-method verdict above, reads its own copy because it must not
    // import an adapter. This is the only thing holding the two equal: a rail
    // that gains, loses or renames a capture flow must change both, or fail here.
    expect(recoveryCaptureFlowCatalog).toEqual(
      paymentProviderCapabilityDescriptors.flatMap((descriptor) => descriptor.captureFlows),
    );
  });

  it("refuses two descriptors claiming the same kind", () => {
    const descriptor = paymentProviderCapabilityDescriptors[0]!;
    expect(() => createPaymentProviderCapabilityRegistry([descriptor, descriptor]))
      .toThrow(/duplicate payment provider capability/);
  });
});
