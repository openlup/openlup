import { expect, it } from "vitest";
import { createNativeUnsupportedInvoicePorts, runInvoiceAdapterConformance } from "../../src/invoicing/index.js";
import type { InvoiceCapabilities, InvoiceFacts, InvoiceIdentity, InvoiceWriteResult, InvoiceReadbackResult, InvoiceServicesOptions } from "../../src/invoicing/contracts/index.js";

type Subject = Parameters<typeof runInvoiceAdapterConformance>[0][number];
type Provider = NonNullable<InvoiceServicesOptions["provider"]>;
const proof = { evidenceRef: "proof-a", fingerprint: "fingerprint-a", observedAt: "2026-10-22T12:00:00Z" };
const refusal = { kind: "unsupported", code: "host_binding_required", retryable: false, effectMayHaveSucceeded: false } as const;
const identity = { providerRef: "fiscal-a", requestKey: " original:key ", providerCreateIdentity: "create-a", factRevision: "revision-a", orderRef: "order-a", invoiceRef: "invoice-a", operation: "issue", correctionRef: null, parentProviderDocumentRef: null } as const satisfies InvoiceIdentity;
const facts: InvoiceFacts = { factRevision: identity.factRevision, policyVersion: "policy-a", refs: { orderId: "order-a", orderRef: identity.orderRef, invoiceRef: identity.invoiceRef }, dates: { issueDate: "2026-10-22", sellDate: "2026-10-22", handedOverAt: null, paymentCompletedAt: proof.observedAt }, documentKind: "host-document", clearanceRequired: false, currency: "XXX", buyer: { name: "Synthetic buyer", email: "synthetic-private", taxIdentifier: null, companyName: null, address: null }, payment: { intentRef: "intent-a", providerRef: "money-a", providerPaymentRef: null, amountMinor: 120, currency: "XXX", localSettlementState: "unavailable" }, orderMoney: null, lines: [{ description: "Example", quantity: 1, unitNetMinor: 100, unitGrossMinor: 120, totalNetMinor: 100, totalTaxMinor: 20, totalGrossMinor: 120, taxRateBps: 2000, positionKind: null, catalogTotalGrossMinor: null, discountAllocatedMinor: null, shippingGrossMinor: null, shippingDiscountMinor: null }], totalNetMinor: 100, totalTaxMinor: 20, totalGrossMinor: 120, chargedTotalGrossMinor: 120 };
const issue = { identity, facts, recoveryLookupRequired: false } as const;
const correction = { identity: { ...identity, operation: "full_reversal", correctionRef: "correction-a", providerCreateIdentity: "create-correction-a", parentProviderDocumentRef: "external-a" }, before: facts, after: { totalNetMinor: 0, totalTaxMinor: 0, totalGrossMinor: 0 }, reason: "order_refunded", recoveryLookupRequired: false } as const;
const voidInput = { ...identity, operation: "remote_void" } as const;
const capability: InvoiceCapabilities = { version: "invoicing.capabilities.v1", providerRef: identity.providerRef, fiscalScope: { scopeRef: "host-scope", version: "v1" }, policies: { identifierRef: "id-v1", taxRef: "tax-v1", roundingRef: "round-v1" }, documentKinds: [facts.documentKind], correctionKinds: ["full_reversal"], numberingOwner: "provider", sellerTiming: "execution", defaultOff: true,
  operations: { issue: { supported: true }, correction: { supported: true }, recovery: { supported: true }, readback: { supported: true }, exactAbsence: { supported: true }, remoteVoid: { supported: false, reason: "not_implemented" }, artifact: { supported: false, reason: "host_required" }, clearance: { supported: false, reason: "host_required" }, settlement: { supported: false, reason: "host_required" }, companyLookup: { supported: false, reason: "host_required" } } };

