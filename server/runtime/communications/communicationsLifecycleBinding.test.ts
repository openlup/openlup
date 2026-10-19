import { expect, it } from "vitest";
import { createCommunicationsLifecycleBinding } from "./communicationsLifecycleBinding.js";
const provider = { providerKind: "synthetic",capabilities: { subscribe: true,unsubscribe: true,suppress: true,unsuppress: false,doubleOptIn: false,emailChange: false,listMembership: false,webhookIdempotency: false,retryAfter: false },sync: async () => ({ status: "sent" as const }) };
it("refuses every unselected or missing native configuration without a fallback", () => {
  for (const env of [{}, { PLATFORM_BUNDLE: "node-postgres" }, { PLATFORM_BUNDLE: "supabase",DATABASE_URL: "postgresql://unused.invalid/synthetic" }]) {
    expect(() => createCommunicationsLifecycleBinding(env, { binding: "synthetic",provider,operatorId: "verified-host" })).toThrow("native_communications_bundle_required");
  }
});
it("closes a failed native operation and exposes no scheduler", async () => {
  let releases = 0, closes = 0;
  const pool = { connect: async () => ({ query: async (sql: string) => { if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [] }; throw new Error("synthetic query refused"); },release: () => { releases++; } }),end: async () => { closes++; } };
  const binding = createCommunicationsLifecycleBinding({ PLATFORM_BUNDLE: "node-postgres",DATABASE_URL: "injected" }, { binding: "synthetic",provider,operatorId: "verified-host",poolFactory: () => pool as never });
  await expect(binding.readDeliveryEvidence("synthetic")).rejects.toThrow("synthetic query refused");
  expect({ releases,closes }).toEqual({ releases: 1,closes: 1 });
  expect(Object.keys(binding)).toEqual(["registerNetworkTarget","readDeliveryEvidence","reconcileDelivery","registerSyncWork","dispatchSync","withRecipients","evaluateConsent"]);
});
