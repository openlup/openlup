import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { withPlatformCatalog } from "../helpers/issuedPlatformCatalog.js";
import { runManagedCompatPostgres } from "../helpers/managedCompatPostgres.js";
import { closePostgres, postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
import { actorId, documentRow, fixture, graph, hash, installPublicationActors, json, sealedState, transaction } from "./catalogPublicationFixture.js";
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
  "public.catalog_publication_price_receipt_facts_v2(public.catalog_price_setup_receipts,jsonb,jsonb,uuid,timestamptz)"];
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
      const claims = JSON.stringify({ sub: actorId, role: "authenticated" });
      const recordSql = "SELECT public.catalog_publication_record_command($1) AS bytes";
      const { issue, publish, originalPublication } = await transaction(owner, async db => {
        const draft = await graph(db, fixture());
        const command = { schemaVersion: 2, action: "publish", productId: draft.productId, commandKey: draft.commandKey,
          candidateRef: draft.candidateRef, candidateDigest: draft.candidateDigest, expectedHead: null, changes: [] };
        const fingerprint = hash(json([command, actorId]));
        await documentRow(db, { ...draft, fingerprint });
        await db.query("UPDATE public.catalog_products SET publication_facts=$2,variant_axes=$3,attribute_values=$4 WHERE id=$1",
          [draft.productId, draft.product, draft.product.axes, draft.product.attributes]);
        await db.query(`UPDATE public.catalog_skus SET publication_facts=$2,option_values=$2::jsonb->'options',
          sellable_standalone=false,sellable_in_subscription=false,attribute_values=$2::jsonb->'attributes',net_content_dimension='mass',net_content_unit='openlup:g',
          net_content_unscaled=100,net_content_scale=0 WHERE id=$1`, [draft.skuId, draft.facts]);
        const seal = sealedState(draft.product, [{ skuId: draft.skuId, digest: hash(json(draft.facts)) }]);
        await db.query("SELECT set_config('request.jwt.claims',$1,true)", [claims]);
        await db.query("SET LOCAL SESSION AUTHORIZATION openlup_catalog_publication");
        await db.query(recordSql, [{ ...draft.decision, postStateText: seal, postStateDigest: hash(seal) }]);
        await db.query("RESET SESSION AUTHORIZATION");
        const { rows: [{ id: approvalId }] } = await db.query("SELECT id FROM public.catalog_publication_decisions WHERE product_id=$1",
          [draft.productId]);
        const packet = { ...command, fingerprint, approvalId, product: draft.product, skus: [draft.facts] };
        await db.query("SET LOCAL SESSION AUTHORIZATION openlup_catalog_publication");
        const { rows: [{ bytes }] } = await db.query(recordSql, [packet]);
        return { issue: draft, publish: packet, originalPublication: Buffer.from(bytes, "utf8") };
      });
      const keys = [issue.productId, issue.commandKey];
      const savedPublication = async () => (await owner.query(`SELECT result FROM public.catalog_operator_receipts
        WHERE scope_id=$1 AND command_key=$2 AND kind='publish'`, keys)).rows.map(row => Buffer.from(row.result, "utf8"));
      expect(await savedPublication()).toEqual([originalPublication]);
      const replayPublication = () => transaction(publisher, async db => {
        await db.query("SELECT set_config('request.jwt.claims',$1,true)", [claims]);
        const { rows: [{ bytes }] } = await db.query(recordSql, [publish]);
        return Buffer.from(bytes, "utf8");
      });
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
      expect(await replayPublication()).toEqual(originalPublication);
      expect(await savedPublication()).toEqual([originalPublication]);
      expect((await owner.query("SELECT count(*)::int AS effects FROM public.outbox_events WHERE aggregate_id=$1", [issue.productId])).rows)
        .toEqual([{ effects: 1 }]);
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

const installedPriceEntries = [
  "public.catalog_publication_assess_prices_v2(jsonb)",
  "public.catalog_publication_record_command(jsonb)",
  "public.catalog_publication_lock_effective_base_price_v2(uuid,uuid,uuid)",
  "public.catalog_price_setup_apply_claimed(jsonb,timestamp with time zone)",
] as const;
const decisionIdentity = "public.catalog_publication_decide_prices_v2(jsonb,jsonb,jsonb,jsonb,jsonb,timestamp with time zone)";
const landedIdentity = "public.catalog_publication_target_price_verdict(jsonb,timestamp with time zone)";

type InstalledRoutine = {
  schema: string; name: string; identity: string; definition: string; language: string; searchPath: string[] | null;
};
async function installedRoutines(db: Pick<Pool, "query">) {
  return (await db.query<InstalledRoutine>(`SELECT n.nspname AS schema,p.proname AS name,
    n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')' AS identity,pg_get_functiondef(p.oid) AS definition,
    l.lanname AS language, string_to_array((SELECT substr(c,13) FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'),', ') AS "searchPath"
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
    WHERE p.prokind IN ('f','p') AND (p.oid>=16384 OR n.nspname NOT IN ('pg_catalog','information_schema'))
    ORDER BY identity`)).rows.map(row => ({ ...row, identity: row.identity.replaceAll(", ", ",") }));
}

