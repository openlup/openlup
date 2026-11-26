import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
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
const decision = "public.catalog_publication_decide_prices_v2(jsonb,jsonb,jsonb,jsonb,jsonb,timestamptz)";
const assessment = "public.catalog_publication_assess_prices_v2(jsonb)";
const privateRoutines = [mutation, lockedV2, decision, assessment,
  "public.catalog_publication_price_operations_v2(jsonb)",
  "public.catalog_publication_price_revision_facts_v2(uuid,jsonb)",
  "public.catalog_publication_price_tax_class_v2(jsonb,jsonb,boolean)",
  "public.catalog_publication_lock_price_plan_v2(jsonb,jsonb,jsonb)",
  "public.catalog_publication_price_receipt_facts_v2(public.catalog_price_setup_receipts,jsonb,jsonb,uuid)",
  "public.catalog_publication_write_price_v2(jsonb,jsonb,uuid,uuid,timestamptz)"];
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
    p.proconfig AS settings, p.proacl::text AS acl, p.provolatile AS volatility
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
  const [entry, gate, valid, record, ...routines] = await routineAttributes(owner, [apply, basisGate, validator, recorder, ...privateRoutines]);
  expect(record).toMatchObject({ owner: entry.owner, definer: installation.generation === "qualified-v2",
    settings: ["search_path=pg_catalog, public, pg_temp"] });
  expect(routines).toHaveLength(privateRoutines.length);
  for (const helper of [gate, valid, ...routines]) expect(helper).toMatchObject({
    owner: entry.owner, definer: helper.name === lockedV2, settings: ["search_path=pg_catalog, pg_temp"],
  });
  expect(routines.find(routine => routine.name === decision)).toMatchObject({ volatility: "v" });
  expect((await owner.query(`SELECT a.grantee FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid IN (SELECT to_regprocedure(name) FROM unnest($1::text[]) name) AND a.grantee<>p.proowner`, [privateRoutines])).rows).toEqual([]);
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
  const forward = current().qualified.forward.find(unit => recorderForward.test(unit.file))!;
  await withPlatformCatalog(predecessor, async root => {
    const store = await installAccountMutations("bootstrap", true, "populated-price-recorder-upgrade", root);
    const { owner, runtime, installation } = store;
    const password = randomUUID();
    const publicationUrl = new URL(owner.options.connectionString!);
    publicationUrl.username = "openlup_catalog_publication";
    publicationUrl.password = password;
    const publisher = new Pool({ connectionString: publicationUrl.href });
    try {
      if (installation.generation !== "qualified-v2") throw new Error("Expected the qualified runtime login");
      // Bind the temporary catalogue to the measured prefix and verify it before seeding receipts.
      predecessor.qualified.objectInventorySha256.bootstrapMigrator.withRestore = store.inventory;
      writeFileSync(join(root, catalogPath), JSON.stringify(predecessor));
      const prefixRunner = createPostgresMigrationRunner({ connectionString: store.migrator.options.connectionString! }, {
        installation, root, poolFactory: () => store.migrator,
      });
      expect(await prefixRunner.apply()).toEqual({ applied: [] });
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
      for (const [routine, query] of [
        ["catalog_publication_decide_prices_v2", "SELECT public.catalog_publication_decide_prices_v2(NULL,NULL,NULL,NULL,NULL,NULL)"],
        ["catalog_publication_assess_prices_v2", "SELECT public.catalog_publication_assess_prices_v2(NULL)"],
        ["catalog_publication_lock_effective_base_price_v2", "SELECT * FROM public.catalog_publication_lock_effective_base_price_v2(NULL,NULL,NULL)"],
      ]) await expect(publisher.query(query!)).rejects.toMatchObject({ code: "42501", message: `permission denied for function ${routine}` });
      expect((await owner.query("SELECT count(*)::int AS prices FROM public.price_entries WHERE variant_id=$1", [issue.skuId])).rows)
        .toEqual([{ prices: 1 }]);
    } finally {
      await publisher.end();
      await store.close();
    }
  });
}, postgresSetupTimeoutMs);

it("denies direct calls to the dormant locked price reader on a fresh qualified-v2 install", async () => {
  const store = await installAccountMutations("bootstrap", false, "price-basis-fresh");
  try {
    await installPublicationActors(store.owner);
    await assertDormant(store);
    await store.owner.query(`GRANT EXECUTE ON FUNCTION ${applyV2} TO openlup_catalog_publication`);
    expect(await dormant(store)).toBe(refusal);
    for (const [pool, role] of [[store.runtime, "SET LOCAL ROLE authenticated"],
      [store.owner, "SET LOCAL SESSION AUTHORIZATION openlup_catalog_publication"],
      [store.owner, "SET LOCAL ROLE service_role"]] as const) {
      await expect(transaction(pool, async db => {
        await db.query(role);
        await db.query("SELECT * FROM public.catalog_publication_lock_effective_base_price_v2(NULL,NULL,NULL)");
      })).rejects.toMatchObject({ code: "42501", message: "permission denied for function catalog_publication_lock_effective_base_price_v2" });
    }
  } finally { await store.close(); }
}, postgresSetupTimeoutMs);

