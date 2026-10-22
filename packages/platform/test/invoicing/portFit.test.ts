import { expect, expectTypeOf, it } from "vitest";
import type { InvoiceFacts, InvoiceLine, InvoiceBuyer, InvoiceSeller, InvoiceIdentity, InvoiceReadbackResult, InvoiceWriteResult, InvoiceCompanyLookupPort, InvoiceHostPorts, InvoiceServicesOptions, InvoiceStorePort } from "../../src/invoicing/contracts/index.js";

// Synthetic translation of providerPorts/LocalInvoiceSnapshot and the canonical
// position carrier. No live adapter, jurisdiction, config or upstream reread.
const seller: InvoiceSeller = { name: "Example seller", address: { line1: "Example 1", postalCode: "00000", city: "Example" }, taxIdentifier: { scheme: "host-tax", value: "seller-a" }, registrationIds: [{ scheme: "host-registry", value: "registration-a" }], bankAccount: null, routingRef: "department-a" };
const buyer: InvoiceBuyer = { name: "Example buyer", email: null, taxIdentifier: null, companyName: null, address: { line1: null, postalCode: null, city: null, country: null } };
const line: InvoiceLine = { description: "Example item", quantity: 1, quantityUnit: "unit", unitNetMinor: 100, unitGrossMinor: 120, totalNetMinor: 100, totalTaxMinor: 20, totalGrossMinor: 120, taxRateBps: 2000, taxRateLabel: "20", positionKind: "item", catalogTotalGrossMinor: 130, discountAllocatedMinor: 10, shippingGrossMinor: null, shippingDiscountMinor: null };
const facts: InvoiceFacts = { factRevision: "facts-a", policyVersion: "policy-a", refs: { orderId: "order-a", orderRef: "order-ref-a", invoiceRef: "invoice-a" }, dates: { issueDate: "2026-10-22", sellDate: "2026-10-22", handedOverAt: null, paymentCompletedAt: "2026-10-22T12:00:00Z" }, documentKind: "host-document", clearanceRequired: false, currency: "XXX", buyer, seller, payment: { intentRef: "intent-a", providerRef: "money-a", providerPaymentRef: null, amountMinor: 120, localSettlementState: "unavailable" }, orderMoney: { subtotalMinor: 130, discountMinor: 10, shippingMinor: 0, shippingDiscountMinor: 0, totalMinor: 120 }, lines: [line], totalNetMinor: 100, totalTaxMinor: 20, totalGrossMinor: 120, chargedTotalGrossMinor: 120 };
const identity = { providerRef: "fiscal-a", requestKey: " exact:key ", providerCreateIdentity: "invoicing:duty-a", factRevision: facts.factRevision, orderRef: facts.refs.orderRef, invoiceRef: facts.refs.invoiceRef, operation: "issue", correctionRef: null, parentProviderDocumentRef: null } as const satisfies InvoiceIdentity;
const proof = { evidenceRef: "evidence-a", fingerprint: "fingerprint-a", observedAt: "2026-10-22T12:01:00Z" };

it("fits issue/correction recovery and all four readback results without discarding parent, revision or key bytes", async () => {
  type Provider = NonNullable<InvoiceServicesOptions["provider"]>;
  const trace: unknown[] = [];
  const provider: Provider = {
    async issue(input) { trace.push(input); return { kind: "issued", identity: input.identity, providerDocumentRef: "external-a", providerDocumentNumber: null, proof, replayed: false }; },
    async correct(input) { trace.push(input); return { kind: "unknown", identity: input.identity, code: "unknown", effectMayHaveSucceeded: true }; },
    async read(input) { return { kind: "absent", identity: input, evidence: { ...proof, exact: true, complete: true, scope: input } }; },
    async void() { return { kind: "unsupported", code: "unsupported", retryable: false, effectMayHaveSucceeded: false }; },
  };
  const issued: InvoiceWriteResult = await provider.issue({ identity, facts, recoveryLookupRequired: false });
  expect(issued).toMatchObject({ kind: "issued", providerDocumentNumber: null });
  const correction = { identity: { ...identity, operation: "full_reversal", providerCreateIdentity: "invoicing:correction-duty-a", correctionRef: "correction-a", parentProviderDocumentRef: "external-a" }, before: facts, after: { totalNetMinor: 0, totalTaxMinor: 0, totalGrossMinor: 0 }, reason: "order_refunded", recoveryLookupRequired: true } as const;
  expect(await provider.correct(correction)).toMatchObject({ kind: "unknown", effectMayHaveSucceeded: true });
  expect(trace).toEqual([{ identity, facts, recoveryLookupRequired: false }, correction]);
  expect(identity.requestKey).toBe(" exact:key ");
  const legacy: InvoiceFacts = { ...facts, orderMoney: null, lines: [{ ...line, positionKind: null, catalogTotalGrossMinor: null, discountAllocatedMinor: null }] };
  expect(legacy.lines[0].positionKind).toBeNull();
  expect(legacy.orderMoney).toBeNull();
  const results: InvoiceReadbackResult[] = [await provider.read(identity), { kind: "found", identity, providerDocumentRef: "external-a", providerDocumentNumber: null, proof }, { kind: "unknown", identity, code: "unknown" }, { kind: "unsupported", code: "unsupported", retryable: false, effectMayHaveSucceeded: false }];
  expect(results.map(result => result.kind)).toEqual(["absent", "found", "unknown", "unsupported"]);
  expectTypeOf<Parameters<InvoiceStorePort["claim"]>[0]["orderId"]>().toEqualTypeOf<string | null | undefined>();
});

