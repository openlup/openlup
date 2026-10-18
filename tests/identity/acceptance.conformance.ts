import { env as processEnvironment } from "node:process";
/** Complete installed reference proof. Assertion output never includes sessions or messages. */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { build, type Plugin, type UserConfig } from "vite";
import { tmpdir } from "node:os";
import react from "@vitejs/plugin-react";
import { Pool } from "pg";
import { createPostgresDataGateway } from "@openlup/platform/data";
import { SignJWT } from "jose";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { readManagedMigrationChain } from "../../scripts/public-ci-pgtap.mjs";
import { createServiceRoleClient as createManagedClient } from "../../server/_lib/admin-domain/auth.js";
import { createAdminUserInviteHandler, createAdminUserInvitePort, createInviteAdminUserGateway, runInviteAdminUserUseCase, readBearerToken, createAdminUserRemoveHandler, createCustomerMeHandler, customerMeResponseSchema,
  createPrivacyExportHandler, createPrivacyEraseHandler, createPostgresPrivacyUnitOfWork, createPostgresPrivacyStore, createManagedPrivacyStore,
  createIdentityPersonalDataContributor, createPersonalDataContributorRegistry, createPrivacyOperations, type ManagedIdentityClient, type PrivacyOperations, type InviteAdminUserClient } from "@openlup/platform/identity";
import { createSchemaProbe, type LoadedPackage } from "@openlup/core/readiness";
import type { HttpRequest } from "@openlup/platform/http";
import type { ReferenceIdentityPorts } from "../../server/runtime/auth/referenceIdentity.js";
import { createSubscriptionsPrivacyContributor } from "../../server/runtime/auth/subscriptionsPrivacyContributor.js";
import { createSupabaseAdminUserRemovePort } from "../../server/adapters/supabase/adminUserActionPort.js";
import type { ReferenceIdentityRuntime } from "../../server/runtime/public-reference/serve.js";
import type { createCapturedIdentityMailbox } from "../../server/runtime/auth/capturedIdentityMailbox.js";

type Setup = { bundle: "node-postgres" | "node-supabase"; directory: string; database: string; origin: string; runId: string; assertContainer(): void;
  auth?: { url: string; anonKey: string; serviceKey: string; mail: string } };