function fixture(): Subject {
  let writes = 0;
  const existing = new Map<string, Extract<InvoiceWriteResult, { kind: "issued" }>>();
  const issued = (input: InvoiceIdentity, providerDocumentRef: string) => ({ kind: "issued", identity: input, providerDocumentRef, providerDocumentNumber: null, proof, replayed: false } as const);
  const read = (input: InvoiceIdentity): InvoiceReadbackResult => input.invoiceRef === "absent"
    ? { kind: "absent", identity: input, evidence: { ...proof, exact: true, complete: true, scope: input } }
    : input.invoiceRef === "unknown" ? { kind: "unknown", identity: input, code: "unknown" }
      : { kind: "found", identity: input, providerDocumentRef: "external-a", providerDocumentNumber: null, proof };
  const provider: Provider = {
    async issue(input) {
      const previous = existing.get(input.identity.providerCreateIdentity);
      if (previous) return { ...previous, replayed: true };
      writes++; const result = issued(input.identity, "external-a"); existing.set(input.identity.providerCreateIdentity, result); return result;
    },
    async correct(input) {
      const previous = existing.get(input.identity.providerCreateIdentity);
      if (previous && previous.identity.parentProviderDocumentRef !== input.identity.parentProviderDocumentRef) return { kind: "refused", identity: input.identity, code: "parent_mismatch", retryable: false, effectMayHaveSucceeded: false };
      if (previous) return { ...previous, replayed: true };
      writes++; const result = issued(input.identity, "external-correction-a"); existing.set(input.identity.providerCreateIdentity, result); return result;
    },
    async read(input) { return read(input); }, async void() { return refusal; },
  };
  const mismatch = { ...correction, identity: { ...correction.identity, parentProviderDocumentRef: "wrong-parent" }, recoveryLookupRequired: true };
  return { subjectId: "offline-bridge", capability, provider, readWriteCount: () => writes, sensitiveValues: ["synthetic-private"], fixtures: {
    issue: [{ input: issue, expected: issued(identity, "external-a"), replay: true }],
    correction: [{ input: correction, expected: issued(correction.identity, "external-correction-a"), replay: true }, { input: mismatch, expected: { kind: "refused", identity: mismatch.identity, code: "parent_mismatch", retryable: false, effectMayHaveSucceeded: false } }],
    readback: [identity, { ...identity, invoiceRef: "absent" }, { ...identity, invoiceRef: "unknown" }].map(input => ({ input, expected: read(input) })),
    void: [{ input: voidInput, expected: refusal }],
  } };
}

it("native host/provider/store seams refuse without inspecting input or making a partial write", async () => {
  const ports = createNativeUnsupportedInvoicePorts();
  let touches = 0, calls = 0;
  const input = new Proxy({}, { get() { touches++; throw new Error("input must remain untouched"); }, ownKeys() { touches++; throw new Error("input must remain untouched"); } });
  async function exercise(value: object): Promise<void> {
    for (const member of Object.values(value)) {
      if (typeof member === "function") { calls++; expect(await member(input)).toEqual(refusal); }
      else await exercise(member);
    }
  }
  await exercise(ports);
  expect(calls).toBe(36);
  expect(touches).toBe(0);
});

it("proves issue/correction lost-ACK recovery, parent refusal, four-way readback and default-off offline", async () => {
  const positive = fixture(), native = createNativeUnsupportedInvoicePorts();
  const unsupported: Subject = { subjectId: "native-unsupported", capability: { ...capability, operations: { ...Object.fromEntries(Object.keys(capability.operations).map(key => [key, { supported: false, reason: "host_required" }])), remoteVoid: capability.operations.remoteVoid } as InvoiceCapabilities["operations"] }, provider: native.provider, readWriteCount: () => 0, sensitiveValues: [], fixtures: { issue: [{ input: issue, expected: refusal }], correction: [{ input: correction, expected: refusal }], readback: [{ input: identity, expected: refusal }], void: [{ input: voidInput, expected: refusal }] } };
  const evidence = await runInvoiceAdapterConformance([positive, unsupported]);
  expect(positive.readWriteCount()).toBe(2);
  expect(evidence.subjects[0].cases).toContain("correction:issued:recovery");
  expect(evidence.subjects[0].cases).toContain("correction:refused");
  expect(evidence.subjects[0].cases).toContain("read:unknown");
  expect(evidence.subjects[1].cases).toContain("read:unsupported");
  expect(JSON.stringify(evidence)).not.toContain("synthetic-private");
});

