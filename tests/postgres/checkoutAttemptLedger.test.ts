import { canonicalCatalogDraftJson, catalogPackManifest, installCatalogDefinitions } from "@openlup/platform/catalog";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { runManagedCompatPostgres } from "../helpers/managedCompatPostgres.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";
import { captureStoreJourney, journeySelection, storeJourneyResources, type JourneyInstallation } from "../helpers/storeJourney.js";

const resources = storeJourneyResources();
const table = "public.commerce_checkout_attempt_ledger";
const record = `SELECT public.commerce_record_checkout_attempt($1,$2,$3,$4,$5,$6,$7,$8) AS outcome`;
const digest = (label: string) => createHash("sha256").update(label).digest("hex");
const ledgerWaiters = async (db: PoolClient) => (await db.query(`SELECT count(*)::int AS n FROM pg_locks
  WHERE relation=$1::regclass AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
  AND mode='ShareRowExclusiveLock' AND NOT granted`, [table])).rows[0].n;
const request = digest("requester"), email = digest("email"), exact = digest("attempt");
const windowMs = 600_000, retentionMs = 1_200_000;
const allowed = { allowed: true }, emailQuota = { allowed: false, reason: "email_quota" }, requesterQuota = { allowed: false, reason: "ip_quota" };
const attempt = async (db: Pool | PoolClient, key = exact, requester = request, address = email,
  limits: readonly (number | string)[] = [windowMs, retentionMs, 1, 1, 8]) =>
  (await db.query(record, [key, requester, address, ...limits])).rows[0].outcome;
const ledgerRows = async (db: Pool) => (await db.query(`SELECT * FROM ${table} ORDER BY attempt_digest`)).rows;
let managedContainer: PostgresContainer | undefined;
let managedOwner: Pool | undefined, managedRuntime: Pool | undefined;
let native: JourneyInstallation, managed: JourneyInstallation;

beforeAll(async () => {
  native = await resources.installation("checkout-ledger");
  managedContainer = await runManagedCompatPostgres({ name: `checkout-ledger-managed-${process.pid}`, password: randomUUID() });
  const connectionString = managedContainer.connectionString.replace("postgres://postgres:", "postgres://supabase_admin:");
  managedOwner = new Pool({ connectionString });
  const installer = await managedOwner.connect();
  try {
    await installer.query(readFileSync("scripts/public-reference/subscription-prereqs.sql", "utf8"));
    await installer.query("SET ROLE postgres");
    for (const name of readdirSync("supabase/migrations").filter(name => name.endsWith(".sql")).sort()) {
      await installer.query(readFileSync(`supabase/migrations/${name}`, "utf8").replace(/^\\(?:un)?restrict .*$/gmu, ""));
    }
  } finally {
    await installer.query("RESET ROLE");
    installer.release();
  }
  managedRuntime = new Pool({ connectionString: managedContainer.connectionString, options: "-c role=service_role" });
  expect((await managedRuntime.query("SELECT current_user")).rows).toEqual([{ current_user: "service_role" }]);
  managed = { owner: managedOwner, runtime: managedRuntime, runtimeUrl: managedContainer.connectionString };
}, postgresSetupTimeoutMs);
afterAll(() => resources.close([() => closePostgres(managedContainer, [managedOwner, managedRuntime])]), postgresTeardownTimeoutMs);

