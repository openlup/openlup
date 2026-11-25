import { readFileSync, readdirSync } from "node:fs";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { withPlatformCatalog } from "../helpers/issuedPlatformCatalog.js";
import { runManagedCompatPostgres } from "../helpers/managedCompatPostgres.js";
import { closePostgres, postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
import { actorId, hash, installPublicationActors, json, transaction } from "./catalogPublicationFixture.js";
import { installAccountMutations, type AccountMutationsStore } from "./customerAccountMutations.fixture.js";

const catalogPath = "config/platform-migration-manifest.json";
const current = () => JSON.parse(readFileSync(catalogPath, "utf8")) as Parameters<typeof withPlatformCatalog>[0];
const listForward = /_catalog_price_list_basis_select\.sql$/u;
const writerForward = /_catalog_price_writer_v2\.sql$/u;
const isOwnForward = (path: string) => listForward.test(path) || writerForward.test(path);
const basisGate = "public.catalog_price_basis_gate(text)";
const validator = "public.catalog_price_setup_v2_command_valid(jsonb)";
const apply = "public.catalog_price_setup_apply(text,text)";
const applyV2 = "public.catalog_price_setup_apply_v2(text,text,uuid)";
const lockedV2 = "public.catalog_publication_lock_effective_base_price_v2(uuid,uuid,uuid)";
const replaced = [apply, "public.catalog_price_setup_claim(text,text)", "public.catalog_price_setup_apply_claimed(jsonb,timestamptz)"];
const refusal = '{"reason": "command_invalid", "outcome": "validation_issue"}';
const before = () => {
  const manifest = current();
  for (const plan of [manifest, manifest.qualified, manifest.qualifiedAdmin]) {
    const boundary = plan.forward.findIndex(unit => listForward.test(unit.file));
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
    to_regprocedure($2)::text AS second_function`, [applyV2, lockedV2])).rows[0];
  expect(facts).toEqual({ basis: installation.generation === "qualified-v2", write_basis: false, delegation: false,
    other_column: false, whole_table: false, first_execute: false, second_function: null });
  const [entry, gate, valid] = await routineAttributes(owner, [apply, basisGate, validator]);
  for (const helper of [gate, valid]) expect(helper).toMatchObject({
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
      const expected = current().forward.map(unit => unit.file).filter(isOwnForward);
      expect(expected).toHaveLength(2);
      expect((await store.runner.apply()).applied.slice(0, expected.length)).toEqual(expected);
      expect(await routineAttributes(store.owner, replaced)).toEqual(original);
      expect(await dormant(store)).toBe(released);
      if (profile === "legacy") {
        // The legacy inventory includes cluster roles. Verify the exact grant
        // again with the sibling role after the runner has checked the inventory.
        await store.owner.query("CREATE ROLE openlup_catalog_publication LOGIN NOINHERIT");
        await store.owner.query(readFileSync(expected[0]!, "utf8"));
      }
      await assertDormant(store);
    } finally { await store.close(); }
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
      expect(await routineAttributes(owner, [apply, applyV2, lockedV2, basisGate, validator])).toEqual([]);
      expect((await db.query("SELECT to_regclass('public.catalog_price_setup_receipts') AS receipts")).rows).toEqual([{ receipts: null }]);
    } finally { db.release(); }
  } finally { await closePostgres(managed, owner); }
}, postgresSetupTimeoutMs);
