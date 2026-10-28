import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import * as jose from "jose";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createOidcIdentityVerifier, createPostgresAccountLinkStore, createPostgresCustomerMePort } from "@openlup/platform/identity";
import { createPostgresDataGateway, type PgGatewayClient } from "@openlup/platform/data";
import { createPostgresOrderReviewLifecyclePort, createPostgresOrderReviewMediaPort } from "@openlup/platform/commerce/server";
import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { captureConnectedNativeStore, connectedNativeStoreTables, type ConnectedNativeStoreCapture } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions, type QualifiedPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { OrderReviewMediaObjectStore } from "../../server/adapters/filesystem/orderReviewMediaObjectStore.js";
import { captureOrderReviewMediaFilesystem, type OrderReviewMediaFilesystemCensus } from "../../server/adapters/filesystem/orderReviewMediaTransferInventory.js";
import { createOrderReviewMediaTransferReader } from "../../server/adapters/filesystem/orderReviewMediaTransferReader.js";
import { restoreOrderReviewMediaFilesystem } from "../../server/adapters/filesystem/orderReviewMediaTransferRestore.js";
import { fixture, openCase, replacement } from "../helpers/fulfillmentNative.js";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const containers: PostgresContainer[] = [], pools: Pool[] = [], ports: { close(): Promise<void> }[] = [];
const selection: QualifiedPostgresInstallation = { generation: "qualified-v2", roleMode: "installer-managed",
  migrationLogin: "transfer_owner", bootstrapLogin: "postgres", runtimeLogin: "transfer_runtime", restoreLogin: "transfer_restore" };