function installedBody(routine: InstalledRoutine) {
  if (routine.language === "c" || routine.language === "internal") return routine.definition;
  expect(["sql", "plpgsql"], routine.identity).toContain(routine.language);
  const body = /\nAS (\$[a-z_0-9]*\$)([\s\S]*)\1\s*$/iu.exec(routine.definition)?.[2];
  if (body === undefined) throw new Error(`Cannot parse installed body for ${routine.identity}`);
  return body;
}

function installedCalls(routine: InstalledRoutine, body: string, definitions: InstalledRoutine[]) {
  if (routine.language === "c" || routine.language === "internal") return [];
  // Tokenize executable text. Strings and comments cannot masquerade as calls.
  const lexeme = /--[^\n]*|\/\*|\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|[a-z_][a-z_0-9$]*|[^\s]/giu;
  let comment = 0;
  const tokens: string[] = [];
  for (const { 0: token } of body.matchAll(lexeme)) {
    if (token === "/*") comment++;
    else if (token === "*/") comment--;
    else if (comment === 0 && !token.startsWith("--")) {
      tokens.push(token.startsWith('"') ? token.slice(1, -1).replaceAll('""', '"') : token.toLowerCase());
    }
  }
  expect(comment, routine.identity).toBe(0);
  expect(tokens, `${routine.identity} must use statically resolved calls`).not.toContain("execute");
  const path = routine.searchPath ?? ["public"];
  const calls = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i + 1] !== "(") continue;
    const qualified = tokens[i - 1] === ".";
    for (const target of definitions) {
      if (target.name === tokens[i] && (qualified ? target.schema === tokens[i - 2] : path.includes(target.schema))) {
        // Keep every installed overload as a candidate. A change in overloads
        // must also change the witness instead of hiding a different callee.
        calls.add(target.identity);
      }
    }
  }
  return [...calls].sort();
}

function assertInstalledPriceGraph(definitions: InstalledRoutine[]) {
  const byIdentity = new Map(definitions.map(routine => [routine.identity, routine]));
  const graph = new Map<string, { calls: string[]; definition: string }>();
  const walk = (identity: string, visited: Set<string>) => {
    if (visited.has(identity)) return;
    visited.add(identity);
    const routine = byIdentity.get(identity);
    if (!routine) throw new Error(`Missing installed price routine ${identity}`);
    const body = installedBody(routine);
    const node = graph.get(identity) ?? { calls: installedCalls(routine, body, definitions), definition: hash(body) };
    graph.set(identity, node);
    for (const call of node.calls) walk(call, visited);
  };
  for (const entry of installedPriceEntries) {
    const visited = new Set<string>();
    walk(entry, visited);
    expect(visited.has(decisionIdentity), entry).toBe(true);
  }
  expect([...graph].filter(([, node]) => node.calls.includes(landedIdentity)).map(([identity]) => identity)).toEqual([decisionIdentity]);
  // Seal the reviewed code and its edges, including the decision owner and all
  // application helpers. An extra expression can change decisions without
  // changing any edge or reusing a known variable name.
  const reviewedGraph = [...graph].sort(([left], [right]) => left.localeCompare(right));
  expect(hash(JSON.stringify(reviewedGraph)), JSON.stringify(reviewedGraph)).toBe("d04b45c000fc628c26537df00dd6cc3ac294058ab7a1f48a10aba6606077a614");
}

it("uses one installed builder and refusal selector across the publication price call graph", async () => {
  const store = await installAccountMutations("bootstrap", true, "price-decision-structure");
  try {
    const definitions = await installedRoutines(store.owner);
    assertInstalledPriceGraph(definitions);
    await transaction(store.owner, async db => {
      for (const [identity, addedDecision] of [
        [installedPriceEntries[0], "PERFORM (sku->>'id')::uuid FROM jsonb_array_elements(post_state->'skus') sku WHERE sku->'memberships' @> '[{\"admitted\":true}]';"],
        [installedPriceEntries[1], "IF child_results #>> '{probe,outcome}' = 'claimed' THEN PERFORM 1; END IF;"],
        [installedPriceEntries[2], "PERFORM t FROM jsonb_array_elements(plan) t WHERE t->>'skuId' = p_sku::text;"],
        [installedPriceEntries[3], "IF p_claim->>'outcome' <> 'claimed' THEN RETURN jsonb_build_object('reason','price_operation_invalid'); END IF;"],
        [decisionIdentity, "plan := jsonb_build_array(jsonb_build_object('operation',p_saved_operations));"],
        ["public.catalog_publication_read_sku_revision(uuid,jsonb)", "IF p_product IS NULL THEN RETURN NULL; END IF;"],
      ] as const) {
        const definition = definitions.find(routine => routine.identity === identity)!.definition;
        const changed = definition.replace(/\bBEGIN\b/iu, `BEGIN\n  ${addedDecision}`);
        expect(changed, identity).not.toBe(definition);
        await db.query("SAVEPOINT installed_decision_probe");
        await db.query(changed);
        const mutated = await installedRoutines(db);
        expect(() => assertInstalledPriceGraph(mutated), identity).toThrow();
        await db.query("ROLLBACK TO SAVEPOINT installed_decision_probe; RELEASE SAVEPOINT installed_decision_probe");
      }
    });
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
