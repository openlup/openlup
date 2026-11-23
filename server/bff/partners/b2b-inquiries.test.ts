import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpRequest, HttpResponse } from "../../_lib/types/http.js";

const { direct, directHandler, rpc } = vi.hoisted(() => ({
  direct: { enabled: true },
  directHandler: vi.fn(async () => undefined),
  rpc: vi.fn(),
}));

vi.mock("../../_lib/observability/route.js", () => ({
  withObservedRoute: (_options: unknown, routeHandler: unknown) => routeHandler,
}));
vi.mock("./partnerAcquisitionDirect.js", () => ({
  isDirectPartnerAcquisitionBundle: () => direct.enabled,
  createPartnerAcquisitionSubmitHandler: () => directHandler,
}));
vi.mock("../../_lib/admin-domain/auth.js", () => ({ createServiceRoleClient: () => ({ rpc }) }));
import handler from "./b2b-inquiries.js";

describe("partners B2B inquiries public BFF route", () => {
  it("loads through the observed public route wrapper", () => {
    expect(handler).toBeTypeOf("function");
  });

  it("executes the mounted direct route branch", async () => {
    const req = { method: "GET", headers: {}, query: {} };
    const res = {};
    await handler(req as never, res as never);
    expect(directHandler).toHaveBeenCalledWith(req, res);
  });
});

const trustedHops = "CUSTOMER_DIAGNOSTIC_TRUSTED_PROXY_HOPS";
const peer = "192.0.2.7";
const otherPeer = "192.0.2.8";
const forwarded = "198.51.100.7";
const otherForwarded = "198.51.100.8";
const submitRpc = "public_submit_b2b_inquiry";

describe("managed B2B inquiry quota", () => {
  beforeEach(() => {
    direct.enabled = false;
    vi.stubEnv(trustedHops, undefined);
    vi.stubEnv("VERCEL", undefined);
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role");
    vi.stubEnv("RESEND_PROVIDER_MODE", "sandbox");
    vi.stubEnv("RESEND_SANDBOX_API_KEY", "test-sandbox-key");
    vi.stubEnv("B2B_NOTIFICATION_EMAIL", "");
    rpc.mockImplementation(async (name: string) => name === submitRpc
      ? { data: [{ allowed: true, inquiry_id: "inq-1" }], error: null }
      : { data: { allowed: false, reason: "test_policy" }, error: null });
  });

  afterEach(() => {
    direct.enabled = true;
    rpc.mockReset();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("sends the peer digest to the RPC for requests with different forwarding values", async () => {
    await submitInquiry(peer, forwarded);
    await submitInquiry(peer, otherForwarded);
    await submitInquiry(otherPeer, forwarded);

    expect(rpcAddresses()).toEqual([digest(peer), digest(peer), digest(otherPeer)]);
  });

  it("sends the declared hop digest to the RPC", async () => {
    vi.stubEnv(trustedHops, "2");
    await submitInquiry(peer, `${forwarded}, 203.0.113.7:12345, 192.0.2.1`);

    expect(rpcAddresses()).toEqual([digest("203.0.113.7")]);
  });

  it("uses one shared digest when hop configuration is malformed", async () => {
    vi.stubEnv(trustedHops, "invalid");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await submitInquiry(peer, forwarded);
    await submitInquiry(otherPeer, otherForwarded);

    expect(rpcAddresses()).toEqual([digest("unknown"), digest("unknown")]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("OPENLUP_E_TRUSTED_PROXY_HOPS_INVALID"));
  });

  it("maps RPC quota refusal to 429 before notification policy", async () => {
    rpc.mockResolvedValueOnce({ data: [{ allowed: false, inquiry_id: null }], error: null });
    const res = await submitInquiry(peer, forwarded);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: false, error: expect.objectContaining({ code: "RATE_LIMITED" }),
    }));
    expect(rpc).toHaveBeenCalledOnce();
  });
});

function digest(address: string) {
  return createHash("sha256").update(address).digest("hex");
}

function rpcAddresses() {
  return rpc.mock.calls.filter(([name]) => name === submitRpc).map(([, parameters]) => parameters.p_ip_hash);
}

async function submitInquiry(address: string, forwarding: string) {
  const req = {
    method: "POST",
    headers: { "x-forwarded-for": forwarding, "cf-connecting-ip": "203.0.113.2" },
    query: {},
    socket: { remoteAddress: address },
    body: { company: "Example Studio", country: "US", firstName: "Ada", lastName: "Example", email: "ada@studio.example" },
  } as unknown as HttpRequest;
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as HttpResponse;
  vi.mocked(res.status).mockReturnValue(res);
  await handler(req, res);
  return res;
}