const selected = selectPlatformMigrationManifest(JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")), "qualified-v2", { migrationIsBootstrap: false, hasRestore: true });
const selectedUnits = [selected.baseline, ...selected.forward];
type Installation = { owner: Pool; runtime: Pool; restore: Pool; runtimeUrl: string };
let source: Installation, target: Installation, pristine: ConnectedNativeStoreCapture, packet: ConnectedNativeStoreCapture;
let graph: Awaited<ReturnType<typeof fixture>>, successor: string, prunedHold: string, retainedHold: string, erased: string;
let identity: Awaited<ReturnType<typeof identityFixture>>;
let media: { parent: string; sourceRoot: string; targetRoot: string; grant: string; confirmedRef: string; pendingRef: string;
  cleanupRef: string; partialTemp: string; census: OrderReviewMediaFilesystemCensus } | undefined;
const mediaLimits = { maximumFiles: 20, maximumObjectBytes: 1024, maximumTotalBytes: 4096 };

function pool(connectionString: string): Pool { const result = new Pool({ connectionString }); pools.push(result); return result; }
async function installation(label: string): Promise<Installation> {
  const container = await runPostgresContainer({ name: `m14-connected-${label}-${process.pid}`, password: "synthetic-transfer" });
  containers.push(container);
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Connected transfer PostgreSQL unavailable");
  const bootstrap = pool(container.connectionString);
  await bootstrap.query(`CREATE ROLE transfer_owner LOGIN INHERIT SUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-transfer';
    ALTER DATABASE postgres OWNER TO transfer_owner;
    CREATE ROLE transfer_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-transfer';
    CREATE ROLE transfer_restore LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-transfer'`);
  const url = (login: string, startup = false) => {
    const value = new URL(container.connectionString); value.username = login;
    if (startup) value.searchParams.set("options", qualifiedPostgresStartupOptions(selection));
    return value.toString();
  };
  const owner = pool(url(selection.migrationLogin, true));
  const runner = createPostgresMigrationRunner({ connectionString: url(selection.migrationLogin) }, { installation: selection, poolFactory: () => owner });
  expect((await runner.apply()).applied).toEqual(selectedUnits.map(unit => unit.file));
  expect((await owner.query("SELECT catalog_path,sha256,position FROM public.platform_schema_migrations ORDER BY position")).rows)
    .toEqual(selectedUnits.map((unit, position) => ({ catalog_path: unit.file, sha256: unit.sha256, position })));
  expect((await runner.status()).pending).toEqual([]);
  return { owner, runtime: pool(url(selection.runtimeLogin)), restore: pool(url(selection.restoreLogin!)), runtimeUrl: url(selection.runtimeLogin) };
}
async function capture(db: Pool, sourceId: string): Promise<ConnectedNativeStoreCapture> {
  return captureConnectedNativeStore({ sourceId, catalogueId: selected.objectInventorySha256, maximumRows: 10000, maximumBytes: 64 * 1024 * 1024,
    source: { async withSnapshot(work) {
      const client = await db.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const result = await work({ query: (sql, values) => client.query(sql, values ? [...values] : undefined) });
        await client.query("COMMIT"); return result;
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    } },
  });
}
async function identityFixture() {
  const issuer = "https://issuer.example.invalid/retained-store", audience = "customer-api";
  const key = await jose.generateKeyPair("ES256"), jwk = { ...await jose.exportJWK(key.publicKey), kid: "native-source", alg: "ES256", use: "sig" };
  const verifier = createOidcIdentityVerifier({ issuer, audience, algorithms: ["ES256"], maxTokenLifetimeSeconds: 3600 }, {
    loadJwt: async () => jose,
    fetch: async url => {
      if (String(url) === `${issuer}/.well-known/openid-configuration`) return Response.json({ issuer, jwks_uri: `${issuer}/keys` });
      if (String(url) === `${issuer}/keys`) return Response.json({ keys: [jwk] });
      return new Response(null, { status: 404 });
    },
  });
  const token = (subject: string) => new jose.SignJWT({ email: "retained@example.invalid", email_verified: true })
    .setIssuer(issuer).setAudience(audience).setSubject(subject).setIssuedAt().setExpirationTime("5m")
    .setProtectedHeader({ alg: "ES256", kid: jwk.kid }).sign(key.privateKey);
  const accessToken = await token("original-native-subject"), verified = await verifier.verifyToken(accessToken);
  if (!verified.ok) throw new Error("Owned signed native fixture did not verify");
  return { verifier, token, accessToken, principal: verified.principal };
}

async function mediaFixture() {
  const parent = await mkdtemp(join(await realpath(tmpdir()), "m14-connected-media-"));
  const sourceRoot = join(parent, "source"), targetRoot = join(parent, "target");
  // Register even a partially prepared fixture for bounded teardown.
  media = { parent, sourceRoot, targetRoot, grant: "", confirmedRef: "", pendingRef: "", cleanupRef: "", partialTemp: "", census: { objects: [], temporary: [] } };
  const store = await OrderReviewMediaObjectStore.create(sourceRoot), grant = `review-grant:${randomUUID()}`;
  const subject = `client:${graph.client}`;
  await source.owner.query("INSERT INTO public.subscriber_profiles(subject_reference,revision,fingerprint) VALUES($1,1,$2)", [subject, "a".repeat(64)]);
  await source.owner.query("INSERT INTO public.subscriber_review_access_grants(order_id,kind,grant_reference,expires_at) VALUES($1,'review_request',$2,'2999-01-01')", [graph.order, grant]);
  await source.owner.query(`INSERT INTO public.subscriber_retention_intents(idempotency_key,subject_reference,subscription_id,source_reference,
    access_grant_reference,kind,template_reference,fingerprint,expected_revision,recipient_fingerprint,control_key,status,delivery_reference,attempt_count)
    VALUES($1,$2,$3,$4,$5,'review_request','retained.review','${"b".repeat(64)}',1,'${"c".repeat(64)}','retained.review','accepted','retained-delivery',1)`,
  [`retained-${graph.order}`, subject, graph.subscription, `order:${graph.order}`, grant]);
  const lifecycle = createPostgresOrderReviewLifecyclePort(source.runtime);
  const uploads = createPostgresOrderReviewMediaPort(source.runtime, { async run(work) {
    const client = await source.runtime.connect();
    try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  } });
  const comment = "Retained synthetic review";
  await lifecycle.submit({ grant, rating: 5, comment, fingerprint: createHash("sha256").update(`5\n${comment}`).digest("hex") });
  const body = (value: Buffer) => (async function* () { yield value; })();
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  let confirmedRef = "", pendingRef = "", cleanupRef = "", partialTemp = "";
  for (const kind of ["confirmed", "pending", "cleanup"] as const) {
    const capabilityDigest = createHash("sha256").update(`owned-${kind}`).digest("hex"), writerRef = `retained-writer:${kind}`;
    const intent = await lifecycle.createMediaIntent({ grant, contentType: "image/png", byteLength: png.length, capabilityDigest, commandKey: `retained-intent:${kind}` });
    const admission = await uploads.admitUpload({ capabilityDigest, declaredContentType: "image/png", declaredByteLength: png.length, writerRef });
    if (admission.kind !== "lease") throw new Error("Source media lease unavailable under actual runtime role");
    const { reservation } = admission;
    const partial = kind === "pending" ? png.subarray(0, 8) : png;
    const receipt = await store.writeTemp(writerRef, body(partial), png.length, reservation.leaseExpiresAt);
    if (kind === "pending") { pendingRef = intent.media.mediaRef; partialTemp = receipt.tempRef; continue; }
    expect(await uploads.finalizeUpload({ capabilityDigest, writerRef, leaseVersion: reservation.leaseVersion,
      digest: receipt.sha256, byteLength: receipt.bytes, promote: () => store.promote(receipt.tempRef, reservation.objectKey) })).toMatchObject({ state: "stored" });
    await lifecycle.confirmMedia({ grant, mediaRef: intent.media.mediaRef, digest: receipt.sha256, commandKey: `retained-confirm:${kind}` });
    if (kind === "confirmed") confirmedRef = intent.media.mediaRef;
    else {
      cleanupRef = intent.media.mediaRef;
      expect(await uploads.prepareAdminDelete({ actorRef: "synthetic-preparation", mediaRef: cleanupRef, idempotencyKey: "retained-cleanup" })).toMatchObject({ media: { state: "cleanup_pending" } });
    }
  }
  const census = await captureOrderReviewMediaFilesystem({ root: sourceRoot, ...mediaLimits });
  return { parent, sourceRoot, targetRoot, grant, confirmedRef, pendingRef, cleanupRef, partialTemp, census };
}

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Connected transfer proof requires owned disposable PostgreSQL");
  source = await installation("source"); target = await installation("target");
  pristine = await capture(target.owner, "owned-pristine-target");
  identity = await identityFixture();
  graph = await fixture(source.owner);
  const retainedGraph = await fixture(source.owner);
  await source.owner.query("UPDATE public.clients SET principal_id=$2,email='retained@example.invalid',lifecycle_stage='customer' WHERE id=$1", [graph.client, identity.principal.principalId]);
  await source.owner.query("UPDATE public.subscriptions SET next_cycle_at='2027-01-01T12:00:00.123456Z' WHERE id=$1", [graph.subscription]);
  await openCase(source.owner, graph);
  prunedHold = (await source.owner.query("SELECT id FROM public.commerce_order_holds WHERE idempotency_key=$1", [`exception-${graph.order}`])).rows[0].id;
  await openCase(source.owner, retainedGraph);
  retainedHold = (await source.owner.query("SELECT id FROM public.commerce_order_holds WHERE idempotency_key=$1", [`exception-${retainedGraph.order}`])).rows[0].id;
  await source.owner.query("INSERT INTO public.commerce_order_operations(order_id,hold_id,operation_type,idempotency_key) VALUES($1,$2,'hold_created',$3)", [graph.order, prunedHold, `hold-history-${prunedHold}`]);
  await source.owner.query("DELETE FROM public.outbox_events WHERE event_type='commerce.shipment.exception' AND idempotency_key=$1", [`shipment_exception:${prunedHold}`]);
  successor = await replacement(source.owner, graph);
  await source.owner.query("INSERT INTO public.shipment_external_refs(shipment_id,ref_role,external_id,recorded_at) VALUES($1,'tracking','retained-tracking','2026-08-02T03:04:05.123456Z')", [successor]);
  await source.owner.query(`INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref)
    VALUES($1,'XXX','fixture-stock','fixture-settlement','2020-01-02T03:04:05.654321Z','retained-authorization')`, [graph.subscription]);
  await source.owner.query("INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES($1,1,'retained-sku',1,9007199254740993)", [graph.subscription]);
  const openOrder = randomUUID();
  const orderWriter = await source.owner.connect();
  await orderWriter.query("BEGIN");
  try {
    await orderWriter.query("INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor) VALUES($1,$2,'pending_payment','XXX',9007199254740993)", [openOrder, graph.client]);
    await orderWriter.query("INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,1,1,9007199254740993,9007199254740993)", [openOrder]);
    await orderWriter.query("COMMIT");
  } catch (error) { await orderWriter.query("ROLLBACK"); throw error; }
  finally { orderWriter.release(); }
  await source.owner.query(`INSERT INTO public.commerce_settlement_intents(order_id,channel_key,amount_minor,currency_code,open_idempotency_key)
    VALUES($1,'fixture-settlement',9007199254740993,'XXX',$2)`, [openOrder, `owed-${openOrder}`]);
  const parent = "f1000000-0000-4000-8000-000000000001", child = "11000000-0000-4000-8000-000000000002";
  await source.owner.query("INSERT INTO public.invoicing_duties(id,order_id,original_key) VALUES($1,$2,'original-invoice-duty')", [parent, graph.order]);
  await source.owner.query("INSERT INTO public.invoicing_duties(id,order_id,parent_duty_id,original_key) VALUES($1,$2,$3,'retained-child-duty')", [child, graph.order, parent]);
  await source.owner.query("INSERT INTO public.invoicing_seller_revisions(duty_id,eligibility_version) VALUES($1,'invoicing.seller.v1')", [parent]);
  await source.owner.query(`INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,status,attempts)
    VALUES('subscription',$1,'retained.owed','original-effect-key','{"frozen":9007199254740993}','processing',3)`, [graph.subscription]);
  const admin = randomUUID(), revoked = randomUUID(); erased = randomUUID();
  await source.owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,'admin@example.invalid'),($2,'revoked@example.invalid')", [admin, revoked]);
  await source.owner.query(`INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at)
    VALUES($1,'admin','active','legacy','2020-01-01')`, [admin]);
  await source.owner.query(`INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at,membership_revoked_at,membership_revoked_by)
    VALUES($1,'distributor','revoked','legacy','2020-01-01','2021-01-01',$2)`, [revoked, admin]);
  await source.owner.query(`INSERT INTO public.identity_privacy_erasures(erasure_id,idempotency_key,principal_id,actor_principal_id,contract_version,contributor_versions,dispositions,retained_obligations,completed_at)
    VALUES($1,$2,$3,$4,'identity.erasure.v1','{}','[]','[]','2022-01-01T03:04:05.123456Z')`, [randomUUID(), randomUUID(), erased, admin]);
  media = await mediaFixture();
  packet = await capture(source.owner, "owned-existing-source");
}, postgresSetupTimeoutMs);
afterAll(async () => {
  try { await closePostgres(containers, pools, ports.map(port => () => port.close())); }
  finally { if (media) await rm(media.parent, { recursive: true, force: true }); }
}, postgresTeardownTimeoutMs);

