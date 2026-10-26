import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfiguratorIntentPersistenceConflictError, runBestEffortAccountLink } from "../../src/commerce/server/index.js";
import { persistCheckoutIdentityOrRespond, createResponse, responder, intent, CLIENT_ID, ADDRESS_ID } from "./checkoutTestFixtures.js";
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe("checkout identity and best-effort hooks", () => {
  it("preserves the provisioned identity and stage, without any resume lookup on success", async () => {
    const provisioned = { clientId: CLIENT_ID, addressId: ADDRESS_ID, replayed: true }, persistIntent = vi.fn(async () => provisioned), recorded = vi.fn(), recordPersistStage = async <T>(operation: () => Promise<T>): Promise<T> => { recorded(); return operation(); };
    const result = await persistCheckoutIdentityOrRespond({ res: createResponse(), persistencePort: { persistIntent }, resumeGuardDeps: {}, intent: intent(), checkoutKind: "one_time", now: () => new Date(0), previewDiagnosticsEnabled: false, recordPersistStage });
    expect(result).toEqual({ kind: "provisioned", provisioned }); expect(persistIntent).toHaveBeenCalledExactlyOnceWith(intent()); expect(recorded).toHaveBeenCalledOnce();
  });
  it("refuses a conflict deterministically when no existing resumable identity is proved", async () => {
    const res = createResponse(); const result = await persistCheckoutIdentityOrRespond({ res, persistencePort: { persistIntent: vi.fn().mockRejectedValue(new ConfiguratorIntentPersistenceConflictError()) }, resumeGuardDeps: {}, intent: intent(), checkoutKind: "one_time", now: () => new Date(0), previewDiagnosticsEnabled: false, recordPersistStage: operation => operation() });
    expect(result).toEqual({ kind: "responded", outcome: "rejected" }); expect(res.status).toHaveBeenCalledWith(409); expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ details: { feature: "checkout", stage: "provision_identity", reason: "checkout_already_submitted" } }) }));
  });
  it("times out once with only the supplied trigger and clears the timer", async () => {
    vi.useFakeTimers(); const warn = vi.spyOn(console, "warn").mockImplementation(() => {}), hook = vi.fn(() => new Promise<void>(() => {}));
    const pending = runBestEffortAccountLink(hook, "buyer@example.test", { trigger: "checkout" }); await vi.advanceTimersByTimeAsync(1500); await pending;
    expect(hook).toHaveBeenCalledExactlyOnceWith("buyer@example.test"); expect(warn).toHaveBeenCalledExactlyOnceWith("checkout_account_link_timed_out", JSON.stringify({ trigger: "checkout" })); expect(vi.getTimerCount()).toBe(0);
  });
});