describe.each(["native", "managed"] as const)("%s checkout attempt ledger", rail => {
  let store: JourneyInstallation;
  beforeEach(async () => {
    store = rail === "native" ? native : managed;
    await store.owner.query(`TRUNCATE ${table}`);
  });

  it("replays a retained digest ahead of quotas and checks email before requester", async () => {
    expect(await attempt(store.runtime)).toEqual(allowed);
    const before = await ledgerRows(store.owner);
    expect(before).toEqual([{ attempt_digest: exact, requester_digest: request, email_digest: email, recorded_at_ms: expect.stringMatching(/^\d+$/u) }]);
    expect(await attempt(store.runtime, exact, digest("different requester"), digest("different email"))).toEqual(allowed);
    expect(await attempt(store.runtime, digest("both quotas"))).toEqual(emailQuota);
    expect(await attempt(store.runtime, digest("requester quota"), request, digest("different email"))).toEqual(requesterQuota);
    expect(await ledgerRows(store.owner)).toEqual(before);
  });

  it("rejects raw input and non-safe or inconsistent policies without writes", async () => {
    for (const digests of [[null, request, email], [exact, "192.0.2.42", email], [exact, request, "fixture@example.invalid"]]) {
      await expect(store.runtime.query(record, [...digests, windowMs, retentionMs, 1, 1, 8]))
        .rejects.toMatchObject({ code: "22023", message: "checkout_attempt_invalid_digest" });
    }
    for (const limits of [[windowMs, windowMs - 1, 1, 1, 8], [windowMs, retentionMs, 0, 1, 8], [windowMs, retentionMs, 1, 1, "9007199254740992"]]) {
      await expect(attempt(store.runtime, exact, request, email, limits)).rejects.toMatchObject({ code: "22023", message: "checkout_attempt_invalid_policy" });
    }
    expect(await ledgerRows(store.owner)).toEqual([]);
  });

  it("serializes concurrent writers at capacity without evicting a live row", async () => {
    const blocker = await store.owner.connect();
    const keys = Array.from({ length: 4 }, (_, index) => digest(`capacity-${index}`));
    let writers: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(`LOCK TABLE ${table} IN SHARE ROW EXCLUSIVE MODE`);
      writers = Promise.allSettled(keys.map(key => attempt(store.runtime, key, key, key, [windowMs, retentionMs, 4, 4, 1])));
      await expect.poll(() => ledgerWaiters(blocker)).toBe(keys.length);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await writers;
    }
    const outcomes = (await writers!).map(result => result.status === "fulfilled" ? result.value : result.reason);
    expect(outcomes).toEqual(expect.arrayContaining([allowed, { allowed: false }]));
    expect(outcomes.filter(outcome => (outcome as typeof allowed).allowed === false)).toHaveLength(keys.length - 1);
    const rows = await ledgerRows(store.owner);
    expect(rows).toHaveLength(1);
    expect(await attempt(store.runtime, rows[0].attempt_digest, request, email, [windowMs, retentionMs, 1, 1, 1])).toEqual(allowed);
    expect(await ledgerRows(store.owner)).toEqual(rows);
  });

  it("excludes the window cutoff and deletes the retention cutoff", async () => {
    // Run both sides of the probe in PostgreSQL. Retry if the wall clock crosses
    // a millisecond while preparing the fixture so the witness hits exact equality.
    await store.owner.query(`DO $$
      DECLARE anchor bigint; observed bigint; outcome jsonb;
      BEGIN
        FOR retry IN 1..30 LOOP
          DELETE FROM ${table};
          anchor := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
          INSERT INTO ${table} VALUES
            (repeat('a',64), repeat('c',64), repeat('e',64), anchor-${windowMs}),
            (repeat('b',64), repeat('d',64), repeat('f',64), anchor-${retentionMs});
          outcome := public.commerce_record_checkout_attempt(repeat('0',64), repeat('c',64), repeat('e',64),${windowMs},${retentionMs},1,1,8);
          IF outcome <> '{"allowed":true}'::jsonb THEN RAISE EXCEPTION 'window cutoff counted'; END IF;
          SELECT recorded_at_ms INTO STRICT observed FROM ${table} WHERE attempt_digest=repeat('0',64);
          IF observed = anchor THEN RETURN; END IF;
        END LOOP;
        RAISE EXCEPTION 'clock did not produce an exact boundary witness';
      END
    $$`);
    const rows = await ledgerRows(store.owner);
    expect(rows.map(row => row.attempt_digest)).toEqual(["0".repeat(64), "a".repeat(64)]);
    expect(BigInt(rows[0].recorded_at_ms) - BigInt(rows[1].recorded_at_ms)).toBe(BigInt(windowMs));
    expect(await attempt(store.runtime, "a".repeat(64))).toEqual(allowed);
    expect(await attempt(store.runtime, "b".repeat(64))).toEqual(allowed);
    expect(await ledgerRows(store.owner)).toHaveLength(3);
  });

  it("samples time after waiting for the table lock across the retention cutoff", async () => {
    const blocker = await store.owner.connect();
    const runtime = await store.runtime.connect();
    const next = digest("after lock");
    let waiting: Promise<PromiseSettledResult<unknown>[]> | undefined;
    let cutoff: string;
    try {
      // Commit a row that fills the ledger and falls out of retention shortly
      // after the rival starts. Distinct quota digests isolate retained capacity.
      ({ cutoff } = (await blocker.query(`INSERT INTO ${table}
        SELECT $1,$1,$1,floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint - $2::bigint + 2000
        RETURNING recorded_at_ms + $2::bigint AS cutoff`, [exact, retentionMs])).rows[0]);
      await blocker.query("BEGIN");
      await blocker.query(`LOCK TABLE ${table} IN SHARE ROW EXCLUSIVE MODE`);
      waiting = Promise.allSettled([attempt(runtime, next, request, email, [windowMs, retentionMs, 1, 1, 1])]);
      await expect.poll(() => ledgerWaiters(blocker)).toBe(1);
      expect((await blocker.query(`SELECT clock_timestamp() < to_timestamp($1::bigint / 1000.0) AS retained`, [cutoff])).rows[0].retained).toBe(true);
      await blocker.query("SELECT pg_sleep_until(to_timestamp(($1::bigint + 1) / 1000.0))", [cutoff]);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await waiting;
      runtime.release();
    }
    expect(await waiting).toEqual([{ status: "fulfilled", value: allowed }]);
    const rows = await ledgerRows(store.owner);
    expect(rows).toHaveLength(1);
    expect(rows[0].attempt_digest).toBe(next);
    expect(BigInt(rows[0].recorded_at_ms)).toBeGreaterThanOrEqual(BigInt(cutoff));
  });

  it("allows restricted EXECUTE while denying table access and browser execution", async () => {
    expect(await attempt(store.runtime)).toEqual(allowed);
    for (const sql of [`SELECT * FROM ${table}`, `INSERT INTO ${table} VALUES ($1,$1,$1,0)`, `UPDATE ${table} SET recorded_at_ms=0`, `DELETE FROM ${table}`]) {
      await expect(store.runtime.query(sql, sql.includes("$1") ? [exact] : [])).rejects.toMatchObject({ code: "42501" });
    }
    const db = await store.owner.connect();
    try {
      for (const role of rail === "managed" ? ["anon", "authenticated", "openlup_mcp_reader"] : ["anon", "authenticated"]) {
        await db.query(`SET ROLE ${role}`);
        await expect(attempt(db)).rejects.toMatchObject({ code: "42501" });
        await expect(db.query(`SELECT * FROM ${table}`)).rejects.toMatchObject({ code: "42501" });
        await db.query("RESET ROLE");
      }
    } finally {
      await db.query("RESET ROLE");
      db.release();
    }
    expect(await ledgerRows(store.owner)).toHaveLength(1);
  });
});

