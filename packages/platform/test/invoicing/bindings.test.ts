import { expect, it, vi } from "vitest";
import { createInvoiceServices, createInvoiceContribution, createNativeUnsupportedInvoicePorts } from "../../src/invoicing/index.js";
import type { InvoiceCapabilities } from "../../src/invoicing/contracts/index.js";

const yes = { supported: true } as const;
const capability: InvoiceCapabilities = {
  version: "invoicing.capabilities.v1", providerRef: "host", fiscalScope: { scopeRef: "host", version: "v1" },
  policies: { identifierRef: "id", taxRef: "tax", roundingRef: "round" }, documentKinds: ["host"], correctionKinds: ["full_reversal"],
  numberingOwner: "provider", sellerTiming: "first_claim", defaultOff: true,
  operations: { issue: yes, correction: yes, recovery: yes, readback: yes, exactAbsence: yes, remoteVoid: yes, artifact: yes, clearance: yes, settlement: yes, companyLookup: yes },
};
it("refuses default-off, mismatched selection, missing ports and host refusal before factory or claim", async () => {
  const native = createNativeUnsupportedInvoicePorts();
  const observe = vi.fn(async () => ({ kind: "ready" as const }));
  const factory = vi.fn(() => vi.fn(async () => "done"));
  const options = { ...native, capability, selection: { providerRef: "host" }, readiness: observe, factories: { issue: factory } };
  for (const change of [{}, { enabled: false }, { enabled: true, selection: null }, { enabled: true, selection: { providerRef: "other" } }, { enabled: true, store: null }]) {
    expect(await createInvoiceServices({ ...options, ...change }).run("issue")).toHaveProperty("code");
  }
  expect(observe).not.toHaveBeenCalled(); expect(factory).not.toHaveBeenCalled();
  const services = createInvoiceServices({ ...options, enabled: true, readiness: async () => ({ kind: "unsupported", code: "host_binding_required", retryable: false, effectMayHaveSucceeded: false }) });
  expect(await services.run("issue")).toMatchObject({ kind: "unsupported" }); expect(factory).not.toHaveBeenCalled();
});
it("runs only the selected existing factory after readiness and refuses absent or unsupported factories", async () => {
  const native = createNativeUnsupportedInvoicePorts(); const trace: string[] = [];
  const services = createInvoiceServices({ ...native, capability, enabled: true, selection: { providerRef: "host" },
    readiness: async () => { trace.push("ready"); return { kind: "ready" }; },
    factories: { issue: ports => { expect(ports.store).toBe(native.store); trace.push("factory"); return async () => { trace.push("claim"); return 1; }; } },
  });
  expect(await services.run("issue")).toBe(1); expect(trace).toEqual(["ready", "factory", "claim"]);
  expect(await services.run("delivery")).toHaveProperty("kind", "unsupported");
});
it("preserves the host registration table and callable identity without installing another executor", () => {
  const handler = { eventType: "accounting.reversal", timeoutMs: 30000 };
  const run = vi.fn(); const route = vi.fn();
  const result = createInvoiceContribution({ version: "test", requiredSchema: { version: "full", migration: "full", objects: [] },
    invoicing: { issue: run, unsupported: null }, handlers: [handler], schedules: [{ id: "existing-job", cadenceSeconds: 60, run }], routes: [{ id: "existing-route", handle: route }],
  });
  expect(result.contributions[0].handlers[0]).toBe(handler);
  expect(result.contributions[0].manifest.handles).toEqual([handler.eventType]);
  expect(result.triggers["@openlup/platform/invoicing:existing-job"]).toBe(run);
  expect(result.routes["@openlup/platform/invoicing:existing-route"]).toBe(route);
  expect(result.ports).toEqual({ "@openlup/platform/invoicing:issue": run }); expect(run).not.toHaveBeenCalled();
});

it.each(["issue", "delivery", "collectDuties", "documentSync", "settlementSync", "history"] as const)("composes the real module helper for %s", async operation => {
  const native = createNativeUnsupportedInvoicePorts(), state: string[] = [];
  const store = { ...native.store,
    claim: async () => { state.push("issue claim"); return []; },
    claimDeliveries: async () => { state.push("delivery claim"); return []; },
    sweep: async () => { state.push("duty sweep"); return { collected: 0, claims: [] }; },
  };
  const services = createInvoiceServices({ ...native, store, capability, enabled: true, selection: { providerRef: "host" },
    readiness: async () => ({ kind: "ready" }),
    host: { ...native.host, accountHistory: { ...native.host.accountHistory, read: async input => {
      state.push("history read"); return { kind: "found", ...input, documents: [] };
    } } },
    jobs: {
      issue: { readLocalPayment: async () => ({ kind: "unavailable", code: "money_unavailable" }) },
      delivery: { claimOptions: { limit: 3, visibilitySeconds: 97, requireClearance: false }, filename: () => "host.pdf" },
      collectDuties: { limit: 5 }, history: { accountRef: "account-a", orderId: "order-b" },
      documentSync: { targets: async () => ["target"], observe: async () => "accepted", accepted: () => true,
        recordStatus: async () => { state.push("document status"); }, downloads: [async () => "artifact"], record: async (_target, _status, docs) => { state.push(`document ${docs[0]}`); } },
      settlementSync: { list: async () => [], project: async () => { throw Error("empty payout list"); } },
    },
  });
  const expected = {
    issue: { checked: 0, updated: 0, failures: 0, ok: true }, delivery: { checked: 0, updated: 0, failures: 0, ok: true, skipped: false },
    collectDuties: { kind: "collected", collected: 0, prepared: 0, failures: 0 },
    documentSync: { checked: 1, updated: 1, failures: 0, ok: true, skipped: false }, settlementSync: { checked: 0, recorded: 0, replayed: 0, items: [] },
    history: { kind: "found", accountRef: "account-a", orderId: "order-b", documents: [] },
  };
  expect(await services.run(operation)).toEqual(expected[operation]);
  expect(state).toEqual({ issue: ["issue claim"], delivery: ["delivery claim"], collectDuties: ["duty sweep"],
    documentSync: ["document status", "document artifact"], settlementSync: [], history: ["history read"] }[operation]);
});