// Independent whole-row readback; no importer/capture comparison helper is used.
async function census(db: Pool): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {};
  const client = await db.connect();
  try {
    await client.query("BEGIN READ ONLY"); await client.query("SET LOCAL TimeZone='UTC'");
    for (const table of connectedNativeStoreTables) result[table] = (await client.query(`SELECT to_jsonb(t)::text AS value FROM public."${table}" t`)).rows.map(row => String(row.value)).sort();
    await client.query("COMMIT"); return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
const restore = (capturePacket = packet) => restoreConnectedNativeStore({ owner: target.owner, installation: selection, packet: capturePacket, freshTarget: pristine });
function corruptDeclaredTotal(): ConnectedNativeStoreCapture {
  const copy = JSON.parse(JSON.stringify(packet)) as ConnectedNativeStoreCapture;
  const orders = copy.compatible.tables.find(table => table.table === "commerce_orders")!;
  let changed = false;
  orders.rows = orders.rows.map(row => {
    if ((JSON.parse(row) as { id: string }).id !== graph.order) return row;
    const corrupted = row.replace(/"total_amount_minor": 900(?=[,}])/, '"total_amount_minor": 901');
    if (corrupted === row) throw new Error("Deferred-total counterexample did not change the source row");
    changed = true; return corrupted;
  });
  if (!changed) throw new Error("Deferred-total counterexample source order missing");
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const { sha256: _inner, ...inner } = copy.compatible; copy.compatible.sha256 = hash(inner);
  const { sha256: _outer, ...outer } = copy; copy.sha256 = hash(outer);
  return copy;
}

