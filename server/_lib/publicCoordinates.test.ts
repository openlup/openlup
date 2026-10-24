import { tpayPaymentCapabilities } from "@openlup/platform/payments/tpay";
import { describe, expect, it, vi } from "vitest";
import siteRoutesManifest from "../../config/site-routes.json" with { type: "json" };
import { isCanonicalTpayProductionCallbackUrl } from "../infra/tpay/tpayEnvironment.js";
import { buildTpayAdapterIfEnabled, unattendedChargeCapability } from "../adapters/tpay/tpayAdapterFactory.js";
import { createPaymentProviderReadbackRegistry } from "../runtime/paymentProviderReadbackRegistry.js";
import { runPlatformWatchdogRoute, platformAlertEnvironment } from "../ops/platformWatchdog.js";
import { createSupabaseObservabilityEvidencePort } from "../adapters/supabase/platform/observabilityEvidencePort.js";

vi.mock("../adapters/supabase/platform/observabilityEvidencePort.js", () => ({
  createSupabaseObservabilityEvidencePort: vi.fn(() => ({ collectSnapshot: vi.fn() })),
}));

const codeKind = unattendedChargeCapability.providerKind as keyof ReturnType<typeof createPaymentProviderReadbackRegistry>;

describe("configured public coordinates", () => {
  it("admits only HTTPS callbacks on an explicitly listed production host", () => {
    const hosts = ["shop.example", "WWW.SHOP.EXAMPLE"];
    expect(isCanonicalTpayProductionCallbackUrl("https://shop.example/notify", hosts)).toBe(true);
    expect(isCanonicalTpayProductionCallbackUrl("https://www.shop.example/return", hosts)).toBe(true);
    for (const url of ["http://shop.example/notify", "https://preview.shop.example/notify",
      "https://shop.example.attacker.example/notify", "https://user@shop.example/notify", "invalid"]) {
      expect(isCanonicalTpayProductionCallbackUrl(url, hosts)).toBe(false);
    }
    expect(isCanonicalTpayProductionCallbackUrl("https://shop.example/notify", [])).toBe(false);
  });

  it("uses the configured hosts for both live execution and recovery admission", async () => {
    const origin = `https://${siteRoutesManifest.productionHosts[0]}`;
    const env = {
      PAYMENTS_TPAY_ENABLED: "true", PAYMENTS_TPAY_PRODUCTION_ENABLED: "true",
      TPAY_PRODUCTION_CONFIRMED: "true", TPAY_API_BASE_URL: "https://api.tpay.com",
      TPAY_CLIENT_ID: "fixture-client", TPAY_CLIENT_SECRET: "fixture-secret",
      TPAY_NOTIFICATION_URL: `${origin}/notify`, TPAY_SUCCESS_URL: `${origin}/success?retained=1`,
      TPAY_ERROR_URL: `${origin}/error?retained=2`,
    };
    expect(buildTpayAdapterIfEnabled(env)?.mode).toBe("production");
    expect(createPaymentProviderReadbackRegistry(env)[codeKind]).toBeDefined();
    for (const key of ["TPAY_NOTIFICATION_URL", "TPAY_SUCCESS_URL", "TPAY_ERROR_URL"]) {
      const invalid = { ...env, [key]: "https://unlisted.example/return" };
      expect(buildTpayAdapterIfEnabled(invalid)).toBeNull();
      expect(createPaymentProviderReadbackRegistry(invalid)[codeKind]).toBeUndefined();
    }
    const executionInput = { idempotencyKey: "host", providerIdempotencyKey: "host-key", providerRequestFingerprint: "host-fingerprint",
      paymentIntentId: "intent-host", amountMinor: 1490, currency: tpayPaymentCapabilities.supportedCurrencies[0]!, mode: "one_time" as const, orderRef: "order_abc" };
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      const posted: Record<string, unknown>[] = [];
      fetch.mockImplementation(async (url, init) => {
        if (String(url).endsWith("/oauth/auth")) return Response.json({ access_token: "fixture", expires_in: 3600 });
        posted.push(JSON.parse(String(init?.body)));
        return Response.json({ transactionId: "api-id", title: "notification-id", status: "pending", transactionPaymentUrl: "https://example.test/pay", payments: {} });
      });
      const bankCode = buildTpayAdapterIfEnabled(env)!;
      for (const returnContext of ["public", "account"] as const) {
        const observed = await bankCode.adapter.execute({ ...executionInput,
          orderId: "order-id", clientId: "client-id", petId: "pet-id", returnContext, customerRef: "fixture@example.test",
          transientProviderInput: { provider: "tpay", flow: "pbl_one_time", channelId: "1" } });
        expect(observed).toMatchObject({ provider: "tpay", providerAttemptId: "notification-id", providerSessionId: "api-id" });
        const body = posted.at(-1)!;
        const callbacks = body.callbacks as { payerUrls: { success: string; error: string } };
        for (const [key, retained] of [["success", "1"], ["error", "2"]] as const) {
          const target = new URL(callbacks.payerUrls[key]);
          expect(target.origin).toBe(origin);
          expect(target.pathname).toBe(returnContext === "account" ? "/konto/zamowienie/status" : key === "success" ? "/success" : "/error");
          expect(Object.fromEntries(target.searchParams)).toEqual({ retained, orderId: "order-id", paymentIntentId: executionInput.paymentIntentId,
            clientId: "client-id", ...(returnContext === "account" ? { pet: "pet-id" } : {}), order: "order_abc" });
          expect(target.searchParams.has("subject")).toBe(false);
        }
        expect(body.payer).toMatchObject({ email: "fixture@example.test", name: "openlup customer" });
      }
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally { fetch.mockRestore(); }
    expect(buildTpayAdapterIfEnabled({ ...env, TPAY_PRODUCTION_CONFIRMED: "false" })).toBeNull();
    expect(createPaymentProviderReadbackRegistry({ ...env, TPAY_PRODUCTION_CONFIRMED: "false" })[codeKind]).toBeUndefined();
  });

  it("passes configured production hosts into watchdog email evidence", async () => {
    const result = await runPlatformWatchdogRoute(
      { method: "GET", headers: { authorization: "Bearer fixture-cron" }, query: { checkOnly: "true" } } as never,
      { CRON_SECRET: "fixture-cron", SUPABASE_URL: "https://database.example",
        SUPABASE_SERVICE_ROLE_KEY: "fixture-service", OPENLUP_ENVIRONMENT: "preview" },
      new Date("2026-09-26T00:00:00Z"),
      () => ({ asService: async (work: (client: never) => unknown) => work({} as never) }) as never,
      vi.fn(),
      async () => ({
        ok: true, health: "healthy", checkOnly: true, checkedAt: "2026-09-26T00:00:00Z",
        alertCount: 0, firingCount: 0, actionableCriticalCount: 0, suppressedCriticalCount: 0,
        actionablePageableCount: 0, maxSeverity: null, decisions: [], notified: 0,
        notificationFailures: 0, deliveryBackoffCount: 0, throttledNotifications: 0,
        skippedNotifications: 0, belowThreshold: 0, suppressed: 0, muted: 0, resolved: 0,
      }),
    );
    expect(result.status).toBe(200);
    expect(result.body.environment).toBe("preview");
    expect(createSupabaseObservabilityEvidencePort).toHaveBeenCalledWith(
      expect.anything(), expect.anything(),
      expect.objectContaining({ emailProductionHosts: siteRoutesManifest.productionHosts }),
    );
    expect(platformAlertEnvironment({ OPENLUP_ENVIRONMENT: " staging ", VERCEL_ENV: "preview" })).toBe("staging");
  });
});
