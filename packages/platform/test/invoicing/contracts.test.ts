import { expect, expectTypeOf, it } from "vitest";
import * as contracts from "../../src/invoicing/contracts/index.js";
import * as runtime from "../../src/invoicing/index.js";
import type { InvoiceCapabilities, InvoiceIdentity, InvoiceReadbackResult, InvoiceWriteResult, InvoiceArtifactResult, InvoiceSettlementResult, InvoiceStorePort, InvoiceHostPorts } from "../../src/invoicing/contracts/index.js";

const capability: InvoiceCapabilities = {
  version: "invoicing.capabilities.v1", providerRef: "fiscal-a", fiscalScope: { scopeRef: "host-scope", version: "v1" },
  policies: { identifierRef: "identifier-v1", taxRef: "tax-v1", roundingRef: "rounding-v1" },
  documentKinds: ["host-document"], correctionKinds: ["full_reversal"], numberingOwner: "provider", sellerTiming: "execution", defaultOff: true,
  operations: { issue: { supported: true }, correction: { supported: true }, recovery: { supported: true }, readback: { supported: true }, exactAbsence: { supported: true }, remoteVoid: { supported: false, reason: "not_implemented" }, artifact: { supported: false, reason: "host_required" }, clearance: { supported: false, reason: "host_required" }, settlement: { supported: false, reason: "host_required" }, companyLookup: { supported: false, reason: "host_required" } },
};

it("keeps contracts runtime-empty and selection default-off without invoking host effects", () => {
  expect(Object.keys(contracts)).toEqual([]);
  expect(Object.keys(runtime)).toEqual(["readInvoiceCapabilities"]);
  for (const enabled of [undefined, false]) expect(runtime.readInvoiceCapabilities({ enabled, selection: { providerRef: capability.providerRef }, capability })).toMatchObject({ kind: "refused", code: "disabled", effectMayHaveSucceeded: false });
  for (const selection of [null, { providerRef: "other" }]) expect(runtime.readInvoiceCapabilities({ enabled: true, selection, capability })).toMatchObject({ kind: "refused", code: "selection_required" });
  expect(runtime.readInvoiceCapabilities({ enabled: true, selection: { providerRef: capability.providerRef }, capability: null })).toMatchObject({ kind: "refused", code: "selection_required" });
  expect(runtime.readInvoiceCapabilities({ enabled: true, selection: { providerRef: capability.providerRef }, capability })).toEqual({ kind: "ready", capability });
});

it("requires scoped complete absence, separates uncertainty and retains the SQL owed-duty envelope", () => {
  expectTypeOf<Extract<InvoiceReadbackResult, { kind: "absent" }>["evidence"]["scope"]>().toEqualTypeOf<InvoiceIdentity>();
  expectTypeOf<Extract<InvoiceReadbackResult, { kind: "absent" }>["evidence"]["complete"]>().toEqualTypeOf<true>();
  expectTypeOf<Extract<InvoiceWriteResult, { kind: "unknown" }>["effectMayHaveSucceeded"]>().toEqualTypeOf<true>();
  expectTypeOf<Extract<InvoiceWriteResult, { kind: "unsupported" }>["effectMayHaveSucceeded"]>().toEqualTypeOf<false>();
  expectTypeOf<Extract<InvoiceWriteResult, { kind: "issued" }>["providerDocumentNumber"]>().toEqualTypeOf<string | null>();
  expectTypeOf<Extract<InvoiceArtifactResult, { kind: "found" }>["artifact"]>().not.toHaveProperty("url");
  expectTypeOf<Extract<InvoiceSettlementResult, { kind: "recorded" }>["itemRef"]>().toEqualTypeOf<string>();
  expectTypeOf<Extract<Parameters<InvoiceStorePort["fail"]>[0], { kind: "absent" }>["evidence"]>().toEqualTypeOf<Extract<InvoiceReadbackResult, { kind: "absent" }>>();
  type IssueIdentity = Parameters<NonNullable<import("../../src/invoicing/contracts/index.js").InvoiceServicesOptions["provider"]>["issue"]>[0]["identity"];
  expectTypeOf<IssueIdentity["operation"]>().toEqualTypeOf<"issue">();
  expectTypeOf<IssueIdentity["parentProviderDocumentRef"]>().toEqualTypeOf<null>();
  type AbsentMoney = Extract<Awaited<ReturnType<InvoiceHostPorts["money"]["read"]>>, { kind: "absent" }>;
  expectTypeOf<AbsentMoney["evidence"]["scope"]>().toEqualTypeOf<Parameters<InvoiceHostPorts["money"]["read"]>[0]>();
  type Duty = Exclude<Awaited<ReturnType<InvoiceStorePort["readDuties"]>>, { kind: "unsupported" }>;
  const readback: Duty = { orderId: "order-a", captureFaults: [{ sourceId: "source-a", state: "resolved", attempts: 2, availableAt: "2026-10-22T12:00:00Z" }], duties: [{ dutyId: "duty-a", parentDutyId: null, documentId: null, state: "unsupported", attempts: 0, factAttempts: 2, diagnosticCode: "legacy_facts_unproved", createdAt: "2026-10-22T12:00:00Z", availableAt: "2026-10-22T12:01:00Z", leaseUntil: null }] };
  expect(readback.duties[0]).toMatchObject({ state: "unsupported", diagnosticCode: "legacy_facts_unproved" });
  expectTypeOf<Duty["duties"][number]["state"]>().toEqualTypeOf<"owed" | "blocked" | "claimed" | "unknown" | "issued" | "voided" | "unsupported" | "faulted">();
  type History = Extract<Awaited<ReturnType<InvoiceHostPorts["accountHistory"]["read"]>>, { kind: "found" }>;
  expectTypeOf<History["documents"][number]>().not.toHaveProperty("buyer");
  expectTypeOf<History["documents"][number]>().not.toHaveProperty("raw");
  expectTypeOf<History["documents"][number]>().toHaveProperty("parentDocumentRef");
});