it("carries nonempty admission state through native transfer and replays it through a fresh pool", async () => {
  await native.owner.query(`TRUNCATE ${table}`);
  const first = new Pool({ connectionString: native.runtimeUrl, max: 1 });
  try { expect(await attempt(first)).toEqual(allowed); }
  finally { await first.end(); }
  const fresh = new Pool({ connectionString: native.runtimeUrl });
  try {
    const rows = await ledgerRows(native.owner);
    expect(await attempt(fresh)).toEqual(allowed);
    expect(await attempt(fresh, digest("fresh pool quota"))).toEqual(emailQuota);
    expect(await ledgerRows(native.owner)).toEqual(rows);

    const source = await captureStoreJourney(native.owner, "checkout-ledger-source");
    expect(source.compatible.tables.find(value => value.table === "commerce_checkout_attempt_ledger")?.rows).toHaveLength(1);
    const targets = await resources.targetTemplate("checkout-ledger-target");
    const target = await targets.nextTarget();
    const freshTarget = await captureStoreJourney(target.owner, "checkout-ledger-target");
    const restore = () => restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet: source, freshTarget });
    expect(await restore()).toMatchObject({ replayed: false });
    expect(await ledgerRows(target.owner)).toEqual(rows);
    expect(await attempt(target.runtime)).toEqual(allowed);
    expect(await attempt(target.runtime, digest("restored quota"))).toEqual(emailQuota);
    expect(await restore()).toMatchObject({ replayed: true });
    expect(await ledgerRows(target.owner)).toEqual(rows);
  } finally { await fresh.end(); }
}, 150_000);


it("requires the checkout attempt ledger in current packets even when empty", async () => {
  await native.owner.query(`TRUNCATE ${table}`);
  const capture = await captureStoreJourney(native.owner, "current-ledger-source");
  const { sha256: _captureDigest, ...body } = capture;
  const { sha256: _compatibleDigest, ...compatible } = body.compatible;
  compatible.tables = compatible.tables.filter(entry => entry.table !== "commerce_checkout_attempt_ledger");
  const missingLedger = { ...body, compatible: { ...compatible, sha256: digest(JSON.stringify(compatible)) } };
  const targets = await resources.targetTemplate("current-ledger-target");
  const target = await targets.nextTarget();
  const freshTarget = await captureStoreJourney(target.owner, "current-ledger-target");
  await expect(restoreConnectedNativeStore({
    owner: target.owner, installation: journeySelection,
    packet: { ...missingLedger, sha256: digest(JSON.stringify(missingLedger)) }, freshTarget,
  })).rejects.toMatchObject({ code: "invalid_input" });
}, 105_000);