it("rejects mismatched parent recovery, incomplete/scopeless absence, leaked diagnostics and adapter errors", async () => {
  const changes: ((subject: Subject) => void)[] = [
    subject => { const original = subject.provider.correct; subject.provider.correct = async input => ({ ...await original(input), identity: { ...input.identity, parentProviderDocumentRef: "different-parent" } } as InvoiceWriteResult); },
    subject => { const original = subject.provider.read; subject.provider.read = async input => { const result = await original(input); return result.kind === "absent" ? { ...result, evidence: { ...result.evidence, complete: false } } as unknown as InvoiceReadbackResult : result; }; },
    subject => { const original = subject.provider.read; subject.provider.read = async input => { const result = await original(input); return result.kind === "absent" ? { ...result, evidence: { ...result.evidence, scope: { ...input, requestKey: "other" } } } : result; }; },
    subject => { const original = subject.provider.read; subject.provider.read = async input => input.invoiceRef === "unknown" ? { kind: "absent", identity: input, evidence: { ...proof, exact: true, complete: true, scope: input } } : original(input); },
    subject => { const original = subject.provider.issue; subject.provider.issue = async input => Object.assign(await original(input), { raw: "synthetic-private" }); },
    subject => { subject.provider.issue = async () => { throw new Error("synthetic-private"); }; },
    subject => { Object.assign(subject, { subjectId: "synthetic-private" }); },
    subject => { subject.provider.issue = async input => ({ kind: "refused", identity: input.identity, code: "absent", retryable: false, effectMayHaveSucceeded: false } as unknown as InvoiceWriteResult); },
    subject => { subject.provider.issue = async input => ({ kind: "unknown", identity: input.identity, code: "unknown" } as InvoiceWriteResult); },
    subject => { subject.provider.void = async () => ({ kind: "voided", identity: voidInput, proof } as unknown as Awaited<ReturnType<Provider["void"]>>); },
  ];
  for (const change of changes) {
    const subject = fixture(); change(subject);
    await expect(runInvoiceAdapterConformance([subject])).rejects.toThrow(/^INVOICE_CONFORMANCE:/);

  }
  // Matching adapter/expected bytes must still fail when the runtime union is invalid.
  for (const kind of ["refused", "unknown"] as const) {
    const subject = fixture(), original = subject.provider.issue;
    const input = { ...issue, identity: { ...identity, invoiceRef: "bad-arm" } };
    const invalid = { kind, identity: input.identity, code: kind === "refused" ? "absent" : "unknown", ...(kind === "refused" ? { retryable: false } : {}), effectMayHaveSucceeded: false } as unknown as InvoiceWriteResult;
    subject.provider.issue = async request => request.identity.invoiceRef === "bad-arm" ? invalid : original(request);
    Object.assign(subject.fixtures, { issue: [...subject.fixtures.issue, { input, expected: invalid }] });
    await expect(runInvoiceAdapterConformance([subject])).rejects.toThrow(kind === "refused" ? "INVOICE_CONFORMANCE:refusal_before_write" : "INVOICE_CONFORMANCE:unknown_not_absent");
  }

});

