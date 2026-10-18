import { z } from "@/lib/validation/zod";
import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import { privacyExportRequestSchema, privacyEraseRequestSchema, privacyExportResponseSchema, privacyEraseResponseSchema, type PrivacySubjectRef, type PrivacyEraseRequest, type PrivacyExport, type ErasureReceipt } from "@openlup/platform/identity/contracts";
function options(token: string, body: unknown, extra: BffRequestOptions): BffRequestOptions {
  const headers = new Headers(extra.headers); headers.set("Authorization", `Bearer ${token}`);
  return { ...extra, method: "POST", cache: "no-store", headers, body };
}
export function exportIdentityPersonalData(token: string, subject: PrivacySubjectRef, extra: BffRequestOptions = {}) {
  return requestBff("/api/bff/admin/identity/privacy/export", z.custom<PrivacyExport>(value => privacyExportResponseSchema.safeParse(value).success), options(token, privacyExportRequestSchema.parse({ subject }), extra));
}
export function eraseIdentityPersonalData(token: string, input: PrivacyEraseRequest, extra: BffRequestOptions = {}) {
  return requestBff("/api/bff/admin/identity/privacy/erase", z.custom<ErasureReceipt>(value => privacyEraseResponseSchema.safeParse(value).success), options(token, privacyEraseRequestSchema.parse(input), extra));
}
