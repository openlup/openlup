import { describe, expect, it, vi } from "vitest";
import {
  createPaymentProviderRegistry,
  fromCoreCaptureHandoff,
  toCoreCaptureHandoff,
  toCorePaymentProviderCapability,
} from "../../src/payments/index.js";
import type { PaymentAdapter, PaymentAdapterCapabilities } from "../../src/payments/contracts/index.js";

function syntheticAdapter(
  providerKind: string,
  captureFlows: PaymentAdapterCapabilities["captureFlows"],
  withMethodPort = false,
): PaymentAdapter {
  return {
    capabilities: {
      providerKind,
      captureFlows,
      requiresStoredMandateEvidence: false,
      assessMandate: () => ({ chargeable: true }),
      unattendedChargeFlow: "off_session",
      payerContext: { requiresPayerBlock: false, customerRefFallsBackToContactEmail: false },
      methodHealth: { requiresCustomerRef: true, requiredMethodKind: null, requiresPayerContact: false },
      terminalOutcomeReporting: { kind: "status_field", silenceBecomesSuspectAfterMinutes: 360 },
      mandateUpsertIsSubscriptionScoped: false,
      supportedCurrencies: ["EUR"],
      unattended: "supported",
      readback: "supported",
      close: "unsupported",
      exactAbsence: "unsupported",
      refundObservation: "supported",
      refundCreate: "unsupported",
      authorizationCaptureSplit: "unsupported",
    },
    attemptPort: { validateInput: vi.fn(), execute: vi.fn() },
    verifyPort: { verifyAndNormalize: vi.fn() },
    readbackPort: { readPayment: vi.fn() },
    ...(withMethodPort ? { methodPort: { setupMethod: vi.fn() } } : {}),
  };
}

describe("PaymentProviderRegistry and capture handoff translator", () => {
  it("translates capture handoffs losslessly between platform and core vocabularies", () => {
    expect(toCoreCaptureHandoff("client-confirmed")).toBe("embedded_client_secret");
    expect(toCoreCaptureHandoff("customer-authorization")).toBe("payer_supplied_code");
    expect(toCoreCaptureHandoff("redirect")).toBeNull();
    expect(fromCoreCaptureHandoff("embedded_client_secret")).toBe("client-confirmed");
    expect(fromCoreCaptureHandoff("payer_supplied_code")).toBe("customer-authorization");
  });

  it("projects capabilities, rail handoffs, method ports and readback ports from one registry", () => {
    const railA = syntheticAdapter("rail-a", [
      { kind: "card_flow", handoff: "client-confirmed", methodFamilies: ["card"] },
    ], true);
    const railB = syntheticAdapter("rail-b", [
      { kind: "bank_flow", handoff: "redirect", methodFamilies: ["bank-redirect"] },
      { kind: "code_flow", handoff: "customer-authorization", methodFamilies: ["one-time-code"] },
    ]);

    const registry = createPaymentProviderRegistry([railA, railB]);
    expect(registry.kinds()).toEqual(["rail-a", "rail-b"]);
    expect(registry.get("rail-a")).toBe(railA);
    expect(registry.get("missing")).toBeNull();
    expect(registry.requireAdapter("rail-b")).toBe(railB);
    expect(() => registry.requireAdapter("missing")).toThrow("unknown_payment_provider_kind:missing");

    expect(registry.railHandoffKinds("rail-a")).toEqual(["client-confirmed"]);
    expect(registry.railHandoffKinds("rail-b")).toEqual(["redirect"]);
    expect(registry.railHandoffKinds("missing")).toEqual([]);

    expect(registry.methodPort("rail-a")).toBe(railA.methodPort);
    expect(registry.methodPort("rail-b")).toBeNull();
    expect(registry.readbackPorts()).toEqual({ "rail-a": railA.readbackPort, "rail-b": railB.readbackPort });

    const capRegistry = registry.asCapabilityRegistry({
      "rail-b": { payerContext: { requiresPayerBlock: true, customerRefFallsBackToContactEmail: true } },
    });
    expect(capRegistry.kinds()).toEqual(["rail-a", "rail-b"]);
    expect(capRegistry.get("rail-a")?.captureFlows).toEqual([{ kind: "card_flow", handoff: "embedded_client_secret" }]);
    expect(capRegistry.get("rail-b")?.captureFlows).toEqual([{ kind: "code_flow", handoff: "payer_supplied_code" }]);
    expect(capRegistry.get("rail-b")?.payerContext).toEqual({
      requiresPayerBlock: true,
      customerRefFallsBackToContactEmail: true,
    });
    expect(capRegistry.get("missing")).toBeNull();

    const projected = toCorePaymentProviderCapability(railA.capabilities, {
      captureFlows: [{ kind: "custom_setup", handoff: "embedded_client_secret" }],
    });
    expect(projected.captureFlows).toEqual([{ kind: "custom_setup", handoff: "embedded_client_secret" }]);
  });

  it("rejects blank or duplicate provider kinds", () => {
    const adapter = syntheticAdapter("rail-a", []);
    expect(() => createPaymentProviderRegistry([adapter, syntheticAdapter("rail-a", [])]))
      .toThrow("duplicate_payment_provider_kind:rail-a");
    expect(() => createPaymentProviderRegistry([syntheticAdapter("   ", [])]))
      .toThrow("payment_provider_kind_required");
  });
});
