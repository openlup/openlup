import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { captureCompatiblePostgresRows, PostgresTransferError, type CompatiblePostgresSnapshot } from "@openlup/platform/portability";
import type { QueryConfig } from "pg";
import { expect, it } from "vitest";
import {
  captureConnectedNativeStore, connectedStoreClusterIdentitySql, connectedStoreRowSource, type ConnectedNativeStoreCapture,
} from "../../server/adapters/postgres/connectedStoreCapture.js";
import { connectedStoreSourceShape, restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { qualifiedPostgresCatalogPayload } from "../../server/adapters/postgres/qualifiedInstall.js";
import { readPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
import { sealConnectedCapture } from "./connectedStoreHistoricalPacket.fixture.js";
import { installAccountMutations } from "./customerAccountMutations.fixture.js";
import { prepareOriginal, sandboxRenewal } from "./subscriptionNativeFixture.js";

const profiles = ["bootstrap", "separate", "admin-managed", "admin-operator"] as const;
const acceptedReferences = "20261124220001_catalog_accepted_references.sql";
const histories = [
  { before: "20261123191000_catalog_publication_commands.sql", predatesLedger: true, predatesScheme: true, inventories: [
    "1c9190ad0520e6ce8229a81ed9ba756da528986d19cad09fc1716d72dadd70c0", "c19175002e39e2b4100841e7138759a4dd07fe3158ebd3ce5f7283a5e8d538a9",
    "10be382792deaf1cb8f7c1620984d3c47a5c7e8b1cb1634aa7e44374370d2c00", "9979a84636b80febb605161e2df5fe14b59ad975781b697bd42fee0dcd9dc71c",
  ] },
  { before: "20261124200000_checkout_attempt_ledger.sql", predatesLedger: true, predatesScheme: false, inventories: [
    "df04bdf1590aae92df0fe1885a90a6f7d8c25075a38b3e57a5a66f9bb358eadb", "0fca9c01fd08e76700cd55eaafb81ff1dd9f265ed9a672d3c9936812c8df1153",
    "955596b9524fa304df1240b3e170d920c1ba27aefc366fb436c78bf7abb326b5", "443cb07abc88ad43dd3c712310b31204f242b50793fc40d0a5e5ba8765995017",
  ] },
  { before: "20261124220000_catalog_governed_lifecycle.sql", predatesLedger: false, predatesScheme: false, inventories: [
    "25bc3a527c27eb205c60b26e388d475bc8532638e66537438e60659a77214f20", "b80abf637c8f3f6f854fcac09c88c6b9774857f93c41f0f94664e20f7e62b385",
    "37df11b3df727367715dcabaff16e366fac0477c8a09167d3f180e31746b82c4", "4c05ab3d6ed00157305853bdfd272469feabc03c6528aab3d6eec7a7e7a2d8ac",
  ] },
  // Qualified inventories at 3df347309.
  { before: acceptedReferences, predatesLedger: false, predatesScheme: false, inventories: [
    "ec9028a590334948606d160362e9363c50793284548c2b9c092a71632234724c", "1feea98acf1cd7cdf1de399cdf8ab8c9ff6a30cec67168a274428f05f4722638",
    "02c68db9202830bd08f574130d3a3de19345a4050b8879d3338824b379474195", "a05e24a7dcdc6cb4394907be818520a33fa89e9a269a7c01853cd656ecfcf91b",
  ] },
] as const;
type History = typeof histories[number];
type Store = Awaited<ReturnType<typeof installAccountMutations>>;
const limits = { maximumRows: 10000, maximumBytes: 64 * 1024 * 1024 };
const schema = "db/platform/migrations";
const ledger = "commerce_checkout_attempt_ledger";
const quotes = "subscription_edit_quotes";
const carriedRows = (packet: ConnectedNativeStoreCapture) => [...packet.compatible.tables, ...packet.owned];

function historicalRoot(root: string, history: History) {
  const manifest = readPlatformMigrationManifest(process.cwd()) as Extract<PlatformMigrationManifest, { schemaVersion: 3 }>;
  const [bootstrap, separate, installerManaged, operatorProvisioned] = history.inventories;
  manifest.qualified.objectInventorySha256 = { bootstrapMigrator: { withRestore: bootstrap }, separateMigrator: { withRestore: separate } };
  manifest.qualifiedAdmin.objectInventorySha256 = { installerManaged, operatorProvisioned };
  for (const plan of [manifest, manifest.qualified, manifest.qualifiedAdmin]) {
    const position = plan.forward.findIndex(unit => unit.file === `${schema}/${history.before}`);
    if (position < 0) throw new Error(`Missing historical boundary ${history.before}`);
    plan.forward = plan.forward.slice(0, position);
    for (const unit of [plan.baseline, ...plan.forward]) {
      const target = join(root, unit.file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(unit.file, target);
    }
  }
  mkdirSync(join(root, "config"));
  writeFileSync(join(root, "config/platform-migration-manifest.json"), JSON.stringify(manifest));
}

function snapshot(store: Store, target = false): CompatiblePostgresSnapshot {
  return { async withSnapshot(work) {
    const client = await (target ? store.migrator : store.owner).connect();
    const restricted = target && store.installation.generation === "qualified-admin";
    try {
      if (restricted) await client.query("GRANT platform_acquisition_owner TO account_m WITH ADMIN FALSE, INHERIT TRUE, SET FALSE GRANTED BY account_m");
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await work({ query: (sql, values) => client.query(sql, values ? [...values] : undefined) });
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally {
      try { if (restricted) await client.query("REVOKE platform_acquisition_owner FROM account_m GRANTED BY account_m"); }
      finally { client.release(); }
    }
  } };
}

function capture(store: Store, sourceId: string, target = false) {
  return captureConnectedNativeStore({ source: snapshot(store, target), sourceId, catalogueId: store.inventory, ...limits });
}

// Read the old installations directly using the historical table lists and
// census rule. Read only the columns that actually exist in the old catalog.
async function capturePredecessor(store: Store, fresh: ConnectedNativeStoreCapture, history: History) {
  const compatibleTables = fresh.compatible.tables.map(({ table }) => table).filter(table => !history.predatesLedger || table !== ledger);
  const ownedTables = fresh.owned.map(({ table }) => table).filter(table => table !== quotes);
  const carried = new Set<string>([...compatibleTables, ...ownedTables].map(table => `public.${table}`));
  return snapshot(store).withSnapshot(async db => {
    await db.query("SET LOCAL row_security = off");
    await db.query("SET LOCAL TimeZone = 'UTC'");
    const observation = (await db.query<ConnectedNativeStoreCapture["observation"]>(`SELECT
      ${connectedStoreClusterIdentitySql} AS cluster, current_database() AS database,
      session_user::text AS login, txid_current_snapshot()::text AS snapshot`)).rows[0];
    const relations = (await db.query<{ relation: string; owner: string; qualified: string }>(`SELECT
      n.nspname || '.' || c.relname AS relation, pg_get_userbyid(c.relowner) AS owner,
      format('%I.%I', n.nspname, c.relname) AS qualified
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'
      AND c.relkind IN ('r','p') ORDER BY n.nspname,c.relname`)).rows;
    const outsideProfileCensus: ConnectedNativeStoreCapture["outsideProfileCensus"] = [];
    for (const { relation, owner, qualified } of relations) {
      if (carried.has(relation)) continue;
      const disposition = fresh.outsideProfileCensus.find(entry => entry.relation === relation)?.disposition ?? "unsupported-empty";
      const { rows: [{ count }] } = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${qualified}`);
      if (disposition === "unsupported-empty" && count !== "0") throw new PostgresTransferError("unsupported_table", relation);
      outsideProfileCensus.push({ relation, owner, rows: count, disposition });
    }
    const compatible = await captureCompatiblePostgresRows({
      source: { withSnapshot: work => work(db) }, sourceId: "predecessor", catalogueId: store.inventory, tables: compatibleTables, ...limits,
    });
    const owned: ConnectedNativeStoreCapture["owned"] = [];
    for (const table of ownedTables) {
      const columns = (await db.query<{ name: string; type: string }>(`SELECT attname AS name,format_type(atttypid,atttypmod) AS type
        FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum`, [`public.${table}`])).rows;
      const rows = (await db.query<{ value: string }>(`SELECT to_jsonb(t)::text AS value FROM ${connectedStoreRowSource(table, columns)} t
        ORDER BY to_jsonb(t)::text`)).rows.map(({ value }) => value);
      owned.push({ table, columns, rows });
    }
    return sealConnectedCapture({ format: "openlup.native-retained-store.v1", compatible, owned, observation, outsideProfileCensus,
      emptyOutsideProfile: outsideProfileCensus.filter(entry => entry.disposition === "unsupported-empty").map(entry => entry.relation), sha256: "" });
  });
}

async function seed(store: Store, history: History) {
  const f = await sandboxRenewal(store.owner);
  await prepareOriginal(store.owner, f);
  const sku = f.snapshot.lines[0].sku;
  await store.owner.query(`INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,currency_code,unit_price_minor)
    SELECT $1,id,2,0,'XXX',100 FROM public.catalog_skus WHERE sku=$2`, [f.subscription, sku]);
  await store.owner.query(`INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload)
    VALUES($1,'fixture.retained','restore-upgrade-event','{"exact":9007199254740993}')`, [f.subscription]);
  await store.owner.query(`INSERT INTO public.catalog_sku_identifiers(catalog_sku_id,issuer,identifier_kind,normalized_value,pack_kind,quantity)
    SELECT id,'fixture','gtin','05901234123457','unit',1 FROM public.catalog_skus WHERE sku=$1`, [sku]);
  if (!history.predatesScheme) await store.owner.query("UPDATE public.catalog_sku_identifiers SET scheme='gs1:gtin'");
  if (!history.predatesLedger) await store.owner.query(`INSERT INTO public.${ledger}
    (attempt_digest,requester_digest,email_digest,recorded_at_ms)
    VALUES(repeat('a',64),repeat('b',64),repeat('c',64),9007199254740993)`);
  return f.subscription;
}

it.each(histories.map((history, index) => ({ history, profile: profiles[index], inventory: history.inventories[index] })))(
  "restores $profile packets byte for byte against an in-place upgrade from before $history.before", async ({ history, profile, inventory }) => {
    const root = mkdtempSync(join(tmpdir(), "connected-restore-prefix-"));
    const stores: Store[] = [];
    const install = async (label: string, prefix?: string) => {
      const store = await installAccountMutations(profile, false, label, prefix);
      stores.push(store);
      return store;
    };
    try {
      historicalRoot(root, history);
      const source = await install("restore-predecessor", root);
      expect(source.inventory).toBe(inventory);
      const subscription = await seed(source, history);
      const convertedTarget = await install("restore-converted");
      const fresh = await capture(convertedTarget, "fresh-converted", true);
      await source.owner.query(`INSERT INTO public.${quotes}(subscription_id,idempotency_key,request_fingerprint,quote_hash,
        expected_template_version,proposed_lines,proposed_cadence_days,current_total_minor,new_total_minor,currency_code,expires_at)
        VALUES($1,'fixture-quote',repeat('b',64),repeat('c',64),1,'[]',28,200,200,'XXX','2026-09-02')`, [subscription]);
      await expect(capturePredecessor(source, fresh, history)).rejects.toMatchObject({ code: "unsupported_table", table: `public.${quotes}` });
      await source.owner.query(`DELETE FROM public.${quotes} WHERE subscription_id=$1`, [subscription]);
      const predecessor = await capturePredecessor(source, fresh, history);
      expect(predecessor.outsideProfileCensus).toContainEqual(expect.objectContaining({
        relation: `public.${quotes}`, rows: "0", disposition: "unsupported-empty",
      }));
      for (const table of ["commerce_orders", "subscription_events", "subscription_renewal_terms", "subscription_renewal_operations",
        "subscription_lines", "catalog_sku_identifiers"]) {
        expect(carriedRows(predecessor).find(entry => entry.table === table)?.rows.length).toBeGreaterThan(0);
      }
      if (convertedTarget.installation.generation === "legacy") throw new Error("Qualified restore target required");
      const restore = { owner: convertedTarget.migrator, installation: convertedTarget.installation, packet: predecessor, freshTarget: fresh };
      expect(await restoreConnectedNativeStore(restore)).toMatchObject({ captureSha256: predecessor.sha256, replayed: false });
      expect(await restoreConnectedNativeStore(restore)).toMatchObject({ captureSha256: predecessor.sha256, replayed: true });
      expect((await source.runner.apply()).applied).toContain(`${schema}/${acceptedReferences}`);
      const upgraded = await capture(source, "upgraded-in-place");
      // Exact current-shape restore is covered by tests/postgres/connectedStoreCatalogRevisions.test.ts:90.
      expect(carriedRows(await capture(convertedTarget, "restored-converted"))).toEqual(carriedRows(upgraded));
    } finally {
      try { await Promise.all(stores.map(store => store.close())); }
      finally { rmSync(root, { recursive: true, force: true }); }
    }
  }, postgresSetupTimeoutMs,
);

// Both code revisions run this same witness. The first run writes the actual
// source capture, and the second run consumes its unchanged bytes.
const parityProfiles = [
  { history: histories[0], profile: "bootstrap", shape: "beforePublicationCommands" },
  { history: histories[1], profile: "separate", shape: "beforeCheckoutAttemptLedger" },
  { history: histories[3], profile: "admin-operator", shape: "beforeAcceptedReferences" },
] as const;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const evidenceDigest = (value: unknown) => sha256(JSON.stringify(value));

async function retainedTargetState(store: Store) {
  const key = (await store.owner.query("SELECT tableoid::text,ctid::text,xmin::text FROM acquisition_private.installation_key")).rows;
  expect(key).toHaveLength(1);
  const ledger = (await store.owner.query(`SELECT pg_catalog.to_jsonb(m)::text AS value
    FROM public.platform_schema_migrations m ORDER BY position`)).rows.map(({ value }) => value);
  const roles = (await store.owner.query(`SELECT pg_get_userbyid(roleid) AS role,pg_get_userbyid(member) AS member,
      pg_get_userbyid(grantor) AS grantor,admin_option,inherit_option,set_option
    FROM pg_catalog.pg_auth_members ORDER BY 1,2,3,4,5,6`)).rows;
  return { key, ledger, roles };
}

it.each(parityProfiles)("compares real PostgreSQL 16 restore bytes for $shape", async ({ history, profile, shape }) => {
  const started = performance.now();
  const root = mkdtempSync(join(tmpdir(), "connected-restore-parity-"));
  const stores: Store[] = [];
  const install = async (label: string, prefix?: string) => {
    const store = await installAccountMutations(profile, false, label, prefix);
    stores.push(store);
    return store;
  };
  const writer = process.env.OPENLUP_RESTORE_PARITY_WRITE;
  const reader = process.env.OPENLUP_RESTORE_PARITY_READ;
  const lockMs: number[] = [];
  let peakHeap = process.memoryUsage().heapUsed;
  try {
    const target = await install("restore-parity-target");
    const fresh = await capture(target, "parity-target", true);
    let bytes: string;
    if (reader) {
      bytes = readFileSync(join(reader, shape + ".json"), "utf8");
    } else {
      historicalRoot(root, history);
      const source = await install("restore-parity-source", root);
      const version = (await source.owner.query("SHOW server_version_num")).rows[0]!.server_version_num;
      expect(Number(version)).toBeGreaterThanOrEqual(160000);
      expect(Number(version)).toBeLessThan(170000);
      await seed(source, history);
      bytes = JSON.stringify(await capturePredecessor(source, fresh, history));
      if (writer) writeFileSync(join(writer, shape + ".json"), bytes, { mode: 0o600, flag: "wx" });
    }
    const packet = JSON.parse(bytes) as ConnectedNativeStoreCapture;
    const before = await retainedTargetState(target);
    if (target.installation.generation === "legacy") throw new Error("Qualified restore target required");
    // Sample the worker heap and measure the public lock window using the
    // adapter's ordinary connection path.
    const owner = { async connect() {
      const client = await target.migrator.connect();
      let lockStarted: number | undefined;
      return {
        async query(sql: string | QueryConfig, values?: unknown[]) {
          const text = typeof sql === "string" ? sql : sql.text;
          const result = typeof sql === "string" ? await client.query(sql, values) : await client.query(sql);
          peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
          if (text.startsWith('LOCK TABLE "public".')) lockStarted ??= performance.now();
          if (text === "COMMIT" && lockStarted !== undefined) lockMs.push(performance.now() - lockStarted);
          return result;
        },
        release: (destroy?: boolean) => client.release(destroy),
      };
    } } as unknown as typeof target.migrator;
    const input = { owner, installation: target.installation, packet, freshTarget: fresh };
    const expected = { captureSha256: packet.sha256, neutralizedHistoricalHoldNotifications: 0 };
    expect(await restoreConnectedNativeStore(input)).toEqual({ ...expected, replayed: false });
    const imported = await retainedTargetState(target);
    const importedRows = carriedRows(await capture(target, "parity-restored")).map(data => [data.table, [...data.rows].sort()]);
    expect(await restoreConnectedNativeStore(input)).toEqual({ ...expected, replayed: true });
    const replayed = await retainedTargetState(target);
    const replayedRows = carriedRows(await capture(target, "parity-replayed")).map(data => [data.table, [...data.rows].sort()]);
    expect(replayedRows).toEqual(importedRows);
    expect(imported).toEqual(before);
    expect(replayed).toEqual(before);
    expect(JSON.stringify(packet)).toBe(bytes);
    const expectedLedger = packet.compatible.tables.find(data => data.table === ledger)?.rows ?? [];
    expect(importedRows.find(([table]) => table === ledger)?.[1]).toEqual([...expectedLedger].sort());
    const evidence = JSON.stringify({
      shape, profile, sortedRows: evidenceDigest(importedRows), replayedRows: evidenceDigest(replayedRows),
      inputBytes: Buffer.byteLength(bytes), inputDigest: sha256(bytes), captureDigest: packet.sha256,
      checkoutLedger: evidenceDigest(expectedLedger),
      target: [before, imported, replayed].map(state => ({
        migrationLedger: evidenceDigest(state.ledger), keyTuple: evidenceDigest(state.key), roleEdges: evidenceDigest(state.roles),
      })),
      elapsedMs: Math.round(performance.now() - started), peakHeapBytes: peakHeap, publicLockMs: lockMs.map(Math.round),
    });
    const output = process.env.OPENLUP_RESTORE_PARITY_EVIDENCE;
    if (output) appendFileSync(output, evidence + "\n", { mode: 0o600 });
    else console.info("RESTORE_PARITY " + evidence);
  } finally {
    try { await Promise.all(stores.map(store => store.close())); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
}, postgresSetupTimeoutMs);

it.each(["bootstrap", "separate"] as const)("exercises a qualified-v2-only inventory append for %s", async profile => {
  const stores: Store[] = [];
  try {
    const source = await installAccountMutations(profile, false, "same-shape-source");
    stores.push(source);
    const target = await installAccountMutations(profile, false, "same-shape-target");
    stores.push(target);
    if (source.installation.generation !== "qualified-v2" || target.installation.generation !== "qualified-v2") {
      throw new Error("Qualified-v2 restore targets required");
    }
    await source.owner.query("INSERT INTO public.clients(email,lifecycle_stage) VALUES('same-shape@example.invalid','lead')");
    const original = await capture(source, "original");
    // Reverse the existing qualified-v2 catalogue read grant on a disposable
    // source. This changes its observed pin and leaves row descriptors intact.
    await source.migrator.query(`REVOKE EXECUTE ON FUNCTION public.catalog_offer_memberships_page(text,jsonb,integer,text),
      public.catalog_publication_activation_readiness(text[],text) FROM openlup_catalog_publication`);
    const lock = "openlup:public-platform-migrations:v1", db = await source.migrator.connect();
    let pin: string;
    try {
      await db.query("SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended($1,0))", [lock]);
      pin = sha256(await qualifiedPostgresCatalogPayload(db, source.installation, lock));
    } finally {
      try { await db.query("SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1,0))", [lock]); }
      finally { db.release(); }
    }
    const predecessor = await capture(source, "predecessor");
    expect(carriedRows(predecessor)).toEqual(carriedRows(original));
    expect(pin).not.toBe(original.compatible.catalogueId);
    predecessor.compatible.catalogueId = pin;
    const packet = sealConnectedCapture(predecessor);
    const freshTarget = await capture(target, "same-shape-target", true);
    expect(carriedRows(packet).map(row => [row.table, row.columns]))
      .toEqual(carriedRows(freshTarget).map(row => [row.table, row.columns]));
    const input = { owner: target.migrator, installation: target.installation, freshTarget, packet };
    const replay = process.env.OPENLUP_RESTORE_APPEND_MODE === "appended";
    expect(connectedStoreSourceShape(profile, pin, target.inventory)).toBe(replay ? "current" : "unsupported");
    const other = profile === "bootstrap" ? "separate" : "bootstrap";
    expect(connectedStoreSourceShape(other, pin, target.inventory)).toBe("unsupported");
    if (replay) {
      expect((await restoreConnectedNativeStore(input)).replayed).toBe(false);
      expect((await restoreConnectedNativeStore(input)).replayed).toBe(true);
      expect(carriedRows(await capture(target, "same-shape-restored"))).toEqual(carriedRows(packet));
    } else {
      await expect(restoreConnectedNativeStore(input)).rejects.toMatchObject({
        code: "schema_conflict", remedy: "upgrade the source, then capture",
      });
      expect(carriedRows(await capture(target, "same-shape-pristine"))).toEqual(carriedRows(freshTarget));
    }
    const output = process.env.OPENLUP_RESTORE_APPEND_EVIDENCE;
    if (output) appendFileSync(output, JSON.stringify({ profile, pin, replay }) + "\n", { mode: 0o600 });
  } finally { await Promise.all(stores.map(store => store.close())); }
}, postgresSetupTimeoutMs);
