import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { withPlatformCatalog } from "../helpers/issuedPlatformCatalog.js";
import { runManagedCompatPostgres } from "../helpers/managedCompatPostgres.js";
import { closePostgres, postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
import { actorId, fixture, graph, hash, insertGraph, installPublicationActors, json, transaction } from "./catalogPublicationFixture.js";
import { installAccountMutations, type AccountMutationsStore } from "./customerAccountMutations.fixture.js";

const catalogPath = "config/platform-migration-manifest.json";
const current = () => JSON.parse(readFileSync(catalogPath, "utf8")) as Parameters<typeof withPlatformCatalog>[0];
const listForward = /_catalog_price_list_basis_select\.sql$/u;
const recorderForward = /_catalog_price_publication_recorder_v2\.sql$/u;
const basisGate = "public.catalog_price_basis_gate(text)";
const validator = "public.catalog_price_setup_v2_command_valid(jsonb)";
const apply = "public.catalog_price_setup_apply(text,text)";
const applyV2 = "public.catalog_price_setup_apply_v2(text,text,uuid)";
const lockedV2 = "public.catalog_publication_lock_effective_base_price_v2(uuid,uuid,uuid)";
const recorder = "public.catalog_publication_record_command(jsonb)";
const mutation = "public.catalog_price_setup_mutate_claimed(jsonb,timestamptz,jsonb)";
const verifyReceipt = "public.catalog_publication_assert_price_receipt_v2(jsonb,jsonb,jsonb,uuid,text[])";
const priceOperations = "public.catalog_publication_price_operations_v2(jsonb,uuid,boolean)";
const priceModes = "public.catalog_publication_price_modes_v2(jsonb,uuid,jsonb)";
const replaced = [recorder, "public.catalog_price_setup_apply_claimed(jsonb,timestamptz)"];
const refusal = '{"reason": "command_invalid", "outcome": "validation_issue"}';
const before = () => {
  const manifest = current();
  for (const plan of [manifest, manifest.qualified, manifest.qualifiedAdmin]) {
    const boundary = plan.forward.findIndex(unit => recorderForward.test(unit.file));
    expect(boundary).toBeGreaterThanOrEqual(0);
    plan.forward = plan.forward.slice(0, boundary);
  }
  // The predecessor is measured by the role fixture. The upgraded installation
  // is verified against the candidate's committed inventory by the real runner.
  return manifest;
};

async function routineAttributes(db: Pool, signatures: string[]) {
  return (await db.query(`SELECT name, p.proowner::regrole::text AS owner, p.prosecdef AS definer,
    p.proconfig AS settings, p.proacl::text AS acl
    FROM unnest($1::text[]) WITH ORDINALITY AS lookup(name,n)
    JOIN pg_catalog.pg_proc p ON p.oid=to_regprocedure(name) ORDER BY n`, [signatures])).rows;
}

async function dormant(store: AccountMutationsStore) {
  const command = json({ schemaVersion: 2, commandKey: "dormant-basis-command", variantId: "10000000-0000-4000-8000-000000000001",
    priceListId: "10000000-0000-4000-8000-000000000002", amountKind: "net", expectedListAmountBasis: "tax_exclusive",
    unitPriceMinor: 100, mode: "one_time", minQty: 1, expected: { entryId: null, unitPriceMinor: null, amountKind: null } });
  return transaction(store.runtime, async db => {
    await db.query("SET LOCAL ROLE authenticated");
    await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actorId, role: "authenticated" })]);
    return (await db.query("SELECT public.catalog_price_setup_apply($1,$2)::text AS bytes", [command, hash(command)])).rows[0].bytes;
  });
}

