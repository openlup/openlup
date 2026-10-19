import { readCustomerRouteEnv } from "../../bff/customers/shared.js";
import { Readable } from "node:stream";
import { Server } from "node:http";
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { RouteEntry } from "@openlup/platform/bff";
import type { CandidateIdentity, SchemaObject } from "@openlup/core/readiness";
import { createVerifierResultOnlyEmailTrustPolicy } from "@openlup/platform/identity";
import { createReferenceIdentity, admitReferenceIdentity, type ReferenceIdentityAdmission, type ReferenceIdentityPorts } from "./referenceIdentity.js";
import { identityRequiredSchema, type IdentityBundle } from "./identitySchema.js";
import { readManagedMigrationChain } from "../../../scripts/public-ci-pgtap.mjs";
import { startPublicReferenceServer, createPublicReferenceServer } from "../public-reference/serve.js";

const policy = vi.hoisted(() => ({ allow: false }));
vi.mock("#deployment-route-policy", async importOriginal => {
  const original = await importOriginal<typeof import("../../_lib/publicDeploymentPolicies.js")>();
  return { ...original, enforceDeploymentRoutePolicy: (...args: Parameters<typeof original.enforceDeploymentRoutePolicy>) => policy.allow || original.enforceDeploymentRoutePolicy(...args) };
});
const candidate: CandidateIdentity = { artifact: "synthetic", configuration: "synthetic", environment: "test", database: "owned", schema: "complete" };
// These presence facts come from the shipped DDL, never from a requested inventory.
function catalogue(bundle: IdentityBundle): Set<string> {
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as { baseline: { file: string }; forward: { file: string }[] };
  const sources: string[] = bundle === "node-postgres"
    ? [manifest.baseline, ...manifest.forward].map(entry => readFileSync(entry.file, "utf8"))
    : readManagedMigrationChain(process.cwd()).map((entry: { contents: string }) => entry.contents);
  const objects = new Set<string>();
  for (const source of sources) {
    const sql = source.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([\w.]+)\s*\(([\s\S]*?)\n\);/gi)) {
      objects.add(`table:${match[1]}`);
      for (const line of match[2].split("\n")) {
        const column = /^\s*"?(\w+)"?\s+(?:uuid|text|character|boolean|integer|bigint|jsonb|timestamp|timestamptz|date|numeric|smallint|double|bytea)\b/i.exec(line);
        if (column) objects.add(`column:${match[1]}.${column[1]}`);
      }
    }
    for (const match of sql.matchAll(/ALTER TABLE (?:ONLY )?([\w.]+)\s+ADD COLUMN (?:IF NOT EXISTS )?(\w+)/gi)) objects.add(`column:${match[1]}.${match[2]}`);
    for (const match of sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION ([\w.]+)\(([\s\S]*?)\)\s*RETURNS/gi)) {
      const signature = match[2].split(",").filter(value => value.trim()).map(value => value.trim().replace(/^\w+\s+/, "").replace(/\s+DEFAULT[\s\S]*/i, "").replace(/timestamptz/gi, "timestamp with time zone")).join(",");
      objects.add(`function:${match[1]}(${signature})`);
    }
  }
  return objects;
}
const objectKey = (object: SchemaObject) => `${object.kind}:${object.name}${object.kind === "function" ? `(${object.signature ?? ""})` : ""}`;
// Auth is owned by the managed runtime, outside its public migration chain.
// These fixed external observations are only a readiness fixture; the managed DB proof probes them live.
const managedAuth = new Set(["function:auth.uid()", "table:auth.users", "column:auth.users.id", "column:auth.users.email", "column:auth.users.email_confirmed_at"]);
function selectedPorts(): ReferenceIdentityPorts {
  return {
    emailTrustPolicy: createVerifierResultOnlyEmailTrustPolicy(),
    customerSession: { verifyAccessToken: vi.fn(async () => null) }, customerProfile: { getCustomerMe: vi.fn(async () => null) },
    operatorAuthorization: { authorize: vi.fn(async () => ({ ok: true as const, principalId: "11111111-1111-4111-8111-111111111111", role: "admin" as const, isMachineActor: false })) },
    operatorActions: { inviteAdminUser: vi.fn(), removeAdminUser: vi.fn() },
    delivery: { deliver: vi.fn(async () => {}) }, privacy: { export: vi.fn(), erase: vi.fn() },
  };
}
function admission(bundle: IdentityBundle): ReferenceIdentityAdmission {
  vi.stubEnv("PLATFORM_BUNDLE", bundle);
  const runtime = createReferenceIdentity({ bundle, env: readCustomerRouteEnv(), migrationIdentity: "complete", ports: selectedPorts(),
    createRoutes: ports => [
      { route: "/api/bff/customers/reconcile-account", pattern: /^\/api\/bff\/customers\/reconcile-account$/, params: [],
        handler: async () => { await ports.customerProfile.getCustomerMe("11111111-1111-4111-8111-111111111111"); } },
      ...(["export", "erase"] as const).map((operation): RouteEntry => ({ route: `/api/bff/admin/identity/privacy/${operation}`, pattern: new RegExp(`^/api/bff/admin/identity/privacy/${operation}$`), params: [], ...(bundle === "node-postgres" ? { availability: "direct-postgres" as const } : {}),
        handler: async (_req, res) => {
          const actor = { principalId: "11111111-1111-4111-8111-111111111111" };
          const subject = { kind: "contact" as const, contactId: "22222222-2222-4222-8222-222222222222" };
          if (operation === "export") await ports.privacy.export(actor, subject);
          else await ports.privacy.erase(actor, { subject, idempotencyKey: "33333333-3333-4333-8333-333333333333" });
          res.status(200).json({ ok: true });
        } })),
    ],
  });
  const present = catalogue(bundle);
  return { runtime, candidate, currentIdentity: () => candidate, observed: { inventoryComplete: true, loadedPackages: [
    { name: "@openlup/core", version: "0.98.7", kind: "kernel" }, { name: "@openlup/platform", version: "0.98.7", kind: "rail" },
  ] }, schemaProbe: { observe: async requirement => ({ database: "owned", version: "complete", objects: requirement.objects.map(object => ({ object,
    present: present.has(objectKey(object)) || (bundle === "node-supabase" && managedAuth.has(objectKey(object))) })) }) } };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it.each(["node-postgres", "node-supabase"] as const)("admits %s with its selected inventory and actual installed version", async bundle => {
  const input = admission(bundle);
  const observed = vi.spyOn(input.schemaProbe, "observe");
  const result = await admitReferenceIdentity(input);
  expect(result.report.state, JSON.stringify(result.report.issues)).toBe("ready"); expect(result.report.issues).toEqual([]);
  expect(result.report.loadedPackages.find(pkg => pkg.name === "@openlup/platform")).toMatchObject({ version: "0.98.7", modules: ["bff", "data", "kernel", "http", "identity"] });
  expect(observed).toHaveBeenCalledWith(identityRequiredSchema(bundle, "complete"));
});
it.each(["node-postgres", "node-supabase"] as const)("refuses every absent required object for %s", async bundle => {
  const input = admission(bundle);
  const observe = input.schemaProbe.observe;
  for (const missing of input.runtime.requiredSchema.objects) {
    input.schemaProbe.observe = async requirement => {
      const result = await observe(requirement);
      return { ...result, objects: result.objects.map(entry => ({ ...entry, present: entry.object !== missing && entry.present })) };
    };
    const result = await admitReferenceIdentity(input);
    expect(result.admitted, JSON.stringify(missing)).toBe(false);
    expect(result.report.issues).toContainEqual(expect.objectContaining({ module: "identity", observation: "object_absent" }));
  }
});
it("keeps the inventories disjoint and pins fields used by each bundle", () => {
  const direct = identityRequiredSchema("node-postgres", "complete").objects.map(object => object.name);
  const managed = identityRequiredSchema("node-supabase", "complete").objects.map(object => object.name);
  expect(direct).toEqual(expect.arrayContaining(["public.clients.principal_id", "public.identity_privacy_erasures.dispositions", "public.identity_operator_invitations.expires_at", "public.operator_identity_challenges.used_at", "public.subscriptions.status"]));
  expect(managed).toEqual(expect.arrayContaining(["auth.users.email_confirmed_at", "public.admin_users.membership_state", "public.customer_magic_link_attempts.email_hash"]));
  expect(direct.some(name => name.startsWith("public.admin_users") || name.startsWith("auth.users"))).toBe(false);
  expect(managed.some(name => /platform_human|operator_identity|identity_privacy|identity_operator/.test(name))).toBe(false);
});
it("refuses a registered route replaced with an unrelated function", async () => {
  const input = admission("node-postgres"); input.runtime.routes[0].handler = async () => {};
  expect((await admitReferenceIdentity(input)).report.issues).toContainEqual(expect.objectContaining({ module: "identity", code: "OPENLUP_E_PORT_MISSING", subject: "/api/bff/customers/reconcile-account" }));
});
it.each(["customerSession", "customerProfile", "operatorAuthorization", "operatorActions", "delivery", "privacy"] as const)("refuses missing %s binding", async key => {
  const input = admission("node-postgres"); Reflect.deleteProperty(input.runtime.ports, key);
  expect((await admitReferenceIdentity(input)).report.issues).toContainEqual(expect.objectContaining({ module: "identity", code: "OPENLUP_E_PORT_MISSING", subject: key }));
});
it.each([null, "other-chain"])("cannot infer migration history from matching objects (%s)", async version => {
  const input = admission("node-postgres"), observe = input.schemaProbe.observe;
  input.schemaProbe.observe = async requirement => ({ ...await observe(requirement), version });
  expect((await admitReferenceIdentity(input)).report.state).toBe(version === null ? "unknown" : "unsatisfied");
});
it.each(["EMAIL_TRUST_ENVELOPE_REFUSED", "EMAIL_TRUST_SETTINGS_UNAVAILABLE"] as const)("awaits email trust and refuses before listening: %s", async code => {
  const input = admission("node-supabase");
  const assess = vi.fn(async () => ({ trusted: false as const, code, reason: "synthetic" })); input.runtime.ports.emailTrustPolicy = { assess };
  const result = await admitReferenceIdentity(input);
  expect(result.report.state).toBe(code === "EMAIL_TRUST_SETTINGS_UNAVAILABLE" ? "unknown" : "unsatisfied");
  expect(result.report.issues).toContainEqual(expect.objectContaining({ observation: code, module: "identity" }));
  // A nonexistent root would throw during server construction if admission were bypassed.
  await expect(startPublicReferenceServer({ root: "/missing-reference.invalid", identity: input })).rejects.toThrow(/identity candidate refused before listener/);
  expect(assess).toHaveBeenCalledTimes(2);
});
it("refuses stale admission and legacy whole-platform outbox composition", async () => {
  const input = admission("node-postgres"), result = await admitReferenceIdentity(input);
  input.currentIdentity = () => ({ ...candidate, schema: "changed" }); expect(result.assertCurrent).toThrow(/stale/);
  await expect(startPublicReferenceServer({ identity: input, outbox: {} as never })).rejects.toThrow(/candidate refused|contributions together/);
});
it("keeps the public default profile static", () => {
  const root = mkdtempSync(join(tmpdir(), "identity-default-"));
  try {
    mkdirSync(join(root, "config")); writeFileSync(join(root, "config/site-routes.json"), readFileSync("config/public-reference-site-routes.json"));
    const server = createPublicReferenceServer({ root, env: {} });
    const request = { url: "/api/bff/customers/reconcile-account", method: "POST", headers: {} };
    const response = { writeHead: vi.fn(), end: vi.fn() };
    server.emit("request", request, response);
    expect(response.writeHead).toHaveBeenCalledWith(405, expect.anything());
    expect(response.end).toHaveBeenCalledWith("Method not allowed\n");
    server.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.each(["node-postgres", "node-supabase"] as const)("starts %s only after admission and denies HTTP before buffering input", async bundle => {
  const root = mkdtempSync(join(tmpdir(), "identity-startup-"));
  try {
    mkdirSync(join(root, "config")); writeFileSync(join(root, "config/site-routes.json"), readFileSync("config/public-reference-site-routes.json"));
    const input = admission(bundle), order: string[] = [];
    const observe = input.schemaProbe.observe;
    input.schemaProbe.observe = async requirement => { order.push("schema"); return observe(requirement); };
    input.runtime.ports.emailTrustPolicy = { assess: async () => { order.push("email"); return { trusted: true }; } };
    const listen = vi.spyOn(Server.prototype, "listen").mockImplementation(function(this: Server, ...args: unknown[]) {
      order.push("listen"); (args.at(-1) as () => void)(); return this;
    } as typeof Server.prototype.listen);
    const server = await startPublicReferenceServer({ root, env: readCustomerRouteEnv(), identity: input });
    expect(order).toEqual(["schema", "email", "listen"]); expect(listen).toHaveBeenCalledOnce();
    const readInput = vi.fn(() => { throw new Error("input must stay unread"); });
    const req = { url: "/api/bff/customers/reconcile-account", method: "POST", headers: {}, [Symbol.asyncIterator]: readInput };
    const res = { statusCode: 0, setHeader: vi.fn(), hasHeader: vi.fn(() => true), end: vi.fn() };
    server.emit("request", req, res);
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.end.mock.calls[0][0])).toMatchObject({ error: { details: { reason: "adopter_policy_required" } } });
    expect(readInput).not.toHaveBeenCalled();
    expect(input.runtime.ports.customerProfile.getCustomerMe).not.toHaveBeenCalled();
    server.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.each(["node-postgres", "node-supabase"] as const)("refuses the %s inventory when the host selects the other bundle", async bundle => {
  const root = mkdtempSync(join(tmpdir(), "identity-bundle-"));
  try {
    mkdirSync(join(root, "config")); writeFileSync(join(root, "config/site-routes.json"), readFileSync("config/public-reference-site-routes.json"));
    const input = admission(bundle);
    await expect(startPublicReferenceServer({ root, env: { ...readCustomerRouteEnv(), PLATFORM_BUNDLE: bundle === "node-postgres" ? "node-supabase" : "node-postgres" }, identity: input })).rejects.toThrow(/bundle does not match/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.each(["node-postgres", "node-supabase"] as const)("every %s public requirement exists in its committed SQL catalogue", bundle => {
  const present = catalogue(bundle);
  for (const object of identityRequiredSchema(bundle, "complete").objects.filter(object => !object.name.startsWith("auth.") || bundle === "node-postgres")) {
    expect(present.has(objectKey(object)), objectKey(object)).toBe(true);
  }
});
it("covers invitation writes and managed soft-link lookup columns independently of the inventory", () => {
  const direct = new Set(identityRequiredSchema("node-postgres", "complete").objects.map(objectKey));
  const source = readFileSync("packages/platform/src/identity/directOperatorInvitationStore.ts", "utf8");
  const inserts = [...source.matchAll(/INSERT INTO public.identity_operator_invitations\s*\(([^)]+)\)/g)];
  expect(inserts.length).toBeGreaterThan(0);
  for (const match of inserts) for (const column of match[1].split(",").map(value => value.trim())) expect(direct.has(`column:public.identity_operator_invitations.${column}`), column).toBe(true);
  const managed = new Set(identityRequiredSchema("node-supabase", "complete").objects.map(objectKey));
  const lookup = readFileSync("packages/platform/src/identity/managedClientAuthLink.ts", "utf8").split('client.from("clients")')[1];
  expect(lookup).toBeDefined();
  const columns = [...lookup.matchAll(/\.(?:select|order|eq|is)\("([^"]+)"/g)].flatMap(match => match[1].split(",").map(value => value.trim()));
  expect(columns).toContain("created_at");
  for (const column of columns) expect(managed.has(`column:public.clients.${column}`), column).toBe(true);
});
it.each(["customerSession", "customerProfile", "operatorAuthorization", "operatorActions", "delivery", "privacy"] as const)("refuses a placeholder for the actual %s binding", async key => {
  const input = admission("node-postgres");
  for (const method of Object.keys(input.runtime.ports[key])) Reflect.deleteProperty(input.runtime.ports[key], method);
  const result = await admitReferenceIdentity(input);
  expect(result.admitted).toBe(false);
  expect(result.report.issues).toContainEqual(expect.objectContaining({ code: "OPENLUP_E_PORT_MISSING", subject: key }));
});
it("preserves additional observed packages and refuses an incompatible set", async () => {
  const input = admission("node-postgres");
  input.observed = { inventoryComplete: true, loadedPackages: [...input.observed!.loadedPackages, { name: "@openlup/outbox", version: "0.98.6", kind: "rail" }] };
  const result = await admitReferenceIdentity(input);
  expect(result.admitted).toBe(false);
  expect(result.report.loadedPackages).toContainEqual({ name: "@openlup/outbox", version: "0.98.6", kind: "rail" });
  expect(result.report.issues).toContainEqual(expect.objectContaining({ code: "OPENLUP_E_SET_MISMATCH", package: "@openlup/outbox", subject: "version" }));
});
it.each([["PLATFORM_BUNDLE", "node-supabase"], ["DATABASE_URL", "postgresql://other.invalid/test"]])("refuses a candidate/ambient environment mismatch before listening (%s)", async (key, value) => {
  const input = admission("node-postgres");
  vi.stubEnv(key, value);
  const listen = vi.spyOn(Server.prototype, "listen");
  await expect(startPublicReferenceServer({ root: "/missing-reference.invalid", env: input.runtime.env, identity: input })).rejects.toThrow("environment does not match");
  expect(listen).not.toHaveBeenCalled();
});
it.each([
  ["node-postgres", "export"], ["node-postgres", "erase"],
  ["node-supabase", "export"], ["node-supabase", "erase"],
] as const)("dispatches the admitted %s policy-wrapped privacy %s implementation", async (bundle, operation) => {
  policy.allow = true;
  const input = admission(bundle);
  const root = mkdtempSync(join(tmpdir(), "identity-dispatch-"));
  try {
    mkdirSync(join(root, "config")); writeFileSync(join(root, "config/site-routes.json"), readFileSync("config/public-reference-site-routes.json"));
    vi.spyOn(Server.prototype, "listen").mockImplementation(function(this: Server, ...args: unknown[]) { (args.at(-1) as () => void)(); return this; } as typeof Server.prototype.listen);
    const server = await startPublicReferenceServer({ root, env: readCustomerRouteEnv(), identity: input });
    const req = Object.assign(Readable.from([]), { url: `/api/bff/admin/identity/privacy/${operation}`, method: "POST", headers: {} });
    const res = { statusCode: 0, headersSent: false, writeHead: vi.fn(), setHeader: vi.fn(), hasHeader: vi.fn(() => true), end: vi.fn() };
    server.emit("request", req, res);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(200);
    expect(input.runtime.ports.privacy[operation]).toHaveBeenCalledOnce();
    expect(input.runtime.ports.operatorAuthorization.authorize).toHaveBeenCalledOnce();
    server.close();
  } finally { policy.allow = false; rmSync(root, { recursive: true, force: true }); }
});

it("refuses an environment changed during asynchronous admission before listening", async () => {
  const input = admission("node-postgres"), observe = input.schemaProbe.observe;
  input.schemaProbe.observe = async required => {
    const result = await observe(required);
    vi.stubEnv("DATABASE_URL", "postgresql://changed.invalid/test");
    return result;
  };
  const listen = vi.spyOn(Server.prototype, "listen");
  await expect(startPublicReferenceServer({ root: "/missing-reference.invalid", identity: input })).rejects.toThrow("environment does not match");
  expect(listen).not.toHaveBeenCalled();
});