it("refuses a changed known trigger body and an unknown INSERT trigger before importing rows", async () => {
  const before = await census(target.owner);
  const original = (await target.owner.query<{ definition: string }>(
    "SELECT pg_catalog.pg_get_functiondef('public.fulfillment_emit_shipment_exception_notification()'::regprocedure) AS definition")).rows[0]!.definition;
  try {
    // Keeping the admitted trigger name must not admit another function body.
    await target.owner.query(`CREATE OR REPLACE FUNCTION public.fulfillment_emit_shipment_exception_notification()
      RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
      BEGIN RAISE EXCEPTION 'unreviewed_trigger_executed' USING ERRCODE='P0001'; END; $$`);
    await expect(restore()).rejects.toMatchObject({ code: "schema_conflict" });
    expect(await census(target.owner)).toEqual(before);
  } finally { await target.owner.query(original); }
  try {
    await target.owner.query(`CREATE TRIGGER retained_transfer_unapproved AFTER INSERT ON public.commerce_order_holds
      FOR EACH ROW EXECUTE FUNCTION public.fulfillment_emit_shipment_exception_notification()`);
    await expect(restore()).rejects.toMatchObject({ code: "schema_conflict" });
    expect(await census(target.owner)).toEqual(before);
  } finally { await target.owner.query("DROP TRIGGER IF EXISTS retained_transfer_unapproved ON public.commerce_order_holds"); }
  expect(await census(target.owner)).toEqual(before);
});

