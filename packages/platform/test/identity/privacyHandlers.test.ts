import { expect, it, vi } from "vitest";
import type { HttpRequest, HttpResponse } from "../../src/http/index.js";
import { createPrivacyExportHandler, createPrivacyEraseHandler } from "../../src/identity/privacyHandlers.js";
import { PrivacyRefusal, type PrivacyOperations } from "../../src/identity/privacyPorts.js";
import type { AdminAuthorizationResult } from "../../src/identity/ports.js";
const ID = "11111111-1111-4111-8111-111111111111";
function fixture(auth: AdminAuthorizationResult = { ok: true, role: "admin", principalId: ID, isMachineActor: false }) {
  const response = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() }; response.status.mockReturnValue(response);
  const operations: PrivacyOperations = { export: vi.fn(), erase: vi.fn() };
  return { response, res: response as unknown as HttpResponse, deps: { authorizeAdmin: async () => auth, operations }, req: { method: "POST", body: { subject: { kind: "contact", contactId: ID }, idempotencyKey: ID } } as HttpRequest };
}
it("both privacy POSTs require live human admin authority including explicit machine status", async () => {
  for (const factory of [createPrivacyExportHandler, createPrivacyEraseHandler]) {
    for (const auth of [{ ok: false, code: "UNAUTHORIZED", message: "required" }, { ok: true, role: "distributor", principalId: ID, isMachineActor: false }, { ok: true, role: "admin", principalId: ID, isMachineActor: true }, { ok: true, role: "admin", principalId: ID }] as AdminAuthorizationResult[]) {
      const f = fixture(auth); await factory(f.deps)(f.req, f.res);
      expect(f.response.status).toHaveBeenCalledWith(!auth.ok ? 401 : 403);
      expect(f.deps.operations.erase).not.toHaveBeenCalled(); expect(f.deps.operations.export).not.toHaveBeenCalled();
      expect(f.response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    }
  }
});
it.each([["PRIVACY_ACTIVE_SUBSCRIPTION", 409], ["MANAGED_PRIVACY_ERASURE_UNAVAILABLE", 503], ["PRIVACY_SUBJECT_NOT_FOUND", 404]] as const)("maps %s to safe structured refusal", async (code, status) => {
  const f = fixture(); vi.mocked(f.deps.operations.erase).mockRejectedValue(new PrivacyRefusal(code));
  await createPrivacyEraseHandler(f.deps)(f.req, f.res);
  expect(f.response.status).toHaveBeenCalledWith(status);
  expect(f.response.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ details: { privacyCode: code } }) }));
});
it("invalid requests, methods and adapter errors never return partial exports or raw diagnostics", async () => {
  const f = fixture(); f.req.body = { subject: { kind: "contact", contactId: ID } };
  vi.mocked(f.deps.operations.export).mockRejectedValue(new Error("SELECT private credentials"));
  await createPrivacyExportHandler(f.deps)(f.req, f.res);
  expect(JSON.stringify(f.response.json.mock.calls)).not.toContain("SELECT");
  f.req.body = {}; await createPrivacyEraseHandler(f.deps)(f.req, f.res); expect(f.response.status).toHaveBeenLastCalledWith(400);
  f.req.method = "GET"; await createPrivacyExportHandler(f.deps)(f.req, f.res); expect(f.response.status).toHaveBeenLastCalledWith(405);
});
