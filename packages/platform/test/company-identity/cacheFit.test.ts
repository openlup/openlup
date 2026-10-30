import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpRequest, HttpResponse } from "../../src/http/index.js";
import { createBffResponder } from "../../src/bff/index.js";
import { __resetCompanyIdentityCaches, createCompanyIdentityLookupHandler } from "../../src/company-identity/server/index.js";

const result = {
  contractVersion: "company_identity.lookup.v1", status: "not_found", verificationLevel: "invalid",
  company: null, sources: [], warnings: ["not_found"],
};
function req(id = " Alpha ", purpose = "checkout_invoice") {
  return { method: "POST", body: { country: "US", identifierKind: "registry", identifierValue: id, purpose } } as HttpRequest;
}
function res() {
  const response = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response); response.json.mockReturnValue(response);
  return response as unknown as HttpResponse;
}
function handler(lookup = vi.fn().mockResolvedValue(result)) {
  return { lookup, run: createCompanyIdentityLookupHandler({ lookupPort: { lookupCompanyIdentity: lookup } }, createBffResponder()) };
}
beforeEach(() => { __resetCompanyIdentityCaches(); vi.useFakeTimers(); vi.setSystemTime("2026-10-29T12:00:00Z"); });
afterEach(() => { vi.useRealTimers(); __resetCompanyIdentityCaches(); });
describe("company cache fit", () => {
  it("shares normalized keys across factories, provider identities and purposes", async () => {
    const first = handler(); const second = handler();
    await first.run(req(), res());
    await second.run(req("alpha", "customer_billing_profile"), res());
    expect(first.lookup).toHaveBeenCalledTimes(1); expect(second.lookup).not.toHaveBeenCalled();
  });
  it("uses UTC day and exact TTL without refreshing on a hit", async () => {
    vi.setSystemTime("2026-10-29T23:59:00Z"); const h = handler();
    await h.run(req(), res()); vi.setSystemTime("2026-10-30T00:00:00Z"); await h.run(req(), res());
    expect(h.lookup).toHaveBeenCalledTimes(2);
    vi.setSystemTime("2026-10-30T00:09:59Z"); await h.run(req(), res());
    vi.setSystemTime("2026-10-30T00:10:00Z"); await h.run(req(), res());
    expect(h.lookup).toHaveBeenCalledTimes(3);
  });
  it("evicts oldest insertion at 5000 without promoting cache hits", async () => {
    const h = handler();
    for (let n = 0; n < 5000; n++) await h.run(req(String(n)), res());
    await h.run(req("0"), res()); await h.run(req("5000"), res());
    await h.run(req("1"), res()); expect(h.lookup).toHaveBeenCalledTimes(5001);
    await h.run(req("0"), res()); expect(h.lookup).toHaveBeenCalledTimes(5002);
  });
  it("retains cache-before-output-validation order", async () => {
    const h = handler(vi.fn().mockResolvedValue({ ...result, diagnostic: "invalid" }));
    const a = res(); const b = res(); await h.run(req(), a); await h.run(req(), b);
    expect(h.lookup).toHaveBeenCalledTimes(1);
    expect(a.status).toHaveBeenCalledWith(502); expect(b.status).toHaveBeenCalledWith(502);
  });
});
