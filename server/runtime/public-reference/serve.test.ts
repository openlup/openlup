import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as dataGateway from "../../adapters/supabase/dataGateway.js";
import * as customerAuth from "../../_lib/customer-domain/auth.js";
import { hashCustomerMagicLinkRateLimitKey } from "../../_lib/rate-limit/customerMagicLinkRateLimit.js";
import { createPublicReferenceServer } from "./serve.ts";

const scratch: string[] = [];
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), "public-reference-server-"));
  scratch.push(root);
  mkdirSync(join(root, "config"));
  mkdirSync(join(root, "dist", "items", "field-notes"), { recursive: true });
  mkdirSync(join(root, "dist", "assets"));
  writeFileSync(join(root, "config", "site-routes.json"), readFileSync("config/public-reference-site-routes.json", "utf8"));
  writeFileSync(join(root, "dist", "index.html"), "<h1>Reference collection</h1>");
  writeFileSync(join(root, "dist", "items", "field-notes", "index.html"), "<h1>Field notes</h1>");
  writeFileSync(join(root, "dist", "assets", "entry.js"), "console.log('public')");
  return root;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function live(options: Parameters<typeof createPublicReferenceServer>[0]) {
  const server = createPublicReferenceServer(options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function rawStatus(origin: string, path: string): Promise<number> {
  const target = new URL(origin);
  return new Promise((resolve, reject) => {
    const requestToServer = request({ host: target.hostname, port: target.port, path }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    requestToServer.once("error", reject);
    requestToServer.end();
  });
}

describe("public reference static root", () => {
  it("serves only declared generated documents and assets, including after a clean rebind", async () => {
    const root = temp();
    const first = await live({ root, distDir: "dist" });
    try {
      expect(await (await fetch(`${first.origin}/`)).text()).toContain("Reference collection");
      expect(await (await fetch(`${first.origin}/items/field-notes`)).text()).toContain("Field notes");
      expect((await fetch(`${first.origin}/assets/entry.js`)).status).toBe(200);
    } finally {
      await first.close();
    }
    const second = await live({ root, distDir: "dist" });
    try {
      expect(await (await fetch(`${second.origin}/items/field-notes`)).text()).toContain("Field notes");
    } finally {
      await second.close();
    }
  });

  it("fails closed for mutations, unknown paths, encoded traversal, and all withheld prefixes", async () => {
    const running = await live({ root: temp(), distDir: "dist" });
    try {
      const post = await fetch(`${running.origin}/`, { method: "POST" });
      expect(post.status).toBe(405);
      expect(post.headers.get("allow")).toBe("GET, HEAD");
      for (const path of ["/missing", "/api/anything", "/admin", "/subscribe/x", "/checkout", "/api/cron/x"]) {
        expect((await fetch(`${running.origin}${path}`)).status).toBe(404);
      }
      expect(await rawStatus(running.origin, "/%2e%2e")).toBe(404);
      expect(await rawStatus(running.origin, "//reference.invalid/")).toBe(404);
      expect(await rawStatus(running.origin, "/./")).toBe(404);
      expect(await rawStatus(running.origin, "/items/../")).toBe(404);
      expect(await rawStatus(running.origin, "/items\\..\\")).toBe(404);
      expect(await rawStatus(running.origin, "/items\\field-notes")).toBe(404);
      expect(await rawStatus(running.origin, "/#fragment")).toBe(404);
    } finally {
      await running.close();
    }
  });

  it("keeps GET representation lengths on bodyless HEAD responses", async () => {
    const running = await live({ root: temp(), distDir: "dist" });
    try {
      for (const path of ["/", "/healthz"]) {
        const get = await fetch(`${running.origin}${path}`);
        const head = await fetch(`${running.origin}${path}`, { method: "HEAD" });
        expect(head.status).toBe(get.status);
        expect(head.headers.get("content-length")).toBe(get.headers.get("content-length"));
        expect(await head.text()).toBe("");
      }
    } finally {
      await running.close();
    }
  });

  it("always sends the static security and noindex headers", async () => {
    const running = await live({ root: temp(), distDir: "dist" });
    try {
      const response = await fetch(`${running.origin}/`, { headers: { host: "host-does-not-matter.invalid" } });
      expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("x-robots-tag")).toContain("noindex");
    } finally {
      await running.close();
    }
  });
});

describe("public reference health", () => {
  it.each([
    ["absent", {}, { releaseSha: null, deploymentUrl: null }],
    ["blank", { APP_RELEASE_SHA: " ", APP_DEPLOYMENT_URL: "" }, { releaseSha: null, deploymentUrl: null }],
    ["malformed release with a valid deployment URL", { APP_RELEASE_SHA: "release sha", APP_DEPLOYMENT_URL: "https://release.invalid/path" }, { releaseSha: null, deploymentUrl: "https://release.invalid" }],
    ["valid release with a malformed deployment URL", { APP_RELEASE_SHA: "release:2026.08", APP_DEPLOYMENT_URL: "not a URL" }, { releaseSha: "release:2026.08", deploymentUrl: null }],
    ["valid release with a credential deployment URL", { APP_RELEASE_SHA: "release:2026.08", APP_DEPLOYMENT_URL: "https://name:secret@example.invalid" }, { releaseSha: "release:2026.08", deploymentUrl: null }],
    ["safe normalized", { APP_RELEASE_SHA: " release:2026.08 ", APP_DEPLOYMENT_URL: "https://release.invalid/path?query=1" }, { releaseSha: "release:2026.08", deploymentUrl: "https://release.invalid" }],
    ["fallback-shaped inputs ignored", { SSG_BUILD_SHA: "ssg", GITHUB_SHA: "github", VERCEL_URL: "compatibility.invalid", VERCEL_GIT_COMMIT_SHA: "compatibility" }, { releaseSha: null, deploymentUrl: null }],
  ])("uses only neutral APP values when they are %s", async (_label, env, expected) => {
    const running = await live({ root: temp(), distDir: "dist", env });
    try {
      const response = await fetch(`${running.origin}/healthz?APP_RELEASE_SHA=query`, { headers: { host: "host-fallback.invalid" } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok", ...expected });
    } finally {
      await running.close();
    }
  });
});

it("uses the live Node transport peer after request adaptation and dispatch", async () => {
  const root = temp();
  const site = "http://127.0.0.1:56430";
  const instanceId = "a9931d52-153f-49d4-a4ef-8d80f6dc56b8";
  const config = `project_id = "openlup-reference-test"
[api]
port = 56421
[auth]
site_url = "${site}"
[auth.email]
enable_confirmations = true
[inbucket]
enabled = true
`;
  const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  const baseline = readFileSync(new URL("../../../supabase/migrations/00000000000000_platform_schema_baseline.sql", import.meta.url));
  mkdirSync(join(root, "supabase"));
  writeFileSync(join(root, "supabase", "config.toml"), config);
  writeFileSync(join(root, "subscription-owner.json"), JSON.stringify({
    version: 2, projectId: "openlup-reference-test", portBase: 56420, phase: "sealed",
    boundContainerId: "a".repeat(64), instanceId, configSha256: hash(config), baselineSha256: hash(baseline),
  }));
  const localSettings = {
    from: () => ({ select: () => ({ eq: () => ({ limit: async () => ({ data: [{ value_text: instanceId }] }) }) }) }),
  };
  vi.spyOn(dataGateway, "createSupabaseDataGateway").mockReturnValue({
    asService: (work) => work(localSettings as never),
  } as ReturnType<typeof dataGateway.createSupabaseDataGateway>);
  const limit = vi.fn().mockResolvedValue({ data: { allowed: false, reason: "ip_quota" }, error: null });
  vi.spyOn(customerAuth, "createCustomerServiceClient").mockReturnValue({ rpc: limit } as never);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
    mailer_autoconfirm: false, external: { email: true },
  }))));
  vi.stubEnv("CUSTOMER_DIAGNOSTIC_TRUSTED_PROXY_HOPS", undefined);
  const running = await live({ root, distDir: "dist", env: {
    LOCAL_BFF: "1", OSS_REFERENCE_STORE_PROFILE: "local-supabase-demo-v1",
    OPENLUP_REFERENCE_PROFILE: "subscription", OPENLUP_REFERENCE_DISPOSABLE: "1",
    OPENLUP_REFERENCE_PROJECT_ID: "openlup-reference-test", OPENLUP_REFERENCE_SUPABASE_DIR: root,
    APP_BASE_URL: site, SUPABASE_URL: "http://127.0.0.1:56421",
    SUPABASE_ANON_KEY: "test-anon", SUPABASE_SERVICE_ROLE_KEY: "test-service", OSS_REFERENCE_PAYMENT_OUTCOME: "captured",
  } });
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const outbound = request(`${running.origin}/api/bff/customers/magic-link`, {
        method: "POST",
        headers: {
          host: new URL(site).host, origin: site, "content-type": "application/json",
          "x-forwarded-for": "203.0.113.9",
        },
      }, (res) => {
        res.resume();
        res.once("end", () => resolve(res.statusCode ?? 0));
      });
      outbound.once("error", reject);
      outbound.end(JSON.stringify({ email: "buyer@example.test" }));
    });
    expect(status).toBe(200);
    expect(limit).toHaveBeenCalledExactlyOnceWith("public_record_customer_magic_link_attempt", expect.objectContaining({
      p_ip_hash: hashCustomerMagicLinkRateLimitKey("127.0.0.1"),
    }));
  } finally {
    await running.close();
  }
});