it("checks declared host artifact/clearance/company capabilities and refuses collapsed payout items", async () => {
  function hostSubject(collapse = false): Subject {
    const subject = fixture(), native = createNativeUnsupportedInvoicePorts();
    let writes = 0; const providerWrites = subject.readWriteCount;
    const documentIdentity = { providerRef: identity.providerRef, documentRef: "legacy-document-a", providerDocumentRef: "external-a", orderRef: identity.orderRef, invoiceRef: identity.invoiceRef, parentProviderDocumentRef: null };
    const artifactInput = { identity: documentIdentity, kind: "pdf" } as const;
    const artifact = { kind: "found", identity: documentIdentity, artifact: { kind: "pdf", ref: "object-a", owner: "host_storage", mediaType: "application/pdf", proof } } as const;
    const absentIdentity = { ...documentIdentity, documentRef: "absent" };
    const absent = { kind: "absent", identity: absentIdentity, evidence: { ...proof, exact: true, complete: true, scope: { identity: absentIdentity, kind: "pdf", artifactRef: null } } } as const;
    const unknownIdentity = { ...documentIdentity, documentRef: "unknown" };
    const unknown = { kind: "unknown", identity: unknownIdentity, code: "unknown" } as const;
    const clearance = { kind: "observed", observation: { state: "accepted", reference: "clearance-a", proof } } as const;
    const lookupInput = { identifier: { scheme: "host-tax", value: "company-a" }, asOf: proof.observedAt, sourceRef: "registry-a" };
    const company = { kind: "partial", identifier: lookupInput.identifier, legalName: "Example", registrationIds: [], address: null, taxRegistrations: [{ scheme: "host-tax", status: "not_registered" }], sourceRef: "registry-a", proof } as const;
    const item = { requestKey: "item-key-a", providerRef: "money-a", batchRef: "batch-a", itemRef: "balance-a", providerPaymentRef: "payment-a", paymentIntentRef: null, paymentRef: null, invoiceRef: null, grossMinor: 120, feeMinor: 2, netMinor: 118, currency: "XXX", status: "unmatched", bankReceivedAt: null, proof } as const;
    const items = [item, { ...item, requestKey: "item-key-b", itemRef: "balance-b" }];
    return { ...subject, readWriteCount: () => providerWrites() + writes,
      capability: { ...capability, operations: { ...capability.operations, artifact: { supported: true }, clearance: { supported: true }, settlement: { supported: true }, companyLookup: { supported: true } } },
      host: { ...native.host, artifacts: { ...native.host.artifacts, read: async input => input.identity.documentRef === "absent" ? absent : input.identity.documentRef === "unknown" ? unknown : artifact }, clearance: { observe: async input => input.identity.documentRef === "unknown" ? { kind: "unknown", code: "unknown" } : clearance }, registry: { lookup: async input => input.identifier.value === "missing" ? { kind: "not_found", identifier: input.identifier, sourceRef: input.sourceRef, proof } : input.identifier.value === "unknown" ? { kind: "unknown", sourceRef: input.sourceRef, code: "unknown" } : company }, settlement: { ...native.host.settlement, record: async row => { writes++; return { kind: "recorded", itemRef: row.itemRef, settlementItemRef: collapse ? "one-receipt" : "receipt:" + row.itemRef, replayed: false }; } } },
      fixtures: { ...subject.fixtures, artifact: [{ input: artifactInput, expected: artifact }, { input: { ...artifactInput, identity: absentIdentity }, expected: absent }, { input: { ...artifactInput, identity: unknownIdentity }, expected: unknown }], clearance: [{ input: { identity: documentIdentity, providerDocumentRef: "external-a" }, expected: clearance }, { input: { identity: unknownIdentity, providerDocumentRef: "external-a" }, expected: { kind: "unknown", code: "unknown" } }], companyLookup: [{ input: lookupInput, expected: company }, { input: { ...lookupInput, identifier: { ...lookupInput.identifier, value: "missing" } }, expected: { kind: "not_found", identifier: { ...lookupInput.identifier, value: "missing" }, sourceRef: lookupInput.sourceRef, proof } }, { input: { ...lookupInput, identifier: { ...lookupInput.identifier, value: "unknown" } }, expected: { kind: "unknown", sourceRef: lookupInput.sourceRef, code: "unknown" } }], settlement: items.map(input => ({ input, expected: { kind: "recorded", itemRef: input.itemRef, settlementItemRef: collapse ? "one-receipt" : "receipt:" + input.itemRef, replayed: false } })) },
    };
  }
  const positive = hostSubject();
  expect((await runInvoiceAdapterConformance([positive])).subjects[0].cases).toContain("settlement");
  expect(positive.readWriteCount()).toBe(4);
  await expect(runInvoiceAdapterConformance([hostSubject(true)])).rejects.toThrow("INVOICE_CONFORMANCE:distinct_payout_items");
  for (const defect of ["scope", "incomplete", "old_proof", "old_clearance"] as const) {
    const subject = hostSubject();
    if (!subject.host) throw new Error("host fixture required");
    const original = subject.host.artifacts.read;
    subject.host.artifacts.read = async input => {
      const result = await original(input);
      if (result.kind !== "absent") return result;
      if (defect === "scope") return { ...result, evidence: { ...result.evidence, scope: { ...result.evidence.scope, artifactRef: "unrequested-artifact" } } };
      if (defect === "incomplete") return { ...result, evidence: { ...result.evidence, complete: false } } as unknown as typeof result;
      if (defect === "old_proof") return { kind: "absent", identity: result.identity, proof: result.evidence } as unknown as typeof result;
      return result;
    };
    if (defect === "old_clearance") subject.host.clearance.observe = async () => ({ state: "accepted", reference: "clearance-a", proof } as unknown as Awaited<ReturnType<typeof subject.host.clearance.observe>>);
    await expect(runInvoiceAdapterConformance([subject])).rejects.toThrow(/^INVOICE_CONFORMANCE:/);
  }
  const partial = hostSubject();
  if (!partial.host) throw new Error("host fixture required");
  const record = partial.host.settlement.record;
  partial.host.settlement.record = async row => {
    const result = await record(row); // Count the partial write before refusing.
    return row.itemRef === "balance-b" ? refusal : result;
  };
  Object.assign(partial.fixtures, { settlement: partial.fixtures.settlement?.map((row, index) => index === 1 ? { ...row, expected: refusal } : row) });
  await expect(runInvoiceAdapterConformance([partial])).rejects.toThrow("INVOICE_CONFORMANCE:host_unsupported_write");

});
