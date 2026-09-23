import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateSubscriptionProfile } from "./subscriptionProfile.js";

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
function setup(text = config): NodeJS.ProcessEnv {
  const directory = mkdtempSync(join(tmpdir(), "reference-profile-test-"));
  scratch.push(directory);
  mkdirSync(join(directory, "supabase"));
  writeFileSync(join(directory, "supabase/config.toml"), text);
  writeFileSync(join(directory, "subscription-owner.json"), JSON.stringify({
    version: 2, projectId: "openlup-reference-test", portBase: 56420, phase: "sealed",
    boundContainerId: "a".repeat(64), instanceId, configSha256: sha256(text),
    baselineSha256: sha256(readFileSync(new URL("../../../supabase/migrations/00000000000000_platform_schema_baseline.sql", import.meta.url))),
  }));
  return {
    LOCAL_BFF: "1", OSS_REFERENCE_STORE_PROFILE: "local-supabase-demo-v1",
    OPENLUP_REFERENCE_DISPOSABLE: "1", OPENLUP_REFERENCE_PROJECT_ID: "openlup-reference-test",
    OPENLUP_REFERENCE_SUPABASE_DIR: directory, APP_BASE_URL: "http://127.0.0.1:56430",
    SUPABASE_URL: "http://127.0.0.1:56421", SUPABASE_ANON_KEY: "test-anon", SUPABASE_SERVICE_ROLE_KEY: "test-service",
    OSS_REFERENCE_PAYMENT_OUTCOME: "captured",
  };
}
afterEach(() => { vi.unstubAllGlobals(); for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true }); });

describe("disposable subscription admission", () => {
  it.each([
    { SUPABASE_URL: "https://project.example.test" }, { APP_BASE_URL: "http://external.example.test" },
    { NODE_ENV: "production" }, { VERCEL: "1" }, { RAILWAY_ENVIRONMENT: "preview" },
    { OPENLUP_REFERENCE_DISPOSABLE: "0" }, { OPENLUP_REFERENCE_PROJECT_ID: "another-project" },
    { OSS_REFERENCE_PAYMENT_OUTCOME: "succeeded" },
  ])("refuses unsuitable environment before a network or write", (change) => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect(() => validateSubscriptionProfile({ ...setup(), ...change })).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    config.replace("enable_confirmations = true", "enable_confirmations = false"),
    config + "[auth.email.smtp]\nenabled = true\n",
    config + "[auth.external.github]\nenabled = true\n",
    config.replace("port = 56421", "port = 54321"),
  ])("refuses unsafe captured configuration", (text) => {
    expect(() => validateSubscriptionProfile(setup(text))).toThrow();
  });
  it("requires live Auth confirmation, including after a configuration change", async () => {
    const checked = validateSubscriptionProfile(setup());
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ mailer_autoconfirm: false, external: { email: true, github: false } })));
    vi.stubGlobal("fetch", fetcher);
    await expect(checked.assertDisposable(async () => instanceId)).resolves.toBeUndefined();
    fetcher.mockResolvedValue(new Response(JSON.stringify({ mailer_autoconfirm: true, external: { email: true } })));
    await expect(checked.assertDisposable(async () => instanceId)).rejects.toThrow("captured email confirmation");
  });
  it("refuses a different live database at the same loopback port before Auth or a mutation", async () => {
    const checked = validateSubscriptionProfile(setup());
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(checked.assertDisposable(async () => "31f357fc-909c-4512-a34f-a263514cd91e"))
      .rejects.toThrow("Live database does not match");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("refuses a changed marker after startup", async () => {
    const env = setup();
    const checked = validateSubscriptionProfile(env);
    const path = join(env.OPENLUP_REFERENCE_SUPABASE_DIR!, "subscription-owner.json");
    const marker = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...marker, instanceId: "31f357fc-909c-4512-a34f-a263514cd91e" }));
    await expect(checked.assertDisposable(async () => instanceId)).rejects.toThrow("Live database does not match");
  });
  it("refuses an unsealed or wrong-port setup marker before a network call", () => {
    for (const change of [{ phase: "bound" }, { portBase: 56440 }, { configSha256: "0".repeat(64) }]) {
      const env = setup();
      const path = join(env.OPENLUP_REFERENCE_SUPABASE_DIR!, "subscription-owner.json");
      const marker = JSON.parse(readFileSync(path, "utf8"));
      writeFileSync(path, JSON.stringify({ ...marker, ...change }));
      expect(() => validateSubscriptionProfile(env)).toThrow("marker does not identify");
    }
  });
});
