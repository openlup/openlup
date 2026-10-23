import { readFileSync } from "node:fs";
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


it("fits pre-claim seller reads to order-scoped and unscoped first-claim wrappers", async () => {
  // Pinned 195000 invoicing_claim_with_seller + 195100 managed claim wrappers;
  // donor readAccountingSellerConfig reads configuration without any duty.
  const seen: (string | null)[] = [];
  const current: InvoiceHostPorts["seller"] = {
    async read(input) { seen.push(input.orderId); return { kind: "found", seller, revisionRef: "seller-revision-a" }; },
  };
  for (const orderId of ["order-a", null]) {
    const snapshot = await current.read({ orderId });
    if (snapshot.kind !== "found") throw new Error("expected_seller_fixture");
    const native = { p_limit: 10, p_visibility: 300, p_provider: "fiscal-a", p_seller: snapshot.seller, p_revision: snapshot.revisionRef, p_order_id: orderId };
    const managed = { p_limit: 10, p_order: orderId, p_seller: snapshot.seller, p_revision: snapshot.revisionRef };
    const corrections = { p_limit: 10, p_seller: snapshot.seller, p_revision: snapshot.revisionRef };
    expect(native.p_revision).toBe("seller-revision-a");
    expect(managed).toMatchObject({ p_order: orderId, p_seller: seller, p_revision: native.p_revision });
    expect(corrections).toEqual({ p_limit: 10, p_seller: seller, p_revision: native.p_revision });
  }
  expect(seen).toEqual(["order-a", null]);
});


