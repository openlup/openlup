import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { createLocalReferenceDemoSellableCatalogPort } from "../../adapters/localReferenceStoreAdapter.js";
import * as dataGateway from "../../adapters/supabase/dataGateway.js";
import * as customerAuth from "../../_lib/customer-domain/auth.js";
import { hashCustomerMagicLinkRateLimitKey } from "../../_lib/rate-limit/customerMagicLinkRateLimit.js";
import { hashCheckoutRateLimitKey } from "../../_lib/rate-limit/publicCheckoutRateLimit.js";
import { riskSubjectHash } from "../../domains/risk/riskFingerprint.js";
import { TRUSTED_PROXY_HOPS_ENV_KEY } from "../observability/clientAddressResolver.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSubscriptionProfile, OWNED_SUPABASE_CONFIG, validateSubscriptionProfile, subscriptionCsp, SUBSCRIPTION_CSP } from "./subscriptionProfile.js";

const scratch: string[] = [];
const instanceId = "a9931d52-153f-49d4-a4ef-8d80f6dc56b8";
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const config = `project_id = "openlup-reference-test"
[api]
port = 56421
[auth]
site_url = "http://127.0.0.1:56430"
[auth.email]
enable_confirmations = true
[inbucket]
enabled = true
`;
// A stand-in for the flattened baseline, so admission is tested without the public tree's 2.8 MB artifact.
const BASELINE_FIXTURE = "-- baseline fixture\n";
const validate = (env: NodeJS.ProcessEnv) => validateSubscriptionProfile(env, join(env.OPENLUP_REFERENCE_SUPABASE_DIR!, "baseline.sql"));
function setup(text = config, baseline = BASELINE_FIXTURE): NodeJS.ProcessEnv {
  const directory = mkdtempSync(join(tmpdir(), "reference-profile-test-"));
  scratch.push(directory);
  mkdirSync(join(directory, "supabase"));
  writeFileSync(join(directory, ...OWNED_SUPABASE_CONFIG), text);
  writeFileSync(join(directory, "baseline.sql"), baseline);
  writeFileSync(join(directory, "subscription-owner.json"), JSON.stringify({
    version: 2, projectId: "openlup-reference-test", portBase: 56420, phase: "sealed",
    boundContainerId: "a".repeat(64), instanceId, configSha256: sha256(text),
    baselineSha256: sha256(baseline),
  }));
  return {
    LOCAL_BFF: "1", OSS_REFERENCE_STORE_PROFILE: "local-supabase-demo-v1",
    OPENLUP_REFERENCE_DISPOSABLE: "1", OPENLUP_REFERENCE_PROJECT_ID: "openlup-reference-test",
    OPENLUP_REFERENCE_SUPABASE_DIR: directory, APP_BASE_URL: "http://127.0.0.1:56430",
    SUPABASE_URL: "http://127.0.0.1:56421", SUPABASE_ANON_KEY: "test-anon", SUPABASE_SERVICE_ROLE_KEY: "test-service",
    OSS_REFERENCE_PAYMENT_OUTCOME: "captured",
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true });
});