it("fits A5 provenance, explicit suppression/skip, distinct payout items and safe owned history", async () => {
  const registry: InvoiceCompanyLookupPort = { async lookup(input) { return { kind: "partial", identifier: input.identifier, legalName: "Example company", registrationIds: [], address: null, taxRegistrations: [{ scheme: "host-tax", status: "not_registered" }], sourceRef: input.sourceRef, proof }; } };
  const company = await registry.lookup({ identifier: { scheme: "host-tax", value: "company-a", country: "XX" }, asOf: proof.observedAt, sourceRef: "registry-a" });
  expect(company).toMatchObject({ kind: "partial", sourceRef: "registry-a", proof });
  const deliveryInput: Parameters<InvoiceHostPorts["delivery"]["send"]>[0] = { deliveryRef: "outbox-a", requestKey: " exact:delivery-key ", attemptCount: 2, documentRef: "document-a", orderId: "order-a", orderRef: "order-ref-a", invoiceRef: "invoice-ref-a", providerDocumentRef: "external-a", clientRef: null, recipient: "buyer@example.invalid", source: null, providerDocumentNumber: null, filename: "invoice.pdf", content: new Uint8Array([37, 80, 68, 70]), contentType: "application/pdf" };
  let deliveredInput: typeof deliveryInput | undefined;
  const delivery: InvoiceHostPorts["delivery"] = { async send(input) { deliveredInput = input; return { kind: "uncertain", code: "uncertain_delivery", receiptRef: "message-a" }; } };
  const deliveryResult = await delivery.send(deliveryInput);
  expect(deliveredInput).toEqual(deliveryInput);
  expect(deliveryResult).toEqual({ kind: "uncertain", code: "uncertain_delivery", receiptRef: "message-a" });
  expectTypeOf<Extract<Awaited<ReturnType<typeof delivery.send>>, { kind: "uncertain" }>["receiptRef"]>().toEqualTypeOf<string | null>();
  type Policy = Exclude<Awaited<ReturnType<InvoiceHostPorts["policy"]["decide"]>>, { kind: "unsupported" }>;
  const receipts: Policy[] = [{ kind: "issue", policyVersion: "v1" }, { kind: "policy_suppressed", outcome: "channel_issues", policyVersion: "v1", requestKey: "key-a" }, { kind: "policy_suppressed", outcome: "no_document", policyVersion: "v1", requestKey: "key-b" }, { kind: "operator_skipped", outcome: "operator_skip", actorRef: "operator-a", reason: "approved skip", requestKey: "key-c" }];
  expect(receipts.map(receipt => receipt.kind)).toEqual(["issue", "policy_suppressed", "policy_suppressed", "operator_skipped"]);
  type Item = Parameters<InvoiceHostPorts["settlement"]["record"]>[0];
  const item: Item = { requestKey: "item-key-a", providerRef: "money-a", batchRef: "batch-a", itemRef: "balance-a", providerPaymentRef: "payment-a", paymentIntentRef: null, paymentRef: null, invoiceRef: null, grossMinor: 120, feeMinor: 2, netMinor: 118, currency: "XXX", status: "unmatched", bankReceivedAt: null, proof };
  const items: Item[] = [item, { ...item, requestKey: "item-key-b", itemRef: "balance-b" }];
  expect(new Set(items.map(row => row.itemRef)).size).toBe(2);
  expect(items.map(row => row.providerPaymentRef)).toEqual(["payment-a", "payment-a"]);
  type History = Extract<Awaited<ReturnType<InvoiceHostPorts["accountHistory"]["read"]>>, { kind: "found" }>;
  const history: History = { kind: "found", accountRef: "owner-a", orderId: "order-a", documents: [{ documentRef: "child-a", invoiceRef: "invoice-a", parentDocumentRef: "parent-a", role: "correction", status: "issued", providerDocumentNumber: null, totalGrossMinor: -120, currency: "XXX", emailState: "not_requested", isCurrent: true, createdAt: proof.observedAt, downloadAvailable: false }] };
  expect(history.documents[0]).toMatchObject({ role: "correction", parentDocumentRef: "parent-a", currency: "XXX" });
  expect(history.accountRef).toBe("owner-a");
  expectTypeOf<InvoiceHostPorts["money"]>().not.toHaveProperty("refund");
});
