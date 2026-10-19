import { expect, it, vi } from "vitest";
import { createCommunicationPurposeRegistry } from "../../src/communications/consentPurposeRegistry.js";
import { evaluateCommunicationPolicy } from "../../src/communications/consentPolicy.js";
import { createCommunicationPreferenceToken, verifyCommunicationPreferenceToken } from "../../src/communications/preferencesToken.js";
import { createNewsletterIntegrationSchemas, normalizeCanonicalNewsletterWebhookEvent } from "../../src/communications/newsletterIntegrationContracts.js";
import { createRegisteredPublicPreferenceTokenPort } from "../../src/communications/publicPreferenceToken.js";
import { processNewsletterWebhookEvent } from "../../src/communications/newsletterWebhookProcessing.js";
import type { NewsletterWebhookPort } from "../../src/communications/contracts/newsletterWebhook.js";
import { runCommunicationSyncDispatch } from "../../src/communications/communicationSyncWorker.js";
import { fullNewsletterProviderCapabilities } from "../../src/communications/newsletterIntegrationContracts.js";

const registry = createCommunicationPurposeRegistry([{ id: "custom_updates", classification: "marketing" }, { id: "custom_notice", classification: "non-marketing" }]);
const secret = "synthetic-local";
it.each([
  [{ id: "", classification: "marketing" }], [{ id: "  ", classification: "marketing" }],
  [{ id: " padded", classification: "marketing" }], [{ id: "missing" }],
  [{ id: "custom", classification: "marketing" }, { id: "custom", classification: "marketing" }],
  [{ id: "marketing_newsletter", classification: "non-marketing" }],
  [{ id: "transactional", classification: "marketing" }],
])("C1 invalid purpose declarations refuse: %j", (...additions) => {
  expect(() => createCommunicationPurposeRegistry(additions as never)).toThrow("communication_purpose_definition_invalid");
});
it("C1 immutable copied definitions cannot be changed after composition", () => {
  const additions = [{ id: "custom", classification: "marketing" as const }]; const r = createCommunicationPurposeRegistry(additions);
  additions[0].id = "changed";
  expect(r.has("custom")).toBe(true); expect(r.has("changed")).toBe(false);
  expect(Object.isFrozen(r)).toBe(true); expect(Object.isFrozen(r.purposes)).toBe(true); expect(r.purposes.every(Object.isFrozen)).toBe(true);
});
it.each(["custom_updates", "custom_notice", "transactional", "tester_program", "marketing_launch_offer", "marketing_newsletter", "subscription_dunning", "admin_notification"] as const)("C3 registered token round trip: %s", purpose => {
  const token = createCommunicationPreferenceToken({ email: " Reader@Example.invalid ", purpose, expiresAt: 100 }, secret);
  expect(verifyCommunicationPreferenceToken(token, secret, 100, registry)).toEqual({ email: "reader@example.invalid", purpose, expiresAt: 100 });
  expect(verifyCommunicationPreferenceToken(token, secret, 101, registry)).toBeNull();
  expect(verifyCommunicationPreferenceToken(token, "wrong", 100, registry)).toBeNull();
  expect(verifyCommunicationPreferenceToken(token, "", 100, registry)).toBeNull();
  expect(verifyCommunicationPreferenceToken(token + "x", secret, 100, registry)).toBeNull();
});
it("C3/C4 unregistered signed identifiers fail closed; registration never grants marketing permission", () => {
  const token = createCommunicationPreferenceToken({ email: "reader@example.invalid", purpose: "unknown", expiresAt: 100 }, secret);
  expect(verifyCommunicationPreferenceToken(token, secret, 10, registry)).toBeNull();
  expect(evaluateCommunicationPolicy({ purpose: "unknown", recipientKind: "customer", permission: { state: "granted" } }, registry)).toEqual({ decision: "blocked", reason: "unsupported_purpose" });
  for (const state of [null, "unknown", "denied", "suppressed", "granted"] as const) {
    expect(evaluateCommunicationPolicy({ purpose: "custom_updates", recipientKind: "customer", permission: state ? { state } : null }, registry)).toEqual({ decision: state === "granted" ? "allowed" : "blocked", reason: state === "granted" ? "marketing_permission_granted" : state === "suppressed" ? "permission_suppressed" : "missing_marketing_permission" });
    expect(evaluateCommunicationPolicy({ purpose: "custom_notice", recipientKind: "customer", permission: state ? { state } : null }, registry)).toEqual({ decision: "allowed", reason: "purpose_allowed_without_marketing_consent" });
  }
});
it("C5 default registry preserves every built-in special policy branch", () => {
  for (const definition of registry.purposes.slice(0, 6)) for (const state of ["unknown", "granted", "denied", "suppressed"] as const) for (const legacySequencePaused of [false, true]) {
    const input = { purpose: definition.id, recipientKind: "tester" as const, permission: { state, legacySequencePaused } };
    expect(evaluateCommunicationPolicy(input, registry)).toEqual(evaluateCommunicationPolicy(input));
  }
});
it.each(["custom_updates", "custom_notice"] as const)("C6/C7 schema → feedback permission → sync retains %s", async purpose => {
  const schemas = createNewsletterIntegrationSchemas(registry);
  const event = normalizeCanonicalNewsletterWebhookEvent(schemas.webhookEvent.parse({ providerKind: "synthetic", providerEventId: "event:1", eventType: "unsubscribe", purpose }));
  const writes: unknown[] = [];
  const port: NewsletterWebhookPort<typeof purpose> = {
    async recordProviderEvent(input) { writes.push(["event", input.purpose]); return { providerEventId: "row:1", contactId: "contact:1", inserted: true }; },
    async recordPermission(input) { writes.push(["permission", input.purpose, input.state]); },
    async markProviderEvent(input) { writes.push(["settle", input.status]); },
  };
  await processNewsletterWebhookEvent({ providerKind: "synthetic", event, port, registry });
  await runCommunicationSyncDispatch({ registry, store: {
    async claimBatch() { return [{ id: "sync:1", claimToken: "claim:1", contactId: "contact:1", normalizedEmail: "reader@example.invalid", eventType: "unsubscribe", purpose, payload: {}, attemptCount: 0 }]; },
    async markSent(input) { writes.push(["sync-settle", input.claimToken]); return true; }, async markFailed() { throw Error("unexpected retry"); },
  }, provider: { providerKind: "synthetic", capabilities: fullNewsletterProviderCapabilities, async sync(input) { writes.push(["sync", input.purpose]); return { status: "sent" }; } } });
  expect(writes).toEqual([["event", purpose], ["permission", purpose, "suppressed"], ["settle", "processed"], ["sync", purpose], ["sync-settle", "claim:1"]]);
  expect(schemas.purpose.safeParse("unknown").success).toBe(false);
});
it("C7/C8 explicit unregistered feedback refuses before writes; default fan-out remains exactly two", async () => {
  const writes: string[] = [];
  const port: NewsletterWebhookPort<string> = { async recordProviderEvent() { writes.push("event"); return { inserted: true, contactId: "contact:1", providerEventId: "row:1" }; }, async recordPermission(input) { writes.push(input.purpose); }, async markProviderEvent() { writes.push("settle"); } };
  const event = normalizeCanonicalNewsletterWebhookEvent({ providerKind: "synthetic", providerEventId: "event:1", eventType: "unsubscribe", purpose: "unknown" });
  await expect(processNewsletterWebhookEvent({ providerKind: "synthetic", event, port, registry })).rejects.toThrow("unregistered_communication_purpose"); expect(writes).toEqual([]);
  await processNewsletterWebhookEvent({ providerKind: "synthetic", event: { ...event, purpose: null }, port, registry });
  expect(writes).toEqual(["event", "marketing_launch_offer", "marketing_newsletter", "settle"]);
});
it("C9 explicit persistence receives exact non-marketing definition and no implicit sync effect", async () => {
  const persist = vi.fn(async () => ({ updated: true }));
  const port = createRegisteredPublicPreferenceTokenPort({ registry, persist });
  const payload = { email: "reader@example.invalid", purpose: "custom_notice" as const, expiresAt: 100 };
  expect(await port.updatePreference(payload, "suppressed")).toEqual({ updated: true });
  expect(persist.mock.calls).toEqual([[payload, "suppressed", { id: "custom_notice", classification: "non-marketing" }]]);
  await expect(port.updatePreference({ ...payload, purpose: "unknown" as never }, "suppressed")).rejects.toThrow("unregistered_communication_purpose"); expect(persist).toHaveBeenCalledTimes(1);
  await expect(port.updatePreference(payload, "granted" as never)).rejects.toThrow("communication_preference_state_invalid"); expect(persist).toHaveBeenCalledTimes(1);
});

it("C6 registered dispatch refuses an unregistered batch before any provider effect or settlement", async () => {
  const calls: string[] = [];
  await expect(runCommunicationSyncDispatch({ registry, store: {
    async claimBatch() { calls.push("claim"); return [{ id: "sync:1", claimToken: "claim:1", contactId: "contact:1", normalizedEmail: "reader@example.invalid", eventType: "subscribe", purpose: "unknown", payload: {}, attemptCount: 0 }]; },
    async markSent() { calls.push("sent"); return true; }, async markFailed() { calls.push("failed"); return true; },
  }, provider: { providerKind: "synthetic", capabilities: fullNewsletterProviderCapabilities, async sync() { calls.push("effect"); return { status: "sent" }; } } })).rejects.toThrow("unregistered_communication_purpose");
  expect(calls).toEqual(["claim"]);
});