describe("disposable subscription admission", () => {
  it.each([
    { SUPABASE_URL: "https://project.example.test" }, { APP_BASE_URL: "http://external.example.test" },
    { NODE_ENV: "production" }, { VERCEL: "1" }, { RAILWAY_ENVIRONMENT: "preview" },
    { OPENLUP_REFERENCE_DISPOSABLE: "0" }, { OPENLUP_REFERENCE_PROJECT_ID: "another-project" },
    { OSS_REFERENCE_PAYMENT_OUTCOME: "succeeded" },
  ])("refuses unsuitable environment before a network or write", (change) => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const env = setup();
    expect(() => validate({ ...env, ...change })).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    config.replace("enable_confirmations = true", "enable_confirmations = false"),
    config + "[auth.email.smtp]\nenabled = true\n",
    config + "[auth.external.github]\nenabled = true\n",
    config.replace("port = 56421", "port = 54321"),
  ])("refuses unsafe captured configuration", (text) => {
    const env = setup(text);
    expect(() => validate(env)).toThrow();
  });
  it("requires live Auth confirmation, including after a configuration change", async () => {
    const checked = validate(setup());
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ mailer_autoconfirm: false, external: { email: true, github: false } })));
    vi.stubGlobal("fetch", fetcher);
    await expect(checked.assertDisposable(async () => instanceId)).resolves.toBeUndefined();
    fetcher.mockResolvedValue(new Response(JSON.stringify({ mailer_autoconfirm: true, external: { email: true } })));
    await expect(checked.assertDisposable(async () => instanceId)).rejects.toThrow("captured email confirmation");
  });
  it("refuses a different live database at the same loopback port before Auth or a mutation", async () => {
    const checked = validate(setup());
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(checked.assertDisposable(async () => "31f357fc-909c-4512-a34f-a263514cd91e"))
      .rejects.toThrow("Live database does not match");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("refuses a changed marker after startup", async () => {
    const env = setup();
    const checked = validate(env);
    const path = join(env.OPENLUP_REFERENCE_SUPABASE_DIR!, "subscription-owner.json");
    const marker = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...marker, instanceId: "31f357fc-909c-4512-a34f-a263514cd91e" }));
    await expect(checked.assertDisposable(async () => instanceId)).rejects.toThrow("Live database does not match");
  });
  it("reads the captured configuration from the owned directory", () => {
    expect(OWNED_SUPABASE_CONFIG).toEqual(["supabase", "config.toml"]);
    const env = setup();
    const path = join(env.OPENLUP_REFERENCE_SUPABASE_DIR!, ...OWNED_SUPABASE_CONFIG);
    rmSync(path);
    expect(() => validate(env)).toThrow(path);
  });
  it("refuses an unsealed or wrong-port setup marker before a network call", () => {
    for (const change of [{ phase: "bound" }, { portBase: 56440 }, { configSha256: "0".repeat(64) }]) {
      const env = setup();
      const path = join(env.OPENLUP_REFERENCE_SUPABASE_DIR!, "subscription-owner.json");
      const marker = JSON.parse(readFileSync(path, "utf8"));
      writeFileSync(path, JSON.stringify({ ...marker, ...change }));
      expect(() => validate(env)).toThrow("marker does not identify");
    }
  });
});

it("adds exactly the validated configured auth origin to connect-src", () => {
  const checked = validate(setup());
  expect(subscriptionCsp(checked.authOrigin)).toBe(`${SUBSCRIPTION_CSP} http://127.0.0.1:56421`);
  expect(subscriptionCsp(checked.authOrigin).split("connect-src ")[1]).toBe("'self' http://127.0.0.1:56421");
});
it.each([undefined, "", "https://external.invalid", "http://127.0.0.1:56421/path", "http://user@127.0.0.1:56421", "http://127.0.0.1:56421/?unsafe=1"])("unvalidated or missing origin %j adds nothing to CSP", (value) => {
  expect(subscriptionCsp(value)).toBe(SUBSCRIPTION_CSP);
});

function profileWithTrustedHop() {
  const baseline = readFileSync(new URL("../../../supabase/migrations/00000000000000_platform_schema_baseline.sql", import.meta.url), "utf8");
  const env = setup(config, baseline);
  env[TRUSTED_PROXY_HOPS_ENV_KEY] = "1";
  const rpc = vi.fn();
  const service = {
    rpc,
    from: () => ({ select: () => ({ eq: () => ({ limit: async () => ({ data: [{ value_text: instanceId }] }) }) }) }),
  };
  vi.spyOn(dataGateway, "createSupabaseDataGateway").mockReturnValue({
    asService: (work) => work(service as never),
  } as ReturnType<typeof dataGateway.createSupabaseDataGateway>);
  vi.spyOn(customerAuth, "createCustomerServiceClient").mockReturnValue(service as never);
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json({
    mailer_autoconfirm: false, external: { email: true },
  })));
  return { profile: createSubscriptionProfile(env), rpc };
}

