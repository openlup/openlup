import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, expect, it } from "vitest";
import { createPlatformPostgresMigrationRunner } from "@openlup/platform/migrations";
import { readPlatformMigrations, type PlatformMigrationManifestEntry } from "../../scripts/platform-migration-manifest.js";
import { qualifiedPostgresStartupOptions } from "../../server/adapters/postgres/qualifiedInstall.js";
import { fixture } from "../helpers/fulfillmentNative.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer,
  waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";
import { bindDestinationOrder, destinationContext, orderBindingTable, snapshot } from "./destinationDocumentFixture.js";

const installation = { generation: "qualified-v2", roleMode: "installer-managed",
  bootstrapLogin: "postgres", migrationLogin: "postgres", runtimeLogin: "ledger_runtime", restoreLogin: "ledger_restore" } as const;
const password = "synthetic-ledger";
const table = "public.commerce_fulfillment_provider_commands";
const predicate = "public.fulfillment_order_has_destination_v2(uuid,uuid)";
const guard = "commerce_fulfillment_provider_command_destination_v2_guard";
const guardRoutine = `public.${guard}()`;
const roles = ["anon", "authenticated", "service_role", installation.runtimeLogin];
const rpcNames = ["commerce_fulfillment_enqueue_provider_command", "commerce_fulfillment_claim_provider_commands",
  "commerce_fulfillment_mark_command_submitting", "commerce_fulfillment_provider_command_guard"];
const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");
const correlation = fingerprint("correlation");
const exactDialect = ["22023", "destination_adapter_unsupported", "selectedDelivery.providerRef",
  "Use the qualified native dispatch workflow for the original order."];
const exactPair = ["22023", "fulfillment_dispatch_identity_invalid", undefined, undefined];
const plain = (message: string, code = "22023") => [code, message, undefined, undefined];

let container: PostgresContainer | undefined, owner: Pool, runtime: Pool;
afterAll(() => closePostgres(container, [owner, runtime].filter(Boolean)), postgresTeardownTimeoutMs);

async function refusal(run: Promise<unknown>, expected: readonly (string | undefined)[]) {
  const error = await run.then(() => undefined, (cause: unknown) => cause) as
    { code: string; message: string; detail?: string; hint?: string } | undefined;
  expect(error && [error.code, error.message, error.detail, error.hint]).toEqual(expected);
}
type Db = Pool | PoolClient;
function enqueue(db: Db, shipment: string, provider: string, key: string, payload = fingerprint("payload")) {
  return db.query<{ value: string }>(`SELECT public.commerce_fulfillment_enqueue_provider_command($1,$2,
    'dispatch_create','1',$3,$4,$5,NULL,$6,$7,$8,3)::text AS value`,
  [shipment, provider, key, fingerprint(key), payload, fingerprint("routing"), fingerprint("config"), correlation]);
}
const claim = (db: Db, provider: string) => db.query<{ value: string }>(
  "SELECT public.commerce_fulfillment_claim_provider_commands($1,'dispatch_create',1,$2,900)::text AS value",
  [provider, fingerprint("worker")]);
const submitting = (db: Db, fence: unknown[], attempt: string | null = null) => db.query<{ value: string }>(
  "SELECT public.commerce_fulfillment_mark_command_submitting($1,$2,$3,$4,$5)::text AS value", [...fence, attempt]);
const fenceArgs = (claim: Record<string, unknown>) => [claim.commandId, claim.claimToken, claim.claimGeneration, claim.version];

function directInsert(shipment: string, order: string, provider: string) {
  const key = randomUUID();
  return runtime.query(`INSERT INTO ${table}(shipment_id,order_id,provider_kind,command_kind,contract_version,
    idempotency_key_fingerprint,command_key_fingerprint,command_payload_fingerprint,routing_fingerprint,config_fingerprint,
    correlation_fingerprint,retry_budget,available_at)
    VALUES($1,$2,$3,'dispatch_create','1',$4,$4,$4,$4,$4,$5,3,now()-interval '1 hour') RETURNING id`,
  [shipment, order, provider, fingerprint(key), correlation]);
}

async function boundParcel() {
  const context = await destinationContext(owner), issued = await snapshot(runtime, context);
  const order = await bindDestinationOrder(owner, context, issued), shipment = randomUUID();
  await owner.query("INSERT INTO public.fulfillment_ports(port_key,provider_type,routable) VALUES('ledger-fixture','3pl',true) ON CONFLICT DO NOTHING");
  await owner.query(`INSERT INTO public.fulfillment_shipments(id,order_id,port_key,provider_type,create_idempotency_key)
    VALUES($1,$2,'ledger-fixture','3pl',$1::uuid::text)`, [shipment, order]);
  return { context, issued, order, shipment };
}