const CUSTOMER = "11111111-1111-4111-8111-111111111111", CONTACT = "22222222-2222-4222-8222-222222222222", ADMIN = "33333333-3333-4333-8333-333333333333";
const BROWSER_CUSTOMER = "44444444-4444-4444-8444-444444444444", BROWSER_CONTACT = "55555555-5555-4555-8555-555555555555", BROWSER_ADMIN = "66666666-6666-4666-8666-666666666666";
const CUSTOMER_EMAIL = "customer@example.com", ADMIN_EMAIL = "administrator@example.com", INVITEE_EMAIL = "invited@example.com";
async function waitFor<T>(read: () => Promise<T | undefined>, stage: string): Promise<T> {
  for (let attempt = 0; attempt < 40; attempt++) { const value = await read(); if (value !== undefined) return value; await new Promise(done => setTimeout(done, 250)); }
  throw new Error(`Identity acceptance readiness timeout: ${stage}`);
}
/** Match the identity verifier's signing-key profile for this disposable installation. */
export function identityReferenceJwks(publicKey: KeyObject, keyId: string): string {
  return JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: keyId, alg: "ES256", use: "sig" }] });
}
/** Bundle the existing policy seam only for this disposable runtime. */
export async function buildIdentityReferenceRuntime(entry: string, outDir: string) {
  const packages = new Map<string, LoadedPackage>();
  let inventoryComplete = true;
  await build({ configFile: false, logLevel: "silent", plugins: [react(), {
    name: "identity-runtime-package-inventory",
    moduleParsed(info) {
      let directory = dirname(info.id.replace(/\?.*$/, ""));
      while (directory !== dirname(directory)) {
        const manifestPath = join(directory, "package.json");
        if (existsSync(manifestPath)) {
          const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
          if (typeof manifest.name === "string" && manifest.name.startsWith("@openlup/")) {
            const gatesPath = join(directory, "release-gates.json");
            if (!existsSync(gatesPath)) inventoryComplete = false;
            else {
              const gates = JSON.parse(readFileSync(gatesPath, "utf8"));
              packages.set(directory, { name: manifest.name, version: manifest.version, kind: gates.kind });
            }
          }
          break;
        }
        directory = dirname(directory);
      }
    },
    generateBundle(_options, output) {
      for (const chunk of Object.values(output)) if (chunk.type === "chunk"
        && [...chunk.imports, ...chunk.dynamicImports].some(id => id.startsWith("@openlup/"))) inventoryComplete = false;
    },
  }], resolve: { alias: { "@": resolve("src"), "#deployment-route-policy": resolve("server/runtime/auth/referenceIdentityPolicy.ts") } }, ssr: { noExternal: [/^@openlup\//] }, build: { ssr: entry, outDir, rollupOptions: { output: { entryFileNames: "runtime.mjs" } } } });
  return { loadedPackages: [...packages.values()], inventoryComplete };
}
/** Bind the same application route and policy modules for the disposable host. */
export function writeIdentityReferenceEntry(entry: string) {
  const exports = [
      ["withObservedRoute", "server/_lib/observability/route.ts"],
      ["createCustomerIdentityBinding", "server/runtime/customers/customerIdentityBinding.ts"],
      ["createDirectCustomerReconcileHandler", "server/runtime/customers/customerReconcileBinding.ts"],
      ["createDirectOperatorActionsBinding", "server/runtime/auth/operatorActionsBinding.ts"],
      ["resolveAdminAuthBinding", "server/runtime/auth/adminAuthBinding.ts"],
      ["createReferenceIdentity", "server/runtime/auth/referenceIdentity.ts"],
      ["startPublicReferenceServer", "server/runtime/public-reference/serve.ts"],
      ["validateIdentityReferenceProfile", "server/runtime/auth/referenceIdentityPolicy.ts"],
      ["createCapturedIdentityMailbox", "server/runtime/auth/capturedIdentityMailbox.ts"],
      ["resolveCustomerSessionBinding", "server/runtime/customers/customerSessionBinding.ts"],
      ["createOperatorSessionBinding", "server/runtime/auth/operatorSessionBinding.ts"],
      ["operatorRoutes", "server/runtime/auth/operatorRoutes.ts"],
      ["privacyRoutes", "server/runtime/auth/privacyRoutes.ts"],
      ["bindIdentityEmailTrust", "server/runtime/auth/emailTrustBinding.ts"],
      ["createCustomerMagicLinkRoute", "server/bff/customers/magic-link.ts"],
      ["createCustomerVerifyOtpRoute", "server/bff/customers/verify-otp.ts"],
      ["createInviteHandler", "server/bff/admin/platform/admin-users/invite.ts"],
      ["createRemoveHandler", "server/bff/admin/platform/admin-users/remove.ts"],
    ];
  const defaults = [
      ["customerMe", "server/bff/customers/me.ts"],
      ["reconcile", "server/bff/customers/reconcile-account.ts"],
      ["operatorMagicLink", "server/bff/admin/platform/magic-link.ts"],
      ["operatorMe", "server/bff/admin/platform/me.ts"],
    ];
  writeFileSync(entry, [
      ...exports.map(([name, file]) => `export { ${name} } from ${JSON.stringify(resolve(file))};`),
      ...defaults.map(([name, file]) => `export { default as ${name} } from ${JSON.stringify(resolve(file))};`),
    ].join("\n"), { mode: 0o600 });
}
/** Keep the disposable host's customer reads on its owned pool, outside the application cache. */
export function createIdentityAcceptanceDatabase(pool: Pool) {
  let closing = false;
  let failed = false;
  const requests = new Set<Promise<unknown>>();
  pool.on("error", () => { if (!closing) failed = true; });
  const customerGateway = createPostgresDataGateway({ connectionString: "" }, { poolFactory: () => pool });
  return {
    customerGateway,
    async runRequest<T>(work: () => T | Promise<T>): Promise<T> {
      const pending = Promise.resolve().then(work);
      requests.add(pending);
      try { return await pending; }
      catch (error) { failed = true; throw error; }
      finally { requests.delete(pending); }
    },
    async close(server?: import("node:http").Server) {
      closing = true;
      try {
        if (server) await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
      } finally {
        // HTTP response completion can precede a route's asynchronous binding cleanup.
        await Promise.allSettled(requests);
        await pool.end();
      }
      if (failed) throw new Error("Identity acceptance database or request failed during assertions; credential-bearing details suppressed");
    },
  };
}
export async function runAcceptance(setup: Setup) {
  const { bundle, directory, database, origin, runId, auth } = setup;
  const pool = new Pool({ connectionString: database });
  const ownedDatabase = createIdentityAcceptanceDatabase(pool);
  let server: import("node:http").Server | undefined;
  let runtime: ReferenceIdentityRuntime | undefined;
  let managedReplay: { runId: string; chainDigest: string; files: string[]; completedAt: string } | undefined;
  try {
    await waitFor(async () => { try { await pool.query("SELECT 1"); return true; } catch { return undefined; } }, "database TCP");
    setup.assertContainer();
    if (bundle === "node-postgres") {
      const runner = createPostgresMigrationRunner({ connectionString: database }, { root: process.cwd(), poolFactory: async () => pool });
      await runner.apply();
      assert.deepEqual((await runner.apply()).applied, []);
    } else {
      assert(auth);
      assert.equal((await pool.query("SELECT to_regclass('public.clients') AS relation")).rows[0].relation, null);
      const defaults = ["postgres", "supabase_admin"].flatMap(role => ["", " IN SCHEMA public"].flatMap(scope => ["TABLES", "SEQUENCES", "FUNCTIONS"].map(kind => `ALTER DEFAULT PRIVILEGES FOR ROLE ${role}${scope} REVOKE ALL ON ${kind} FROM PUBLIC, anon, authenticated, service_role;`))).join("\n");
      const migrations = readManagedMigrationChain(process.cwd());
      // No fixture grants: the actual reviewed forward must supply the application columns.
      await pool.query(["BEGIN;", readFileSync("scripts/public-reference/subscription-prereqs.sql", "utf8"), defaults, "SET ROLE postgres;", ...migrations.map(({ contents }: { contents: string }) => contents.replace(/^\\(?:un)?restrict [A-Za-z0-9]+\r?$/gmu, "")), "RESET ROLE;", "COMMIT;", "NOTIFY pgrst, 'reload schema';"].join("\n"));
      managedReplay = { runId, chainDigest: createHash("sha256").update(JSON.stringify(migrations)).digest("hex"), files: migrations.map((entry: { name: string }) => entry.name), completedAt: new Date().toISOString() };
      for (const [table, verb, columns] of [["clients", "INSERT", ["email", "auth_user_id", "acquisition_source", "lifecycle_stage"]], ["clients", "UPDATE", ["auth_user_id"]], ["admin_users", "SELECT", ["email"]], ["admin_users", "INSERT", ["id", "email", "role", "membership_state", "membership_provenance", "membership_accepted_at"]]] as const) {
        for (const column of columns) assert.equal((await pool.query("SELECT has_column_privilege('service_role',$1,$2,$3) AS allowed", [`public.${table}`, column, verb])).rows[0].allowed, true);
      }
      await waitFor(async () => { try { const response = await fetch(`${auth.url}/rest/v1/clients?select=id&limit=1`, { headers: { apikey: auth.serviceKey, authorization: `Bearer ${auth.serviceKey}` }, signal: AbortSignal.timeout(3000) }); await response.arrayBuffer(); return response.ok ? true : undefined; } catch { return undefined; } }, "managed schema reload");
      const client = createManagedClient({ url: auth.url, serviceRoleKey: auth.serviceKey });
      for (const [id, email] of [[CUSTOMER, CUSTOMER_EMAIL], [ADMIN, ADMIN_EMAIL], [BROWSER_CUSTOMER, "browser-customer@example.com"], [BROWSER_ADMIN, "browser-administrator@example.com"]]) {
        const result = await client.auth.admin.createUser({ id, email, email_confirm: true }); assert.equal(Boolean(result.error), false);
      }
    }
    await pool.query("INSERT INTO public.commerce_settings(key,value_text) VALUES ('identity_reference_instance',$1)", [runId]);
    if (bundle === "node-postgres") {
      await pool.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES ($1,$2),($3,$4)", [CUSTOMER, CUSTOMER_EMAIL, ADMIN, ADMIN_EMAIL]);
      await pool.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES ($1,'admin','active','legacy',now())", [ADMIN]);
    } else await pool.query("INSERT INTO public.admin_users(id,email,role,membership_state,membership_provenance,membership_accepted_at) VALUES ($1,$2,'admin','active','legacy',now())", [ADMIN, ADMIN_EMAIL]);
    await pool.query(`INSERT INTO public.clients(id,email,${bundle === "node-postgres" ? "principal_id" : "auth_user_id"}) VALUES ($1,$2,$3)`, [CONTACT, CUSTOMER_EMAIL, CUSTOMER]);
    if (bundle === "node-postgres") {
      await pool.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES ($1,'browser-customer@example.com'),($2,'browser-administrator@example.com')", [BROWSER_CUSTOMER, BROWSER_ADMIN]);
      await pool.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES ($1,'admin','active','legacy',now())", [BROWSER_ADMIN]);
    } else await pool.query("INSERT INTO public.admin_users(id,email,role,membership_state,membership_provenance,membership_accepted_at) VALUES ($1,'browser-administrator@example.com','admin','active','legacy',now())", [BROWSER_ADMIN]);
    await pool.query(`INSERT INTO public.clients(id,email,${bundle === "node-postgres" ? "principal_id" : "auth_user_id"}) VALUES ($1,'browser-customer@example.com',$2)`, [BROWSER_CONTACT, BROWSER_CUSTOMER]);
    if (bundle === "node-postgres") {
      const ledger = (await pool.query("SELECT * FROM public.platform_schema_migrations ORDER BY position")).rows;
      const contacts = (await pool.query("SELECT * FROM public.clients ORDER BY id")).rows;
      const runner = createPostgresMigrationRunner({ connectionString: database }, { root: process.cwd(), poolFactory: async () => pool });
      assert.deepEqual((await runner.apply()).applied, []);
      assert.deepEqual((await pool.query("SELECT * FROM public.platform_schema_migrations ORDER BY position")).rows, ledger);
      assert.deepEqual((await pool.query("SELECT * FROM public.clients ORDER BY id")).rows, contacts);
    }
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const keyId = "reference-key";
    const env: NodeJS.ProcessEnv = { ...processEnvironment, NODE_ENV: "test", PLATFORM_BUNDLE: bundle, DATABASE_URL: database, APP_BASE_URL: origin,
      OPENLUP_REFERENCE_PROFILE: "identity", OPENLUP_REFERENCE_DISPOSABLE: "1", OPENLUP_IDENTITY_RUN_DIR: directory, OPENLUP_IDENTITY_RUN_ID: runId,
      CUSTOMER_IDENTITY_ISSUER: origin, CUSTOMER_IDENTITY_AUDIENCE: "identity-reference-customer", OPERATOR_IDENTITY_AUDIENCE: "identity-reference-operator",
      CUSTOMER_IDENTITY_KEY_ID: keyId, CUSTOMER_IDENTITY_PRIVATE_JWK: JSON.stringify({ ...pair.privateKey.export({ format: "jwk" }), kid: keyId, alg: "ES256" }),
      CUSTOMER_IDENTITY_JWKS: identityReferenceJwks(pair.publicKey, keyId),
      COMMERCE_V2_W12_CUSTOMER_AUTH_UI: "true", VITE_COMMERCE_AUTH_PROVIDER_KIND: bundle === "node-postgres" ? "postgres" : "supabase",
      ...(auth ? { OPENLUP_IDENTITY_MAIL_ORIGIN: auth.mail, SUPABASE_URL: auth.url, SUPABASE_ANON_KEY: auth.anonKey, SUPABASE_SERVICE_ROLE_KEY: auth.serviceKey } : {}) };
    // Resolve installed tooling from this checkout; no install or cold-consumer claim.
    symlinkSync(resolve("node_modules"), join(directory, "node_modules"), "dir");
    const entry = join(directory, "runtime-entry.ts");
    writeIdentityReferenceEntry(entry);
    const observed = await buildIdentityReferenceRuntime(entry, join(directory, "runtime"));
    Object.assign(processEnvironment, env);
    const loaded = await import(pathToFileURL(join(directory, "runtime/runtime.mjs")).href);
    const profile = loaded.validateIdentityReferenceProfile(env, async () => {
      setup.assertContainer();
      assert.equal((await pool.query("SELECT value_text FROM public.commerce_settings WHERE key='identity_reference_instance'")).rows[0]?.value_text, runId);
    });
    const mailbox: Awaited<ReturnType<typeof createCapturedIdentityMailbox>> = await loaded.createCapturedIdentityMailbox(profile);
    const requestScope = new AsyncLocalStorage<{ req: HttpRequest; customer?: ReturnType<typeof loaded.createCustomerIdentityBinding> }>();
    const currentRequest = () => { const scope = requestScope.getStore(); assert(scope, "Identity request scope required"); return scope; };
    const authorize: ReferenceIdentityPorts["operatorAuthorization"]["authorize"] = (token, options) => {
      const binding = loaded.resolveAdminAuthBinding(env).binding;
      assert(binding);
      return binding.run(token, (authority: ReferenceIdentityPorts["operatorAuthorization"]) => authority.authorize(token, options));
    };
    const privacy = async <T>(work: (operations: PrivacyOperations) => Promise<T>): Promise<T> => {
      const policy = { retainedContactFields: Object.fromEntries(["lifecycle_stage", "acquisition_source"].map(field => [field, {
        owner: "clients", resource: `clients.${field}`, disposition: "retain" as const, reasonCode: "CONTACT_LIFECYCLE_RETENTION", remote: false,
      }])) };
      if (bundle === "node-postgres") {
        const unitOfWork = createPostgresPrivacyUnitOfWork({ connectionString: database });
        try {
          const store = createPostgresPrivacyStore();
          const registry = createPersonalDataContributorRegistry([createIdentityPersonalDataContributor(store, policy, randomUUID), createSubscriptionsPrivacyContributor()], { requiredContributorIds: ["identity", "subscriptions"] });
          return await work(createPrivacyOperations({ store, unitOfWork, registry, now: () => new Date(), randomId: randomUUID }));
        } finally { await unitOfWork.close(); }
      }
      assert(auth);
      const client = createManagedClient({ url: auth.url, serviceRoleKey: auth.serviceKey }) as unknown as ManagedIdentityClient;
      const store = createManagedPrivacyStore();
      const registry = createPersonalDataContributorRegistry([createIdentityPersonalDataContributor(store, policy, randomUUID)], { requiredContributorIds: ["identity", "subscriptions"] });
      return work(createPrivacyOperations({ store, registry, unitOfWork: { run: work => work(client) }, now: () => new Date(), randomId: randomUUID }));
    };
    const ports: ReferenceIdentityPorts = {
      customerSession: { async verifyAccessToken(token) {
        const scope = currentRequest();
        const binding = loaded.createCustomerIdentityBinding({ headers: { authorization: `Bearer ${token}` } }, env, {
          createPostgresGateway: () => ownedDatabase.customerGateway,
        });
        assert(binding); scope.customer = binding;
        const result = await binding.authenticateUser(scope.req);
        return result.ok ? { principalId: result.userId, email: null, emailVerified: false } : null;
      } },
      customerProfile: { async getCustomerMe(principalId) { const binding = currentRequest().customer; assert(binding); return binding.mePort.getCustomerMe(principalId); } },
      operatorAuthorization: { authorize },
      operatorActions: {
        async inviteAdminUser(input) {
          const token = readBearerToken(currentRequest().req);
          if (bundle === "node-postgres") {
            const binding = loaded.createDirectOperatorActionsBinding(env, token, { notification: mailbox.roleNotifications });
            try { return await binding.invitePort.inviteAdminUser(input); } finally { await binding.close(); }
          }
          assert(auth);
          const gateway = createInviteAdminUserGateway(() => createManagedClient({ url: auth.url, serviceRoleKey: auth.serviceKey }) as unknown as InviteAdminUserClient);
          return createAdminUserInvitePort({ accessToken: token, runInviteAdminUser: request => runInviteAdminUserUseCase(request, {
            gateway, activateMembership: gateway.activateMembership, roleNotificationPort: mailbox.roleNotifications, siteUrl: origin, notificationLocale: "en",
          }) }).inviteAdminUser(input);
        },
        async removeAdminUser(input) {
          const token = readBearerToken(currentRequest().req);
          if (bundle === "node-postgres") {
            const binding = loaded.createDirectOperatorActionsBinding(env, token);
            try { return await binding.removePort.removeAdminUser(input); } finally { await binding.close(); }
          }
          return createSupabaseAdminUserRemovePort({ accessToken: token }).removeAdminUser(input);
        },
      },
      delivery: mailbox.customer,
      privacy: { export: (actor, subject) => privacy(operations => operations.export(actor, subject)), erase: (actor, input) => privacy(operations => operations.erase(actor, input)) },
      emailTrustPolicy: loaded.bindIdentityEmailTrust(env, auth ? { url: auth.url, anonKey: auth.anonKey } : undefined),
    };
    const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
    const expectedHistory = [manifest.baseline, ...manifest.forward].map((row: { file: string; sha256: string }, position: number) => ({ catalog_path: row.file, sha256: row.sha256, position }));
    const migrationIdentity = bundle === "node-postgres" ? createHash("sha256").update(JSON.stringify(expectedHistory)).digest("hex") : managedReplay!.chainDigest;
    const candidate = { artifact: createHash("sha256").update(readFileSync(join(directory, "runtime/runtime.mjs"))).digest("hex"), configuration: createHash("sha256").update(JSON.stringify(env)).digest("hex"), environment: runId, database: runId, schema: migrationIdentity };
    runtime = { profile, observed, ...(auth ? { authOrigin: auth.url } : {}), candidate, currentIdentity: () => ({ ...candidate,
        artifact: createHash("sha256").update(readFileSync(join(directory, "runtime/runtime.mjs"))).digest("hex"),
        configuration: createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.keys(env).map(key => [key, processEnvironment[key]])))).digest("hex"),
      }),
      runtime: loaded.createReferenceIdentity({ bundle, migrationIdentity, env, ports,
        createRoutes: (selected: ReferenceIdentityPorts, environment: Record<string, string | undefined>) => {
          const mount = (route: string, handler: import("@openlup/platform/bff").RouteEntry["handler"]) => ({ route, pattern: new RegExp(`^${route}$`), params: [],
            handler: (req: HttpRequest, res: import("@openlup/platform/http").HttpResponse) => requestScope.run({ req }, () => handler(req, res)) });
          const authenticateUser = async (req: HttpRequest) => {
            const token = readBearerToken(req), principal = token ? await selected.customerSession.verifyAccessToken(token) : null;
            return principal ? { ok: true as const, userId: principal.principalId } : { ok: false as const, code: "UNAUTHORIZED" as const, message: "Customer session required" };
          };
          const authorizeAdmin = (req: HttpRequest) => selected.operatorAuthorization.authorize(readBearerToken(req), { allowedRoles: ["admin"] });
          const customerSession = () => loaded.resolveCustomerSessionBinding(environment, { delivery: selected.delivery });
          const operatorSession = () => loaded.createOperatorSessionBinding(environment, mailbox.operator);
          return [
            mount("/api/bff/customers/magic-link", loaded.createCustomerMagicLinkRoute(customerSession)),
            mount("/api/bff/customers/verify-otp", loaded.createCustomerVerifyOtpRoute(customerSession)),
            mount("/api/bff/customers/me", createCustomerMeHandler({ authenticateUser, mePort: selected.customerProfile, responseSchema: customerMeResponseSchema })),
            mount("/api/bff/customers/reconcile-account", bundle === "node-postgres" ? loaded.createDirectCustomerReconcileHandler(environment, () => ({ authenticateUser, mePort: selected.customerProfile })) : loaded.reconcile),
            mount("/api/bff/admin/platform/admin-users/invite", createAdminUserInviteHandler({ authorizeAdmin, settingsPort: selected.operatorActions })),
            mount("/api/bff/admin/platform/admin-users/remove", createAdminUserRemoveHandler({ authorizeAdmin, settingsPort: selected.operatorActions })),
            ...(["export", "erase"] as const).map(operation => mount(`/api/bff/admin/identity/privacy/${operation}`,
              (req, res) => (operation === "export" ? createPrivacyExportHandler : createPrivacyEraseHandler)({ authorizeAdmin: () => authorizeAdmin(req), operations: selected.privacy })(req, res))),
            ...(bundle === "node-postgres" ? loaded.operatorRoutes(environment, operatorSession) : [
              mount("/api/bff/admin/platform/magic-link", loaded.operatorMagicLink), mount("/api/bff/admin/platform/me", loaded.operatorMe),
            ]),
          ].map(entry => ({ ...entry, handler: (req: HttpRequest, res: import("@openlup/platform/http").HttpResponse) => ownedDatabase.runRequest(() => entry.handler(req, res)) }));
        },
      }),
      schemaProbe: createSchemaProbe({ query: (text, values) => pool.query(text, [...(values ?? [])]) }, async () => {
        await profile.assertOwned();
        if (bundle === "node-postgres") {
          const history = (await pool.query("SELECT catalog_path, sha256, position FROM public.platform_schema_migrations ORDER BY position")).rows;
          assert.deepEqual(history, expectedHistory);
        } else {
          assert.equal(managedReplay!.runId, runId);
          assert.equal(createHash("sha256").update(JSON.stringify(readManagedMigrationChain(process.cwd()))).digest("hex"), managedReplay!.chainDigest);
        }
        return { database: runId, version: migrationIdentity };
      }),
    };
    const { publicReferenceViteConfig } = await import("../../vite.public-reference.config.ts");
    const client = publicReferenceViteConfig();
    await build({ ...client, configFile: false, logLevel: "silent", build: { ...client.build, outDir: join(directory, "client") } });
    server = await loaded.startPublicReferenceServer({ env, identity: runtime, distDir: join(directory, "client"), port: Number(new URL(origin).port), host: "127.0.0.1" });
    const request = async (path: string, token?: string, body?: unknown) => {
      const response = await fetch(origin + path, { method: body === undefined ? "GET" : "POST", headers: { origin, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
      return { status: response.status, envelope: await response.json() };
    };
    async function login(kind: "customer" | "operator", email: string) {
      const prefix = kind === "customer" ? "/api/bff/customers" : "/api/bff/admin/platform";
      const before = new Set((await mailbox.read(kind)).map(message => message.id));
      const managedBefore = auth ? new Set((await (await fetch(`${auth.mail}/api/v1/messages`)).json()).messages.map((message: { ID?: string; id?: string }) => message.ID ?? message.id)) : new Set();
      const issued = await request(`${prefix}/magic-link`, undefined, kind === "customer" ? { email, locale: "en", returnTo: "/account" } : { email }); assert.equal(issued.status, 200);
      if (bundle === "node-postgres") {
        const captured = await waitFor(async () => (await mailbox.read(kind)).find(message => !before.has(message.id) && "challenge" in message && message.challenge.email === email), "captured challenge");
        assert("challenge" in captured);
        const verified = await request(`${prefix}/verify-otp`, undefined, kind === "customer" ? { email, token: captured.challenge.token } : { token: captured.challenge.token });
        assert.equal(verified.status, 200); assert.equal(typeof verified.envelope.data?.accessToken, "string");
        assert.equal((await request(`${prefix}/verify-otp`, undefined, kind === "customer" ? { email, token: captured.challenge.token } : { token: captured.challenge.token })).status, 401);
        return { token: verified.envelope.data.accessToken as string, callback: "callback" in captured ? captured.callback : undefined };
      }
      assert(auth);
      const message = await waitFor(async () => {
        const response = await fetch(`${auth.mail}/api/v1/messages`); assert(response.ok);
        const list = await response.json();
        return list.messages.find((entry: { ID?: string; id?: string; To?: (string | { Address: string })[] }) => !managedBefore.has(entry.ID ?? entry.id) && entry.To?.some(value => (typeof value === "string" ? value : value.Address).toLowerCase() === email));
      }, "managed captured mail");
      const detail = await fetch(`${auth.mail}/api/v1/message/${encodeURIComponent(message.ID ?? message.id)}`); assert(detail.ok);
      const content = await detail.json();
      const text = [content.HTML, content.Text, content.html, content.text].filter(value => typeof value === "string").join("\n").replaceAll("&amp;", "&").replaceAll("&#38;", "&");
      const url = (text.match(/https?:\/\/[^\s"'<>]+/g) ?? []).map(value => new URL(value)).find(value => value.origin === auth.url && value.pathname === "/auth/v1/verify" && value.searchParams.has("token")); assert(Boolean(url));
      const response = await fetch(url!, { redirect: "manual" });
      const location = response.headers.get("location"); assert(Boolean(location));
      const fragment = new URLSearchParams(new URL(location!).hash.slice(1)), token = fragment.get("access_token"); assert(Boolean(token));
      return { token: token!, callback: location! };
    }
    const customer = await login("customer", CUSTOMER_EMAIL), admin = await login("operator", ADMIN_EMAIL);
    assert.equal((await request("/api/bff/admin/platform/admin-users/invite", admin.token, { email: INVITEE_EMAIL, role: "unknown" })).status, 400);
    if (bundle === "node-postgres") {
      const minted = (subject: string, expired: boolean) => new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: keyId }).setSubject(subject).setIssuer(origin).setAudience(env.OPERATOR_IDENTITY_AUDIENCE!).setExpirationTime(expired ? 1 : Math.floor(Date.now() / 1000) + 60).sign(pair.privateKey);
      for (const token of [await minted(randomUUID(), false), await minted(ADMIN, true)]) assert([401,403].includes((await request("/api/bff/admin/platform/me", token)).status));
    }
    assert.equal((await request("/api/bff/customers/me", customer.token)).envelope.data?.clientId, CONTACT);
    for (let repeat = 0; repeat < 2; repeat++) {
      const reconciled = await request("/api/bff/customers/reconcile-account", customer.token, {}); assert.equal(reconciled.status, 200);
      assert.equal(reconciled.envelope.data?.accountId, CONTACT);
      if (bundle === "node-postgres") assert.deepEqual(reconciled.envelope.data, { accountId: CONTACT, created: false, linked: false });
    }
    for (const token of [undefined, "invalid", customer.token]) assert([401,403].includes((await request("/api/bff/admin/platform/me", token)).status));
    if (bundle === "node-postgres") assert.equal((await request("/api/bff/customers/me", admin.token)).status, 401);
    if (bundle === "node-supabase") {
      assert(auth);
      const identity = createManagedClient({ url: auth.url, serviceRoleKey: auth.serviceKey });
      const email = "nonmember@example.com", id = "77777777-7777-4777-8777-777777777777";
      assert.equal(Boolean((await identity.auth.admin.createUser({ id, email, email_confirm: true, user_metadata: { role: "admin" } })).error), false);
      const generated = await identity.auth.admin.generateLink({ type: "magiclink", email });
      assert.equal(Boolean(generated.error), false);
      const verified = await identity.auth.verifyOtp({ type: "magiclink", token_hash: generated.data.properties!.hashed_token });
      assert.equal(Boolean(verified.error), false);
      const token = verified.data.session?.access_token; assert.equal(typeof token, "string");
      assert([401,403].includes((await request("/api/bff/admin/platform/me", token!)).status));
      assert.notEqual((await request("/api/bff/customers/me", admin.token)).status, 200);
    }
    const invited = await request("/api/bff/admin/platform/admin-users/invite", admin.token, { email: INVITEE_EMAIL, role: "distributor" }); assert.equal(invited.status, 200);
    assert.equal(invited.envelope.data?.membershipState, bundle === "node-postgres" ? "invited" : "active");
    const invitee = await login("operator", INVITEE_EMAIL);
    assert.equal((await request("/api/bff/admin/platform/me", invitee.token)).status, 200);
    const principalTable = bundle === "node-postgres" ? "platform_human_principals" : "admin_users", principalColumn = bundle === "node-postgres" ? "principal_id" : "id";
    const inviteeId = (await pool.query(`SELECT ${principalColumn} AS id FROM public.${principalTable} WHERE lower(email)=lower($1)`, [INVITEE_EMAIL])).rows[0].id;
    assert.equal((await request("/api/bff/admin/platform/admin-users/remove", admin.token, { userId: inviteeId })).status, 200);
    assert([401,403].includes((await request("/api/bff/admin/platform/me", invitee.token)).status));
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM public.${principalTable} WHERE ${principalColumn}=$1`, [inviteeId])).rows[0].count, 1);
    const subject = { kind: "contact", contactId: CONTACT };
    const exported = await request("/api/bff/admin/identity/privacy/export", admin.token, { subject }); assert.equal(exported.status, 200);
    assert.equal(JSON.stringify(exported.envelope).includes("token_hash"), false);
    const erase = { subject, idempotencyKey: randomUUID() };
    if (bundle === "node-postgres") {
      const subscription = randomUUID();
      await pool.query("INSERT INTO public.subscriptions(id,client_id,status,cadence_days) VALUES ($1,$2,'active',28)", [subscription, CONTACT]);
      for (const status of ["active", "paused"]) {
        await pool.query("UPDATE public.subscriptions SET status=$1 WHERE id=$2", [status, subscription]);
        const before = (await pool.query("SELECT * FROM public.clients WHERE id=$1", [CONTACT])).rows;
        assert.notEqual((await request("/api/bff/admin/identity/privacy/erase", admin.token, erase)).status, 200);
        assert.deepEqual((await pool.query("SELECT * FROM public.clients WHERE id=$1", [CONTACT])).rows, before);
      }
      await pool.query("UPDATE public.subscriptions SET status='cancelled' WHERE id=$1", [subscription]);
    }
    // The browser journey runs before erasing the contact whose account it needs.
    const browserInput = { bundle, customerEmail: "browser-customer@example.com", adminEmail: "browser-administrator@example.com", contactId: BROWSER_CONTACT };
    writeFileSync(join(directory, "browser-input.json"), JSON.stringify(browserInput), { mode: 0o600 });
    const browserExit = await new Promise<number | null>((done, reject) => {
      const child = spawn(process.execPath, [resolve("node_modules/@playwright/test/cli.js"), "test", "--config", "tests/identity/playwright.config.ts"], { env: { ...processEnvironment, ...env }, stdio: "ignore", timeout: 180000 });
      child.once("error", reject); child.once("exit", done);
    });
    assert.equal(browserExit, 0, "Identity browser acceptance failed; credential-bearing output suppressed");
    const before = (await pool.query("SELECT * FROM public.clients WHERE id=$1", [CONTACT])).rows;
    const erased = await request("/api/bff/admin/identity/privacy/erase", admin.token, erase);
    if (bundle === "node-postgres") {
      assert.equal(erased.status, 200);
      assert.deepEqual((await request("/api/bff/admin/identity/privacy/erase", admin.token, erase)).envelope.data, { ...erased.envelope.data, outcome: "ALREADY_ERASED" });
      assert.equal((await pool.query("SELECT principal_id FROM public.clients WHERE id=$1", [CONTACT])).rows[0].principal_id, null);
      assert.equal((await pool.query("SELECT id FROM public.clients WHERE id=$1", [CONTACT])).rows[0].id, CONTACT);
    } else {
      assert.equal(erased.status, 503); assert.equal(erased.envelope.error?.details?.privacyCode, "MANAGED_PRIVACY_ERASURE_UNAVAILABLE");
      assert.deepEqual((await pool.query("SELECT * FROM public.clients WHERE id=$1", [CONTACT])).rows, before);
      const retained = await createManagedClient({ url: auth!.url, serviceRoleKey: auth!.serviceKey }).auth.admin.getUserById(CUSTOMER);
      assert.equal(retained.data.user?.id, CUSTOMER);
    }
  } catch { throw new Error(`Identity acceptance ${bundle} failed; credential-bearing assertion details suppressed`); }
  finally {
    await ownedDatabase.close(server);
  }
}

/** Compare static and subscription inputs only when explicitly invoked with history. */
function profileSettings(config: UserConfig) {
  const { plugins, ...settings } = config;
  const flattened = ((plugins ?? []) as unknown[]).flat(Infinity) as Plugin[];
  const document = flattened.find(plugin => plugin.name === "public-reference-document")!.transformIndexHtml as { order: string; handler: () => string };
  const auth = flattened.find(plugin => plugin.name === "public-reference-auth-settings")!;
  const resolved = { env: {} };
  (auth.configResolved as (config: typeof resolved) => void)(resolved);
  return { settings: structuredClone(settings), plugins: flattened.map(plugin => plugin.name), document: { order: document.order, html: document.handler() }, auth: resolved.env };
}

async function proveProfilePredecessor(args: string[]) {
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === "--base"), "Usage: node --import tsx tests/identity/acceptance.conformance.ts --profile-predecessor [--base <full-predecessor-commit>]");
  const predecessor = args.length ? args[1] : processEnvironment.OPENLUP_STACK_BASE;
  assert.ok(predecessor && /^[a-f0-9]{40}$/.test(predecessor), "Supply --base or OPENLUP_STACK_BASE naming the exact ancestor predecessor; no default or skip is permitted");
  execFileSync("git", ["merge-base", "--is-ancestor", predecessor, "HEAD"], { stdio: "pipe" });
  const before = (file: string) => execFileSync("git", ["show", `${predecessor}:${file}`], { maxBuffer: 32 * 1024 * 1024 });
  for (const file of ["config/public-reference-subscription-imports.json", "package-lock.json"]) assert.deepEqual(readFileSync(file), before(file), file);
  const manifest = JSON.parse(readFileSync("package.json", "utf8")), priorManifest = JSON.parse(before("package.json").toString());
  for (const field of ["imports", "dependencies", "devDependencies"]) assert.deepEqual(manifest[field], priorManifest[field], `package.json ${field}`);

  const directory = realpathSync(mkdtempSync(join(tmpdir(), "identity-profile-predecessor-")));
  const keys = ["OPENLUP_REFERENCE_PROFILE", "OPENLUP_BUILD_TARGET", "VITE_COMMERCE_AUTH_PROVIDER_KIND"] as const;
  const environment = keys.map(key => [key, processEnvironment[key]] as const);
  try {
    symlinkSync(resolve("node_modules"), join(directory, "node_modules"), "dir");
    for (const profile of ["", "subscription"]) {
      processEnvironment.OPENLUP_REFERENCE_PROFILE = profile;
      processEnvironment.OPENLUP_BUILD_TARGET = "public-reference";
      processEnvironment.VITE_COMMERCE_AUTH_PROVIDER_KIND = "postgres";
      const { publicReferenceViteConfig } = await import(`${pathToFileURL(resolve("vite.public-reference.config.ts")).href}?profile=${profile}`);
      const config = publicReferenceViteConfig();
      const settings = profileSettings(config);
      const modules = new Set<string>();
      const collect: Plugin = { name: "profile-predecessor-inputs", load(id) { modules.add(id); }, moduleParsed(info) { modules.add(info.id); } };
      await build({ ...config, configFile: false, logLevel: "silent", plugins: [...(config.plugins ?? []), collect], build: { ...config.build, write: false } });
      const entry = join(directory, `baseline-${profile || "default"}.ts`);
      writeFileSync(entry, before("vite.public-reference.config.ts").toString().replace('const configDir = typeof __dirname === "string" ? __dirname : import.meta.dirname;', `const configDir = ${JSON.stringify(process.cwd())};`));
      const output = join(directory, profile || "default");
      await build({ configFile: false, logLevel: "silent", build: { ssr: entry, outDir: output, rollupOptions: { output: { entryFileNames: "baseline.mjs" } } } });
      const baseline = (await import(pathToFileURL(join(output, "baseline.mjs")).href)).publicReferenceViteConfig();
      assert.deepEqual(settings, profileSettings(baseline), `${profile || "default"} configuration, document and auth settings`);
      const inputs = new Set(["index.html", ...[...modules].map(id => id.replace(/\?.*$/, "")).filter(id => isAbsolute(id) && !id.split("/").includes("node_modules")).map(id => relative(process.cwd(), id))]);
      assert.ok(inputs.has(`src/public-reference/${profile === "subscription" ? "subscription-main" : "main"}.tsx`), "Expected profile entry must be built");
      for (const file of [...inputs].sort()) {
        // Workspace outputs have no prior blob; compare their tracked compiler inputs.
        let source = file.replace(/^(packages\/[^/]+)\/dist\/(.*)\.js$/, "$1/src/$2.ts");
        if (source !== file) {
          if (!existsSync(source)) source = source.replace(/\.ts$/, ".tsx");
          for (const name of ["package.json", "tsconfig.build.json"]) {
            const input = `${file.split("/").slice(0, 2).join("/")}/${name}`;
            assert.deepEqual(readFileSync(input), before(input), input);
          }
        }
        assert.deepEqual(readFileSync(source), before(source), source);
      }
    }
    console.log("Default and subscription profile inputs match the explicit predecessor.");
  } finally {
    for (const [key, value] of environment) {
      if (value === undefined) delete processEnvironment[key]; else processEnvironment[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv[2], "--profile-predecessor", "Usage: node --import tsx tests/identity/acceptance.conformance.ts --profile-predecessor [--base <full-predecessor-commit>]");
  await proveProfilePredecessor(process.argv.slice(3));
}
