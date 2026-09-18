import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DueSubscription } from "../../domains/subscription/chargeSubscriptionCycleOffSession.js";
import type {
  PaymentProviderCapabilityDescriptor,
  PaymentProviderCapabilityRegistry,
} from "@openlup/core/payment";
import { createSubscriptionRenewalExecutionPortResolver } from "./subscriptionRenewalExecutionPortResolver.js";

const { mockBuildStripeAdapterIfEnabled, mockBuildTpayAdapterIfEnabled } = vi.hoisted(() => ({
  mockBuildStripeAdapterIfEnabled: vi.fn(),
  mockBuildTpayAdapterIfEnabled: vi.fn(),
}));

vi.mock("../../adapters/stripe/stripeAdapterFactory.js", () => ({
  buildStripeAdapterIfEnabled: mockBuildStripeAdapterIfEnabled,
}));
vi.mock("../../adapters/tpay/tpayAdapterFactory.js", () => ({
  buildTpayAdapterIfEnabled: mockBuildTpayAdapterIfEnabled,
}));

// The resolver reads the injected registry, so the rails are stated here as
// capabilities. The real descriptors live in the adapters and are held to them
// by that suite's conformance matrix.
const capabilityRegistry = (
  published: Record<string, string | null>,
): PaymentProviderCapabilityRegistry => ({
  get: (providerKind) => providerKind in published
    ? {
      providerKind,
      methodHealth: { requiredMethodKind: published[providerKind] },
    } as PaymentProviderCapabilityDescriptor
    : null,
  kinds: () => Object.keys(published),
});
const publishedCapabilities = capabilityRegistry({ stripe: null, tpay: "blik_payid" });
const resolverFor = (capabilities = publishedCapabilities) =>
  createSubscriptionRenewalExecutionPortResolver({}, capabilities);

describe("subscription renewal execution-port resolver", () => {
  beforeEach(() => {
    mockBuildStripeAdapterIfEnabled.mockReset();
    mockBuildTpayAdapterIfEnabled.mockReset();
  });

  it("lazily maps each supported provider once and reuses its port", () => {
    const stripePort = { execute: vi.fn() };
    const tpayPort = { execute: vi.fn() };
    mockBuildStripeAdapterIfEnabled.mockReturnValue({ adapter: stripePort, mode: "sandbox" });
    mockBuildTpayAdapterIfEnabled.mockReturnValue({ adapter: tpayPort, mode: "simulator" });
    const resolve = resolverFor();

    expect(resolve(due("stripe"))).toEqual({ port: stripePort, reason: null });
    expect(resolve(due("stripe"))).toEqual({ port: stripePort, reason: null });
    expect(mockBuildTpayAdapterIfEnabled).not.toHaveBeenCalled();
    expect(resolve(due("tpay", "blik_payid"))).toEqual({ port: tpayPort, reason: null });
    expect(resolve(due("tpay", "blik_payid"))).toEqual({ port: tpayPort, reason: null });

    expect(mockBuildStripeAdapterIfEnabled).toHaveBeenCalledTimes(1);
    expect(mockBuildTpayAdapterIfEnabled).toHaveBeenCalledTimes(1);
  });

  it("caches disabled adapters only for one invocation-local resolver", () => {
    mockBuildStripeAdapterIfEnabled.mockReturnValue(null);
    const firstInvocation = resolverFor();

    expect(firstInvocation(due("stripe"))).toEqual({ port: null, reason: "stripe_provider_not_configured" });
    expect(firstInvocation(due("stripe"))).toEqual({ port: null, reason: "stripe_provider_not_configured" });

    const nextInvocation = resolverFor();
    expect(nextInvocation(due("stripe"))).toEqual({ port: null, reason: "stripe_provider_not_configured" });
    expect(mockBuildStripeAdapterIfEnabled).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid Tpay rails before provider construction and maps unsupported providers", () => {
    const resolve = resolverFor();

    expect(resolve(due("tpay", "card"))).toEqual({ port: null, reason: "tpay_recurring_requires_blik_payid" });
    expect(resolve(due("tpay", "bank_transfer"))).toEqual({ port: null, reason: "tpay_recurring_requires_blik_payid" });
    expect(resolve(due("legacy_psp"))).toEqual({ port: null, reason: "subscription_provider_not_supported" });
    expect(mockBuildTpayAdapterIfEnabled).not.toHaveBeenCalled();
  });

  it("takes the stored-method precheck from the published capability, not from the provider name", async () => {
    // Same row, same provider name, different capability: a rail that expects no
    // particular stored-method kind admits the row the mandate rail refuses.
    // Nothing here would move if the rule still lived in a name comparison.
    const tpayPort = { execute: vi.fn() };
    mockBuildTpayAdapterIfEnabled.mockReturnValue({ adapter: tpayPort, mode: "simulator" });

    expect(resolverFor()(due("tpay", "card"))).toEqual({ port: null, reason: "tpay_recurring_requires_blik_payid" });
    expect(resolverFor(capabilityRegistry({ tpay: null }))(due("tpay", "card")))
      .toEqual({ port: tpayPort, reason: null });
  });

  it("fails closed for a kind this deployment publishes without an adapter factory", () => {
    // A capability with no local factory is not a chargeable rail: resolving it
    // would hand renewal a port it never built.
    expect(resolverFor(capabilityRegistry({ future_rail: null }))(due("future_rail")))
      .toEqual({ port: null, reason: "subscription_provider_not_supported" });
    expect(mockBuildStripeAdapterIfEnabled).not.toHaveBeenCalled();
    expect(mockBuildTpayAdapterIfEnabled).not.toHaveBeenCalled();
  });
});

function due(providerKind: string, methodKind = "card"): DueSubscription {
  return { providerKind, methodKind } as DueSubscription;
}
