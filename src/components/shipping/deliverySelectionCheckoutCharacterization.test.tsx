/** @vitest-environment jsdom */
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDeliverySelection } from "@/domains/shipping/useDeliverySelection";
import { buildCheckoutIntent } from "@/checkout/machine/buildCheckoutIntent";
import { defaultConfiguratorFormData, type ConfiguratorFormData } from "@/checkout/composer/configuratorFormStore";
import { COMMERCE_RECOMMENDATION_VERSION } from "@/domains/commerce/recommendationEngine";
import { OMNIPACK_DELIVERY_OPTIONS, deliveryOptionSchema, pickupPointAddressSchema } from "@/domains/shipping/deliverySelectionContracts";

const { getDeliveryOptions } = vi.hoisted(() => ({ getDeliveryOptions: vi.fn() }));
vi.mock("@/domains/shipping/deliverySelectionClient", () => ({ getDeliveryOptions }));
const country = pickupPointAddressSchema.shape.country.value;
const providerKind = OMNIPACK_DELIVERY_OPTIONS[0].providerKind;
const options = OMNIPACK_DELIVERY_OPTIONS.map(o => deliveryOptionSchema.parse(o));
function form(): ConfiguratorFormData {
  return { ...defaultConfiguratorFormData, dogName: "Example", dogBreed: "mixed", dogWeightKg: "12", dogAge: "adult",
    activityLevel: "normal", bcs: "ideal", flavors: ["alpha"], lengthDays: 28, subscription: true,
    firstName: "Example", lastName: "Buyer", email: "buyer@example.invalid", phone: "test-contact",
    street: "Example 1", postalCode: "00-001", city: "Warszawa", gdprConsent: true, termsConsent: true,
    paymentMethod: "card", recommendationSnapshot: { version: COMMERCE_RECOMMENDATION_VERSION, status: "ready_to_buy",
      reasonCodes: [], energy: { policyVersion: "example.v1", source: "example", ageBand: "adult", activityLevel: "normal", bcs: "ideal",
        kcalPerKgBodyWeight075: 100, dailyKcal: 500, dailyGrams: 400 }, dailyKcal: 500, dailyGrams: 400,
      totalWeightG: 8400, feedingDays: 21, desiredSizeKind: "unit_count", cadenceDays: 28,
      lines: [{ variantId: "variant-a", sku: "A", slug: "alpha", qty: 21, netWeightG: 400, kcalPerUnit: 500, allergenSlugs: [] }],
      allergenConflicts: [], excludedProducts: [], allergenOverrideRecorded: false } };
}
function mount(initial: ConfiguratorFormData) {
  let data = initial;
  const update = vi.fn((patch: Partial<ConfiguratorFormData>) => { data = { ...data, ...patch }; });
  const hook = renderHook(() => useDeliverySelection({ enabled: true, data, update }));
  return { hook, update, data: () => data };
}
const intent = (data: ConfiguratorFormData) => buildCheckoutIntent(data, { knownCompositionSlugs: ["alpha"],
  idempotencyKey: "checkout-original", subscriptionCheckoutEnabled: true, deliverySelectionEnabled: true });
afterEach(() => { cleanup(); getDeliveryOptions.mockReset(); localStorage.clear(); sessionStorage.clear(); });

describe("W8 restored delivery option → fresh checkout intent", () => {
  it("resolves a saved ID from fresh options and carries exact codes, address and contact with unchanged cadence", async () => {
    const courier = options.find(o => o.carrierKind === "dpd")!;
    const fresh = { ...courier, carrierCode: "FRESH_CODE", serviceCode: "FRESH_SERVICE" };
    getDeliveryOptions.mockResolvedValue({ options: [fresh] });
    const f = mount({ ...form(), pendingDeliveryOptionId: courier.id, selectedDeliveryOption: null });
    await waitFor(() => expect(f.data().selectedDeliveryOption).toEqual(fresh));
    expect(f.data().pendingDeliveryOptionId).toBeNull();
    expect(intent(f.data())).toMatchObject({ mode: "subscription", cadenceDays: 28, contact: { phone: "test-contact" },
      address: { street: "Example 1", postalCode: "00-001", city: "Warszawa", country },
      selectedDelivery: { carrierCode: "FRESH_CODE", serviceCode: "FRESH_SERVICE", providerKind, pickupPoint: null } });
  });
  it("drops a withdrawn restore marker and retains the current legacy courier fallback", async () => {
    getDeliveryOptions.mockResolvedValue({ options });
    const f = mount({ ...form(), pendingDeliveryOptionId: "withdrawn", selectedDeliveryOption: null, deliveryMethod: "courier" });
    await waitFor(() => expect(f.data().pendingDeliveryOptionId).toBeNull());
    expect(f.data().selectedDeliveryOption).toBeNull();
    expect(intent(f.data())).toMatchObject({ selectedDelivery: { carrierCode: "DPD_COURIER_STANDARD", serviceCode: "DPD_COURIER_STANDARD" } });
  });
  it("requires a point for a restored locker and carries canonical point evidence into the intent", async () => {
    const locker = options.find(o => o.pickupPointRequired)!;
    getDeliveryOptions.mockResolvedValue({ options: [locker] });
    const f = mount({ ...form(), pendingDeliveryOptionId: locker.id, selectedDeliveryOption: null, selectedPickupPoint: null });
    await waitFor(() => expect(f.data().selectedDeliveryOption).toEqual(locker));
    expect(intent(f.data())).toBeNull();
    const point = { id: "TEST01", provider: "inpost" as const, name: "Example point", address: { line1: "Point 2", postalCode: "00-001", city: "Warszawa", country } };
    expect(intent({ ...f.data(), selectedPickupPoint: point })).toMatchObject({ cadenceDays: 28,
      selectedDelivery: { providerRef: "TEST01", pickupPoint: point, serviceCode: locker.serviceCode } });
  });
  it("clears failed dictionary selection while preserving manually entered destination and subscription choice", async () => {
    getDeliveryOptions.mockRejectedValue(new Error("offline"));
    const f = mount({ ...form(), selectedDeliveryOption: options[0]! });
    await waitFor(() => expect(f.hook.result.current.deliveryOptionsLoading).toBe(false));
    expect(f.data()).toMatchObject({ selectedDeliveryOption: null, selectedPickupPoint: null, street: "Example 1", subscription: true, lengthDays: 28 });
  });
});
