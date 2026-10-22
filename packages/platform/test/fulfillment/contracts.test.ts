import { expect, expectTypeOf, it } from "vitest";
import { createHash } from "node:crypto";
import * as contracts from "../../src/fulfillment/contracts/index.js";
import type { DispatchEvidence, DispatchRecord, FulfillmentDispatchPrepareResult, FulfillmentDispatchPort, FulfillmentDispatchRequest, FulfillmentDispatchResult, FulfillmentStorePort, FulfillmentLabelPort, LabelDocument, SyncCursor, StockSnapshot, StockMovement, LocalStock } from "../../src/fulfillment/contracts/index.js";

it("isolates browser types, nullable pre-create parcels, actual-command proof and transient label responses (G1–G5)", () => {
  expect(Object.keys(contracts)).toEqual([]);
  expectTypeOf<FulfillmentDispatchRequest["parcelRef"]>().toEqualTypeOf<string | null>();
  expectTypeOf<FulfillmentDispatchRequest["contactRevision"]>().toEqualTypeOf<{ schemaVersion: number; source: string; revision: number }>();
  type Record = NonNullable<Awaited<ReturnType<FulfillmentStorePort["read"]>>>;
  expectTypeOf<Record["evidence"]>().not.toHaveProperty("url");
  expectTypeOf<Record["evidence"]>().not.toHaveProperty("recipient");
  expectTypeOf<Record>().not.toHaveProperty("rawBody");
  expectTypeOf<Record["evidence"]>().toHaveProperty("commandFingerprint");
  expectTypeOf<Record>().toEqualTypeOf<DispatchRecord>();
  expectTypeOf<Record["evidence"]>().toEqualTypeOf<DispatchEvidence>();
  expectTypeOf<keyof DispatchEvidence>().toEqualTypeOf<"commandFingerprint" | "contactRevision" | "providerRef" | "carrierRef" | "serviceRef">();
  expectTypeOf<Extract<FulfillmentDispatchPrepareResult, { kind: "prepared" }>>().toEqualTypeOf<{ kind: "prepared"; evidence: DispatchEvidence }>();
  expectTypeOf<DispatchRecord>().not.toHaveProperty("rawCommand");
  expectTypeOf<LabelDocument>().not.toHaveProperty("rawCommand");
  expectTypeOf<SyncCursor>().not.toHaveProperty("rawCommand");
  expectTypeOf<StockSnapshot>().not.toHaveProperty("rawCommand");
  expectTypeOf<StockMovement>().not.toHaveProperty("rawCommand");
  expectTypeOf<LocalStock>().not.toHaveProperty("rawCommand");
  expectTypeOf<Extract<FulfillmentDispatchResult, { kind: "not_dispatched" }>["effectMayHaveSucceeded"]>().toEqualTypeOf<false>();
  expectTypeOf<Extract<FulfillmentDispatchResult, { kind: "unknown" }>["effectMayHaveSucceeded"]>().toEqualTypeOf<true>();
  type Created = Extract<Awaited<ReturnType<FulfillmentLabelPort["create"]>>, { kind: "created" }>;
  expectTypeOf<Created["document"]>().toBeNullable();
  expectTypeOf<NonNullable<Created["document"]>>().toEqualTypeOf<LabelDocument>();
  expectTypeOf<NonNullable<Created["document"]>>().not.toHaveProperty("url");
  const cleanup: Awaited<ReturnType<FulfillmentLabelPort["void"]>> = { providerDeletion: "unconfirmed", labelDeleted: false, canProceed: true };
  expect(cleanup).toEqual({ providerDeletion: "unconfirmed", labelDeleted: false, canProceed: true });
});

