import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { captureCompatiblePostgresRows, PostgresTransferError, type CompatiblePostgresSnapshot } from "@openlup/platform/portability";
import { expect, it } from "vitest";
import {
  captureConnectedNativeStore, connectedStoreClusterIdentitySql, connectedStoreRowSource, type ConnectedNativeStoreCapture,
} from "../../server/adapters/postgres/connectedStoreCapture.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { readPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
import { sealConnectedCapture } from "./connectedStoreHistoricalPacket.fixture.js";
import { acquisitionSearchPathPredecessor, installAccountMutations, installAtAcquisitionSearchPathBoundary, subscriptionProfilesPredecessor } from "./customerAccountMutations.fixture.js";
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

async function seed(store: Store, history: Pick<History, "predatesScheme" | "predatesLedger">) {
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

async function seedQuote(store: Store, subscription: string) {
  await store.owner.query(`INSERT INTO public.${quotes}(subscription_id,idempotency_key,request_fingerprint,quote_hash,
    expected_template_version,proposed_lines,proposed_cadence_days,current_total_minor,new_total_minor,currency_code,expires_at)
    VALUES($1,'fixture-quote',repeat('b',64),repeat('c',64),1,'[]',28,200,200,'XXX','2026-09-02')`, [subscription]);
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
      await seedQuote(source, subscription);
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

async function restoreAcquisitionCapture(target: Store, packet: ConnectedNativeStoreCapture, label: string) {
  if (target.installation.generation === "legacy") throw new Error("Qualified restore target required");
  const input = { owner: target.migrator, installation: target.installation, packet, freshTarget: await capture(target, label, true) };
  expect(await restoreConnectedNativeStore(input)).toMatchObject({ captureSha256: packet.sha256, replayed: false });
  expect(await restoreConnectedNativeStore(input)).toMatchObject({ captureSha256: packet.sha256, replayed: true });
  return carriedRows(await capture(target, label));
}

it.each(profiles)("pins pg_temp last on the acquisition functions through %s capture and restore", async profile => {
  const stores: Store[] = [];
  try {
    const source = await installAtAcquisitionSearchPathBoundary(profile, "capture-before-pin", "before-subscription-profiles");
    stores.push(source);
    expect(source.inventory).toBe(subscriptionProfilesPredecessor[profile]);
    await seedQuote(source, await seed(source, { predatesLedger: false, predatesScheme: false }));
    const predecessor = await capture(source, "before-pin");
    expect(carriedRows(predecessor).find(entry => entry.table === quotes)?.rows).toHaveLength(1);

    async function restore(packet: ConnectedNativeStoreCapture, label: string) {
      const target = await installAccountMutations(profile, false, label);
      stores.push(target);
      return restoreAcquisitionCapture(target, packet, label);
    }

    const retained = await restore(predecessor, "restore-before-pin");
    expect((await source.runner.apply()).applied).toContainEqual(expect.stringMatching(/_acquisition_definer_search_path_pin\.sql$/u));
    const upgraded = await capture(source, "after-pin");
    expect(upgraded.compatible.catalogueId).not.toBe(predecessor.compatible.catalogueId);
    expect(retained).toEqual(carriedRows(upgraded));
    expect(await restore(upgraded, "restore-after-pin")).toEqual(retained);
  } finally {
    await Promise.all(stores.map(store => store.close()));
  }
}, postgresSetupTimeoutMs);

it("pins pg_temp last on the acquisition functions through capture and restore from the preceding installation", async () => {
  const source = await installAtAcquisitionSearchPathBoundary("bootstrap", "capture-pin-predecessor", "before-pin", "current");
  try {
    expect(source.inventory).toBe(acquisitionSearchPathPredecessor.bootstrap);
    await seedQuote(source, await seed(source, { predatesLedger: false, predatesScheme: false }));
    const predecessor = await capture(source, "pin-predecessor");
    expect(carriedRows(predecessor).find(entry => entry.table === quotes)?.rows).toHaveLength(1);

    const target = await installAccountMutations("bootstrap", false, "restore-pin-predecessor");
    try {
      const retained = await restoreAcquisitionCapture(target, predecessor, "restore-pin-predecessor");
      expect((await source.runner.apply()).applied[0]).toMatch(/_acquisition_definer_search_path_pin\.sql$/u);
      const upgraded = await capture(source, "upgraded-pin-predecessor");
      expect(upgraded.compatible.catalogueId).toBe(target.inventory);
      expect(retained).toEqual(carriedRows(upgraded));
    } finally {
      await target.close();
    }
  } finally {
    await source.close();
  }
}, postgresSetupTimeoutMs);
