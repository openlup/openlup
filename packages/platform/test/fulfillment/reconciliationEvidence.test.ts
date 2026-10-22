import { expect, it } from "vitest";
import { createProductReconciliationEvidenceHandler, createFulfillmentLowStockEvidenceHandler } from "../../src/fulfillment/index.js";
import { createBffResponder } from "../../src/bff/index.js";
import type { HttpRequest, HttpResponse } from "../../src/http/index.js";

it("keeps read-only method/auth/validation ordering and F8 authorization/read refusal detail", async () => {
  for (const product of [true, false]) {
    const trace: string[] = []; let authorizeFails = false, authorized = true, readFails = false;
    let output: unknown; let method = "GET";
    const deps = {
      respond: createBffResponder(),
      authorizeAdmin: async () => { trace.push("auth"); if (authorizeFails) throw new Error("synthetic-private-auth"); return authorized; },
      requestSchema: { safeParse: (_input: unknown) => { trace.push("parse"); return { success: true as const, data: { statusFilter: "open" } }; } },
      responseSchema: { safeParse: (input: unknown) => ({ success: true as const, data: input }) },
    };
    const read = async () => { trace.push("read"); if (readFails) throw new Error("synthetic-private-read"); return { rows: [] }; };
    const handler = product ? createProductReconciliationEvidenceHandler({ ...deps, evidencePort: { getProductReconciliationEvidence: read } }) : createFulfillmentLowStockEvidenceHandler({ ...deps, evidencePort: { getLowStockEvidence: read } });
    const response = { setHeader() {}, status() { return this; }, json(value: unknown) { output = value; return this; } } as unknown as HttpResponse;
    const run = () => handler({ method, query: { statusFilter: ["open", "resolved"] } } as unknown as HttpRequest, response);
    method = "POST"; await run(); expect(trace).toEqual([]); expect(output).toMatchObject({ error: { code: "METHOD_NOT_ALLOWED" } });
    method = "GET"; authorizeFails = true; await run();
    expect(output).toMatchObject({ error: { code: "UPSTREAM_UNAVAILABLE", ...(product ? { details: { reason: "product_reconciliation_authorization_unavailable" } } : {}) } });
    authorizeFails = false; authorized = false; await run(); expect(output).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    authorized = true; readFails = true; await run();
    expect(output).toMatchObject({ error: { code: "UPSTREAM_UNAVAILABLE", ...(product ? { details: { reason: "product_reconciliation_read_unavailable" } } : {}) } });
    readFails = false; trace.length = 0; await run(); expect(trace).toEqual(["auth", "parse", "read"]); expect(output).toEqual({ ok: true, data: { rows: [] } });
    expect(JSON.stringify(output)).not.toContain("synthetic-private");
  }
});