async function assertDormant(store: AccountMutationsStore) {
  const { owner, installation } = store;
  expect(await dormant(store)).toBe(refusal);
  expect((await owner.query("SELECT count(*)::int AS receipts FROM public.catalog_price_setup_receipts")).rows).toEqual([{ receipts: 0 }]);
  const facts = (await owner.query(`SELECT
    has_column_privilege('openlup_catalog_publication','public.price_lists','amount_basis','SELECT') AS basis,
    has_column_privilege('openlup_catalog_publication','public.price_lists','amount_basis','UPDATE') AS write_basis,
    has_column_privilege('openlup_catalog_publication','public.price_lists','amount_basis','SELECT WITH GRANT OPTION') AS delegation,
    has_column_privilege('openlup_catalog_publication','public.price_lists','name','SELECT') AS other_column,
    has_table_privilege('openlup_catalog_publication','public.price_lists','SELECT') AS whole_table,
    has_function_privilege('openlup_catalog_publication',to_regprocedure($1),'EXECUTE') AS first_execute,
    has_function_privilege('openlup_catalog_publication',to_regprocedure($2),'EXECUTE') AS second_execute`, [applyV2, lockedV2])).rows[0];
  expect(facts).toEqual({ basis: installation.generation === "qualified-v2", write_basis: false, delegation: false,
    other_column: false, whole_table: false, first_execute: false, second_execute: false });
  const [entry, gate, valid, record, reader, mutate, verify, operations, modes] = await routineAttributes(owner,
    [apply, basisGate, validator, recorder, lockedV2, mutation, verifyReceipt, priceOperations, priceModes]);
  expect(record).toMatchObject({ owner: entry.owner, definer: installation.generation === "qualified-v2",
    settings: ["search_path=pg_catalog, public, pg_temp"] });
  expect(reader).toMatchObject({ owner: entry.owner, definer: true, settings: ["search_path=pg_catalog, pg_temp"] });
  expect(mutate).toMatchObject({ owner: entry.owner, definer: false, settings: ["search_path=pg_catalog, pg_temp"] });
  for (const helper of [gate, valid, verify, operations, modes]) expect(helper).toMatchObject({
    owner: entry.owner, definer: false, settings: ["search_path=pg_catalog, pg_temp"],
  });
  const { rows: [{ present: hasServiceRole }] } = await owner.query(
    "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') AS present");
  if (installation.generation !== "legacy") expect(hasServiceRole).toBe(true);
  expect((await owner.query(`SELECT p.oid::regprocedure::text AS routine, r.rolname, a.privilege_type, a.is_grantable
    FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a LEFT JOIN pg_roles r ON r.oid=a.grantee
    WHERE p.oid=ANY(ARRAY[to_regprocedure($1)::oid,to_regprocedure($2)::oid]) AND a.grantee<>p.proowner
    ORDER BY routine, r.rolname`, [basisGate, validator])).rows).toEqual(hasServiceRole ? [
    { routine: basisGate.slice(7), rolname: "service_role", privilege_type: "EXECUTE", is_grantable: false },
    { routine: validator.slice(7), rolname: "service_role", privilege_type: "EXECUTE", is_grantable: false },
  ] : []);
}

it.each(["legacy", "admin-managed", "bootstrap"] as const)("preserves the released path across the installed %s upgrade", async profile => {
  await withPlatformCatalog(before(), async root => {
    const store = await installAccountMutations(profile, true, "price-basis-upgrade", root);
    try {
      if (profile === "admin-managed") await store.owner.query("CREATE ROLE openlup_catalog_publication LOGIN NOINHERIT");
      await installPublicationActors(store.owner);
      const released = await dormant(store);
      expect(released).toBe(refusal);
      const original = await routineAttributes(store.owner, replaced);
      const expected = current().forward.map(unit => unit.file).filter(path => recorderForward.test(path));
      expect(expected).toHaveLength(1);
      expect((await store.runner.apply()).applied.slice(0, expected.length)).toEqual(expected);
      expect(await routineAttributes(store.owner, replaced)).toEqual(original);
      expect(await dormant(store)).toBe(released);
      if (profile === "legacy") {
        // The legacy inventory includes cluster roles. Verify the exact grant
        // again with the sibling role after the runner has checked the inventory.
        await store.owner.query("CREATE ROLE openlup_catalog_publication LOGIN NOINHERIT");
        const columnGrant = current().forward.find(unit => listForward.test(unit.file))!;
        await store.owner.query(readFileSync(columnGrant.file, "utf8"));
      }
      await assertDormant(store);
    } finally { await store.close(); }
  });
}, postgresSetupTimeoutMs);

