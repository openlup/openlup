import type { InvoiceIdentity, InvoiceProviderPort, InvoiceReadbackResult } from "./contracts/provider.js";

const identityKeys = ["providerRef", "requestKey", "providerCreateIdentity", "factRevision", "orderRef", "invoiceRef", "operation", "correctionRef", "parentProviderDocumentRef"] as const;
/** Internal validation used by the read model. No nullable lookup shortcut. */
export async function readInvoiceReadback(provider: Pick<InvoiceProviderPort, "read">, identity: InvoiceIdentity): Promise<InvoiceReadbackResult> {
  const unknown = (): InvoiceReadbackResult => ({ kind: "unknown", identity, code: "unknown" });
  try {
    const result = await provider.read(identity);
    if (result.kind === "unsupported") return { kind: "unsupported", code: result.code, retryable: false, effectMayHaveSucceeded: false };
    if (!sameIdentity(identity, result.identity)) return unknown();
    if (result.kind === "found") {
      if (!opaqueReference(result.providerDocumentRef)) return unknown();
      return { kind: "found", identity, providerDocumentRef: result.providerDocumentRef, providerDocumentNumber: result.providerDocumentNumber, proof: { evidenceRef: result.proof.evidenceRef, fingerprint: result.proof.fingerprint, observedAt: result.proof.observedAt } };
    }
    if (result.kind === "absent" && result.evidence.exact === true && result.evidence.complete === true && sameIdentity(identity, result.evidence.scope)) {
      return { kind: "absent", identity, evidence: { evidenceRef: result.evidence.evidenceRef, fingerprint: result.evidence.fingerprint, observedAt: result.evidence.observedAt, exact: true, complete: true, scope: identity } };
    }
    return unknown();
  } catch { return unknown(); }
}
function sameIdentity(a: InvoiceIdentity, b: InvoiceIdentity): boolean {
  return Boolean(b) && identityKeys.every(key => a[key] === b[key]);
}
export function opaqueReference(ref: string): boolean {
  return typeof ref === "string" && ref.trim().length > 0 && !/^(?:https?:|data:|blob:|\/\/)/i.test(ref.trim());
}