const census = (shipments: string[]) => owner.query(`SELECT
  (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM ${table} c WHERE c.shipment_id=ANY($1))::text AS commands,
  (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.commerce_fulfillment_provider_command_transitions t
    JOIN ${table} c ON c.id=t.command_id WHERE c.shipment_id=ANY($1))::text AS transitions,
  (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM public.fulfillment_dispatch_refs r WHERE r.shipment_id=ANY($1))::text AS refs`, [shipments]);
const attrs = () => owner.query(`SELECT oid::regprocedure::text AS signature,
  to_jsonb(p)-'prosrc'-'proargdefaults' AS attributes, pg_get_function_arguments(oid) AS arguments
  FROM pg_proc p WHERE pronamespace='public'::regnamespace AND proname=ANY($1) ORDER BY signature`, [rpcNames]);
const incumbent = () => owner.query(`SELECT oid,pg_get_triggerdef(oid) AS definition FROM pg_trigger
  WHERE tgrelid=$1::regclass AND tgname='commerce_fulfillment_provider_command_guard'`, [table]);

async function assertBrowserDefaultPrivileges(forward: string) {
  const db = await owner.connect();
  try {
    await db.query("BEGIN");
    await db.query(`DROP TRIGGER ${guard} ON ${table};
      DROP FUNCTION ${guardRoutine}, ${predicate};
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
      CREATE FUNCTION public.ledger_default_acl_control() RETURNS boolean LANGUAGE sql AS 'SELECT true'`);
    const allowed = (signature: string) => db.query<{ role: string }>(`SELECT role FROM unnest($1::text[]) AS r(role)
      WHERE has_function_privilege(role,$2::regprocedure,'EXECUTE') ORDER BY role`, [roles, signature]);
    expect((await allowed("public.ledger_default_acl_control()")).rows.map(row => row.role)).toEqual([...roles].sort());
    await db.query(readFileSync(forward, "utf8"));
    expect((await allowed(guardRoutine)).rows).toEqual([]);
    expect((await allowed(predicate)).rows).toEqual([{ role: installation.runtimeLogin }, { role: "service_role" }]);
    for (const role of roles) {
      await db.query(`SET LOCAL ROLE ${role}`);
      const calls = [`SELECT ${guardRoutine}`];
      if (role === "anon" || role === "authenticated") calls.push("SELECT public.fulfillment_order_has_destination_v2(NULL,NULL)");
      for (const sql of calls) {
        await db.query("SAVEPOINT denied_call");
        await expect(db.query(sql)).rejects.toMatchObject({ code: "42501" });
        await db.query("ROLLBACK TO SAVEPOINT denied_call; RELEASE SAVEPOINT denied_call");
      }
      await db.query("RESET ROLE");
    }
  } finally { try { await db.query("ROLLBACK"); } finally { db.release(); } }
}

async function legacyRun(provider: string, commandId: string) {
  const db = await runtime.connect();
  try {
    await db.query("BEGIN");
    const claimed = JSON.parse((await claim(db, provider)).rows[0]!.value);
    const lease = (await db.query(`SELECT claim_token,claim_expires_at=now()+interval '900 seconds' AS valid
      FROM ${table} WHERE id=$1`, [commandId])).rows[0];
    expect(lease).toEqual({ claim_token: claimed.claimToken, valid: true });
    expect((await db.query("SELECT to_jsonb(now()+interval '900 seconds') AS expires")).rows[0]!.expires)
      .toBe(claimed.leaseExpiresAt);
    const submitted = (await submitting(db, fenceArgs(claimed))).rows[0]!.value;
    const { claimToken: _token, leaseExpiresAt: _expiry, ...fixedClaim } = claimed;
    return { fixedClaim: JSON.stringify(fixedClaim), submitted };
  } finally { await db.query("ROLLBACK"); db.release(); }
}

