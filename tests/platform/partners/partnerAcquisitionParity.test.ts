import { afterEach, describe, expect, it, vi } from "vitest";
import * as packaged from "@openlup/platform/marketing";
import * as reference from "../../../src/domains/partners/contracts.js";
import { privateLabelSchema } from "../../../src/components/private-label/privateLabelFormModel.js";
import { createPartnerInquiryIdempotencyKey, submitPublicB2BInquiry } from "../../../src/domains/partners/publicB2BInquiryClient.js";

const form = { company: " North  Studio ", country: "GB", firstName: " Ada ", lastName: " Vale ",
  email: "ada@studio.example", phone: "+44 (20) 1234 5678", notes: " Distinct sample note " };
const schemas = ["partnersB2BInquirySubmitRequestSchema", "partnersB2BInquirySubmitResponseSchema", "partnerAcquisitionCaseSchema",
  "partnerAcquisitionListRequestSchema", "partnerAcquisitionListResponseSchema", "partnerAcquisitionTransitionRequestSchema",
  "partnerAcquisitionTransitionResponseSchema", "partnerAcquisitionIdempotencyKeySchema"] as const;
const projection = { contractVersion: "partner_acquisition_v1", caseRef: "acquisition-case:11111111-1111-4111-8111-111111111111",
  contactRef: "acquisition-contact:22222222-2222-4222-8222-222222222222", organization: { name: "North Studio", country: "GB" },
  contact: { firstName: "Ada", lastName: "Vale", email: "ada@studio.example", phone: null }, notes: null, status: "new", version: 1,
  createdAt: "2026-01-12T10:00:00.000Z", updatedAt: "2026-01-12T10:00:00.000Z" };

afterEach(() => vi.unstubAllGlobals());
describe("R1 partner public-source parity and actual producer fit", () => {
  it("freezes public counterpart admission and parsed values side by side", () => {
    const values: unknown[] = [null, {}, [], "invalid", form, privateLabelSchema.parse(form), projection,
      { ...projection, customerId: "not-part-of-projection" }, { ...form, openlupInternalCheck: "silent" },
      { ...form, unknownInternalCheck: "silent" }, { ...form, country: "OTHER", phone: "0123456789" },
      { success: true }, { success: true, skipped: "internal-check" }, { view: "partner_acquisition_v1" },
      { view: "partner_acquisition_v1", limit: "3" }, { view: "partner_acquisition_v1", limit: 101 },
      { contractVersion: "partner_acquisition_v1", cases: [projection], nextCursor: null },
      { id: projection.caseRef, status: "closed_won", expectedVersion: "2" },
      { id: projection.caseRef, status: "new", expectedVersion: 1 }, { updated: true, acquisitionCase: projection, replayed: false },
      "partner-key-1234", "short"];
    for (const name of schemas) for (const value of values) {
      const expected = reference[name].safeParse(value), actual = packaged[name].safeParse(value);
      expect(actual.success, `${name}: ${JSON.stringify(value)}`).toBe(expected.success);
      if (actual.success && expected.success) expect(actual.data).toEqual(expected.data);
    }
    expect(packaged.PARTNER_ACQUISITION_VIEW).toBe(reference.PARTNER_ACQUISITION_VIEW);
    expect(packaged.PARTNER_ACQUISITION_CONTRACT_VERSION).toBe(reference.PARTNER_ACQUISITION_CONTRACT_VERSION);
  });
  it("sends the actual form model's seven output fields through the actual BFF client and both schemas", async () => {
    const request = privateLabelSchema.parse(form);
    expect(Object.keys(request).sort()).toEqual(["company", "country", "email", "firstName", "lastName", "notes", "phone"]);
    const key = createPartnerInquiryIdempotencyKey();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue({ status: 200, json: async () => ({ ok: true, data: { success: true, id: projection.caseRef } }) } as Response);
    await submitPublicB2BInquiry(request, { fetcher, headers: { "Idempotency-Key": key } });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/bff/partners/b2b-inquiries"); expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe(key);
    const payload = JSON.parse(String(init.body));
    expect(payload).toEqual({ company: "North Studio", country: "GB", firstName: "Ada", lastName: "Vale",
      email: "ada@studio.example", phone: "+44 (20) 1234 5678", notes: "Distinct sample note" });
    expect(packaged.partnersB2BInquirySubmitRequestSchema.parse(payload)).toEqual(reference.partnersB2BInquirySubmitRequestSchema.parse(payload));
    expect(packaged.partnerAcquisitionIdempotencyKeySchema.parse(key)).toBe(key);
    for (const delta of [{ country: "OTHER" }, { phone: "0123456789" }]) {
      const produced = privateLabelSchema.parse({ ...form, ...delta });
      expect(packaged.partnersB2BInquirySubmitRequestSchema.safeParse(produced).success).toBe(true);
    }
  });
  it("keeps an explicit sentinel seam and the existing browser key fallback", () => {
    const sentinel = { ...privateLabelSchema.parse(form), openlupInternalCheck: "silent" };
    expect(packaged.partnersB2BInquirySubmitRequestSchema.parse(sentinel)).toEqual(reference.partnersB2BInquirySubmitRequestSchema.parse(sentinel));
    // A host with another sentinel spelling must map it explicitly; strict admission never silently drops it.
    expect(packaged.partnersB2BInquirySubmitRequestSchema.safeParse({ ...sentinel, hostInternalCheck: "silent" }).success).toBe(false);
    vi.stubGlobal("crypto", undefined);
    expect(packaged.partnerAcquisitionIdempotencyKeySchema.safeParse(createPartnerInquiryIdempotencyKey()).success).toBe(true);
  });
});