it("uses one installed builder and refusal selector across the publication price call graph", async () => {
  const store = await installAccountMutations("bootstrap", false, "price-decision-structure");
  try {
    const { rows } = await store.owner.query<{ name: string; definition: string }>(`SELECT p.proname AS name, pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind IN ('f','p')`);
    const definitions = new Map(rows.map(({ name, definition }) => [name, definition]));
    const owner = "catalog_publication_decide_prices_v2";
    const landed = "catalog_publication_target_price_verdict";
    const evidence = "catalog_publication_price_receipt_facts_v2";
    const adapters = ["catalog_publication_record_command", "catalog_publication_lock_effective_base_price_v2", "catalog_publication_assess_prices_v2"];
    const knownBoundaries = new Set(["catalog_publication_assert_head", "catalog_publication_assert_receipt", "catalog_publication_assert_issued",
      "catalog_publication_assert_candidate", "catalog_publication_head_ref", "catalog_publication_candidate_source", "catalog_publication_manifest_text",
      "catalog_publication_read_sku_revision", "catalog_publication_sku_projection", "catalog_publication_canonical", "catalog_publication_lock_projection",
      "catalog_lifecycle_assert_archive", "catalog_price_setup_lock_context", "catalog_price_setup_require_human_admin", "catalog_price_setup_claim",
      "catalog_price_setup_v2_command_valid", "catalog_price_basis_gate", "commerce_offer_policy_v2_readiness"]);
    const review = (source: Map<string, string>) => {
      const visited = new Set<string>();
      const walk = (name: string) => {
        if (visited.has(name) || knownBoundaries.has(name) || name === landed) return;
        visited.add(name);
        const body = source.get(name)!.split(/\$function\$/u)[1]!.replace(/--[^\n]*/gu, "");
        if (name === owner) {
          expect(body.match(/WITH next_skus AS/gu)).toHaveLength(1);
          expect(body.match(/catalog_publication_target_price_verdict\(/gu)).toHaveLength(1);
          expect(body.match(/ERRCODE=state/gu)).toHaveLength(1);
        } else {
          expect(body).not.toMatch(/needsFresh|requiredModes|requestedModes|offerMemberships|['"]memberships['"]|sellable(?:Standalone|InSubscription)|catalog_publication_target_price_verdict|catalog_publication_price_(?:edit_required|context_mismatch|changed)|\b(?:reason|refusal)\s*(?::=|=)|jsonb_set\(/iu);
          for (const statement of body.split(/;|\bLOOP\b/iu)) {
            expect(statement).not.toMatch(/jsonb_array_elements\(plan\).*\b(?:WHERE|FILTER)\b.*\b(?:t|target)\s*(?:->|#>)/isu);
          }
          if (name !== evidence) expect(body).not.toMatch(/response_payload\s*->/iu);
        }
        for (const match of body.matchAll(/public\.(\w+)\s*\(/gu)) {
          if (source.has(match[1]!)) walk(match[1]!);
        }
      };
      for (const entry of adapters) {
        visited.clear();
        walk(entry);
        expect(visited.has(owner)).toBe(true);
        expect(visited.has(evidence)).toBe(true);
      }
    };
    review(definitions);
    for (const mutation of ["PERFORM authored->'offerMemberships';", "SELECT t FROM jsonb_array_elements(plan) t WHERE t->>'skuId' IS NOT NULL;",
      "reason := 'catalog_publication_price_changed';"]) {
      const mutated = new Map(definitions);
      const entry = adapters[1]!;
      mutated.set(entry, definitions.get(entry)!.replace("BEGIN", `BEGIN ${mutation}`));
      expect(() => review(mutated)).toThrow();
    }
  } finally { await store.close(); }
}, postgresSetupTimeoutMs);

it("revokes browser default EXECUTE on the installed private price routines", async () => {
  const store = await installAccountMutations("bootstrap", false, "price-recorder-acl", undefined, undefined, { isolatedCluster: true });
  const signatures = privateRoutines;
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
        [apply, applyV2, ...privateRoutines, recorder, basisGate, validator])).toEqual([]);
      expect((await db.query("SELECT to_regclass('public.catalog_price_setup_receipts') AS receipts")).rows).toEqual([{ receipts: null }]);
    } finally { db.release(); }
  } finally { await closePostgres(managed, owner); }
}, postgresSetupTimeoutMs);
