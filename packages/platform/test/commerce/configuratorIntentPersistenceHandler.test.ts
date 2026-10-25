import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createConfiguratorIntentPersistenceHandler, ConfiguratorIntentPersistenceConflictError } from "../../src/commerce/server/index.js";
import { createResponse, request, responder } from "./checkoutTestFixtures.js";
const requestSchema = z.object({ id: z.string().min(1) }).strict(), responseSchema = z.object({ id: z.string().min(1), replayed: z.boolean() }).strict();
describe("generic configurator persistence HTTP binding", () => {
  it("parses once, delegates the exact admitted request and reports the parsed response", async () => {
    const persistIntent = vi.fn(async () => ({ id: "identity-a", replayed: true })), res = createResponse();
    await createConfiguratorIntentPersistenceHandler({ requestSchema, responseSchema, responder, persistencePort: { persistIntent } })(request("POST", { id: "input-a" }), res);
    expect(persistIntent).toHaveBeenCalledExactlyOnceWith({ id: "input-a" }); expect(res.status).toHaveBeenCalledWith(200); expect(res.json).toHaveBeenCalledWith({ ok: true, data: { id: "identity-a", replayed: true }, meta: { contractVersion: "commerce.configurator_intent_persistence.v1" } });
  });
  it.each(["method", "request", "response", "conflict", "upstream"] as const)("keeps the %s refusal", async kind => {
    const persistIntent = vi.fn(async () => ({ id: "identity-a", replayed: false })), res = createResponse();
    if (kind === "response") persistIntent.mockResolvedValueOnce({ id: "", replayed: false });
    if (kind === "conflict") persistIntent.mockRejectedValueOnce(new ConfiguratorIntentPersistenceConflictError("conflict", { reason: "same_key" }));
    if (kind === "upstream") persistIntent.mockRejectedValueOnce(new Error("unavailable"));
    await createConfiguratorIntentPersistenceHandler({ requestSchema, responseSchema, responder, persistencePort: { persistIntent } })(request(kind === "method" ? "GET" : "POST", kind === "request" ? {} : { id: "input-a" }), res);
    expect(res.status).toHaveBeenCalledWith({ method: 405, request: 400, response: 502, conflict: 409, upstream: 503 }[kind]);
    if (kind === "method" || kind === "request") expect(persistIntent).not.toHaveBeenCalled();
  });
});
