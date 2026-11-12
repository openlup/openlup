import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { assertInstalledPackages, isolatedConsumerEnv } from "../../scripts/packages/pack-manifest-input.js";
import { platformConsumerInstallArgs } from "../../scripts/packages/platform-cold-consumer.js";
import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions, type QualifiedPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import {
  closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs,
  runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer,
} from "../helpers/postgresContainer.js";

const installation: QualifiedPostgresInstallation = {
  generation: "qualified-v2", roleMode: "installer-managed", bootstrapLogin: "postgres",
  migrationLogin: "store_owner", runtimeLogin: "store_runtime", restoreLogin: "store_restore",
};
const actor = randomUUID(), principal = randomUUID(), subject = randomUUID(), stranger = randomUUID();
let container: PostgresContainer | undefined, scratch: string | undefined, consumer: string;
let owner: Pool, runtime: Pool, runtimeUrl: string;
const pools: Pool[] = [], closers: (() => Promise<void>)[] = [];
let commerce: typeof import("@openlup/platform/commerce/server/postgres");
let support: typeof import("@openlup/platform/account-support/postgres");
let journey: ReturnType<typeof support.createPostgresCustomerSupportJourneyPort>;
const pool = (connectionString: string) => { const value = new Pool({ connectionString }); pools.push(value); return value; };
const npm = (args: string[], cwd: string) => execFileSync("npm", args, {
  cwd, env: isolatedConsumerEnv(), encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
});
async function order(status: "paid" | "pending_payment" = "paid") {
  const id = randomUUID(), item = randomUUID(), db = await owner.connect();
  try {
    await db.query("BEGIN");
    await db.query("INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor) VALUES($1,$2,$3,'XXX',900)", [id, subject, status]);
    await db.query("INSERT INTO public.commerce_order_items(id,order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,$2,1,1,900,900)", [item, id]);
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
  return { id, item };
}
async function operationCount(orderId: string) {
  return (await owner.query("SELECT count(*)::int AS count FROM public.commerce_order_operations WHERE order_id=$1", [orderId])).rows[0].count;
}

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("G12 restricted PostgreSQL proof missing: Docker unavailable");
  // Durable scratch is owned by this worktree. Every OpenLup runtime module below
  // resolves to a real installed directory; no workspace symlinks or TS loader.
  mkdirSync(".context/scratch", { recursive: true });
  scratch = mkdtempSync(resolve(".context/scratch/m19-store-consumer-"));
  // Pack the locked driver/type dependency closure too: an empty npm cache
  // cannot satisfy registry specs or transitive ranges during an offline install.
  const localDependencies = ["zod", "pg", "pg-connection-string", "pg-pool", "pg-protocol", "pg-types", "pg-int8",
    "postgres-array", "postgres-bytea", "postgres-date", "postgres-interval", "xtend", "pgpass", "split2", "@types/pg", "@types/node", "undici-types"];
  const tarballs = ["packages/core", "packages/platform", ...localDependencies.map(name => `node_modules/${name}`)].map(directory => {
    const result = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", scratch!], resolve(directory)));
    return join(scratch!, result[0].filename);
  });
  consumer = join(scratch, "consumer"); mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), '{"type":"module","private":true}');
  npm(platformConsumerInstallArgs(tarballs), consumer);
  assertInstalledPackages(consumer, ["@openlup/core", "@openlup/platform", ...localDependencies]);
  const installed = createRequire(join(consumer, "package.json"));
  const load = async (entry: string) => {
    const path = realpathSync(installed.resolve(entry));
    expect(path.startsWith(realpathSync(join(consumer, "node_modules")) + sep)).toBe(true);
    expect(path.endsWith(".js")).toBe(true);
    return import(pathToFileURL(path).href);
  };
  commerce = await load("@openlup/platform/commerce/server/postgres");
  support = await load("@openlup/platform/account-support/postgres");

  container = await runPostgresContainer({ name: `m19-stores-${process.pid}`, password: "synthetic-store-proof" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("G12 PostgreSQL TCP unavailable");
  const bootstrap = pool(container.connectionString);
  await bootstrap.query(`CREATE ROLE store_owner LOGIN INHERIT SUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-store-proof';
    ALTER DATABASE postgres OWNER TO store_owner;
    CREATE ROLE store_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-store-proof';
    CREATE ROLE store_restore LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-store-proof'`);
  const login = (name: string, startup = false) => {
    const url = new URL(container!.connectionString); url.username = name;
    if (startup) url.searchParams.set("options", qualifiedPostgresStartupOptions(installation));
    return url.toString();
  };
  owner = pool(login(installation.migrationLogin, true));
  const runner = createPostgresMigrationRunner({ connectionString: login(installation.migrationLogin) }, { installation, poolFactory: () => owner });
  const selected = selectPlatformMigrationManifest(JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")), "qualified-v2", { migrationIsBootstrap: false, hasRestore: true });
  const units = [selected.baseline, ...selected.forward];
  expect((await runner.apply()).applied).toEqual(units.map(unit => unit.file));
  expect((await runner.apply()).applied).toEqual([]);
  expect((await owner.query("SELECT catalog_path,sha256,position FROM public.platform_schema_migrations ORDER BY position")).rows)
    .toEqual(units.map((unit, position) => ({ catalog_path: unit.file, sha256: unit.sha256, position })));
  runtimeUrl = login(installation.runtimeLogin); runtime = pool(runtimeUrl);
  await owner.query("INSERT INTO public.clients(id,principal_id,email,lifecycle_stage) VALUES($1,$2,'stores@example.invalid','customer'),($3,$3,'foreign@example.invalid','customer')", [subject, principal, stranger]);
  await owner.query("INSERT INTO public.commerce_operators(id,label) VALUES($1,'Synthetic store operator')", [actor]);
  await owner.query("INSERT INTO public.platform_control_operators(principal_id,active) VALUES($1,true)", [actor]);
  await owner.query("INSERT INTO public.platform_communication_operators(principal_id,active) VALUES($1,true)", [actor]);
  journey = support.createPostgresCustomerSupportJourneyPort({ connectionString: runtimeUrl, operatorId: actor });
  closers.push(() => journey.close());
}, postgresSetupTimeoutMs);
afterAll(async () => {
  try { await closePostgres(container, pools, closers); }
  finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
}, postgresTeardownTimeoutMs);

it("compiles all three installed entries in both declaration modes and parses under CSP", () => {
  writeFileSync(join(consumer, "consumer.mts"), `
import { createPostgresCommerceOmsPort, createPostgresCommerceOmsControlPlane, createPostgresCommerceReturnsPort, createPostgresProviderExceptionHealPort } from "@openlup/platform/commerce/server/postgres";
import { createPostgresCustomerSupportJourneyPort } from "@openlup/platform/account-support/postgres";
import { customer360LookupRequestSchema, adminClientsPortableSearchRequestSchema } from "@openlup/platform/account-support/read-contracts";
import type { PgQueryExecutor } from "@openlup/platform/data";
declare const executor: PgQueryExecutor;
const returns = createPostgresCommerceReturnsPort<"other" | "host_reason">(executor);
returns.createRequest({idempotencyKey:"consumer-key",orderId:"order",reasonCode:"host_reason",lines:[{orderItemId:"item",quantity:1}]});
// @ts-expect-error the selected host reason remains typed
returns.createRequest({idempotencyKey:"consumer-key",orderId:"order",reasonCode:"unselected",lines:[]});
export const selected = [createPostgresCommerceOmsPort(executor), createPostgresCommerceOmsControlPlane(executor), createPostgresProviderExceptionHealPort(executor)];
export {createPostgresCustomerSupportJourneyPort, customer360LookupRequestSchema, adminClientsPortableSearchRequestSchema};
`);
  const compiler = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  for (const mode of ["NodeNext", "Bundler"]) {
    const config = join(consumer, `tsconfig.${mode}.json`);
    writeFileSync(config, JSON.stringify({ compilerOptions: { target: "ES2022", module: mode === "NodeNext" ? "NodeNext" : "ESNext", moduleResolution: mode,
      strict: true, skipLibCheck: false, noEmit: true, types: ["node"], typeRoots: [join(consumer, "node_modules/@types")] }, files: ["consumer.mts"] }));
    execFileSync(process.execPath, [compiler, "--project", config], { cwd: consumer, env: isolatedConsumerEnv(), stdio: "pipe", timeout: 120_000 });
  }
  const script = join(consumer, "csp.mjs");
  writeFileSync(script, `import assert from "node:assert/strict";
import { customer360LookupRequestSchema, adminClientsPortableSearchRequestSchema } from "@openlup/platform/account-support/read-contracts";
assert.deepEqual(customer360LookupRequestSchema.parse({subjectId:"synthetic"}),{subjectId:"synthetic",pageSize:10});
assert.equal(adminClientsPortableSearchRequestSchema.parse({query:"synthetic"}).page,0);
assert.equal(customer360LookupRequestSchema.safeParse({}).success,false);
assert.equal(adminClientsPortableSearchRequestSchema.safeParse({query:"synthetic",extra:true}).success,false);
const packagedErrors = await import("@openlup/platform/account-support");
const native = await import("@openlup/platform/account-support/postgres");
for (const [code, name] of [["42501","CustomerSupportOperatorInactiveError"], ["22023","CustomerSupportCommandInvalidError"], ["23505","CustomerSupportCommandIdempotencyConflictError"], ["42883","OperatorSubscriptionAuthorityUnavailableError"]]) {
  const port = native.createPostgresCustomerSupportJourneyPort({connectionString:"synthetic",operatorId:"operator"}, {
    createLane: () => ({run: async () => {throw Object.assign(new Error("synthetic SQL refusal"),{code});},close:async () => {}})
  });
  await assert.rejects(() => port.absorbLead({customerId:"customer",leadId:"lead",expectedLeadEmail:"lead@example.invalid",idempotencyKey:"identity-proof",operatorId:"operator"}), error => error instanceof packagedErrors[name]);
  await port.close();
}
`);
  execFileSync(process.execPath, ["--disallow-code-generation-from-strings", script], { cwd: consumer, env: isolatedConsumerEnv(), stdio: "pipe", timeout: 30_000 });
}, 300_000);

it("executes through the qualified restricted login without owner, restore or DDL authority", async () => {
  expect((await runtime.query(`SELECT current_user,session_user,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=current_user`)).rows)
    .toEqual([{ current_user: "store_runtime", session_user: "store_runtime", rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false }]);
  for (const sql of ["SET ROLE store_owner", "SET ROLE store_restore", "CREATE TABLE public.forbidden_store_write(id integer)"])
    await expect(runtime.query(sql)).rejects.toMatchObject({ code: "42501" });
});

it("creates/releases exact holds with durable replay and conflicting-command refusal", async () => {
  const value = await order(), port = commerce.createPostgresCommerceOmsPort(runtime);
  const request = { idempotencyKey: `hold-${value.id}`, orderId: value.id, reason: "manual_support" as const, actorUserId: actor };
  const first = await port.createHold(request);
  expect(first).toMatchObject({ replayed: false, hold: { orderId: value.id, status: "active" } });
  expect(await port.createHold(request)).toMatchObject({ replayed: true, hold: { id: first.hold.id } });
  await expect(port.createHold({ ...request, reason: "risk_review" })).rejects.toThrow("Commerce OMS operation refused");
  const release = { idempotencyKey: `release-${value.id}`, holdId: first.hold.id, actorUserId: actor };
  expect(await port.releaseHold(release)).toMatchObject({ replayed: false, hold: { status: "released" } });
  expect(await port.releaseHold(release)).toMatchObject({ replayed: true, hold: { id: first.hold.id } });
  await expect(port.releaseHold({ ...release, idempotencyKey: `unknown-${value.id}`, holdId: randomUUID() })).rejects.toThrow("Commerce OMS operation refused");
  expect(await operationCount(value.id)).toBe(2);
});

it("cancels only unpaid orders and records only completed external refunds, once", async () => {
  const pending = await order("pending_payment"), paid = await order(), port = commerce.createPostgresCommerceOmsPort(runtime);
  const cancel = { idempotencyKey: `cancel-${pending.id}`, orderId: pending.id, reason: "support_request", actorUserId: actor };
  expect(await port.cancelOrder(cancel)).toMatchObject({ status: "cancelled", replayed: false });
  expect(await port.cancelOrder(cancel)).toMatchObject({ status: "cancelled", replayed: true });
  await expect(port.cancelOrder({ ...cancel, idempotencyKey: `paid-cancel-${paid.id}`, orderId: paid.id })).rejects.toThrow("Commerce OMS operation refused");
  const refund = { idempotencyKey: `refund-${paid.id}`, orderId: paid.id, reason: "external_refund_completed", actorUserId: actor };
  expect(await port.markRefunded(refund)).toMatchObject({ status: "refunded", replayed: false });
  expect(await port.markRefunded(refund)).toMatchObject({ status: "refunded", replayed: true });
  await expect(port.markRefunded({ ...refund, idempotencyKey: `cancelled-refund-${pending.id}`, orderId: pending.id })).rejects.toThrow("Commerce OMS operation refused");
  expect(await operationCount(pending.id)).toBe(1); expect(await operationCount(paid.id)).toBe(1);
});

it("requests, approves and rejects returns with ownership refusal and one operation per key", async () => {
  const value = await order(), port = commerce.createPostgresCommerceReturnsPort(runtime);
  const request = { idempotencyKey: `return-${value.id}`, orderId: value.id, reasonCode: "damaged", requestedBy: principal, lines: [{ orderItemId: value.item, quantity: 1 }] };
  const first = await port.createRequest(request);
  expect(first).toMatchObject({ status: "requested", replayed: false });
  expect(await port.createRequest(request)).toMatchObject({ returnRequestId: first.returnRequestId, replayed: true });
  const state = () => owner.query(`SELECT to_jsonb(r) AS request,
    (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.order_item_id) FROM public.commerce_return_lines l WHERE l.return_request_id=r.id) AS lines,
    (SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM public.commerce_return_operations o WHERE o.return_request_id=r.id) AS operations,
    (SELECT count(*)::int FROM public.outbox_events e WHERE e.aggregate_id=r.id) AS events
    FROM public.commerce_return_requests r WHERE r.id=$1`, [first.returnRequestId]);
  const before = (await state()).rows;
  const refusal = { code: "22023", message: "commerce_return_request_create_order_not_found" };
  await expect(port.createRequest({ ...request, idempotencyKey: `foreign-${value.id}`, requestedBy: stranger })).rejects.toMatchObject(refusal);
  await expect(port.createRequest({ ...request, reasonCode: "other" })).rejects.toMatchObject(refusal);
  expect((await state()).rows).toEqual(before);
  const approval = { idempotencyKey: `approve-${value.id}`, returnRequestId: first.returnRequestId, refundMode: "none" as const, actorUserId: actor };
  expect(await port.approve(approval)).toMatchObject({ status: "approved", replayed: false });
  expect(await port.approve(approval)).toMatchObject({ status: "approved", replayed: true });
  await expect(port.approve({ ...approval, idempotencyKey: `reapprove-${value.id}` })).rejects.toMatchObject({ code: "22023" });
  const second = await port.createRequest({ ...request, idempotencyKey: `second-${value.id}` });
  const rejection = { idempotencyKey: `reject-${value.id}`, returnRequestId: second.returnRequestId, actorUserId: actor };
  expect(await port.reject(rejection)).toMatchObject({ status: "rejected", replayed: false });
  expect(await port.reject(rejection)).toMatchObject({ status: "rejected", replayed: true });
  await expect(port.reject({ ...rejection, idempotencyKey: `rereject-${value.id}` })).rejects.toMatchObject({ code: "22023" });
  expect((await owner.query("SELECT count(*)::int AS count FROM public.commerce_return_operations WHERE return_request_id=ANY($1::uuid[])", [[first.returnRequestId, second.returnRequestId]])).rows[0].count).toBe(4);
});

it("exposes reduced control-plane reads and preserves named rich-projection refusals", async () => {
  const value = await order(), port = commerce.createPostgresCommerceOmsControlPlane(runtime);
  expect(await port.resolveOperator(actor)).toBe(actor); expect(await port.resolveOperator(stranger)).toBeNull();
  const request = { view: "control_plane_v1" as const, page: 1, pageSize: 100 };
  const first = await port.listOrders(request);
  expect(first.orders.some(row => row.orderId === value.id)).toBe(true);
  expect(await port.listOrders(request)).toEqual(first);
  expect(await port.getOrderDetail({ view: "control_plane_v1", orderId: value.id })).toMatchObject({ order: { orderId: value.id, money: { amountMinor: 900, currency: "XXX" } } });
  expect(await port.getOrderDetail({ view: "control_plane_v1", orderId: randomUUID() })).toBeNull();
  const rich = commerce.createPostgresCommerceOmsPort(runtime);
  expect(() => rich.listOrders({} as never)).toThrow("rich managed projection is unavailable");
  expect(() => rich.getOrderDetail({} as never)).toThrow("rich managed projection is unavailable");
});

it("heals only delivered system holds, refuses human holds and replays without another release", async () => {
  const value = await order(), waiting = await order(), human = await order();
  await owner.query("INSERT INTO public.fulfillment_ports(port_key,provider_type,routable) VALUES('store-proof','3pl',true)");
  for (const target of [value, waiting, human]) {
    const shipment = randomUUID(), delivered = target !== waiting;
    await owner.query("INSERT INTO public.fulfillment_shipments(id,order_id,port_key,provider_type,status,create_idempotency_key,delivered_at) VALUES($1,$2,'store-proof','3pl',$3,$4,$5)",
      [shipment, target.id, delivered ? "delivered" : "in_transit", `ship-${target.id}`, delivered ? "2030-01-02" : null]);
    await owner.query("INSERT INTO public.fulfillment_shipment_operations(shipment_id,order_id,operation_type,idempotency_key,occurred_at) VALUES($1,$2,'shipment_exception_raised',$3,'2030-01-01')", [shipment, target.id, `exception-${target.id}`]);
  }
  const humanHold = await commerce.createPostgresCommerceOmsPort(runtime).createHold({ idempotencyKey: `human-${human.id}`, orderId: human.id, reason: "fulfillment_exception", actorUserId: actor });
  const port = commerce.createPostgresProviderExceptionHealPort(runtime);
  const create = { idempotencyKey: `system-${value.id}`, orderId: value.id };
  const hold = await port.createSystemHold(create);
  expect(await port.createSystemHold(create)).toMatchObject({ hold: { id: hold.hold.id }, replayed: true });
  await port.createSystemHold({ idempotencyKey: `waiting-${waiting.id}`, orderId: waiting.id });
  const selected = await port.readHealableProviderExceptionHolds();
  expect(selected.map(row => row.order_id)).toEqual([value.id]);
  await port.releaseDelivered(selected[0]!); await port.releaseDelivered(selected[0]!);
  expect(await port.readHealableProviderExceptionHolds()).toEqual([]);
  expect(await operationCount(value.id)).toBe(2);
  await expect(port.releaseDelivered({ ...selected[0]!, order_id: human.id, hold_id: humanHold.hold.id })).rejects.toThrow("Commerce OMS operation refused");
  expect((await owner.query("SELECT status FROM public.commerce_order_holds WHERE id=$1", [humanHold.hold.id])).rows).toEqual([{ status: "active" }]);
});

it("reads customer search/detail/summary/journey repeatedly and refuses an inactive operator", async () => {
  const request = { query: "stores@example.invalid", page: 0, pageSize: 10, lifecycleStage: "all" as const };
  const search = await journey.searchPortableClients(request);
  expect(search.candidates.map(row => row.subject.subjectId)).toEqual([subject]);
  expect(await journey.searchPortableClients(request)).toEqual(search);
  expect(await journey.getPortableClientDetail({ subjectId: subject })).toMatchObject({ subject: { subjectId: subject } });
  expect(await journey.getPortableSummary({})).toMatchObject({ summary: { totalSubjects: 2 } });
  expect(await journey.searchCustomerJourney({ query: request.query, pageSize: 10 })).toMatchObject({ candidates: [{ subjectId: subject }] });
  expect(await journey.getCustomerJourney({ subjectId: subject, pageSize: 10 })).toMatchObject({ subject: { subjectId: subject } });
  expect(await journey.getCustomerJourney({ subjectId: randomUUID(), pageSize: 10 })).toBeNull();
  const denied = support.createPostgresCustomerSupportJourneyPort({ connectionString: runtimeUrl, operatorId: stranger });
  closers.push(() => denied.close());
  await expect(denied.getPortableSummary({})).rejects.toThrow(/^customer_support_read_failed$/);
  await expect(journey.correctSubjectPhone({ subjectId: subject, expectedPhone: "", newPhone: "", idempotencyKey: "phone-refusal", operatorId: actor }))
    .rejects.toThrow(/^operator_subscription_authority_unavailable$/);
});