it("replays populated v1 receipts byte for byte through runtime logins after the runner applies the recorder forward", async () => {
  const predecessor = before();
  // The installed qualified predecessor ends at the renewal generation seam.
  predecessor.qualified.objectInventorySha256.bootstrapMigrator.withRestore =
    "705a544980f4094cec2a093b1287c76acb71ad79386596387adc7833d3acf794";
  const forward = current().qualified.forward.find(unit => recorderForward.test(unit.file))!;
  await withPlatformCatalog(predecessor, async root => {
    const store = await installAccountMutations("bootstrap", false, "populated-price-recorder-upgrade", root);
    const { owner, runtime, installation } = store;
    const password = randomUUID();
    const publicationUrl = new URL(owner.options.connectionString!);
    publicationUrl.username = "openlup_catalog_publication";
    publicationUrl.password = password;
    const publisher = new Pool({ connectionString: publicationUrl.href });
    try {
      if (installation.generation !== "qualified-v2") throw new Error("Expected the qualified runtime login");
      expect((await runtime.query("SELECT session_user AS login")).rows).toEqual([{ login: installation.runtimeLogin }]);
      const tail = predecessor.qualified.forward.at(-1)!;
      expect((await owner.query("SELECT catalog_path,sha256 FROM public.platform_schema_migrations ORDER BY position DESC LIMIT 1")).rows)
        .toEqual([{ catalog_path: tail.file, sha256: tail.sha256 }]);
      await owner.query(`ALTER ROLE openlup_catalog_publication PASSWORD '${password}'`);
      expect((await publisher.query("SELECT session_user AS login")).rows).toEqual([{ login: "openlup_catalog_publication" }]);
      await installPublicationActors(owner);
      const issue = await transaction(owner, async db => {
        const issued = await graph(db, fixture());
        await insertGraph(db, issued);
        return issued;
      });
      const keys = [issue.productId, issue.commandKey];
      const { rows: [savedPublication] } = await owner.query(`SELECT result FROM public.catalog_operator_receipts
        WHERE scope_id=$1 AND command_key=$2 AND kind='publish'`, keys);
      const originalPublication = Buffer.from(savedPublication.result, "utf8");
      const readPublication = async () => {
        const { rows: [result] } = await publisher.query("SELECT public.catalog_publication_assert_receipt($1,$2) AS bytes", keys);
        return Buffer.from(result.bytes, "utf8");
      };
      expect(await readPublication()).toEqual(originalPublication);
      await owner.query(`INSERT INTO public.commerce_settings(key,value_text) VALUES('settlement_region','ZZ'),('settlement_currency','XXX')
        ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text`);
      await owner.query("SELECT public.commerce_capture_offer_policy_v2_legacy_baseline()");
      const priceListId = randomUUID(), commandKey = randomUUID();
      await owner.query(`INSERT INTO public.price_lists(id,name,region_code,currency,valid_from)
        VALUES($1,'Gross upgrade list','ZZ','XXX',clock_timestamp()-interval '1 hour')`, [priceListId]);
      const price = json({ schemaVersion: 1, commandKey, variantId: issue.skuId, priceListId,
        mode: "one_time", minQty: 1, amountKind: "gross", unitPriceMinor: 1200, expected: { entryId: null, unitPriceMinor: null } });
      const rawPrice = () => transaction(runtime, async db => {
        await db.query("SET LOCAL ROLE authenticated");
        await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actorId, role: "authenticated" })]);
        const { rows: [result] } = await db.query("SELECT public.catalog_price_setup_apply($1,$2)::text AS bytes", [price, hash(price)]);
        return Buffer.from(result.bytes, "utf8");
      });
      const committedPrice = await rawPrice();
      expect(JSON.parse(committedPrice.toString("utf8"))).toHaveProperty("outcome", "committed");
      expect((await owner.query(`SELECT status,response_payload::text AS bytes FROM public.catalog_price_setup_receipts
        WHERE scope='catalog.price_setup.base' AND idempotency_key=$1`, [commandKey])).rows)
        .toEqual([{ status: "completed", bytes: committedPrice.toString("utf8") }]);
      const originalPriceReplay = await rawPrice();
      expect(JSON.parse(originalPriceReplay.toString("utf8"))).toHaveProperty("outcome", "replayed");

      expect((await store.runner.apply()).applied[0]).toBe(forward.file);
      await owner.query("UPDATE public.catalog_skus SET title='Live drift' WHERE id=$1", [issue.skuId]);
      await owner.query("UPDATE public.price_lists SET amount_basis='tax_exclusive' WHERE id=$1", [priceListId]);
      expect(await rawPrice()).toEqual(originalPriceReplay);
      expect(await readPublication()).toEqual(originalPublication);
      expect((await owner.query("SELECT count(*)::int AS prices FROM public.price_entries WHERE variant_id=$1", [issue.skuId])).rows)
        .toEqual([{ prices: 1 }]);
    } finally {
      await publisher.end();
      await store.close();
    }
  });
}, postgresSetupTimeoutMs);

