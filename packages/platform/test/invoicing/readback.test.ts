import { expect, it, vi } from "vitest";
import { createInvoiceReadModel } from "../../src/invoicing/index.js";
import type { InvoiceProviderPort, InvoiceReadbackResult } from "../../src/invoicing/contracts/index.js";
import { identity, proof } from "./portFitFixtures.js";

it("keeps found, exact scoped absence, unknown and unsupported distinct on every read; refuses all partial/drifted absence", async () => {
  const read = vi.fn<InvoiceProviderPort["read"]>();
  const model = createInvoiceReadModel({ provider: { read } });
  const absent = { kind: "absent", identity, evidence: { ...proof, exact: true, complete: true, scope: identity } } as const;
  const cases: [InvoiceReadbackResult, string][] = [
    [{ kind: "found", identity, providerDocumentRef: "provider-document-a", providerDocumentNumber: null, proof }, "found"],
    [absent, "absent"], [{ kind: "unknown", identity, code: "unknown" }, "unknown"],
    [{ kind: "unsupported", code: "unsupported", retryable: false, effectMayHaveSucceeded: false }, "unsupported"],
    [{ ...absent, evidence: { ...absent.evidence, complete: false } } as never, "unknown"],
    [{ ...absent, evidence: { ...absent.evidence, exact: false } } as never, "unknown"],
  ];
  for (const key of Object.keys(identity) as (keyof typeof identity)[]) {
    cases.push([{ ...absent, evidence: { ...absent.evidence, scope: { ...identity, [key]: "drift" } } } as InvoiceReadbackResult, "unknown"]);
  }
  for (const [result, kind] of cases) {
    read.mockResolvedValueOnce(result);
    expect(await model.readback(identity)).toMatchObject({ kind });
    expect(read).toHaveBeenLastCalledWith(identity);
  }
  read.mockRejectedValueOnce(new Error("token secret / transport timeout"));
  expect(await model.readback(identity)).toEqual({ kind: "unknown", identity, code: "unknown" });
  expect(model).not.toHaveProperty("issue");
});
