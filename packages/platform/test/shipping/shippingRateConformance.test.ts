import { describe, expect, it, vi } from "vitest";
import { createBffResponder } from "@openlup/platform/bff";
import { createAdminShippingRateHandler, type AdminShippingRateHandlerDeps, type ShippingRateDataPort,
  type ShippingRateHandlerSchemas, type AdminShippingRateResponse, type AdminSetShippingRateRequest,
  type AdminSetShippingRateResponse } from "@openlup/platform/shipping";

function response() {
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
  res.status.mockReturnValue(res); res.json.mockReturnValue(res); return res;
}
function fixture() {
  const calls: string[] = [];
  const dataPort: ShippingRateDataPort = {
    getShippingFlatMinor: vi.fn(async () => { calls.push("read"); return 500; }),
    setShippingFlatMinor: vi.fn(async () => { calls.push("write"); }),
    recordPromotionAudit: vi.fn(async () => { calls.push("audit"); }),
  };
  const deps: AdminShippingRateHandlerDeps = {
    dataPort,
    authorizeAdmin: vi.fn(async () => ({ ok: true, userId: "operator", role: "admin", isMachineActor: false })),
    resolveAdmin: vi.fn(async (authorize) => { calls.push("authorize"); const auth = await authorize(); return auth.ok ? auth : null; }),
  };
  const accepted = <T>() => ({ safeParse: (input: unknown) => ({ success: true as const, data: input as T }) });
  const schemas: ShippingRateHandlerSchemas = {
    contractVersion: "commerce.v0",
    adminShippingRateResponseSchema: accepted<AdminShippingRateResponse>(),
    adminSetShippingRateRequestSchema: accepted<AdminSetShippingRateRequest>(),
    adminSetShippingRateResponseSchema: accepted<AdminSetShippingRateResponse>(),
  };
  const invoke = async (method: string, body?: unknown) => {
    const res = response();
    await createAdminShippingRateHandler(deps, schemas, createBffResponder())({ method, body } as never, res as never);
    return res;
  };
  return { calls, dataPort, deps, schemas, invoke };
}
const refused = { safeParse: (_input: unknown) => ({ success: false as const, error: { flatten: () => ({ policy: ["host refusal"] }) } }) };
describe("flat-rate shipping conformance", () => {
  it("refuses methods before authorization and authorization before mutation", async () => {
    const f = fixture();
    expect((await f.invoke("DELETE")).status).toHaveBeenCalledWith(405);
    expect(f.calls).toEqual([]);
    vi.mocked(f.deps.resolveAdmin).mockResolvedValueOnce(null);
    const denied = await f.invoke("POST", { shippingFlatMinor: 700 });
    expect(denied.json).not.toHaveBeenCalled();
    expect(f.dataPort.setShippingFlatMinor).not.toHaveBeenCalled();
    const read = await f.invoke("GET");
    expect(f.calls).toEqual(["authorize", "read"]);
    expect(read.json).toHaveBeenCalledWith({ ok: true, data: { contractVersion: "commerce.v0", shippingFlatMinor: 500 } });
  });
  it("honors substituted host amount policy and refuses planted values before writes and invalid read responses", async () => {
    const f = fixture();
    f.schemas.adminSetShippingRateRequestSchema = {
      safeParse: (input) => (input as AdminSetShippingRateRequest).shippingFlatMinor === 17
        ? { success: true, data: { shippingFlatMinor: 19 } } : refused.safeParse(input),
    };
    const plant = await f.invoke("POST", { shippingFlatMinor: 500 });
    expect(plant.status).toHaveBeenCalledWith(400);
    expect(plant.json).toHaveBeenCalledWith({ ok: false, error: { code: "BAD_REQUEST", message: "Invalid shipping rate request", details: { policy: ["host refusal"] } } });
    expect(f.dataPort.setShippingFlatMinor).not.toHaveBeenCalled();
    const substituted = await f.invoke("POST", { shippingFlatMinor: 17 });
    expect(f.dataPort.setShippingFlatMinor).toHaveBeenCalledWith(19);
    expect(substituted.json).toHaveBeenCalledWith({ ok: true, data: { contractVersion: "commerce.v0", updated: true, shippingFlatMinor: 19 } });
    f.schemas.adminShippingRateResponseSchema = refused;
    const invalid = await f.invoke("GET");
    expect(invalid.json).toHaveBeenCalledWith({ ok: false, error: { code: "INVALID_RESPONSE", message: "Shipping rate returned invalid response" } });
  });
  it("preserves write/audit/response order, best-effort audit and upstream/invalid-response mapping", async () => {
    const f = fixture();
    vi.mocked(f.dataPort.recordPromotionAudit).mockImplementationOnce(async () => { f.calls.push("audit"); throw new Error("offline"); });
    expect((await f.invoke("POST", { shippingFlatMinor: 700 })).status).toHaveBeenCalledWith(200);
    expect(f.calls.splice(0)).toEqual(["authorize", "write", "audit"]);
    expect(f.dataPort.recordPromotionAudit).toHaveBeenCalledWith({ actorId: "operator", actorEmail: null, action: "shipping_rate_change", promotionId: "shipping_flat_minor", newValue: { shippingFlatMinor: 700 } });
    f.schemas.adminSetShippingRateResponseSchema = refused;
    expect((await f.invoke("POST", { shippingFlatMinor: 700 })).json).toHaveBeenCalledWith({ ok: false, error: { code: "INVALID_RESPONSE", message: "Shipping rate set returned invalid response" } });
    vi.mocked(f.dataPort.setShippingFlatMinor).mockRejectedValueOnce(new Error("offline"));
    expect((await f.invoke("POST", { shippingFlatMinor: 700 })).json).toHaveBeenCalledWith({ ok: false, error: { code: "UPSTREAM_UNAVAILABLE", message: "Shipping rate set failed" } });
    vi.mocked(f.dataPort.getShippingFlatMinor).mockRejectedValueOnce(new Error("offline"));
    expect((await f.invoke("GET")).json).toHaveBeenCalledWith({ ok: false, error: { code: "UPSTREAM_UNAVAILABLE", message: "Shipping rate read failed" } });
  });
});
