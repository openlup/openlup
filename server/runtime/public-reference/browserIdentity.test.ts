import { createHash } from "node:crypto";
import { Socket } from "node:net";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublicReferenceServer } from "./serve.js";

const scratch: string[] = [];
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), "reference-browser-composition-"));
  scratch.push(root);
  mkdirSync(join(root, "config"));
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "config", "site-routes.json"), readFileSync("config/public-reference-site-routes.json", "utf8"));
  writeFileSync(join(root, "dist", "index.html"), "<h1>Reference collection</h1>");
  return root;
};
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true });
});

function subscriptionSetup(root: string) {
  const owned = join(root, "owned");
  mkdirSync(join(owned, "supabase"), { recursive: true });
  const config = `project_id = "browser-reference-test"
[api]
port = 56421
[auth]
site_url = "http://127.0.0.1:56430"
[auth.email]
enable_confirmations = true
[inbucket]
enabled = true
`;
  writeFileSync(join(owned, "supabase", "config.toml"), config);
  const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  writeFileSync(join(owned, "subscription-owner.json"), JSON.stringify({ version: 2, phase: "sealed", projectId: "browser-reference-test", portBase: 56420, boundContainerId: "a".repeat(64), instanceId: "11111111-1111-4111-8111-111111111111", configSha256: sha256(config), baselineSha256: sha256(readFileSync("supabase/migrations/00000000000000_platform_schema_baseline.sql")) }));
  writeFileSync(join(root, "dist", "index.html"), '<html data-openlup-profile="subscription"><div id="root">static</div></html>');
  return { OPENLUP_REFERENCE_PROFILE: "subscription", LOCAL_BFF: "1", OSS_REFERENCE_STORE_PROFILE: "local-supabase-demo-v1", OPENLUP_REFERENCE_DISPOSABLE: "1", OPENLUP_REFERENCE_PROJECT_ID: "browser-reference-test", OPENLUP_REFERENCE_SUPABASE_DIR: owned, APP_BASE_URL: "http://127.0.0.1:56430", SUPABASE_URL: "http://127.0.0.1:56421", SUPABASE_ANON_KEY: "synthetic-public-key", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-key", OSS_REFERENCE_PAYMENT_OUTCOME: "captured" };
}
function composed(options: Parameters<typeof createPublicReferenceServer>[0]) {
  const server = createPublicReferenceServer(options);
  return {
    read(path: string, bearer?: string): Promise<{ status: number; csp: string; body: string }> {
      return new Promise((resolve) => {
        const req = new IncomingMessage(new Socket());
        req.method = "GET"; req.url = path;
        req.headers = { host: "127.0.0.1:56430", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) };
        req.push(null);
        const res = new ServerResponse(req);
        res.writeHead = ((status: number, headers: Record<string, string>) => {
          res.statusCode = status;
          for (const [name, value] of Object.entries(headers ?? {})) res.setHeader(name, value);
          return res;
        }) as typeof res.writeHead;
        res.end = ((body: string | Buffer = "") => {
          resolve({ status: res.statusCode, csp: String(res.getHeader("content-security-policy")), body: String(body) });
          return res;
        }) as typeof res.end;
        server.emit("request", req, res);
      });
    },
    close: async () => { server.removeAllListeners(); },
  };
}

describe("subscription browser composition", () => {
  it("serves only selected localized auth pages with exactly the configured auth connect origin", async () => {
    const root = temp();
    const running = composed({ root, env: subscriptionSetup(root) });
    try {
      for (const path of ["/sign-in", "/zaloguj-sie", "/account/auth/callback", "/konto/auth/callback", "/account", "/konto"]) {
        const result = await running.read(path);
        expect(result.status).toBe(200);
        expect(result.body).toContain('<div id="root"></div>');
        expect(result.csp.split("connect-src ")[1]).toBe("'self' http://127.0.0.1:56421");
        expect(result.csp).not.toContain("frame-src");
        expect(result.csp).toContain("form-action 'self';");
      }
      expect((await running.read("/account/orders")).status).toBe(404);
    } finally { await running.close(); }
  });
  it("mounts GET own-profile through the identity handler with the customer bearer, never the service reader", async () => {
    const root = temp(); const env = subscriptionSetup(root);
    const clientsRead = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/auth/v1/settings") return new Response(JSON.stringify({ mailer_autoconfirm: false, external: { email: true } }));
      if (url.pathname === "/rest/v1/commerce_settings") return new Response(JSON.stringify([{ value_text: "11111111-1111-4111-8111-111111111111" }]));
      if (url.pathname === "/auth/v1/user") return new Response(JSON.stringify({ id: "22222222-2222-4222-8222-222222222222", email: "customer@example.com", email_confirmed_at: "2026-01-01T00:00:00Z" }));
      if (url.pathname === "/rest/v1/clients") {
        clientsRead(new Headers(init?.headers).get("authorization"));
        return new Response(JSON.stringify({ id: "33333333-3333-4333-8333-333333333333", email: "customer@example.com", first_name: null, last_name: null, lifecycle_stage: "customer" }));
      }
      throw new Error("Unexpected external transport");
    }));
    const running = composed({ root, env });
    try {
      const anonymous = await running.read("/api/bff/customers/me");
      expect(anonymous.status).toBe(401);
      expect(clientsRead).not.toHaveBeenCalled();
      const own = await running.read("/api/bff/customers/me", "synthetic-customer-bearer");
      expect(own.status).toBe(200);
      expect(JSON.parse(own.body)).toMatchObject({ ok: true, data: { clientId: "33333333-3333-4333-8333-333333333333" } });
      expect(clientsRead).toHaveBeenCalledExactlyOnceWith("Bearer synthetic-customer-bearer");
      expect((await running.read("/api/bff/customers/verify-otp")).status).toBe(404);
    } finally { await running.close(); }
  });
  it("default static profile refuses every auth page and own-profile endpoint", async () => {
    const running = composed({ root: temp(), env: {} });
    try {
      for (const path of ["/sign-in", "/zaloguj-sie", "/account/auth/callback", "/konto/auth/callback", "/konto", "/api/bff/customers/me"]) expect((await running.read(path)).status).toBe(404);
    } finally { await running.close(); }
  });
});