it("refuses private business omission and nonpristine targets, then preserves the connected retained graph, pruned history and exact replay under actual roles", async () => {
  const sourceBefore = await census(source.owner), targetBefore = await census(target.owner);
  const ledger = (await target.owner.query("SELECT to_jsonb(m)::text AS value FROM public.platform_schema_migrations m ORDER BY position")).rows;
  const keyIdentity = (await target.owner.query("SELECT tableoid::text,ctid::text,xmin::text FROM acquisition_private.installation_key")).rows;
  // An actual canonical private BUSINESS row must not disappear as if private
  // meant credentials. Its key fingerprint is synthetic; no key payload is read.
  await source.owner.query(`INSERT INTO acquisition_private.rate_limit_windows VALUES('requester',decode(repeat('ab',32),'hex'),now(),1,now())`);
  try { await expect(capture(source.owner, "source-with-private-business")).rejects.toMatchObject({ code: "unsupported_table", table: "acquisition_private.rate_limit_windows" }); }
  finally { await source.owner.query("DELETE FROM acquisition_private.rate_limit_windows WHERE key_kind='requester' AND key_fingerprint=decode(repeat('ab',32),'hex')"); }
  await target.owner.query("UPDATE public.commerce_settings SET value_minor=41 WHERE key='shipping_flat_minor'");
  await expect(restore()).rejects.toMatchObject({ code: "target_conflict" });
  expect((await target.owner.query("SELECT value_minor FROM public.commerce_settings WHERE key='shipping_flat_minor'")).rows[0].value_minor).toBe(41);
  const retainedNotification = packet.compatible.tables.find(table => table.table === "outbox_events")!.rows.find(row => {
    const value = JSON.parse(row) as { event_type: string; idempotency_key: string };
    return value.event_type === "commerce.shipment.exception" && value.idempotency_key === `shipment_exception:${retainedHold}`;
  });
  if (!retainedNotification) throw new Error("Retained source obligation fixture missing");
  const setting = pristine.owned.find(table => table.table === "commerce_settings")!.rows[0]!;
  await target.owner.query(`UPDATE public.commerce_settings t SET value_minor=p.value_minor,value_text=p.value_text,updated_at=p.updated_at
    FROM jsonb_populate_record(NULL::public.commerce_settings,$1::jsonb) p WHERE t.key=p.key`, [setting]);
  await target.owner.query("INSERT INTO public.outbox_events SELECT (pg_catalog.jsonb_populate_record(NULL::public.outbox_events,$1::jsonb)).*", [retainedNotification]);
  try {
    await expect(restore()).rejects.toMatchObject({ code: "target_conflict" });
    expect((await target.owner.query("SELECT pg_catalog.to_jsonb(o)::text AS value FROM public.outbox_events o")).rows)
      .toEqual([{ value: retainedNotification }]);
  } finally {
    await target.owner.query("DELETE FROM public.outbox_events WHERE event_type='commerce.shipment.exception' AND idempotency_key=$1", [`shipment_exception:${retainedHold}`]);
  }
  if (!media) throw new Error("Connected media fixture missing");
  const mediaInput = { root: media.targetRoot, census: media.census, ...mediaLimits,
    objects: createOrderReviewMediaTransferReader({ root: media.sourceRoot, maximumObjectBytes: mediaLimits.maximumObjectBytes }),
    temporary: createOrderReviewMediaTransferReader({ root: media.sourceRoot, maximumObjectBytes: mediaLimits.maximumObjectBytes, area: "tmp" }),
  };
  expect(await restoreOrderReviewMediaFilesystem(mediaInput)).toEqual({ replayed: false, objects: 2, temporary: 1 });
  // Files can publish before a failed DB transaction. The target stays inactive;
  // exact filesystem replay plus the original pristine DB baseline permits retry.
  await expect(restore(corruptDeclaredTotal())).rejects.toMatchObject({ code: "target_conflict" });
  expect(await census(target.owner)).toEqual(targetBefore);
  expect((await restoreOrderReviewMediaFilesystem(mediaInput)).replayed).toBe(true);
  const result = await restore();
  expect(result).toEqual({ captureSha256: packet.sha256, replayed: false, neutralizedHistoricalHoldNotifications: 1 });
  expect(await census(target.owner)).toEqual(sourceBefore);
  expect((await target.owner.query("SELECT to_jsonb(m)::text AS value FROM public.platform_schema_migrations m ORDER BY position")).rows).toEqual(ledger);
  expect((await target.owner.query("SELECT tableoid::text,ctid::text,xmin::text FROM acquisition_private.installation_key")).rows).toEqual(keyIdentity);
  expect((await target.owner.query("SELECT 1 FROM public.outbox_events WHERE idempotency_key=$1", [`shipment_exception:${prunedHold}`])).rows).toEqual([]);
  expect((await target.owner.query("SELECT 1 FROM public.outbox_events WHERE idempotency_key=$1", [`shipment_exception:${retainedHold}`])).rows).toHaveLength(1);
  expect((await target.owner.query("SELECT unit_amount_minor::text AS value FROM public.subscription_renewal_term_lines WHERE subscription_id=$1", [graph.subscription])).rows[0].value).toBe("9007199254740993");
  const tuples = (await target.owner.query("SELECT xmin::text FROM public.clients WHERE id=$1", [graph.client])).rows;
  expect((await restore()).replayed).toBe(true);
  expect((await target.owner.query("SELECT xmin::text FROM public.clients WHERE id=$1", [graph.client])).rows).toEqual(tuples);
  expect((await restoreOrderReviewMediaFilesystem(mediaInput)).replayed).toBe(true);
  const runtimeStore = await OrderReviewMediaObjectStore.create(media.targetRoot);
  const mediaPort = createPostgresOrderReviewMediaPort(target.runtime);
  const authorized = await mediaPort.readAuthorized(media.grant, media.confirmedRef);
  if (!authorized) throw new Error("Retained review grant did not authorize its media under actual R");
  expect(await runtimeStore.inspect(authorized.objectKey)).toMatchObject({ exists: true,
    sha256: authorized.media.observedDigest, bytes: authorized.media.observedByteLength });
  const downloaded: Uint8Array[] = []; for await (const chunk of await runtimeStore.open(authorized.objectKey)) downloaded.push(chunk);
  expect(createHash("sha256").update(Buffer.concat(downloaded)).digest("hex")).toBe(authorized.media.observedDigest);
  expect(await mediaPort.readAuthorized(`review-grant:${randomUUID()}`, media.confirmedRef)).toBeNull();
  expect(await mediaPort.readAuthorized(media.grant, media.pendingRef)).toBeNull();
  expect(await mediaPort.readAuthorized(media.grant, media.cleanupRef)).toBeNull();
  expect(await runtimeStore.inspect(media.partialTemp)).toMatchObject({ exists: true, bytes: 8 });
  expect(await captureOrderReviewMediaFilesystem({ root: media.targetRoot, ...mediaLimits })).toEqual(media.census);
  const verified = await identity.verifier.verifyToken(identity.accessToken);
  if (!verified.ok) throw new Error("Retained source token did not verify at target");
  const gateway = createPostgresDataGateway({ connectionString: target.runtimeUrl }, { poolFactory: () => target.runtime });
  const me = (principalId: string) => gateway.asActor({ sub: principalId, role: "authenticated" }, db => createPostgresCustomerMePort(db as PgGatewayClient).getCustomerMe(principalId));
  expect(await me(verified.principal.principalId)).toMatchObject({ clientId: graph.client, email: "retained@example.invalid" });
  const other = await identity.verifier.verifyToken(await identity.token("different-signed-subject"));
  if (!other.ok) throw new Error("Distinct owned subject token did not verify");
  expect(await me(other.principal.principalId)).toBeNull();
  const accounts = createPostgresAccountLinkStore({ connectionString: target.runtimeUrl }); ports.push(accounts);
  await expect(accounts.createAccount({ email: "erased@example.invalid", principalId: erased, acquisitionSource: "direct", lifecycleStage: "lead" })).rejects.toThrow("account_erased_refused");
  await expect(target.restore.query("SELECT id FROM public.clients")).rejects.toMatchObject({ code: "42501" });
  await expect(target.runtime.query("SET ROLE openlup_retained_import_owner")).rejects.toMatchObject({ code: "42501" });
  expect((await target.runtime.query("SELECT current_user,session_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows)
    .toEqual([{ current_user: selection.runtimeLogin, session_user: selection.runtimeLogin, rolsuper: false, rolbypassrls: false }]);
  // Import never claims delivery. Only this explicit synthetic arrival after
  // recovery may shift the schedule, through the existing actual runtime rail.
  expect((await target.owner.query("SELECT delivered_at FROM public.fulfillment_shipments WHERE id=$1", [successor])).rows[0].delivered_at).toBeNull();
  const arrival = () => target.runtime.query("SELECT public.fulfillment_record_alignment_arrival($1,$2,$3,$4)", ["retained-late-arrival", successor, "2027-03-10T12:00:00.654321Z", "evidence:owned-arrival-evidence"]);
  await arrival();
  const schedule = (await target.owner.query("SELECT next_cycle_at::text FROM public.subscriptions WHERE id=$1", [graph.subscription])).rows;
  await arrival();
  expect((await target.owner.query("SELECT next_cycle_at::text FROM public.subscriptions WHERE id=$1", [graph.subscription])).rows).toEqual(schedule);
  expect(schedule[0].next_cycle_at).toBe("2027-04-07 12:00:00.654321+00");
});
