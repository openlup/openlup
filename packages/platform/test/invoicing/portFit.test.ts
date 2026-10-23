import { expect, expectTypeOf, it } from "vitest";
import type { InvoiceFacts, InvoiceLine, InvoiceBuyer, InvoiceSeller, InvoiceIdentity, InvoiceReadbackResult, InvoiceWriteResult, InvoiceCompanyLookupPort, InvoiceHostPorts, InvoiceProviderPort, InvoiceDocumentIdentity, InvoiceStorePort } from "../../src/invoicing/contracts/index.js";

// Synthetic translation of providerPorts/LocalInvoiceSnapshot and the canonical
// position carrier. No live adapter, jurisdiction, config or upstream reread.
const seller: InvoiceSeller = { name: "Example seller", address: { line1: "Example 1", postalCode: "00000", city: "Example" }, taxIdentifier: { scheme: "host-tax", value: "seller-a" }, registrationIds: [{ scheme: "host-registry", value: "registration-a" }], bankAccount: null, routingRef: "department-a" };
const buyer: InvoiceBuyer = { name: "Example buyer", email: null, taxIdentifier: null, companyName: null, address: { line1: null, postalCode: null, city: null, country: null } };
const line: InvoiceLine = { description: "Example item", quantity: 1, quantityUnit: "unit", unitNetMinor: 100, unitGrossMinor: 120, totalNetMinor: 100, totalTaxMinor: 20, totalGrossMinor: 120, taxRateBps: 2000, taxRateLabel: "20", positionKind: "item", catalogTotalGrossMinor: 130, discountAllocatedMinor: 10, shippingGrossMinor: null, shippingDiscountMinor: null };
const facts: InvoiceFacts = { factRevision: "facts-a", policyVersion: "policy-a", refs: { orderId: "order-a", orderRef: "order-ref-a", invoiceRef: "invoice-a" }, dates: { issueDate: "2026-10-22", sellDate: "2026-10-22", handedOverAt: null, paymentCompletedAt: "2026-10-22T12:00:00Z" }, documentKind: "host-document", clearanceRequired: false, currency: "XXX", buyer, seller, payment: { intentRef: "intent-a", providerRef: "money-a", providerPaymentRef: null, amountMinor: 120, currency: "XXX", localSettlementState: "unavailable" }, orderMoney: { subtotalMinor: 130, discountMinor: 10, shippingMinor: 0, shippingDiscountMinor: 0, totalMinor: 120 }, lines: [line], totalNetMinor: 100, totalTaxMinor: 20, totalGrossMinor: 120, chargedTotalGrossMinor: 120 };
const identity = { providerRef: "fiscal-a", requestKey: " exact:key ", providerCreateIdentity: "invoicing:duty-a", factRevision: facts.factRevision, orderRef: facts.refs.orderRef, invoiceRef: facts.refs.invoiceRef, operation: "issue", correctionRef: null, parentProviderDocumentRef: null } as const satisfies InvoiceIdentity;
const proof = { evidenceRef: "evidence-a", fingerprint: "fingerprint-a", observedAt: "2026-10-22T12:01:00Z" };

it("fits issue/correction recovery and all four readback results without discarding parent, revision or key bytes", async () => {
  type Provider = InvoiceProviderPort;
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
  const history: History = { kind: "found", accountRef: "owner-a", orderId: "order-a", documents: [{ documentRef: "child-a", invoiceRef: "invoice-a", parentDocumentRef: "parent-a", role: "correction", status: "issued", issuedAt: proof.observedAt, clearance: { state: "accepted", reference: "clearance-a" }, documentKind: "correction", artifact: "correction", providerDocumentNumber: null, totalGrossMinor: -120, currency: "XXX", emailState: "not_requested", isCurrent: true, createdAt: proof.observedAt, downloadAvailable: false }] };
  expect(history.documents[0]).toMatchObject({ role: "correction", parentDocumentRef: "parent-a", currency: "XXX" });
  expect(history.accountRef).toBe("owner-a");
  expectTypeOf<InvoiceHostPorts["money"]>().not.toHaveProperty("refund");
});

it("fits both producer policy keys and visible recorded skips without a local document", async () => {
  const seen: Parameters<InvoiceHostPorts["policy"]["decide"]>[0][] = [];
  const receipt = { kind: "policy_suppressed", outcome: "channel_issues", policyVersion: "v1", requestKey: "handoff-key", recordedAt: proof.observedAt } as const;
  const policy: InvoiceHostPorts["policy"] = {
    async decide(input) { seen.push(input); return { ...receipt, requestKey: input.requestKey }; },
    async receipts() { return [receipt, { kind: "operator_skipped", outcome: "operator_skip", actorRef: "operator-a", reason: "approved skip", requestKey: "skip-key", recordedAt: proof.observedAt }]; },
  };
  await policy.decide({ requestKey: "paid-key", lookup: { by: "order", orderId: "order-a" } });
  await policy.decide({ requestKey: "handoff-key", lookup: { by: "fulfillmentOrder", fulfillmentOrderRef: "fulfillment-a" } });
  expect(seen.map(input => input.lookup.by)).toEqual(["order", "fulfillmentOrder"]);
  expect(await policy.receipts("order-a")).toMatchObject([{ kind: "policy_suppressed", recordedAt: proof.observedAt }, { kind: "operator_skipped", recordedAt: proof.observedAt }]);
});

