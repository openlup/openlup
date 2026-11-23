import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The public route policy (server/_lib/publicDeploymentPolicies.ts) refuses
// every mutation route until an adopter supplies its own; this file tests the
// route behind an adopter policy that admits it.
vi.mock("#deployment-route-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#deployment-route-policy")>()),
  enforceDeploymentRoutePolicy: () => true,
}));

const mocks = vi.hoisted(() => ({ readGateway: vi.fn(), startCheckout: vi.fn() }));
vi.mock("../../adapters/localReferenceStoreAdapter.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/localReferenceStoreAdapter.js")>()),
  createLocalReferenceCheckoutRuntimePort: () => ({ startCheckoutCommand: mocks.startCheckout }),
}));
vi.mock("./serviceDataGateway.js", () => ({
  readCommerceServiceDataGateway: mocks.readGateway,
}));

import { createLocalReferenceDemoSellableCatalogPort } from "../../adapters/localReferenceStoreAdapter.js";
import { HOSTED_RUNTIME_MARKER_KEY } from "../../adapters/vercel/runtimeProvenance.js";
import type { CheckoutCommandV1 } from "../../../src/domains/commerce/checkoutCommandContracts.js";
import { hashCheckoutRateLimitKey } from "../../_lib/rate-limit/publicCheckoutRateLimit.js";
import { riskSubjectHash } from "../../domains/risk/riskFingerprint.js";
import handler from "./checkouts.js";
import type { HttpRequest, HttpResponse } from "../../_lib/types/http.js";

const clientA = "192.0.2.10";
const clientB = "192.0.2.11";
const secret = "synthetic-risk-hash-key";
function request(command: CheckoutCommandV1, remoteAddress: string, headers: HttpRequest["headers"]): HttpRequest {
  return { method: "POST", body: { command }, headers, query: {}, socket: { remoteAddress } } as HttpRequest;
}

function configureCheckout(blockedAddress: string, currency: string) {
  vi.stubEnv("OSS_REFERENCE_STORE_PROFILE", "local-supabase-demo-v1");
  vi.stubEnv("LOCAL_BFF", "1");
  vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("COMMERCE_RISK_EVALUATION_ENABLED", "true");
  vi.stubEnv("COMMERCE_RISK_CHECKOUT_BLOCKLIST_BLOCKING_ENABLED", "true");
  vi.stubEnv("COMMERCE_RISK_HASH_SECRET", secret);
  const blockedHash = riskSubjectHash("ip", blockedAddress, secret);
  const rpc = vi.fn(async (name: string, args: { p_subject_refs?: { subjectKind: string; subjectHash: string }[] }) => {
    if (name === "public_record_checkout_attempt") {
      return { data: { allowed: true, attempts_by_ip: 1, attempts_by_email: 1 }, error: null };
    }
    if (name === "risk_check_exact_blocklist") {
      const blocked = args.p_subject_refs?.some((ref) => ref.subjectKind === "ip" && ref.subjectHash === blockedHash);
      return { data: { blocked }, error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
  mocks.readGateway.mockReturnValue({ asService: (work: (client: { rpc: typeof rpc }) => unknown) => work({ rpc }) });
  mocks.startCheckout.mockResolvedValue({
    persistence: { replayed: false }, settlement: null,
    runtime: { runtime: {
      clientId: "11111111-1111-4111-8111-111111111111", orderId: "22222222-2222-4222-8222-222222222222",
      total: { amountMinor: 1490, currency },
      payment: { paymentIntentId: "33333333-3333-4333-8333-333333333333", paymentAttemptId: null, status: "processing", attemptStatus: null },
    } },
  });
  return rpc;
}

function response(): HttpResponse {
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() } as unknown as HttpResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

describe("local reference checkout BFF composition", () => {
  const originalProfile = process.env.OSS_REFERENCE_STORE_PROFILE;

  beforeEach(() => {
    mocks.readGateway.mockReset();
    mocks.startCheckout.mockReset();
    vi.stubEnv("CUSTOMER_DIAGNOSTIC_TRUSTED_PROXY_HOPS", undefined);
    vi.stubEnv(HOSTED_RUNTIME_MARKER_KEY, undefined);
    delete process.env.OSS_REFERENCE_STORE_PROFILE;
  });

  afterEach(() => vi.unstubAllEnvs());

  it("returns 404 before reading the service gateway when the local profile is inactive", async () => {
    const res = response();
    await handler({ method: "POST", body: {}, headers: {}, query: {} } as unknown as HttpRequest, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: "NOT_FOUND" }),
    }));
    expect(mocks.readGateway).not.toHaveBeenCalled();
  });

  it("keys quota and blocklist on the peer, blocking only the listed client", async () => {
    const { currency, country } = await createLocalReferenceDemoSellableCatalogPort().getStorefrontProfile();
    const command: CheckoutCommandV1 = {
      version: "commerce.checkout_command.v1", idempotencyKey: "reference-checkout-001",
      mode: "subscription", cadenceDays: 30, currency,
      lines: [{ sku: "NORTHSTAR-REFILL-001", quantity: 1 }],
      customer: { firstName: "Alex", lastName: "Taylor", email: "alex@example.test", phone: "+12025550123" },
      shippingAddress: { street: "1 Reference Way", postalCode: "10001", city: "Reference City", country },
    };
    const rpc = configureCheckout(clientA, currency);
    const blocked = response();
    const admitted = response();
    await handler(request(command, clientA, { "x-forwarded-for": clientB }), blocked);
    await handler(request(command, clientB, { "x-forwarded-for": clientA }), admitted);

    for (const [index, address] of [clientA, clientB].entries()) {
      expect.soft(rpc).toHaveBeenNthCalledWith(2 * index + 1, "public_record_checkout_attempt", expect.objectContaining({
        p_ip_hash: hashCheckoutRateLimitKey(address),
      }));
      expect.soft(rpc).toHaveBeenNthCalledWith(2 * index + 2, "risk_check_exact_blocklist", {
        p_subject_refs: expect.arrayContaining([{ subjectKind: "ip", subjectHash: riskSubjectHash("ip", address, secret) }]),
      });
    }
    expect.soft(blocked.status).toHaveBeenCalledWith(403);
    expect.soft(admitted.status).toHaveBeenCalledWith(200);
    expect(mocks.startCheckout).toHaveBeenCalledTimes(1);
  });

  // Keep the parent process clean for test files that follow in the shared
  // Vitest worker, even when this module is run alone.
  afterAll(() => {
    if (originalProfile === undefined) delete process.env.OSS_REFERENCE_STORE_PROFILE;
    else process.env.OSS_REFERENCE_STORE_PROFILE = originalProfile;
  });
});