it("keeps fresh qualified-v2 dormant until both controlled EXECUTEs are effective", async () => {
  const store = await installAccountMutations("bootstrap", false, "price-basis-fresh");
  try {
    await installPublicationActors(store.owner);
    await assertDormant(store);
    const testPrivileges = readFileSync("tests/postgres/fixtures/catalogPricePublicationV2/grants.sql", "utf8");
    await store.owner.query(`GRANT EXECUTE ON FUNCTION ${applyV2} TO openlup_catalog_publication`);
    expect(await dormant(store)).toBe(refusal);
    await store.owner.query(testPrivileges);
    expect((await store.runtime.query("SELECT public.catalog_price_basis_gate('command_invalid') AS gate")).rows).toEqual([{ gate: null }]);
    await store.owner.query(`REVOKE EXECUTE ON FUNCTION ${applyV2} FROM openlup_catalog_publication`);
    expect(await dormant(store)).toBe(refusal);
  } finally { await store.close(); }
}, postgresSetupTimeoutMs);

it("revokes browser default EXECUTE on the installed private price routines", async () => {
  const store = await installAccountMutations("bootstrap", false, "price-recorder-acl");
  const signatures = [mutation, lockedV2, verifyReceipt, priceOperations, priceModes];
  try {
    const forward = current().forward.find(unit => recorderForward.test(unit.file))!;
    const db = await store.owner.connect();
    try {
      await db.query("BEGIN");
      await db.query(`DROP FUNCTION ${signatures.join(", ")};
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
      await db.query(readFileSync(forward.file, "utf8"));
      expect((await db.query(`SELECT role, signature FROM unnest($1::text[]) r(role)
        CROSS JOIN unnest($2::text[]) f(signature)
        WHERE has_function_privilege(role,signature::regprocedure,'EXECUTE')`,
      [["anon", "authenticated", "service_role", "openlup_catalog_publication"], signatures])).rows).toEqual([]);
    } finally { await db.query("ROLLBACK"); db.release(); }
  } finally { await store.close(); }
}, postgresSetupTimeoutMs);

it("finds no native v2 writer or gate on the managed rail", async () => {
  const managed = await runManagedCompatPostgres({ name: `price-basis-managed-${process.pid}`, password: "synthetic-managed-basis" });
  const owner = new Pool({ connectionString: managed.connectionString.replace("postgres://postgres:", "postgres://supabase_admin:") });
  try {
    const db = await owner.connect();
    try {
      await db.query(readFileSync("scripts/public-reference/subscription-prereqs.sql", "utf8"));
      await db.query("SET ROLE postgres");
      for (const file of readdirSync("supabase/migrations").filter(name => name.endsWith(".sql")).sort()) {
        await db.query(readFileSync(`supabase/migrations/${file}`, "utf8").replace(/^\\(?:un)?restrict .*$/gmu,""));
      }
      expect(await routineAttributes(owner,
        [apply, applyV2, lockedV2, mutation, verifyReceipt, priceOperations, priceModes, recorder, basisGate, validator])).toEqual([]);
      expect((await db.query("SELECT to_regclass('public.catalog_price_setup_receipts') AS receipts")).rows).toEqual([{ receipts: null }]);
    } finally { db.release(); }
  } finally { await closePostgres(managed, owner); }
}, postgresSetupTimeoutMs);
