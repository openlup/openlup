import { describe, expect, it, vi } from "vitest";
import { createCustomerAccountMutationSchemas, createCustomerAccountMutationHandlers } from "../../src/account-support/index.js";
import { createBffResponder } from "../../src/bff/index.js";
import type { CustomerAccountMutationHandlerDependencies } from "../../src/account-support/index.js";
import type { HttpRequest, HttpResponse } from "../../src/http/index.js";
export const policy = { key: { min: 8, max: 180 }, name: { min: 2, max: 80 }, phone: { callingCode: "99", localDigits: 9 }, correction: { reasonMin: 8, reasonMax: 500, fieldsMax: 20, fieldMax: 80, noteMax: 240 } };
const schemas = createCustomerAccountMutationSchemas(policy);
const clientId = "11111111-1111-4111-8111-111111111111", eventId = "22222222-2222-4222-8222-222222222222";
const profile = { contractVersion: "customer.self_service.v1" as const, profile: { clientId, email: "buyer@example.invalid", firstName: "Ada", lastName: null, phone: null, lifecycleStage: "customer" as const } };
const request = (method: string, body: unknown) => ({ method, body }) as HttpRequest;
function response() { const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn(), end: vi.fn() }; res.status.mockReturnValue(res); return res as unknown as HttpResponse & typeof res; }
function handler(auth: CustomerAccountMutationHandlerDependencies["authenticate"] = async () => ({ ok: true, userId: clientId })) {
  const port = { updateProfile: vi.fn().mockResolvedValue(profile), requestInvoiceCorrection: vi.fn().mockResolvedValue({ contractVersion: "customer.billing.v1", eventId }), readEvents: vi.fn() };
  return { port, ...createCustomerAccountMutationHandlers({ port, authenticate: auth, messages: { authentication: "Authentication failed", profileInvalid: "Invalid profile", correctionInvalid: "Invalid correction", unlinked: "Unlinked account", invoiceMissing: "Missing invoice", invalidResponse: "Invalid response", failed: "Request failed" } }, schemas, createBffResponder()) };
}
describe("account request characterizations", () => {
  it("preserves omitted versus null and collapses empty name/phone fields", () => {
    expect(schemas.profileRequest.parse({ idempotencyKey: "profile-1" })).toEqual({ idempotencyKey: "profile-1" });
    expect(schemas.profileRequest.parse({ idempotencyKey: "profile-1", firstName: "  Ada   Buyer ", lastName: " ", phone: "" })).toEqual({ idempotencyKey: "profile-1", firstName: "Ada Buyer", lastName: null, phone: null });
    expect(schemas.profileRequest.parse({ idempotencyKey: "profile-1", firstName: null })).toEqual({ idempotencyKey: "profile-1", firstName: null });
  });
  it("binds the reference phone extraction without broadening accepted input", () => {
    const reference = createCustomerAccountMutationSchemas({ ...policy, phone: { callingCode: "48", localDigits: 9 } });
    for (const phone of ["500 100 100", "+48 500 100 100", "48500100100", "prefix500100100"]) expect(reference.profileRequest.parse({ idempotencyKey: "profile-1", phone }).phone).toBe("+48500100100");
    for (const phone of ["123", "+44500100100", "0048500100100"]) expect(reference.profileRequest.safeParse({ idempotencyKey: "profile-1", phone }).success).toBe(false);
  });
  it.each([{ email: "change@example.invalid" }, { firstName: "A" }, { lastName: "https://example.invalid" }, { phone: "123" }, { firstName: 1 }])("rejects invalid profile input %j", fields => {
    expect(schemas.profileRequest.safeParse({ idempotencyKey: "profile-1", ...fields }).success).toBe(false);
  });
  it("normalizes correction reason/fields and preserves optional note rules", () => {
    expect(schemas.correctionRequest.parse({ idempotencyKey: " correction-1 ", invoiceId: clientId, reason: " Correct the address ", requestedFields: [" address "], note: null })).toMatchObject({ idempotencyKey: "correction-1", reason: "Correct the address", requestedFields: ["address"], note: null });
    expect(schemas.correctionRequest.safeParse({ idempotencyKey: "correction-1", invoiceId: clientId, reason: "Correct address", note: "" }).success).toBe(false);
  });
});
describe("account mutation HTTP characterizations", () => {
  it.each(["profile", "invoiceCorrection"] as const)("refuses methods and authentication before %s input or storage", async lane => {
    const h = handler(), res = response(); await h[lane](request("GET", {}), res); expect(res.status).toHaveBeenCalledWith(405);
    const denied = handler(async () => ({ ok: false, code: "UNAUTHORIZED", message: "Session required" })), other = response();
    await denied[lane](request(lane === "profile" ? "PATCH" : "POST", {}), other); expect(other.status).toHaveBeenCalledWith(401); expect(denied.port.updateProfile).not.toHaveBeenCalled(); expect(denied.port.requestInvoiceCorrection).not.toHaveBeenCalled();
  });
  it("forwards normalized authenticated profile input and refuses email before storage", async () => {
    const h = handler(), ok = response(), bad = response(); await h.profile(request("PATCH", { idempotencyKey: "profile-1", firstName: " Ada " }), ok);
    expect(h.port.updateProfile).toHaveBeenCalledWith(clientId, { idempotencyKey: "profile-1", firstName: "Ada" }); expect(ok.status).toHaveBeenCalledWith(200);
    await h.profile(request("PATCH", { idempotencyKey: "profile-1", email: "change@example.invalid" }), bad); expect(bad.status).toHaveBeenCalledWith(400); expect(h.port.updateProfile).toHaveBeenCalledTimes(1);
  });
  it("acknowledges correction IDs and maps missing documents and malformed bodies", async () => {
    const h = handler(), input = { idempotencyKey: "correction-1", invoiceId: clientId, reason: "Correct address" }, ok = response();
    await h.invoiceCorrection(request("POST", input), ok); expect(ok.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, data: { contractVersion: "customer.billing.v1", eventId } }));
    h.port.requestInvoiceCorrection.mockResolvedValue(null); const missing = response(); await h.invoiceCorrection(request("POST", input), missing); expect(missing.status).toHaveBeenCalledWith(404);
    const bad = response(); await h.invoiceCorrection(request("POST", {}), bad); expect(bad.status).toHaveBeenCalledWith(400); expect(h.port.requestInvoiceCorrection).toHaveBeenCalledTimes(2);
  });
  it("maps unlinked accounts, invalid responses, authentication and write failures", async () => {
    const h = handler(), input = { idempotencyKey: "profile-1" };
    h.port.updateProfile.mockResolvedValue(null); const absent = response(); await h.profile(request("PATCH", input), absent); expect(absent.status).toHaveBeenCalledWith(403);
    h.port.updateProfile.mockResolvedValue({}); const invalid = response(); await h.profile(request("PATCH", input), invalid); expect(invalid.status).toHaveBeenCalledWith(502);
    h.port.updateProfile.mockRejectedValue(new Error("private diagnostic")); const failed = response(); await h.profile(request("PATCH", input), failed); expect(failed.status).toHaveBeenCalledWith(503);
    const broken = handler(async () => { throw new Error("private authentication"); }), auth = response(); await broken.profile(request("PATCH", input), auth); expect(auth.status).toHaveBeenCalledWith(503); expect(broken.port.updateProfile).not.toHaveBeenCalled();
  });
});