async function postToProfile(
  profile: ReturnType<typeof createSubscriptionProfile>,
  path: string,
  body: unknown,
  forwardedFor: string,
) {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: "POST",
    headers: {
      host: new URL(profile.origin).host, origin: profile.origin, "content-type": "application/json",
      "x-forwarded-for": forwardedFor,
    },
    socket: { remoteAddress: "192.0.2.10" },
  }) as unknown as IncomingMessage;
  const end = vi.fn();
  const res = { setHeader: vi.fn(), hasHeader: () => false, end, statusCode: 200 } as unknown as ServerResponse;
  await profile.handle(req, res, path);
  return { res, end };
}

it("uses the profile's selected hop count instead of the ambient count", async () => {
  vi.stubEnv(TRUSTED_PROXY_HOPS_ENV_KEY, "2");
  const { profile, rpc } = profileWithTrustedHop();
  rpc.mockResolvedValue({ data: { allowed: false, reason: "ip_quota" }, error: null });

  const { res, end } = await postToProfile(profile, "/api/bff/customers/magic-link", {
    email: "buyer@example.test",
  }, "203.0.113.8, 198.51.100.9");

  expect(rpc).toHaveBeenCalledExactlyOnceWith("public_record_customer_magic_link_attempt", expect.objectContaining({
    p_ip_hash: hashCustomerMagicLinkRateLimitKey("198.51.100.9"),
  }));
  expect(res.statusCode).toBe(200);
  expect(end).toHaveBeenCalledOnce();
});

it("uses the profile's selected hop for both the captured checkout limiter and blocklist", async () => {
  const selectedAddress = "198.51.100.9";
  const secret = "synthetic-risk-hash-key";
  vi.stubEnv(TRUSTED_PROXY_HOPS_ENV_KEY, undefined);
  vi.stubEnv("OSS_REFERENCE_PAYMENT_OUTCOME", "captured");
  vi.stubEnv("COMMERCE_RISK_EVALUATION_ENABLED", "true");
  vi.stubEnv("COMMERCE_RISK_CHECKOUT_BLOCKLIST_BLOCKING_ENABLED", "true");
  vi.stubEnv("COMMERCE_RISK_HASH_SECRET", secret);
  const { profile, rpc } = profileWithTrustedHop();
  rpc
    .mockResolvedValueOnce({ data: { allowed: true, attempts_by_ip: 1, attempts_by_email: 1 }, error: null })
    .mockResolvedValueOnce({ data: { blocked: true }, error: null });
  const catalog = createLocalReferenceDemoSellableCatalogPort();
  const { currency, country } = await catalog.getStorefrontProfile();
  const [item] = await catalog.listSellableItems();

  const { res } = await postToProfile(profile, "/api/bff/commerce/checkouts", { command: {
    version: "commerce.checkout_command.v1", idempotencyKey: "reference-checkout-001",
    mode: "subscription", cadenceDays: 30, currency,
    lines: [{ sku: item.sku, quantity: 1 }],
    customer: { firstName: "Alex", lastName: "Taylor", email: "buyer@example.test", phone: "+12025550123" },
    shippingAddress: { street: "1 Reference Way", postalCode: "10001", city: "Reference City", country },
  } }, selectedAddress);

  expect.soft(rpc).toHaveBeenNthCalledWith(1, "public_record_checkout_attempt", expect.objectContaining({
    p_ip_hash: hashCheckoutRateLimitKey(selectedAddress),
  }));
  expect.soft(rpc).toHaveBeenNthCalledWith(2, "risk_check_exact_blocklist", {
    p_subject_refs: expect.arrayContaining([{ subjectKind: "ip", subjectHash: riskSubjectHash("ip", selectedAddress, secret) }]),
  });
  expect(res.statusCode).toBe(403);
});