it("supplies native store and seller-wrapper arguments in pinned SQL signature order", async () => {
  // This is a translation witness, not a store implementation or a SQL runner.
  // Required port inputs are checked by TypeScript; object key order is checked
  // against the actual pinned signatures, including the fenced managed overloads.
  const claim = { dutyId: "duty-a", documentId: "document-a", requestId: "request-a", token: "lease-a", generation: 2, leaseUntil: proof.observedAt, identity, facts, action: "create", correction: null } as const satisfies Parameters<InvoiceStorePort["finish"]>[0]["claim"];
  const capture: Parameters<InvoiceStorePort["captureDuty"]>[0] = { requestKey: "paid-key", sourceKind: "paid", sourceId: "transition-a", orderId: facts.refs.orderId, occurredAt: proof.observedAt, evidence: { settlementIntentId: facts.payment.intentRef, amountMinor: 120, currency: facts.currency } };
  const install: Parameters<InvoiceStorePort["installFacts"]>[0] = { dutyId: claim.dutyId, facts };
  const prepare: Parameters<InvoiceStorePort["prepareFacts"]>[0] = { dutyId: claim.dutyId, token: claim.token };
  const finishFacts: Parameters<InvoiceStorePort["finishFacts"]>[0] = { ...prepare, result: { status: "ready", documentId: claim.documentId, requestId: claim.requestId } };
  const scope: Parameters<InvoiceStorePort["claim"]>[0] = { limit: 10, visibilitySeconds: 300, providerRef: identity.providerRef, orderId: facts.refs.orderId };
  const preflight: Parameters<InvoiceStorePort["preflight"]>[0] = { claim, status: "succeeded", amountMinor: 120, currency: facts.currency, proof };
  const finish: Parameters<InvoiceStorePort["finish"]>[0] = { claim, result: { kind: "issued", identity, providerDocumentRef: "external-a", providerDocumentNumber: null, proof, replayed: false } };
  const fail: Parameters<InvoiceStorePort["fail"]>[0] = { claim, retrySeconds: 90, kind: "retryable", phase: "before_send", proof };
  const reversal: Parameters<InvoiceStorePort["requestReversal"]>[0] = { requestKey: "reversal-a", orderId: facts.refs.orderId, reason: "order_refunded", proof };
  const observation: Parameters<InvoiceStorePort["recordObservation"]>[0] = { requestKey: "observation-a", documentId: claim.documentId, eventRef: "event-a", eventKind: "clearance", identity: { providerRef: identity.providerRef, documentRef: claim.documentId, providerDocumentRef: "external-a", orderRef: identity.orderRef, invoiceRef: identity.invoiceRef, parentProviderDocumentRef: null }, providerDocumentRef: "external-a", providerDocumentNumber: null, clearance: { state: "accepted", reference: "clearance-a", proof }, artifacts: [], observedAt: proof.observedAt, payloadHash: proof.fingerprint, source: "provider_api" };
  const delivery: Parameters<InvoiceStorePort["claimDeliveries"]>[0] = { limit: 10, visibilitySeconds: 300, requireClearance: true, orderId: facts.refs.orderId };
  const settle: Parameters<InvoiceStorePort["settleDelivery"]>[0] = { deliveryRef: "delivery-a", token: claim.token, generation: claim.generation, providerDocumentRef: "external-a", retrySeconds: 90, result: { kind: "failed_before_send", retryable: true, code: "retryable" } };
  const current: InvoiceHostPorts["seller"] = { async read() { return { kind: "found", seller, revisionRef: "seller-revision-a" }; } };
  const snapshot = await current.read({ orderId: scope.orderId ?? null });
  if (snapshot.kind !== "found") throw new Error("expected_seller_fixture");
  // Provider selection is a store-construction dependency for managed requests;
  // seller is read before claim. Neither depends on a returned duty identifier.
  const selectedProvider = scope.providerRef;
  const fences = { p_duty: claim.dutyId, p_token: claim.token, p_generation: claim.generation };
  const completion = { ...fences, p_external: finish.result.providerDocumentRef, p_number: finish.result.providerDocumentNumber, p_proof: { kind: "issued", externalId: finish.result.providerDocumentRef, providerCreateIdentity: claim.identity.providerCreateIdentity, ...finish.result.proof } };
  const calls: readonly [string, string, Record<string, unknown>][] = [
    ["190000_invoicing_durable_duties", "invoicing_capture_duty", { p_key: capture.requestKey, p_source_kind: capture.sourceKind, p_source_id: capture.sourceId, p_order_id: capture.orderId, p_evidence: capture.evidence, p_occurred_at: capture.occurredAt }],
    ["190000_invoicing_durable_duties", "invoicing_install_facts", { p_duty: install.dutyId, p_facts: install.facts, p_revision: install.facts.factRevision }],
    ["190000_invoicing_durable_duties", "invoicing_sweep_duties", { p_limit: scope.limit }],
    ["190000_invoicing_durable_duties", "invoicing_prepare_facts", { p_duty: prepare.dutyId, p_token: prepare.token }],
    ["190000_invoicing_durable_duties", "invoicing_finish_facts", { p_duty: finishFacts.dutyId, p_token: finishFacts.token, p_result: finishFacts.result }],
    ["190000_invoicing_durable_duties", "invoicing_duty_readback", { p_order_id: capture.orderId }],
    ["190000_invoicing_durable_duties", "invoicing_claim_duties", { p_limit: scope.limit, p_visibility: scope.visibilitySeconds, p_provider: scope.providerRef, p_order_id: scope.orderId }],
    ["190000_invoicing_durable_duties", "invoicing_preflight_duty", { ...fences, p_evidence: { kind: "observed", outcome: "captured", amountMinor: preflight.amountMinor, currency: preflight.currency, proof: preflight.proof } }],
    ["190000_invoicing_durable_duties", "invoicing_finish_issue", completion],
    ["190000_invoicing_durable_duties", "invoicing_fail_duty", { ...fences, p_kind: fail.kind, p_evidence: { phase: fail.phase, proof: fail.proof }, p_delay: fail.retrySeconds }],
    ["191000_invoicing_document_effects", "invoicing_request_reversal", { p_key: reversal.requestKey, p_order: reversal.orderId, p_reason: reversal.reason, p_evidence: reversal.proof }],
    ["191000_invoicing_document_effects", "invoicing_finish_correction", { ...completion, p_proof: { ...completion.p_proof, parentExternalId: "parent-a" } }],
    ["191000_invoicing_document_effects", "invoicing_record_observation", { p_key: observation.requestKey, p_document: observation.documentId, p_observation: { kind: observation.eventKind, state: observation.clearance?.state, reference: observation.clearance?.reference, observedAt: observation.observedAt } }],
    ["191000_invoicing_document_effects", "invoicing_claim_deliveries", { p_limit: delivery.limit, p_visibility: delivery.visibilitySeconds, p_require_clearance: delivery.requireClearance, p_order_id: delivery.orderId }],
    ["191000_invoicing_document_effects", "invoicing_settle_delivery", { p_delivery: settle.deliveryRef, p_token: settle.token, p_generation: settle.generation, p_kind: settle.result.kind, p_receipt: null, p_evidence: { phase: "before_send", code: "retryable" } }],
    ["193000_invoicing_correction_claims", "accounting_invoice_correction_outbox_claim", { p_limit: scope.limit, p_lease_seconds: scope.visibilitySeconds, p_contract_version: "accounting.correction.v2" }],
    ["193000_invoicing_correction_claims", "accounting_invoice_correction_outbox_succeed", { p_outbox_id: claim.dutyId, p_provider_invoice_id: finish.result.providerDocumentRef, p_provider_invoice_number: finish.result.providerDocumentNumber, p_provider_raw: finish.result.proof, p_claim_attempt_count: claim.generation }],
    ["193000_invoicing_correction_claims", "accounting_invoice_correction_outbox_fail", { p_outbox_id: claim.dutyId, p_error: fail.proof, p_retry_seconds: fail.retrySeconds, p_claim_attempt_count: claim.generation }],
    ["195000_invoicing_seller_revision", "invoicing_request_with_seller_policy", { p_key: capture.requestKey, p_source_kind: capture.sourceKind, p_source_id: capture.sourceId, p_order_id: capture.orderId, p_evidence: capture.evidence, p_occurred_at: capture.occurredAt }],
    ["195000_invoicing_seller_revision", "invoicing_claim_with_seller", { p_limit: scope.limit, p_visibility: scope.visibilitySeconds, p_provider: scope.providerRef, p_seller: snapshot.seller, p_revision: snapshot.revisionRef, p_order_id: scope.orderId }],
    ["195100_invoicing_seller_revision", "invoicing_managed_request_with_seller_policy", { p_key: capture.requestKey, p_source_kind: capture.sourceKind, p_source_id: capture.orderId, p_provider: selectedProvider, p_evidence: capture.evidence }],
    ["195100_invoicing_seller_revision", "invoicing_managed_claim_with_seller", { p_limit: scope.limit, p_order: scope.orderId, p_seller: snapshot.seller, p_revision: snapshot.revisionRef }],
    ["195100_invoicing_seller_revision", "invoicing_managed_claim_corrections_with_seller", { p_limit: scope.limit, p_seller: snapshot.seller, p_revision: snapshot.revisionRef }],
  ];
  for (const [fixture, name, args] of calls) {
    const sql = readFileSync(new URL(`../../../../scripts/fixtures/20261022${fixture}.sql`, import.meta.url), "utf8");
    const signature = sql.match(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\(([^)]*)\\)`));
    expect(signature, name).not.toBeNull();
    const parameters = signature![1].split(",").map(parameter => parameter.trim().split(/\s+/)[0]);
    expect(Object.keys(args), name).toEqual(parameters);
  }
  // The seventh native fixture is a caller of capture, not a new M09 store port.
  const paymentSql = readFileSync(new URL("../../../../scripts/fixtures/20261022192000_invoicing_payment_decoupling.sql", import.meta.url), "utf8");
  expect(paymentSql).toContain("public.invoicing_capture_duty(");
  // The old managed overloads refuse; callers must use the fenced v2 signatures.
  const compatibility = readFileSync(new URL("../../../../scripts/fixtures/20261022193100_invoicing_correction_compatibility.sql", import.meta.url), "utf8");
  expect(compatibility).toContain("accounting_invoice_correction_claim_contract_required");
  expect(compatibility.match(/accounting_invoice_correction_claim_fence_required/g)).toHaveLength(2);
});