it("restores and replays current captures with legacy catalogue receipt bytes intact", async () => {
  const source = await resources.installation("reference-only-source");
  const receipt = await installCatalogDefinitions(source.owner, {
    id: "example:reference-only", namespace: "example", version: 1, openlupRange: "1.x",
    capabilities: {}, types: [], taxClasses: [], subscriptionProfiles: [{ key: "example:repeat", version: 1 }],
  });
  expect(await attempt(source.runtime)).toEqual(allowed);
  const savedLedger = await ledgerRows(source.owner);
  const packet = await captureStoreJourney(source.owner, "reference-only-source");
  expect(packet.outsideProfileCensus).toContainEqual(expect.objectContaining({
    relation: "public.catalog_subscription_profile_receipts", disposition: "unsupported-empty", rows: "0",
  }));
  const capturedReceipts = packet.owned.find(entry => entry.table === "catalog_definition_installs")!.rows;
  expect(capturedReceipts.map(row => JSON.parse(row).receipt)).toEqual([receipt]);
  const targets = await resources.targetTemplate("profiles-target");
  const target = await targets.nextTarget();
  const freshTarget = await captureStoreJourney(target.owner, "profiles-target");
  const restore = () => restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet, freshTarget });
  expect(await restore()).toMatchObject({ replayed: false, captureSha256: packet.sha256 });
  expect(await ledgerRows(target.owner)).toEqual(savedLedger);
  expect(await restore()).toMatchObject({ replayed: true, captureSha256: packet.sha256 });
  const after = await captureStoreJourney(target.owner, "profiles-target-after");
  expect(after.owned.find(entry => entry.table === "catalog_definition_installs")!.rows).toEqual(capturedReceipts);
}, 105_000);

it("AK-2 and AL-1 refuse populated profile receipts after validation and before row inspection or collection", async () => {
  const profileRef = { key: "example:repeat", version: 1 };
  const pack = {
    id: "example:profile-capture", namespace: "example", version: 1, openlupRange: "1.x",
    capabilities: {}, types: [], taxClasses: [], subscriptionProfiles: [profileRef],
  };
  const sql: string[] = [];
  const capture = (limits: { maximumRows?: number; maximumBytes?: number } = {}) => {
    sql.length = 0;
    return captureStoreJourney(native.owner, "profile-receipt-source", { ...limits, observeQuery: query => sql.push(query) });
  };
  await native.owner.query("INSERT INTO public.clients(email) VALUES ('profile-limit-a@example.invalid'), ('profile-limit-b@example.invalid')");
  const limits = [{ maximumRows: 1 }, { maximumBytes: 1 }];
  for (const bound of limits) {
    await expect(capture(bound)).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(sql.some(query => query.includes("SELECT to_jsonb(t)::text AS value"))).toBe(true);
  }
  const referenceOnly = await installCatalogDefinitions(native.owner, pack);
  const before = await capture();
  expect(before.owned.find(entry => entry.table === "catalog_definition_installs")!.rows.map(row => JSON.parse(row).receipt))
    .toContainEqual(referenceOnly);

  const profile = { ...profileRef, allowedCadences: [{ schemaVersion: 1, kind: "fixed_days", days: 28 }],
    policyRef: { key: "example:repeat-policy", version: 1 }, policyDigest: digest("synthetic policy") };
  const canonical = canonicalCatalogDraftJson(profile);
  const { digest: _legacyDigest, ...projection } = catalogPackManifest({ ...pack, version: 2 });
  const manifest = canonicalCatalogDraftJson({ ...projection,
    subscriptionProfileDefinitions: [{ ...profile, profileDigest: digest(canonical) }] });
  await native.owner.query("SELECT public.catalog_definition_install($1,2,$2::jsonb)", [pack.id, {
    manifest, types: [], taxClasses: [], profileDeclarationBytes: [canonical],
  }]);
  const receiptRelation = "public.catalog_subscription_profile_receipts";
  await expect(capture({ maximumRows: 0 })).rejects.toMatchObject({ code: "invalid_input" });
  expect(sql.some(query => query.includes(receiptRelation))).toBe(false);
  for (const bound of limits) {
    await expect(capture(bound)).rejects.toMatchObject({
      code: "subscription_profile_receipts_unsupported",
      table: "catalog_subscription_profile_receipts",
      remedy: "Wait for connected-store restore support for subscription profile receipts (RS-1).",
    });
    expect(sql.map(query => query.split("\n")[0])).toEqual([
      expect.stringContaining("transaction_read_only"),
      "SET LOCAL row_security = off",
      "SET LOCAL TimeZone = 'UTC'",
      `SELECT pg_catalog.to_regclass('${receiptRelation}') IS NOT NULL AS present`,
      `SELECT EXISTS (SELECT 1 FROM ${receiptRelation}) AS present`,
    ]);
  }
}, 105_000);
