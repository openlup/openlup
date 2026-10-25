import { describe, expect, it } from "vitest";
import { CommerceRuntimeConflictError } from "../../src/commerce/index.js";
import { createCheckoutStartRuntimeFailure, CheckoutOrchestrationError } from "../../src/commerce/server/index.js";
describe("start-runtime compensation authority", () => {
  const provider = new CheckoutOrchestrationError("uncertain", null, "provider_attempt_in_flight");
  const map = createCheckoutStartRuntimeFailure({ checkoutProviderAttemptFailure: error => error === provider ? provider : null, prepareConflictReason: "prepared_conflict" }).mapStartRuntimeFailure;
  it.each([
    [provider, null, "provider_attempt_in_flight"],
    [new CommerceRuntimeConflictError("changed", { reason: "prepared_conflict" }), null, "provider_attempt_in_flight"],
    [new CommerceRuntimeConflictError("changed", { reason: "acquisition_terms_changed" }), "draft-a", "acquisition_terms_changed"],
    [new CommerceRuntimeConflictError("consumed", { reason: "journey_consumed" }), "draft-a", "journey_consumed"],
    [{ details: { code: "55P03", reason: "inventory_admission_busy" } }, null, "inventory_admission_busy"],
    [{ details: { code: "55P03", reason: "inventory_lock_unavailable" } }, null, "inventory_admission_busy"],
    [{ code: "55P03" }, "draft-a", null],
    [new Error("unrelated"), "draft-a", null],
  ])("preserves the capability/refusal of %s", (error, orderIdForCompensation, reason) => { expect(map(error, "draft-a")).toMatchObject({ orderIdForCompensation, reason }); });
  it("preserves the mapped provider failure's nominal identity", () => { expect(map(provider, "draft-a")).toBe(provider); });
});
