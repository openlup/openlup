import { expect, it, vi } from "vitest";
import { collectInvoiceDuties, createIndependentInvoiceDutyBinding, createNativeUnsupportedInvoicePorts } from "../../src/invoicing/index.js";
import type { InvoiceStorePort } from "../../src/invoicing/contracts/index.js";

it("commits sweep before split prepare/finish and skips stale claims without fabricating completion", async () => {
  const trace: string[] = [];
  const store: Pick<InvoiceStorePort, "sweep" | "prepareFacts" | "finishFacts"> = {
    async sweep(limit) { expect(limit).toBe(3); trace.push("sweep-commit"); return { collected: 2, claims: [{ dutyId: "a", token: "one" }, { dutyId: "b", token: "two" }] }; },
    async prepareFacts(claim) { trace.push(`prepare-${claim.dutyId}-commit`); return claim.dutyId === "a" ? { status: "ready", documentId: "doc", requestId: "request" } : { status: "stale" }; },
    async finishFacts(input) { expect(input).toEqual({ dutyId: "a", token: "one", result: { status: "ready", documentId: "doc", requestId: "request" } }); trace.push("finish-commit"); return { dutyId: "a", status: "ready" }; },
  };
  expect(await collectInvoiceDuties({ store, limit: 3 })).toEqual({ kind: "collected", collected: 2, prepared: 1, failures: 0 });
  expect(trace).toEqual(["sweep-commit", "prepare-a-commit", "finish-commit", "prepare-b-commit"]);
});

it("retains locked/unknown/unsupported work, advances other claims and never acknowledges an unproved result", async () => {
  for (const phase of ["prepare", "finish", "unknown", "unsupported", "owed"] as const) {
    const finishFacts = vi.fn<InvoiceStorePort["finishFacts"]>(async ({ dutyId }) => {
      if (dutyId === "a" && phase === "finish") throw new Error("connection_lost");
      return { dutyId, status: dutyId === "a" && phase === "owed" ? "owed" : "ready" };
    });
    const binding = createIndependentInvoiceDutyBinding({ store: {
      async sweep() { return { collected: 2, claims: [{ dutyId: "a", token: "a" }, { dutyId: "b", token: "b" }] }; },
      async prepareFacts({ dutyId }) {
        if (dutyId === "a") {
          if (phase === "prepare" || phase === "unknown") throw new Error(phase);
          if (phase === "unsupported") return { kind: "unsupported", code: "host_binding_required", retryable: false, effectMayHaveSucceeded: false };
          if (phase === "owed") return { status: "owed", code: "retryable" };
        }
        return { status: "ready" };
      }, finishFacts,
    } });
    expect(await binding.collect()).toEqual({ kind: "collected", collected: 2, prepared: 1, failures: 1 });
    expect(finishFacts).toHaveBeenCalledTimes(phase === "finish" || phase === "owed" ? 2 : 1);
  }
  const unsupported = createNativeUnsupportedInvoicePorts();
  expect(await createIndependentInvoiceDutyBinding({ store: unsupported.store }).collect()).toMatchObject({ kind: "unsupported" });
  const sweep = vi.fn(async () => { throw new Error("private database details"); });
  expect(await createIndependentInvoiceDutyBinding({ store: { ...unsupported.store, sweep } }).collect()).toEqual({ kind: "unavailable", code: "retryable" });
});