it("upgrades the qualified ledger, preserving legacy bytes and fencing fresh v2 work", async () => {
  container = await runPostgresContainer({ name: `destination-dispatch-ledger-${process.pid}`, password });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Ledger PostgreSQL unavailable");
  owner = new Pool({ connectionString: container.connectionString, options: qualifiedPostgresStartupOptions(installation) });
  await owner.query(`CREATE ROLE ledger_runtime LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD '${password}';
    CREATE ROLE ledger_restore LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS`);
  const runtimeUrl = new URL(container.connectionString);
  runtimeUrl.username = installation.runtimeLogin;
  runtime = new Pool({ connectionString: runtimeUrl.href });

  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
  const isForward = (unit: PlatformMigrationManifestEntry) => unit.file.endsWith("_fulfillment_destination_v2_legacy_ledger_fence.sql");
  const forward: PlatformMigrationManifestEntry = manifest.qualified.forward.find(isForward);
  expect(forward).toBeDefined();
  const all = readPlatformMigrations(process.cwd());
  const runner = (includeForward: boolean) => {
    const selected = structuredClone(manifest);
    const paths = new Set<string>();
    for (const plan of [selected, selected.qualified, selected.qualifiedAdmin]) {
      plan.forward = plan.forward.slice(0, plan.forward.findIndex(isForward) + Number(includeForward));
      for (const unit of [plan.baseline, ...plan.forward]) paths.add(unit.file);
    }
    selected.qualified.objectInventorySha256.bootstrapMigrator.withRestore = fingerprint("");
    return createPlatformPostgresMigrationRunner({ connectionString: container!.connectionString }, {
      installation, poolFactory: () => owner,
      // This fixture isolates a historical prefix. The installation-inventory
      // proof checks the complete production catalog independently.
      catalogProjectionPayload: async () => "",
      catalog: { readManifest: () => selected, readMigrations: () => ({ ...all, migrations: all.migrations.filter(unit => paths.has(unit.file)) }) },
    });
  };
  await runner(false).apply();

  const legacy = await fixture(owner), v2 = await boundParcel(), fresh = await boundParcel();
  const provider = "ledger-fixture", legacyKey = randomUUID(), historicalKey = randomUUID();
  const issued = (await enqueue(runtime, legacy.shipment, provider, legacyKey)).rows[0]!.value;
  const beforeV1 = await legacyRun(provider, JSON.parse(issued).commandId);
  await enqueue(runtime, v2.shipment, "historical", historicalKey);
  const historical = JSON.parse((await claim(runtime, "historical")).rows[0]!.value);
  await directInsert(v2.shipment, v2.order, provider);
  await directInsert(fresh.shipment, legacy.order, provider);
  await directInsert(fresh.shipment, legacy.order, "bad-pair");
  const bad = JSON.parse((await claim(runtime, "bad-pair")).rows[0]!.value);
  const old = await boundParcel(), oldKey = randomUUID();
  await enqueue(runtime, old.shipment, "in-flight", oldKey);
  const inFlight = JSON.parse((await claim(runtime, "in-flight")).rows[0]!.value);
  const submitted = (await submitting(runtime, fenceArgs(inFlight))).rows[0]!.value;
  const wrappedFence = [...fenceArgs(inFlight).slice(0, 3), JSON.parse(submitted).version];
  const reconcile = (db: Db, id: string) => db.query<{ value: string }>(`SELECT public.commerce_fulfillment_reconcile_provider_command
    ($1,4,$2,'correlation_key',$3,now(),'provider_lookup')::text AS value`, [id, correlation, fingerprint("proof")]);
  const uncertain = (db: Db) => db.query(`SELECT public.commerce_fulfillment_apply_command_write_outcome
    ($1,$2,$3,$4,$5,'uncertain','write_uncertain')`, [...wrappedFence, correlation]);

  const deliveryRef = randomUUID();
  const accepted = { kind: "accepted", evidence: { providerRef: "offline" }, externalRef: "issued-fixture" };
  await owner.query(`INSERT INTO public.fulfillment_dispatch_refs(id,request_key,shipment_id,order_id,mode,status,evidence,external_ref,acceptance)
    VALUES($1,$1::uuid::text,$2,$3,'live','created',$4,$5,$6)`,
  [deliveryRef, old.shipment, old.order, accepted.evidence, accepted.externalRef, accepted]);
  const ack = () => runtime.query<{ value: string }>(
    "SELECT public.fulfillment_dispatch_finish($1,$2,true,'push')::text AS value", [deliveryRef, accepted]);
  const ackBefore = (await ack()).rows;
  expect(JSON.parse(ackBefore[0]!.value)).toMatchObject({ acknowledged: true, replayed: true });

  const allShipments = [legacy.shipment, v2.shipment, fresh.shipment, old.shipment];
  const before = (await census(allShipments)).rows, priorAttrs = (await attrs()).rows, priorTrigger = (await incumbent()).rows;
  const upgrade = runner(true);
  expect(await upgrade.apply()).toEqual({ applied: [forward.file] });
  expect((await attrs()).rows).toEqual(priorAttrs);
  expect((await incumbent()).rows).toEqual(priorTrigger);
  expect((await census(allShipments)).rows).toEqual(before);
  expect((await ack()).rows).toEqual(ackBefore);
  expect((await enqueue(runtime, legacy.shipment, provider, legacyKey)).rows[0]!.value).toBe(issued);
  expect(await legacyRun(provider, JSON.parse(issued).commandId)).toEqual(beforeV1);

  const grants = await owner.query(`SELECT p.oid::regprocedure::text AS routine, prosecdef, provolatile, proconfig,
    ARRAY(SELECT r.rolname::text FROM pg_roles r WHERE r.rolname=ANY($1::text[])
      AND has_function_privilege(r.oid,p.oid,'EXECUTE') ORDER BY 1) AS can_execute,
    NOT EXISTS (SELECT 1 FROM aclexplode(proacl) WHERE grantee=0) AS no_public
    FROM pg_proc p WHERE p.oid=ANY($2::regprocedure[]) ORDER BY routine`, [roles, [predicate, guardRoutine]]);
  expect(grants.rows).toEqual([
    { routine: `${guard}()`, prosecdef: false, provolatile: "v", proconfig: ["search_path=pg_catalog, pg_temp"],
      can_execute: [], no_public: true },
    { routine: "fulfillment_order_has_destination_v2(uuid,uuid)", prosecdef: true, provolatile: "s", proconfig: ["search_path=pg_catalog, pg_temp"],
      can_execute: [installation.runtimeLogin, "service_role"], no_public: true },
  ]);
  await assertBrowserDefaultPrivileges(forward.file);
  await expect(runtime.query(`SELECT ${guardRoutine}`)).rejects.toMatchObject({ code: "42501" });
  expect((await runtime.query("SELECT session_user AS login,current_user AS role")).rows)
    .toEqual([{ login: installation.runtimeLogin, role: installation.runtimeLogin }]);
  expect((await owner.query(`SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])
    AND (has_table_privilege(oid,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege(oid,$2,'SELECT,INSERT,UPDATE,REFERENCES'))`, [roles, orderBindingTable])).rows).toEqual([]);

  const beforeRefusals = (await census(allShipments)).rows;
  await refusal(enqueue(runtime, randomUUID(), provider, randomUUID()), plain("fulfillment_provider_command_fulfillment_not_found"));
  await refusal(enqueue(runtime, old.shipment, "new-effect", randomUUID()), plain("fulfillment_command_direct_effect_exists"));
  await refusal(enqueue(runtime, fresh.shipment, provider, randomUUID()), exactDialect);
  await refusal(enqueue(runtime, v2.shipment, "historical", historicalKey, fingerprint("changed")),
    plain("fulfillment_provider_command_enqueue_identity_conflict", "23505"));
  expect(JSON.parse((await enqueue(runtime, v2.shipment, "historical", historicalKey)).rows[0]!.value))
    .toEqual({ commandId: historical.commandId, status: "claimed", version: 2, applied: true });
  await refusal(directInsert(fresh.shipment, fresh.order, provider), exactDialect);
  await refusal(directInsert(fresh.shipment, legacy.order, provider), exactPair);
  await refusal(directInsert(randomUUID(), fresh.order, provider), exactPair);
  await refusal(submitting(runtime, fenceArgs(historical), randomUUID()), plain("fulfillment_provider_command_attempt_mismatch"));
  await refusal(submitting(runtime, [...fenceArgs(historical).slice(0, 3), 1]), plain("fulfillment_provider_command_fence_conflict", "40001"));
  await refusal(submitting(runtime, fenceArgs(historical)), exactDialect);
  await refusal(submitting(runtime, fenceArgs(bad)), exactPair);
  await refusal(runtime.query(`UPDATE ${table} SET status='submitting',version=version+1 WHERE id=$1`, [bad.commandId]), exactPair);
  // Also violates the incumbent version guard. The additive guard runs first.
  await refusal(runtime.query(`UPDATE ${table} SET status='submitting' WHERE id=$1`, [historical.commandId]), exactDialect);
  expect((await census(allShipments)).rows).toEqual(beforeRefusals);

  for (const { context } of [fresh, v2]) await runtime.query("SELECT public.commerce_destination_v2_erase($1)", [context.clientId]);
  await refusal(submitting(runtime, fenceArgs(historical)), exactDialect);
  await refusal(runtime.query(`UPDATE ${table} SET status='submitting' WHERE id=$1`, [historical.commandId]), exactDialect);
  expect((await owner.query(`SELECT selection,service FROM ${orderBindingTable} WHERE order_id=$1`, [fresh.order])).rows)
    .toEqual([{ selection: null, service: null }]);
  await refusal(enqueue(runtime, fresh.shipment, provider, randomUUID()), exactDialect);
  const claimed = (await claim(runtime, provider)).rows.map(row => JSON.parse(row.value));
  expect(claimed.map(row => row.fulfillmentRef)).toEqual([legacy.shipment]);
  expect((await claim(runtime, provider)).rows).toEqual([]);

  await uncertain(runtime);
  expect(JSON.parse((await reconcile(runtime, inFlight.commandId)).rows[0]!.value))
    .toEqual({ commandId: inFlight.commandId, status: "confirmed", version: 5, applied: true, proofRecorded: true });
  expect((await ack()).rows).toEqual(ackBefore);
}, postgresSetupTimeoutMs);