it("prepares actual command evidence before claim/begin and prepares again after contact_stale (G2/G3)", async () => {
  const order: string[] = [];
  const commands = new Map<string, string>(); // transient adapter closure, never a store field
  const request: FulfillmentDispatchRequest = {
    requestKey: "request-a", fulfillmentRef: "fulfillment-a", orderRef: "order-a", orderNumber: null, parcelRef: null,
    contactRevision: { schemaVersion: 1, source: "contact", revision: 1 },
    recipient: { name: null, email: null, phone: null, line1: "Synthetic 1", line2: null, city: "Example", postalCode: "00000", country: "XX", deliveryInstructions: null, courierInstructions: null },
    lines: [{ skuRef: "sku-a", title: null, quantity: 1, productRef: null, packRef: null }],
    selection: { providerRef: "warehouse-a", carrierRef: "carrier-a", serviceRef: "service-a", deliveryKind: "courier", pickupPoint: null },
  };
  const adapter: FulfillmentDispatchPort = {
    async prepare(input) {
      order.push("prepare");
      if (!input.selection.providerRef) return { kind: "refused", refusal: { reason: "selection_required", phase: "selection", retryable: false } };
      if (!input.lines.length) return { kind: "refused", refusal: { reason: "not_dispatchable", phase: "prepare", retryable: false } };
      const command = JSON.stringify({ destination: input.recipient.line1, revision: input.contactRevision.revision, items: input.lines.map(line => [line.skuRef, line.quantity]) });
      const commandFingerprint = createHash("sha256").update(command).digest("hex");
      commands.set(commandFingerprint, command);
      return { kind: "prepared", evidence: { commandFingerprint, contactRevision: input.contactRevision, providerRef: input.selection.providerRef, carrierRef: input.selection.carrierRef, serviceRef: input.selection.serviceRef } };
    },
    async dispatch(input, evidence) {
      order.push("dispatch");
      expect(evidence).toBe(record.evidence);
      expect(evidence.contactRevision).toEqual(input.contactRevision);
      expect(JSON.parse(commands.get(evidence.commandFingerprint)!)).toEqual({ destination: "Synthetic 2", revision: 2, items: [["sku-a", 1]] });
      return { kind: "accepted", externalRef: "remote-a", evidence, providerAttemptKey: "attempt-a", labelKey: "label-a" };
    },
  };
  let record: DispatchRecord;
  const store: Pick<FulfillmentStorePort, "claim" | "begin"> = {
    async claim(input) {
      order.push("claim");
      if (input.evidence.contactRevision.revision === 1) return { kind: "refused", refusal: { reason: "contact_stale", phase: "claim", retryable: true } };
      record = { ...input, dispatchRef: "dispatch-a", externalRef: null, status: "draft", replayed: false };
      return { kind: "claimed", record };
    },
    async begin(input) {
      order.push("begin");
      expect(input).toEqual({ dispatchRef: record.dispatchRef, commandFingerprint: record.evidence.commandFingerprint });
      record.status = "submitting";
      return { kind: "begun", record, begun: true, replayed: false };
    },
  };
  const claim = (evidence: DispatchEvidence) => store.claim({ requestKey: request.requestKey, fulfillmentRef: request.fulfillmentRef, orderRef: request.orderRef, parcelRef: request.parcelRef, mode: "stage", evidence });
  const first = await adapter.prepare(request);
  if (first.kind !== "prepared") throw new Error("fixture preparation refused");
  expect(await claim(first.evidence)).toMatchObject({ kind: "refused", refusal: { reason: "contact_stale" } });
  const remapped = { ...request, contactRevision: { ...request.contactRevision, revision: 2 }, recipient: { ...request.recipient, line1: "Synthetic 2" } };
  const prepared = await adapter.prepare(remapped);
  if (prepared.kind !== "prepared") throw new Error("fixture remap refused");
  expect(prepared.evidence.commandFingerprint).not.toBe(first.evidence.commandFingerprint);
  const claimed = await claim(prepared.evidence);
  if (claimed.kind !== "claimed") throw new Error("fixture claim refused");
  const begun = await store.begin({ dispatchRef: claimed.record.dispatchRef, commandFingerprint: prepared.evidence.commandFingerprint });
  if (begun.kind !== "begun") throw new Error("fixture begin refused");
  expect(await adapter.dispatch(remapped, prepared.evidence)).toMatchObject({ kind: "accepted", evidence: prepared.evidence });
  expect(order).toEqual(["prepare", "claim", "prepare", "claim", "begin", "dispatch"]);
  expect(Object.keys(claimed.record).sort()).toEqual(["dispatchRef", "requestKey", "fulfillmentRef", "orderRef", "parcelRef", "mode", "evidence", "externalRef", "status", "replayed"].sort());
  expect(await adapter.prepare({ ...request, selection: { ...request.selection, providerRef: null } })).toMatchObject({ kind: "refused", refusal: { reason: "selection_required" } });
  expect(await adapter.prepare({ ...request, lines: [] })).toMatchObject({ kind: "refused", refusal: { reason: "not_dispatchable" } });
});