it("fits legacy document artifact, clearance and download carriers without inventing issue metadata", async () => {
  // Pinned accounting_documents + donor delivery/history: no duty, revision or create key.
  const document: InvoiceDocumentIdentity = { providerRef: "fiscal-a", documentRef: "legacy-document", providerDocumentRef: "external-a", orderRef: "order-ref-a", invoiceRef: "invoice-a", parentProviderDocumentRef: null };
  const artifacts: InvoiceHostPorts["artifacts"] = {
    async read(input) { return { kind: "found", identity: input.identity, artifact: { kind: input.kind, ref: "blob-a", owner: "host_storage", mediaType: "application/pdf", proof } }; },
    async download() { return { kind: "downloaded", content: new Uint8Array([37, 80, 68, 70]), contentType: "application/pdf" }; },
    async persist(input) { return { kind: "found", identity: input.identity, artifact: { kind: input.kind, ref: "blob-a", owner: "host_storage", mediaType: input.contentType, proof } }; },
  };
  const clearance: InvoiceHostPorts["clearance"] = { async observe() { return { kind: "observed", observation: { state: "accepted", reference: "clearance-a", proof } }; } };
  expect(await artifacts.read({ identity: document, kind: "pdf" })).toMatchObject({ kind: "found", identity: document });
  expect(await clearance.observe({ identity: document, providerDocumentRef: "external-a" })).toMatchObject({ kind: "observed", observation: { state: "accepted", reference: "clearance-a" } });
  const ticket: Extract<Awaited<ReturnType<InvoiceHostPorts["accountHistory"]["resolveDownload"]>>, { kind: "authorized" }> = { kind: "authorized", identity: document, artifactRef: "blob-a", fileName: "correction.pdf", parentDocumentRef: "parent-a" };
  expect(ticket.fileName).toBe("correction.pdf");
  expect(document).not.toHaveProperty("factRevision");
});

it("fits managed delivery settlement carriers and native uncertain receipt evidence without losing the hint", () => {
  // invoiceDeliveryPorts.ts:69-81 + accountingInvoicePort.ts:170-185;
  // pinned invoicing_settle_delivery(p_delivery,p_token,p_generation,p_kind,p_receipt,p_evidence).
  type Settlement = Parameters<InvoiceStorePort["settleDelivery"]>[0];
  const donor = { outboxId: "outbox-a", claimAttemptCount: 2, providerInvoiceId: "external-a", providerMessageId: "message-a", retrySeconds: 90 };
  const input: Settlement = { deliveryRef: donor.outboxId, token: "lease-a", generation: donor.claimAttemptCount, providerDocumentRef: donor.providerInvoiceId, retrySeconds: donor.retrySeconds, result: { kind: "uncertain", code: "uncertain_delivery", receiptRef: donor.providerMessageId } };
  if (input.result.kind !== "uncertain") throw new Error("expected_uncertain_fixture");
  const managed = { p_outbox_id: input.deliveryRef, p_attempt_count: input.generation, p_provider_invoice_id: input.providerDocumentRef, p_provider_message_id: input.result.receiptRef };
  const native = { p_delivery: input.deliveryRef, p_token: input.token, p_generation: input.generation, p_kind: input.result.kind, p_receipt: null, p_evidence: { code: input.result.code, receiptHint: input.result.receiptRef } };
  expect(managed).toEqual({ p_outbox_id: donor.outboxId, p_attempt_count: donor.claimAttemptCount, p_provider_invoice_id: donor.providerInvoiceId, p_provider_message_id: donor.providerMessageId });
  expect(native).toEqual({ p_delivery: donor.outboxId, p_token: "lease-a", p_generation: donor.claimAttemptCount, p_kind: "uncertain", p_receipt: null, p_evidence: { code: "uncertain_delivery", receiptHint: donor.providerMessageId } });
  const noHint: Settlement = { ...input, result: { kind: "uncertain", code: "uncertain_delivery", receiptRef: null } };
  expect(noHint.result).toMatchObject({ receiptRef: null });
  const failed: Settlement = { ...input, result: { kind: "failed_before_send", retryable: true, code: "retryable" } };
  expect({ p_provider_invoice_id: failed.providerDocumentRef, p_retry_seconds: failed.retrySeconds }).toEqual({ p_provider_invoice_id: donor.providerInvoiceId, p_retry_seconds: donor.retrySeconds });
});

it("fits the existing local paid-order document provider, reference, status and replay response", async () => {
  // server/adapters/postgres/accountingPaidOrderDocument.ts:52-74: providerKind
  // enters the request; invoiceRef is read from accounting_documents.document_ref.
  const donorRequest = { idempotencyKey: " exact:local-key ", orderId: "order-a", providerKind: "local-a" };
  const donorResponse = { invoice: { id: "document-a", invoiceRef: "local-invoice-a", status: "requested", replayed: true } };
  let seen: typeof donorRequest | undefined;
  const local: Pick<InvoiceStorePort, "requestLocalDocument"> = {
    async requestLocalDocument(input) {
      seen = { idempotencyKey: input.requestKey, orderId: input.orderId, providerKind: input.providerRef };
      const { id, invoiceRef, status, replayed } = donorResponse.invoice;
      return { kind: "requested", documentId: id, invoiceRef, status, replayed };
    },
  };
  expect(await local.requestLocalDocument({ requestKey: donorRequest.idempotencyKey, orderId: donorRequest.orderId, providerRef: donorRequest.providerKind })).toEqual({ kind: "requested", documentId: "document-a", invoiceRef: "local-invoice-a", status: "requested", replayed: true });
  expect(seen).toEqual(donorRequest);
});
