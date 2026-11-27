import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseError, Pool, type PoolClient } from "pg";
import { expect, it } from "vitest";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { withPlatformCatalog } from "../helpers/issuedPlatformCatalog.js";
import { runManagedCompatPostgres } from "../helpers/managedCompatPostgres.js";
import { closePostgres, postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
import { actorId, documentRow, fixture, graph, hash, installPublicationActors, json, sealedState, stageProductRows, transaction } from "./catalogPublicationFixture.js";
import { installAccountMutations, type AccountMutationsStore, type AccountProfile } from "./customerAccountMutations.fixture.js";

const catalogPath = "config/platform-migration-manifest.json";
const current = () => JSON.parse(readFileSync(catalogPath, "utf8")) as Parameters<typeof withPlatformCatalog>[0];
const listForward = /_catalog_price_list_basis_select\.sql$/u;
const recorderForward = /_catalog_price_publication_recorder_v2\.sql$/u;
const coreModesForward = /_catalog_price_core_sku_modes_v2\.sql$/u;
const basisGate = "public.catalog_price_basis_gate(text)";
const validator = "public.catalog_price_setup_v2_command_valid(jsonb)";
const apply = "public.catalog_price_setup_apply(text,text)";
const applyV2 = "public.catalog_price_setup_apply_v2(text,text,uuid)";
const lockedV2 = "public.catalog_publication_lock_effective_base_price_v2(uuid,uuid,uuid)";
const recorder = "public.catalog_publication_record_command(jsonb)";
const mutation = "public.catalog_price_setup_mutate_claimed(jsonb,timestamptz,jsonb)";
const decision = "public.catalog_publication_decide_prices_v2(jsonb,jsonb,jsonb,jsonb,jsonb,timestamptz)";
const assessment = "public.catalog_publication_assess_prices_v2(jsonb)";
const targetVerdict = "public.catalog_publication_target_price_verdict(jsonb,timestamptz)";
const privateRoutines = [mutation, lockedV2, decision, assessment,
  "public.catalog_publication_price_operations_v2(jsonb)",
  "public.catalog_publication_price_revision_facts_v2(uuid,jsonb)",
  "public.catalog_publication_price_tax_class_v2(jsonb,jsonb,boolean)",
  "public.catalog_publication_lock_price_plan_v2(jsonb,jsonb,jsonb)",
  "public.catalog_publication_price_receipt_facts_v2(public.catalog_price_setup_receipts,jsonb,jsonb,uuid,timestamptz)"];
const replaced = [recorder, "public.catalog_price_setup_apply_claimed(jsonb,timestamptz)", targetVerdict];
const refusal = '{"reason": "command_invalid", "outcome": "validation_issue"}';
const actorClaims = () => JSON.stringify({ sub: actorId, role: "authenticated" });
const pairedGrants = () => readFileSync("tests/postgres/fixtures/catalogPricePublicationV2/grants.sql", "utf8");
function prefix(forward: RegExp, include = false) {
  const manifest = current();
  for (const plan of [manifest, manifest.qualified, manifest.qualifiedAdmin]) {
    const boundary = plan.forward.findIndex(unit => forward.test(unit.file));
    expect(boundary).toBeGreaterThanOrEqual(0);
    plan.forward = plan.forward.slice(0, boundary + Number(include));
  }
  return manifest;
}

const before = () => prefix(recorderForward);

async function verifyPrefix(manifest: ReturnType<typeof current>, root: string, store: AccountMutationsStore) {
  const { installation, inventory, migrator } = store;
  if (installation.generation === "legacy") manifest.objectInventorySha256 = inventory;
  else if (installation.generation === "qualified-v2") manifest.qualified.objectInventorySha256.bootstrapMigrator.withRestore = inventory;
  else manifest.qualifiedAdmin.objectInventorySha256.installerManaged = inventory;
  writeFileSync(join(root, catalogPath), JSON.stringify(manifest));
  const runner = createPostgresMigrationRunner({ connectionString: migrator.options.connectionString! }, {
    installation, root, poolFactory: () => migrator,
  });
  expect(await runner.apply()).toEqual({ applied: [] });
}

async function withPriceUpgrade(profile: Extract<AccountProfile, "legacy" | "bootstrap" | "admin-managed">,
  forward: RegExp, label: string, verify: (prior: AccountMutationsStore, fresh: AccountMutationsStore, upgrade: () => Promise<void>) => Promise<void>) {
  const predecessor = prefix(forward);
  const candidate = prefix(forward, true);
  await withPlatformCatalog(candidate, afterRoot => withPlatformCatalog(predecessor, async beforeRoot => {
    const prior = await installAccountMutations(profile, true, `${label}-before`, beforeRoot, afterRoot);
    try {
      await verifyPrefix(predecessor, beforeRoot, prior);
      const fresh = await installAccountMutations(profile, true, `${label}-fresh`, afterRoot);
      try {
        await verifyPrefix(candidate, afterRoot, fresh);
        const upgrade = async () => {
          expect(await prior.runner.apply()).toEqual({ applied: [candidate.forward.at(-1)!.file] });
          expect(await prior.runner.apply()).toEqual({ applied: [] });
        };
        await verify(prior, fresh, upgrade);
      } finally { await fresh.close(); }
    } finally { await prior.close(); }
  }));
}

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
      expect(original).toHaveLength(replaced.length);
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

it("preserves raw verdict, gross preview and readiness, and v1 replay bytes across the core SKU upgrade", async () => {
  await withPriceUpgrade("bootstrap", coreModesForward, "populated-core-price-upgrade", async (store, _fresh, upgrade) => {
    const { owner, runtime, installation } = store;
    const password = randomUUID();
    const publicationUrl = new URL(owner.options.connectionString!);
    publicationUrl.username = "openlup_catalog_publication";
    publicationUrl.password = password;
    const publisher = new Pool({ connectionString: publicationUrl.href });
    try {
      if (installation.generation !== "qualified-v2") throw new Error("Expected the qualified runtime login");
      expect((await runtime.query("SELECT session_user AS login")).rows).toEqual([{ login: installation.runtimeLogin }]);
      await owner.query(`ALTER ROLE openlup_catalog_publication PASSWORD '${password}'`);
      expect((await publisher.query("SELECT session_user AS login")).rows).toEqual([{ login: "openlup_catalog_publication" }]);
      await installPublicationActors(owner);
      const claims = JSON.stringify({ sub: actorId, role: "authenticated" });
      const recordSql = "SELECT public.catalog_publication_record_command($1) AS bytes";
      const issueV1 = () => transaction(owner, async db => {
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
      const { issue, publish, originalPublication } = await issueV1();
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
      const priceCommand = { schemaVersion: 1, commandKey, variantId: issue.skuId, priceListId,
        mode: "one_time", minQty: 1, amountKind: "gross", unitPriceMinor: 1200, expected: { entryId: null, unitPriceMinor: null } };
      const price = json(priceCommand);
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

      const { rows: [{ at }] } = await owner.query("SELECT clock_timestamp()::text AS at");
      const baseTarget = { skuId: issue.skuId, requiredModes: ["one_time"] };
      const proposal = { ...baseTarget, operation: { priceListId, expectedListAmountBasis: "tax_inclusive", amountKind: "gross" } };
      const verdictTargets = [
        baseTarget,
        { ...baseTarget, requiredModes: ["one_time", "subscription"] },
        { ...baseTarget, skuId: randomUUID() },
        { ...proposal, operation: { ...proposal.operation, priceListId: randomUUID() } },
        { ...proposal, operation: { ...proposal.operation, amountKind: "net" } },
        proposal,
        { ...baseTarget, observeReplay: "unused by the landed array contract" },
      ];
      const arrayVerdicts = () => transaction(owner, async db => {
        const query = "SELECT public.catalog_publication_target_price_verdict($1,$2)::text AS bytes";
        const active = await db.query(query, [json(verdictTargets), at]);
        const observed = await db.query(query, [{ targets: verdictTargets }, at]);
        const missing = await db.query(query, [json(verdictTargets), "1900-01-01T00:00:00Z"]);
        await db.query("SAVEPOINT exclusive_price_list");
        await db.query("UPDATE public.price_lists SET amount_basis='tax_exclusive' WHERE id=$1", [priceListId]);
        const exclusive = await db.query(query, [json(verdictTargets), at]);
        await db.query("ROLLBACK TO SAVEPOINT exclusive_price_list");
        return [active, missing, exclusive, observed].map(result => Buffer.from(result.rows[0].bytes, "utf8"));
      });
      const originalVerdicts = await arrayVerdicts();
      expect(JSON.parse(originalVerdicts[0]!.toString()).targets.map((target: { reason: string | null }) => target.reason)).toEqual([
        null, "catalog_publication_sku_price_not_ready", "catalog_publication_sku_price_not_ready",
        "price_list_not_active", "catalog_price_setup_basis_mismatch", "expected_state_mismatch", null,
      ]);
      expect(JSON.parse(originalVerdicts[1]!.toString())).toEqual({ reason: "active_price_list_not_found" });
      expect(JSON.parse(originalVerdicts[2]!.toString()).targets[0].reason).toBe("base_price_amount_kind_invalid");

      const grossPackets = async () => {
        const preview = await transaction(runtime, async db => {
          await db.query("SET LOCAL ROLE authenticated");
          await db.query("SELECT set_config('request.jwt.claims',$1,true)", [claims]);
          return db.query(`SELECT public.catalog_price_setup_preview($1,$2,p.amount)::text AS bytes
            FROM unnest(ARRAY[NULL,1500,0]::int[]) WITH ORDINALITY p(amount,n) ORDER BY n`, [issue.skuId, priceListId]);
        });
        const readiness = await owner.query(`SELECT public.catalog_publication_price_reasons(ARRAY[$1::uuid],$2)::text AS bytes,
          public.catalog_publication_readiness_snapshot(ARRAY[$3::text],repeat('0',64),$2)::text AS refusal`, [issue.skuId, at, issue.facts.code]);
        return [...preview.rows.map(row => row.bytes), readiness.rows[0].bytes, readiness.rows[0].refusal];
      };
      const gross = await grossPackets();
      const decisionPackets = async () => {
        const operation = { ...priceCommand, schemaVersion: 2, commandKey: "compatibility-price-edit",
          expectedListAmountBasis: "tax_inclusive", expected: { entryId: JSON.parse(committedPrice.toString()).receipt.current.entryId,
            unitPriceMinor: 1200, amountKind: "gross" } };
        const context = { priceListId, regionCode: "ZZ", currency: "XXX", amountBasis: "tax_inclusive", tax: null };
        const query = "SELECT public.catalog_publication_decide_prices_v2($1,$2,$3,$4,$5,$6)::text AS bytes";
        const bytes: string[] = [];
        for (const [status, addon, standalone, subscription] of [
          ["draft", false, true, false], ["active", true, true, false],
          ["active", false, false, false], ["active", false, true, true],
        ] as const) {
          const facts = { product: { id: issue.productId, schemaVersion: 3, lifecycleState: "active" }, skus: [
            { id: issue.skuId, status, lifecycleState: status, isAddon: addon, sellableStandalone: standalone, sellableInSubscription: subscription },
          ] };
          const sku = { status, is_addon: addon, sellable_standalone: standalone, sellable_in_subscription: subscription };
          const operations = json([{ productId: issue.productId, skuId: issue.skuId, operation }]);
          for (const args of [
            [null, null, null, null, { lane: "immediate", operation, sku }, at],
            [facts, facts, operations, context, { lane: "issuance", actor: actorId }, null],
            [facts, facts, operations, context, { lane: "assessment", actor: actorId }, at],
          ]) bytes.push((await owner.query(query, args)).rows[0].bytes);
        }
        return bytes;
      };
      const decisions = await decisionPackets();
      const priceReceiptBytes = () => owner.query("SELECT response_payload::text AS bytes FROM public.catalog_price_setup_receipts WHERE idempotency_key=$1", [commandKey]);
      expect((await priceReceiptBytes()).rows).toEqual([{ bytes: committedPrice.toString() }]);
      await owner.query("UPDATE public.catalog_skus SET title='Live drift' WHERE id=$1", [issue.skuId]);
      expect(await replayPublication()).toEqual(originalPublication);
      expect(await rawPrice()).toEqual(originalPriceReplay);
      await upgrade();
      expect(await grossPackets()).toEqual(gross);
      expect(await decisionPackets()).toEqual(decisions);
      expect((await priceReceiptBytes()).rows).toEqual([{ bytes: committedPrice.toString() }]);
      const fresh = await issueV1();
      expect(JSON.parse(fresh.originalPublication.toString("utf8"))).toMatchObject({ productId: fresh.issue.productId, head: { revision: 1 } });
      // The qualified recorder's basis gate refuses v2 before these private calls.
      const context = { priceListId, regionCode: "ZZ", currency: "XXX", amountBasis: "tax_inclusive", tax: null };
      const operation = { ...priceCommand, schemaVersion: 2, commandKey: randomUUID(), variantId: fresh.issue.skuId,
        expectedListAmountBasis: context.amountBasis, expected: { ...priceCommand.expected, amountKind: null } };
      const canonicalCommand = json(operation);
      const claim = { outcome: "claimed", canonicalCommand, fingerprint: hash(canonicalCommand) };
      const evidence = { lane: "issuance", actor: actorId, issueId: fresh.issue.issueId,
        plan: [{ skuId: operation.variantId, priceListId, operation, needsFresh: false, requiredModes: [operation.mode] }],
        claims: { [operation.commandKey]: claim } };
      for (const [routine, query, args] of [
        ["catalog_publication_decide_prices_v2", "SELECT public.catalog_publication_decide_prices_v2(NULL,NULL,NULL,$1,$2,NULL)", [context, evidence]],
        ["catalog_price_setup_mutate_claimed", "SELECT public.catalog_price_setup_mutate_claimed($1,clock_timestamp(),$2)", [claim, { previous: null, publicationId: evidence.issueId }]],
      ] as const) await expect(transaction(publisher, async db => {
        await db.query("SELECT set_config('request.jwt.claims',$1,true)", [claims]);
        await db.query(query, [...args]);
      })).rejects.toMatchObject({ code: "42501", message: `permission denied for function ${routine}` });
      expect(await arrayVerdicts()).toEqual(originalVerdicts);
      await owner.query("UPDATE public.price_lists SET amount_basis='tax_exclusive' WHERE id=$1", [priceListId]);
      expect(await rawPrice()).toEqual(originalPriceReplay);
      expect(await replayPublication()).toEqual(originalPublication);
      expect(await savedPublication()).toEqual([originalPublication]);
      expect((await owner.query("SELECT count(*)::int AS effects FROM public.outbox_events WHERE aggregate_id=$1", [issue.productId])).rows)
        .toEqual([{ effects: 1 }]);
      for (const [routine, query] of [
        ["catalog_publication_assess_prices_v2", "SELECT public.catalog_publication_assess_prices_v2(NULL)"],
        ["catalog_publication_lock_effective_base_price_v2", "SELECT * FROM public.catalog_publication_lock_effective_base_price_v2(NULL,NULL,NULL)"],
      ]) await expect(publisher.query(query!)).rejects.toMatchObject({ code: "42501", message: `permission denied for function ${routine}` });
      expect((await owner.query("SELECT count(*)::int AS prices FROM public.price_entries WHERE variant_id=$1", [issue.skuId])).rows)
        .toEqual([{ prices: 1 }]);
    } finally {
      await publisher.end();
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

function standaloneCorePrice() {
  const data = fixture(), priceListId = randomUUID(), entryId = randomUUID();
  const edit = { schemaVersion: 2, commandKey: "standalone-core-quantum", variantId: data.skuId, priceListId, mode: "one_time",
    minQty: 1, amountKind: "gross", expectedListAmountBasis: "tax_inclusive", unitPriceMinor: 9,
    expected: { entryId, unitPriceMinor: 150, amountKind: "gross" } };
  return { data, priceListId, entryId, edit };
}

async function seedStandaloneCorePrice(owner: Pool, { data, priceListId, entryId }: ReturnType<typeof standaloneCorePrice>,
  { subscriptionEligible = false, withPolicy = true } = {}) {
  await installPublicationActors(owner);
  await owner.query(`INSERT INTO public.commerce_settings(key,value_text) VALUES('settlement_region','ZZ'),('settlement_currency','XXX')
    ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text`);
  await owner.query("SELECT public.commerce_capture_offer_policy_v2_legacy_baseline()");
  const publication = await transaction(owner, async db => {
    const draft = await graph(db, data, null, true, { lifecycle: "active", subscriptionEligible });
    const command = { schemaVersion: 2, action: "publish", productId: draft.productId, commandKey: draft.commandKey,
      candidateRef: draft.candidateRef, candidateDigest: draft.candidateDigest, expectedHead: null, changes: [] };
    const fingerprint = hash(json([command, actorId]));
    await documentRow(db, { ...draft, fingerprint });
    await db.query("UPDATE public.catalog_products SET publication_facts=$2,status='active',variant_axes=$3,attribute_values=$4 WHERE id=$1",
      [data.productId, draft.product, draft.product.axes, draft.product.attributes]);
    await db.query(`UPDATE public.catalog_skus SET publication_facts=$2,status='active',sellable_standalone=true,sellable_in_subscription=$3,
      option_values=$2::jsonb->'options',attribute_values=$2::jsonb->'attributes',combination_digest=decode($2::jsonb->>'optionDigest','hex'),
      net_content_dimension='mass',net_content_unit='openlup:g',net_content_unscaled=100,net_content_scale=0 WHERE id=$1`, [data.skuId, draft.facts, subscriptionEligible]);
    const seal = sealedState(draft.product, [{ skuId: data.skuId, digest: hash(json(draft.facts)) }]);
    await db.query("SELECT set_config('request.jwt.claims',$1,true)", [actorClaims()]);
    await db.query("SET LOCAL SESSION AUTHORIZATION openlup_catalog_publication");
    const record = "SELECT public.catalog_publication_record_command($1) AS bytes";
    await db.query(record, [{ ...draft.decision, postStateText: seal, postStateDigest: hash(seal) }]);
    await db.query("RESET SESSION AUTHORIZATION");
    const { rows: [{ id: approvalId }] } = await db.query("SELECT id FROM public.catalog_publication_decisions WHERE product_id=$1", [data.productId]);
    const publish = { ...command, fingerprint, approvalId, product: draft.product, skus: [draft.facts] };
    await db.query("SET LOCAL SESSION AUTHORIZATION openlup_catalog_publication");
    const { rows: [{ bytes }] } = await db.query<{ bytes: string }>(record, [publish]);
    return { publish, bytes, code: draft.facts.code };
  });
  await owner.query("INSERT INTO public.price_lists(id,name,region_code,currency,valid_from) VALUES($1,'Gross','ZZ','XXX','-infinity')", [priceListId]);
  await owner.query(`INSERT INTO public.price_entries(id,variant_id,price_list_id,mode,unit_price_minor,valid_from)
    VALUES($1,$2,$3,'one_time',150,'-infinity')`, [entryId, data.skuId, priceListId]);
  if (withPolicy) await insertSubscriptionPolicy(owner, priceListId, 10);
  return publication;
}

const recordPricePublication = "SELECT public.catalog_publication_record_command($1) AS bytes";

async function prepareInheritedPricePublication(owner: Pool, publication: Awaited<ReturnType<typeof seedStandaloneCorePrice>>,
  operation: ReturnType<typeof standaloneCorePrice>["edit"]) {
  return transaction(owner, async db => {
    const { product, skus } = publication.publish;
    const { draftId, revision } = product.source;
    const { rows: [{ payload }] } = await db.query("SELECT payload FROM public.catalog_draft_revisions WHERE draft_id=$1 AND revision=$2", [draftId, revision]);
    payload.product.sharedContent.catalogAction = "revise";
    payload.publication = { kind: "release", operations: [], evidence: { priceContext: {
      priceListId: operation.priceListId, regionCode: "ZZ", currency: "XXX", amountBasis: "tax_inclusive", tax: null,
    } } };
    payload.skus[0].priceOperations = [operation];
    const source = { draftId, revision: revision + 1, commandKey: randomUUID(), fingerprint: hash(json(payload)) };
    await db.query("UPDATE public.catalog_draft_heads SET revision=$2 WHERE draft_id=$1", [draftId, source.revision]);
    await db.query(`INSERT INTO public.catalog_draft_revisions(draft_id,revision,product_id,status,payload,command_key,fingerprint,actor_id)
      VALUES($1,$2,$3,'open',$4,$5,$6,$7)`, [draftId, source.revision, product.id, payload, source.commandKey, source.fingerprint, actorId]);
    await db.query("INSERT INTO public.catalog_draft_command_receipts(draft_id,command_key,fingerprint,revision) VALUES($1,$2,$3,$4)",
      [draftId, source.commandKey, source.fingerprint, source.revision]);
    const expectedHead = JSON.parse(publication.bytes).head;
    const candidateRef = `v1:${draftId}@${source.revision}/${expectedHead.publicationId}@${expectedHead.revision}`;
    const candidateDigest = hash(json(["catalog-candidate", 1, payload, [{ ...product.type, definitionDigest: product.definitionDigest }], expectedHead]));
    const nextProduct = { ...product, source, content: { ...product.content, catalogAction: "revise" as const } };
    const seal = sealedState(nextProduct, skus.map(sku => ({ skuId: sku.id, digest: hash(json(sku)) })));
    const common = { schemaVersion: 2, productId: product.id, candidateRef, candidateDigest };
    const approvalKey = randomUUID();
    await db.query("SELECT set_config('request.jwt.claims',$1,true)", [actorClaims()]);
    await db.query(recordPricePublication, [{ ...common, action: "approve", commandKey: approvalKey, reason: null,
      postStateText: seal, postStateDigest: hash(seal) }]);
    const { rows: [{ id: approvalId }] } = await db.query("SELECT id FROM public.catalog_publication_decisions WHERE product_id=$1 AND command_key=$2",
      [product.id, approvalKey]);
    const command = { ...common, action: "publish", commandKey: randomUUID(), expectedHead, changes: [] };
    return {
      publish: { ...command, fingerprint: hash(json([command, actorId])), approvalId, product: nextProduct, skus },
      assessment: { productId: product.id, candidateRef, candidateDigest, action: "assess_price_v2", postState: { canonicalText: seal, digest: hash(seal), skus } },
    };
  });
}

async function issueInheritedPrice(db: PoolClient, { publish }: Awaited<ReturnType<typeof prepareInheritedPricePublication>>) {
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [actorClaims()]);
  await db.query("UPDATE public.catalog_products SET publication_facts=$2 WHERE id=$1", [publish.productId, publish.product]);
  return (await db.query<{ bytes: string }>(recordPricePublication, [publish])).rows[0]!.bytes;
}

async function pricePublicationEffects(db: Pool | PoolClient, { data }: ReturnType<typeof standaloneCorePrice>) {
  return (await db.query(`SELECT jsonb_build_array(
    (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM public.price_entries e WHERE variant_id=$1),
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.idempotency_key) FROM public.catalog_price_setup_receipts r WHERE metadata->>'variantId'=$1::uuid::text),
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.command_key) FROM public.catalog_operator_receipts r WHERE scope_id=$2),
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.revision) FROM public.catalog_publications p WHERE product_id=$2),
    (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.revision) FROM public.catalog_sku_revisions s WHERE sku_id=$1),
    (SELECT to_jsonb(h) FROM public.catalog_publication_heads h WHERE product_id=$2),
    (SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM public.outbox_events o WHERE aggregate_id=$2))::text AS bytes`, [data.skuId, data.productId])).rows[0].bytes as string;
}

it("keeps a standalone core SKU ready at a later instant after an advisory wait", async () => {
  await withPriceUpgrade("bootstrap", coreModesForward, "later-price-readiness", async (prior, candidate) => {
    const subject = standaloneCorePrice();
    const { priceListId, edit, data: { skuId } } = subject;
    const aggregate = "catalog_1490_legacy_1340_invalid";
    const gate = async (db: Pool, replacement: string | null = null) => (await db.query(`SELECT
      public.commerce_offer_policy_v2_readiness() AS readiness, statement_timestamp() >
        (SELECT valid_from FROM public.price_entries WHERE id=$1) AS later`, [replacement])).rows[0];
    const effects = async (db: Pool) => (await db.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id)::text FROM public.price_entries e WHERE variant_id=$1) AS prices,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.idempotency_key)::text FROM public.catalog_price_setup_receipts r
        WHERE metadata->>'variantId'=$1::uuid::text) AS receipts`, [skuId])).rows;
    for (const { owner } of [prior, candidate]) {
      await seedStandaloneCorePrice(owner, subject);
      const { readiness } = await gate(owner);
      expect(readiness.evidence).toMatchObject({ activeCoreSkuCount: 1, priceMismatchCount: 0, subscriptionPricePolicyDerivesBand: true });
      expect(readiness.reasons).not.toContain(aggregate);
    }
    const write = (store: AccountMutationsStore, command: typeof edit, wait = false) => transaction(store.runtime, async db => {
      await db.query("SET LOCAL ROLE authenticated");
      await db.query("SELECT set_config('request.jwt.claims',$1,true)", [actorClaims()]);
      const bytes = json(command);
      const apply = () => db.query("SELECT public.catalog_price_setup_apply($1,$2) AS result", [bytes, hash(bytes)]);
      if (!wait) return (await apply()).rows[0].result;
      const { rows: [{ pid }] } = await db.query("SELECT pg_backend_pid() AS pid");
      let pending: ReturnType<typeof apply> | undefined;
      await transaction(store.owner, async peer => {
        await peer.query("SELECT public.catalog_price_setup_lock_context($1,$2)", [priceListId, skuId]);
        pending = apply();
        void pending.catch(() => undefined);
        for (let attempt = 0; attempt < 300; attempt++) {
          if ((await peer.query("SELECT pg_backend_pid()=ANY(pg_blocking_pids($1)) AS waiting", [pid])).rows[0].waiting) return;
          await peer.query("SELECT pg_sleep(0.01)");
        }
        throw new Error("The writer did not wait on the price fence");
      });
      return (await pending!).rows[0].result;
    });
    for (const store of [prior, candidate]) {
      const before = await effects(store.owner);
      expect(await write(store, edit)).toEqual({ outcome: "validation_issue", reason: "command_invalid" });
      expect(await effects(store.owner)).toEqual(before);
      await store.owner.query(pairedGrants());
    }
    expect(await write(prior, edit)).toMatchObject({ outcome: "committed" });
    expect((await gate(prior.owner)).readiness.reasons).toContain(aggregate);
    const original = await effects(candidate.owner);
    expect(await write(candidate, edit)).toEqual({ outcome: "validation_issue", reason: "catalog_publication_sku_price_not_ready" });
    expect(await effects(candidate.owner)).toEqual(original);
    const committed = await write(candidate, { ...edit, unitPriceMinor: 120 }, true);
    expect(committed).toMatchObject({ outcome: "committed", receipt: { current: { unitPriceMinor: 120 } } });
    const { readiness, later } = await gate(candidate.owner, committed.receipt.current.entryId);
    expect(later).toBe(true);
    expect(readiness.evidence).toMatchObject({ activeCoreSkuCount: 1, priceMismatchCount: 0 });
    expect(readiness.reasons).not.toContain(aggregate);
  });
}, postgresSetupTimeoutMs);

it("keeps released price and readiness responses byte-identical with the paired grants closed", async () => {
  await withPriceUpgrade("bootstrap", coreModesForward, "shipped-core-price", async (store, _fresh, upgrade) => {
    const { owner, runtime, installation } = store;
    if (installation.generation !== "qualified-v2") throw new Error("Expected the qualified runtime login");
    const subject = standaloneCorePrice();
    const { priceListId, data: { skuId }, edit } = subject;
    const publication = await seedStandaloneCorePrice(owner, subject);
    const password = randomUUID(), url = new URL(owner.options.connectionString!);
    url.username = "openlup_catalog_publication";
    url.password = password;
    await owner.query(`ALTER ROLE openlup_catalog_publication PASSWORD '${password}'`);
    const publisher = new Pool({ connectionString: url.href });
    try {
      const v1 = json({ schemaVersion: 1, commandKey: "released-core-price", variantId: skuId, priceListId, mode: "one_time",
        minQty: 1, amountKind: "gross", unitPriceMinor: 160, expected: { entryId: edit.expected.entryId, unitPriceMinor: 150 } });
      const applySql = "SELECT public.catalog_price_setup_apply($1,$2)::text AS bytes";
      const applyFreshV1 = (command: string) => transaction(runtime, async db => {
        await db.query("SET LOCAL ROLE authenticated");
        await db.query("SELECT set_config('request.jwt.claims',$1,true)", [actorClaims()]);
        return JSON.parse((await db.query<{ bytes: string }>(applySql, [command, hash(command)])).rows[0]!.bytes);
      });
      const committed = await applyFreshV1(v1);
      expect(committed).toMatchObject({ outcome: "committed", receipt: { current: { unitPriceMinor: 160 } } });
      const operation = { ...edit, expected: { ...edit.expected, entryId: committed.receipt.current.entryId, unitPriceMinor: 160 } };
      const v2 = json(operation);
      const { rows: [sku] } = await owner.query(`SELECT status,is_addon,sellable_standalone,sellable_in_subscription
        FROM public.catalog_skus WHERE id=$1`, [skuId]);
      expect(sku).toEqual({ status: "active", is_addon: false, sellable_standalone: true, sellable_in_subscription: false });
      const evidence = { lane: "immediate", operation, sku };
      const targets = json([{ skuId, requiredModes: ["one_time"], operation,
        skuFacts: { status: "active", isAddon: false, sellableStandalone: true, sellableInSubscription: false } }]);
      const { rows: [{ digest }] } = await owner.query("SELECT public.catalog_publication_read_head()->>'headDigest' AS digest");
      expect(digest).toMatch(/^[a-f0-9]{64}$/u);
      const denied = async (db: PoolClient, sql: string, args: readonly unknown[]) => {
        await db.query("SAVEPOINT unavailable_price");
        await expect(db.query(sql, [...args]), sql).rejects.toMatchObject({ code: "42501", routine: "aclcheck_error" });
        await db.query("ROLLBACK TO SAVEPOINT unavailable_price; RELEASE SAVEPOINT unavailable_price");
      };
      const privateCalls = [
        ["SELECT public.catalog_price_setup_apply_v2($1,$2,NULL)", [v2, hash(v2)]],
        ["SELECT * FROM public.catalog_publication_lock_effective_base_price_v2($1,$2,$3)", [skuId, priceListId, publication.publish.approvalId]],
        ["SELECT public.catalog_publication_assess_prices_v2(NULL)", []],
        ["SELECT public.catalog_publication_decide_prices_v2(NULL,NULL,NULL,NULL,$1,statement_timestamp())", [evidence]],
        ["SELECT public.catalog_publication_target_price_verdict($1,statement_timestamp())", [targets]],
        ["SELECT public.catalog_price_setup_mutate_claimed(NULL,NULL,NULL)", []],
        ["SELECT public.catalog_publication_price_operations_v2(NULL)", []],
        ["SELECT public.catalog_publication_price_revision_facts_v2(NULL,NULL)", []],
        ["SELECT public.catalog_publication_price_tax_class_v2(NULL,NULL,false)", []],
        ["SELECT public.catalog_publication_lock_price_plan_v2(NULL,NULL,NULL)", []],
        ["SELECT public.catalog_publication_price_receipt_facts_v2(NULL,NULL,NULL,NULL,NULL)", []],
      ] as const;
      const probe = async () => {
        const responses: Record<string, string> = {};
        for (const role of ["openlup_catalog_publication", installation.runtimeLogin, "authenticated", "service_role"]) {
          const publicationLogin = role === "openlup_catalog_publication";
          const browser = role === "authenticated";
          const service = role === "service_role" || role === installation.runtimeLogin;
          await transaction(publicationLogin ? publisher : runtime, async db => {
            if (browser) await db.query("SET LOCAL ROLE authenticated");
            if (role === "service_role") await db.query("SET LOCAL ROLE service_role");
            expect((await db.query("SELECT session_user AS login,current_user AS role")).rows)
              .toEqual([{ login: publicationLogin ? role : installation.runtimeLogin, role }]);
            await db.query("SELECT set_config('request.jwt.claims',$1,true)", [actorClaims()]);
            for (const [sql, args] of privateCalls) await denied(db, sql, args);
            for (const [label, allowed, sql, args, shape] of [
              ["v1 price replay", browser || publicationLogin, applySql, [v1, hash(v1)], { outcome: "replayed" }],
              ["v2 dispatch", browser || publicationLogin, applySql, [v2, hash(v2)], JSON.parse(refusal)],
              ["preview", browser, "SELECT public.catalog_price_setup_preview($1,$2,NULL)::text AS bytes", [skuId, priceListId],
                { outcome: "preview", inGate: true }],
              ["proposed preview", browser, "SELECT public.catalog_price_setup_preview($1,$2,9)::text AS bytes", [skuId, priceListId],
                { outcome: "preview", inGate: true, proposed: { unitPriceMinor: 9 } }],
              ["v1 publication replay", publicationLogin, "SELECT public.catalog_publication_record_command($1) AS bytes", [publication.publish],
                JSON.parse(publication.bytes)],
              ["locked base", publicationLogin, "SELECT to_jsonb(p)::text AS bytes FROM public.catalog_publication_lock_effective_base_price($1,$2) p",
                [skuId, priceListId], { unit_price_minor: 160 }],
              ["activation readiness", publicationLogin || service, "SELECT public.catalog_publication_activation_readiness($1,$2)::text AS bytes",
                [[publication.code], digest], { kind: "batch", value: { items: [{ skuCode: publication.code, priceReasons: [] }] } }],
              ["command validator", service, "SELECT public.catalog_price_setup_v2_command_valid($1)::text AS bytes", [v2], true],
              ["basis gate", service, "SELECT public.catalog_price_basis_gate('command_invalid')::text AS bytes", [], JSON.parse(refusal)],
            ] as const) {
              if (!allowed) { await denied(db, sql, args); continue; }
              const { rows: [{ bytes }] } = await db.query<{ bytes: string }>(sql, [...args]);
              const result = JSON.parse(bytes);
              if (typeof shape === "boolean") expect(result).toBe(shape);
              else expect(result, `${role} ${label}`).toMatchObject(shape);
              if (label === "v1 publication replay") expect(bytes).toBe(publication.bytes);
              responses[`${role} ${label}`] = bytes;
            }
            const aggregate = "SELECT public.commerce_offer_policy_v2_readiness()::text AS bytes";
            if (publicationLogin) expect(JSON.parse((await db.query<{ bytes: string }>(aggregate)).rows[0]!.bytes).evidence)
              .toMatchObject({ activeCoreSkuCount: 1, priceMismatchCount: 0 });
            else await denied(db, aggregate, []);
          });
        }
        return responses;
      };
      const decisionReason = async () => (await owner.query(`SELECT public.catalog_publication_decide_prices_v2(
        NULL,NULL,NULL,NULL,$1,statement_timestamp())->'reason' AS reason`, [evidence])).rows[0].reason;
      const draft = await prepareInheritedPricePublication(owner, publication, operation);
      const freshV2Refusal = async () => {
        const before = await pricePublicationEffects(owner, subject);
        const result = await transaction(publisher, db => issueInheritedPrice(db, draft)).catch((error: unknown) => {
          if (!(error instanceof DatabaseError)) throw error;
          return json({ code: error.code, message: error.message, constraint: error.constraint, detail: error.detail, hint: error.hint });
        });
        expect(result).toBe(json({ code: "23514", message: "command_invalid", constraint: "command_invalid" }));
        expect(await pricePublicationEffects(owner, subject)).toBe(before);
        return result;
      };
      expect(await decisionReason()).toBeNull();
      const original = await probe();
      const originalFreshRefusal = await freshV2Refusal();
      // One simple-query message gives both aggregate calls the same statement timestamp.
      const forward = current().forward.find(unit => coreModesForward.test(unit.file))!;
      await transaction(owner, async db => {
        await db.query("SAVEPOINT aggregate_upgrade");
        const aggregate = `SET LOCAL SESSION AUTHORIZATION openlup_catalog_publication;
          SELECT public.commerce_offer_policy_v2_readiness()::text AS bytes;
          RESET SESSION AUTHORIZATION;`;
        const results = await db.query<{ bytes: string }>(`${aggregate}
${readFileSync(forward.file, "utf8")}
${aggregate}`);
        if (!Array.isArray(results)) throw new Error("Expected both aggregate reads");
        const bytes = results.flatMap(result => result.rows.map(row => row.bytes));
        expect(bytes).toHaveLength(2);
        expect(bytes[1]).toBe(bytes[0]);
        await db.query("ROLLBACK TO SAVEPOINT aggregate_upgrade; RELEASE SAVEPOINT aggregate_upgrade");
      });

      await upgrade();
      expect(await decisionReason()).toBe("catalog_publication_sku_price_not_ready");
      expect(await probe()).toEqual(original);
      expect(await freshV2Refusal()).toBe(originalFreshRefusal);
      expect(await applyFreshV1(json({ ...JSON.parse(v1), commandKey: "fresh-released-core-price", unitPriceMinor: 170,
        expected: { entryId: operation.expected.entryId, unitPriceMinor: 160 } })))
        .toMatchObject({ outcome: "committed", receipt: { current: { unitPriceMinor: 170 } } });
    } finally { await publisher.end(); }
  });
}, postgresSetupTimeoutMs);

it("refuses a below-quantum edit for an inherited standalone core SKU at issuance", async () => {
  const candidate = prefix(coreModesForward, true);
  await withPlatformCatalog(candidate, async root => {
    const store = await installAccountMutations("bootstrap", true, "inherited-core-price", root);
    const { owner } = store;
    try {
      await verifyPrefix(candidate, root, store);
      const subject = standaloneCorePrice();
      const publication = await seedStandaloneCorePrice(owner, subject);
      const draft = await prepareInheritedPricePublication(owner, publication, subject.edit);
      await owner.query(pairedGrants());
      const issueAsPublisher = async (db: PoolClient) => {
        await db.query("SET LOCAL SESSION AUTHORIZATION openlup_catalog_publication");
        return issueInheritedPrice(db, draft);
      };
      const before = await pricePublicationEffects(owner, subject);
      expect(draft.publish.skus).toEqual(publication.publish.skus);
      expect(draft.publish.skus[0]).toMatchObject({ status: "active", isAddon: false, sellableStandalone: true, sellableInSubscription: false });
      await expect(transaction(owner, issueAsPublisher)).rejects.toMatchObject({ code: "23514",
        constraint: "catalog_publication_sku_price_not_ready", detail: "SKU and required mode" });
      expect(await pricePublicationEffects(owner, subject)).toBe(before);

      await transaction(owner, async db => {
        const { rows: [{ definition }] } = await db.query<{ definition: string }>(
          "SELECT pg_get_functiondef($1::regprocedure) AS definition", [decision]);
        const withoutInheritedFacts = definition.replace("AND ref->'skuId'=t->'skuId'))",
          "AND lane='reader' AND ref->'skuId'=t->'skuId'))");
        expect(withoutInheritedFacts).not.toBe(definition);
        await db.query("SAVEPOINT inherited_price_lookup");
        await db.query(withoutInheritedFacts);
        const bytes = await issueAsPublisher(db);
        await db.query("SET CONSTRAINTS ALL IMMEDIATE");
        await db.query("RESET SESSION AUTHORIZATION");
        expect(JSON.parse(bytes)).toMatchObject({ head: { revision: 2 }, changes: [] });
        expect((await db.query(`SELECT issued_count FROM public.catalog_publications WHERE product_id=$1 AND revision=2`,
          [subject.data.productId])).rows).toEqual([{ issued_count: 0 }]);
        expect((await db.query(`SELECT unit_price_minor FROM public.price_entries WHERE variant_id=$1 AND active`,
          [subject.data.skuId])).rows).toEqual([{ unit_price_minor: 9 }]);
        await db.query("ROLLBACK TO SAVEPOINT inherited_price_lookup; RELEASE SAVEPOINT inherited_price_lookup");
      });
      expect(await pricePublicationEffects(owner, subject)).toBe(before);
    } finally { await store.close(); }
  });
}, postgresSetupTimeoutMs);

function insertSubscriptionPolicy(db: Pool | PoolClient, listId: string, quantum: number, id = randomUUID(), expires: string | null = null) {
  return db.query(`INSERT INTO public.subscription_price_policy_revisions
    (id,revision_no,price_list_id,region_code,currency,channel,effective_from,effective_to,discount_bps,rounding_quantum_minor,rounding_rule,digest)
    VALUES ($1,1,$2,'ZZ','XXX','D2C','2000-01-01Z',$4,0,$3,'FLOOR_TO_QUANTUM',
      public.catalog_price_setup_policy_digest($1,1,$2,'ZZ','XXX','D2C','2000-01-01Z',$4,0,$3,'FLOOR_TO_QUANTUM'))`,
  [id, listId, quantum, expires]);
}

const policyFixtures = {
  absent: null,
  positive: { quantum: 1, expires: null },
  "rounds to zero": { quantum: 1000, expires: null },
  expired: { quantum: 1, expires: "2000-02-01T00:00:00Z" },
};
type SubscriptionEntry = readonly [kind: "gross" | "net", minQty: number, minor: number];
const subscriptionRows = {
  absent: [],
  valid: [["gross", 1, 100]],
  "wrong kind": [["net", 1, 100]],
  "wrong threshold": [["gross", 2, 100]],
  "zero amount": [["gross", 1, 0]],
  multiple: [["gross", 1, 100], ["gross", 1, 110]],
} as const satisfies Record<string, readonly SubscriptionEntry[]>;

async function capturePriceRefusal(db: PoolClient, call: () => Promise<string | null>) {
  await db.query("SAVEPOINT price_entry_call");
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof DatabaseError)) throw error;
    return JSON.stringify({ sqlstate: error.code, reason: error.message, constraint: error.constraint, field: error.detail, remedy: error.hint });
  } finally {
    await db.query("ROLLBACK TO SAVEPOINT price_entry_call; RELEASE SAVEPOINT price_entry_call");
  }
}

it("matches explicit subscription refusal bytes for inferred core prices on every publication path", async () => {
  await withPriceUpgrade("bootstrap", coreModesForward, "core-price-refusal-parity", async (prior, candidate) => {
    const subject = standaloneCorePrice();
    const { data: { skuId }, priceListId, entryId } = subject;
    const operation = { ...subject.edit, unitPriceMinor: 120 };
    const receiptEntryId = randomUUID(), wrongEntryId = randomUUID(), policyId = randomUUID();
    const storedIds = [randomUUID(), randomUUID()];
    const writtenAt = "2001-01-01T00:00:00Z";
    const context = { priceListId, regionCode: "ZZ", currency: "XXX", amountBasis: "tax_inclusive", tax: null };

    const run = async (store: AccountMutationsStore, subscriptionEligible: boolean) => {
      const { owner } = store;
      const publication = await seedStandaloneCorePrice(owner, subject, { subscriptionEligible, withPolicy: false });
      expect(publication.publish.skus[0]).toMatchObject({ status: "active", isAddon: false, sellableStandalone: true, sellableInSubscription: subscriptionEligible });
      const draft = await prepareInheritedPricePublication(owner, publication, operation);
      await owner.query(pairedGrants());
      const issueId: string = JSON.parse(publication.bytes).head.publicationId;
      const insertStored = async (db: PoolClient, rows: readonly SubscriptionEntry[]) => {
        for (const [index, [kind, minQty, minor]] of rows.entries()) {
          await db.query(`INSERT INTO public.price_entries(id,variant_id,price_list_id,mode,amount_kind,min_qty,unit_price_minor,valid_from)
            VALUES($1,$2,$3,'subscription',$4,$5,$6,(date '2000-03-01'+$7::integer)::timestamptz)`,
          [storedIds[index], skuId, priceListId, kind, minQty, minor, index]);
        }
      };
      const issue = async (db: PoolClient) => {
        await db.query("SET LOCAL SESSION AUTHORIZATION openlup_catalog_publication");
        return issueInheritedPrice(db, draft);
      };
      const probe = (phase: "fresh" | "completed" | "locked") => transaction(owner, async db => {
        await db.query("SELECT set_config('request.jwt.claims',$1,true)", [actorClaims()]);
        const results: Record<string, (string | null)[]> = {};
        for (const [policy, config] of Object.entries(policyFixtures)) for (const [stored, rows] of Object.entries(subscriptionRows)) {
          await db.query("SAVEPOINT subscription_state");
          if (config) await insertSubscriptionPolicy(db, priceListId, config.quantum, policyId, config.expires);
          await insertStored(db, rows);
          for (const identity of ["correct", "wrong amount", "wrong entry"] as const) for (const kind of ["gross", "net"] as const) {
            await db.query("SAVEPOINT base_state");
            const id = phase === "fresh" ? entryId : receiptEntryId;
            const minor = phase === "fresh" ? operation.expected.unitPriceMinor : operation.unitPriceMinor;
            await db.query("UPDATE public.price_entries SET id=$2,unit_price_minor=$3,amount_kind=$4 WHERE id=$1",
              [id, identity === "wrong entry" ? wrongEntryId : id, minor + Number(identity === "wrong amount"), kind]);
            const key = [policy, stored, identity, kind].join(" / ");
            if (phase === "locked") {
              results[key] = [await capturePriceRefusal(db, async () => {
                await db.query("SET LOCAL SESSION AUTHORIZATION openlup_catalog_publication");
                const read = await db.query("SELECT * FROM public.catalog_publication_lock_effective_base_price_v2($1,$2,$3)",
                  [skuId, priceListId, draft.publish.approvalId]);
                expect(read.rows).toEqual([{ id: receiptEntryId, unit_price_minor: 120, amount_kind: "gross" }]);
                return null;
              })];
            } else {
              const { rows: [{ bytes }] } = await db.query<{ bytes: string }>("SELECT public.catalog_publication_assess_prices_v2($1) AS bytes", [draft.assessment]);
              const assessment = JSON.parse(bytes);
              expect(["pass", "blocked-input"], key).toContain(assessment.outcome);
              results[key] = [assessment.outcome === "pass" ? null : bytes,
                await capturePriceRefusal(db, async () => { await issue(db); return null; })];
              if (phase === "completed") {
                // The real recorder also proves after a write. Supply that phase's
                // evidence with the same completed receipt, rows and sealed SKU.
                const plan = [{ skuId, priceListId, operation, needsFresh: false,
                  requiredModes: subscriptionEligible ? ["one_time", "subscription"] : ["one_time"] }];
                const evidence = { lane: "issuance", actor: actorId, issueId, written: true, plan,
                  claims: { [operation.commandKey]: { outcome: "claimed" } } };
                results[key].push(await capturePriceRefusal(db, async () => {
                  await db.query("SELECT public.catalog_publication_decide_prices_v2(NULL,NULL,NULL,$1,$2,$3)", [context, evidence, writtenAt]);
                  return null;
                }));
              }
            }
            await db.query("ROLLBACK TO SAVEPOINT base_state; RELEASE SAVEPOINT base_state");
          }
          await db.query("ROLLBACK TO SAVEPOINT subscription_state; RELEASE SAVEPOINT subscription_state");
        }
        return results;
      });

      const fresh = await probe("fresh");
      await transaction(owner, async db => {
        const response = { outcome: "committed", receipt: { actorId, commandKey: operation.commandKey, variantId: skuId,
          priceListId, amountBasis: context.amountBasis, previous: { ...operation.expected, validFrom: "-infinity" },
          current: { entryId: receiptEntryId, unitPriceMinor: operation.unitPriceMinor, amountKind: "gross", validFrom: writtenAt } } };
        await db.query("UPDATE public.price_entries SET active=false,valid_to=$2 WHERE id=$1", [entryId, writtenAt]);
        await db.query(`INSERT INTO public.price_entries(id,variant_id,price_list_id,mode,unit_price_minor,valid_from)
          VALUES($1,$2,$3,'one_time',$4,$5)`, [receiptEntryId, skuId, priceListId, operation.unitPriceMinor, writtenAt]);
        await db.query(`INSERT INTO public.catalog_price_setup_receipts(scope,idempotency_key,request_fingerprint,status,response_payload,metadata)
          VALUES ('catalog.price_setup.base',$1,$2,'completed',$3,$4)`,
        [operation.commandKey, hash(json(operation)), response, { actorId, variantId: skuId, priceListId, publicationId: issueId }]);
      });
      const completed = await probe("completed");
      await transaction(owner, async db => {
        await insertStored(db, subscriptionRows.valid);
        expect(JSON.parse(await issue(db))).toMatchObject({ head: { revision: 2 }, changes: [] });
      });
      await owner.query("DELETE FROM public.price_entries WHERE id=$1", [storedIds[0]]);
      return { fresh, completed, locked: await probe("locked") };
    };

    const predecessor = await run(prior, true);
    expect(predecessor.fresh["absent / valid / correct / gross"]).toEqual([null, null]);
    expect(predecessor.completed["absent / valid / correct / gross"]).toEqual([null, null, null]);
    expect(predecessor.locked["absent / valid / correct / gross"]).toEqual([null]);
    for (const bytes of predecessor.completed["absent / wrong threshold / wrong amount / gross"]!) {
      expect(JSON.parse(bytes!)).toMatchObject({ reason: "price_shape_invalid", sqlstate: "23514", field: "Effective base entry" });
    }
    for (const bytes of predecessor.completed["positive / absent / correct / net"]!) {
      expect(JSON.parse(bytes!)).toMatchObject({ reason: "catalog_publication_price_changed", sqlstate: "40001" });
    }
    const inferred = await run(candidate, false);
    for (const phase of ["fresh", "completed", "locked"] as const) {
      expect(Object.keys(inferred[phase])).toEqual(Object.keys(predecessor[phase]));
      for (const [testCase, bytes] of Object.entries(predecessor[phase])) {
        expect(inferred[phase][testCase], `${phase}: ${testCase}`).toEqual(bytes);
      }
    }
  });
}, postgresSetupTimeoutMs);

it("uses sealed prospective SKU facts in assessment, issuance proof, and locked readback", async () => {
  const candidate = prefix(coreModesForward, true);
  await withPlatformCatalog(candidate, async root => {
    const store = await installAccountMutations("bootstrap", true, "sealed-core-price", root);
    const { owner } = store;
    try {
      await verifyPrefix(candidate, root, store);
      await installPublicationActors(owner);
      await owner.query(pairedGrants());
      const priceListId = randomUUID(), data = fixture();
      await owner.query(`INSERT INTO public.commerce_settings(key,value_text) VALUES('settlement_region','ZZ'),('settlement_currency','XXX')
        ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text`);
      await owner.query("SELECT public.commerce_capture_offer_policy_v2_legacy_baseline()");
      await owner.query("INSERT INTO public.price_lists(id,name,region_code,currency,valid_from) VALUES($1,'Publication','ZZ','XXX','-infinity')", [priceListId]);
      const draft = await transaction(owner, db => graph(db, data, null, false, { lifecycle: "active" }));
      const priceContext = { priceListId, regionCode: "ZZ", currency: "XXX", amountBasis: "tax_inclusive", tax: null };
      const edit = { schemaVersion: 2, commandKey: randomUUID(), variantId: data.skuId, priceListId, mode: "one_time", minQty: 1,
        amountKind: "gross", expectedListAmountBasis: "tax_inclusive", unitPriceMinor: 120,
        expected: { entryId: null, unitPriceMinor: null, amountKind: null } };
      const seal = sealedState(draft.product, [{ skuId: data.skuId, digest: hash(json(draft.facts)) }]);
      const postState = { canonicalText: seal, digest: hash(seal), skus: [draft.facts] };
      const notReady = "catalog_publication_sku_price_not_ready";
      const approveId = await transaction(owner, async db => {
        const { rows: [{ payload }] } = await db.query("SELECT payload FROM public.catalog_draft_revisions WHERE draft_id=$1", [data.draftId]);
        payload.publication.evidence.priceContext = priceContext;
        payload.skus[0].priceOperations = [edit];
        await db.query("ALTER TABLE public.catalog_draft_revisions DISABLE TRIGGER catalog_draft_revisions_immutable");
        await db.query("UPDATE public.catalog_draft_revisions SET payload=$2 WHERE draft_id=$1", [data.draftId, payload]);
        await db.query("ALTER TABLE public.catalog_draft_revisions ENABLE TRIGGER catalog_draft_revisions_immutable");
        const candidateDigest = hash(json(["catalog-candidate", 1, payload,
          [{ ...draft.product.type, definitionDigest: draft.product.definitionDigest }], null]));
        await db.query("SELECT set_config('request.jwt.claims',$1,true)", [actorClaims()]);
        const assess = async () => JSON.parse((await db.query("SELECT public.catalog_publication_assess_prices_v2($1) AS result", [
          { action: "assess_price_v2", productId: data.productId, candidateRef: draft.candidateRef, candidateDigest, postState },
        ])).rows[0].result);
        expect((await db.query("SELECT status FROM public.catalog_skus WHERE id=$1", [data.skuId])).rows).toEqual([]);
        expect(await assess()).toMatchObject({ outcome: "blocked-input", reason: notReady });
        await stageProductRows(db, data);
        expect((await db.query("SELECT status FROM public.catalog_skus WHERE id=$1", [data.skuId])).rows).toEqual([{ status: "draft" }]);
        expect(await assess()).toMatchObject({ outcome: "blocked-input", reason: notReady });
        const approve = { ...draft.decision, candidateDigest, postStateText: seal, postStateDigest: postState.digest };
        const command = { schemaVersion: 2, action: "publish", productId: data.productId, commandKey: draft.commandKey,
          candidateRef: draft.candidateRef, candidateDigest, expectedHead: null, changes: [] };
        const fingerprint = hash(json([command, actorId]));
        await documentRow(db, { ...draft, fingerprint });
        await db.query("UPDATE public.catalog_products SET publication_facts=$2,status='active',variant_axes=$3,attribute_values=$4 WHERE id=$1",
          [data.productId, draft.product, draft.product.axes, draft.product.attributes]);
        await db.query(`UPDATE public.catalog_skus SET publication_facts=$2,status='active',sellable_standalone=true,
          option_values=$2::jsonb->'options',attribute_values=$2::jsonb->'attributes',
          combination_digest=decode($2::jsonb->>'optionDigest','hex'),net_content_dimension='mass',net_content_unit='openlup:g',
          net_content_unscaled=100,net_content_scale=0 WHERE id=$1`, [data.skuId, draft.facts]);
        const record = "SELECT public.catalog_publication_record_command($1) AS bytes";
        await db.query("SET LOCAL SESSION AUTHORIZATION openlup_catalog_publication");
        await db.query(record, [approve]);
        await db.query("RESET SESSION AUTHORIZATION");
        const { rows: [{ id: approvalId }] } = await db.query("SELECT id FROM public.catalog_publication_decisions WHERE product_id=$1", [data.productId]);
        const publish = { ...command, fingerprint, approvalId, product: draft.product, skus: [draft.facts] };
        const issue = async () => {
          await db.query("SET LOCAL SESSION AUTHORIZATION openlup_catalog_publication");
          const result = JSON.parse((await db.query(record, [publish])).rows[0].bytes);
          await db.query("RESET SESSION AUTHORIZATION");
          return result;
        };
        const effects = () => db.query(`SELECT
          (SELECT count(*)::int FROM public.price_entries WHERE variant_id=$1 AND mode='one_time') AS prices,
          (SELECT count(*)::int FROM public.catalog_price_setup_receipts WHERE idempotency_key=$2) AS receipts,
          (SELECT count(*)::int FROM public.catalog_publications WHERE product_id=$3) AS issues`, [data.skuId, edit.commandKey, data.productId]);
        const refusesIssue = async () => {
          await expect(issue()).rejects.toMatchObject({ code: "23514", constraint: notReady });
          await db.query("ROLLBACK TO SAVEPOINT price_proof; RELEASE SAVEPOINT price_proof");
          expect((await effects()).rows).toEqual([{ prices: 0, receipts: 0, issues: 0 }]);
        };
        await db.query("SAVEPOINT price_proof");
        await refusesIssue();
        await db.query(`INSERT INTO public.price_entries(variant_id,price_list_id,mode,unit_price_minor,valid_from)
          VALUES($1,$2,'subscription',100,'-infinity')`, [data.skuId, priceListId]);
        expect(await assess()).toMatchObject({ outcome: "pass" });
        await db.query(`SAVEPOINT price_proof;
          CREATE FUNCTION pg_temp.hide_subscription() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN UPDATE public.price_entries SET active=false WHERE variant_id=NEW.variant_id AND mode='subscription'; RETURN NEW; END $$;
          CREATE TRIGGER hide_subscription AFTER INSERT ON public.price_entries FOR EACH ROW
          WHEN (NEW.mode='one_time') EXECUTE FUNCTION pg_temp.hide_subscription()`);
        await refusesIssue();
        expect(await issue()).toMatchObject({ schemaVersion: 3, head: { revision: 1 } });
        expect((await effects()).rows).toEqual([{ prices: 1, receipts: 1, issues: 1 }]);
        return approvalId as string;
      });
      await transaction(owner, async db => {
        await db.query("SELECT set_config('request.jwt.claims',$1,true)", [actorClaims()]);
        const read = async () => {
          await db.query("SET LOCAL SESSION AUTHORIZATION openlup_catalog_publication");
          const result = await db.query("SELECT * FROM public.catalog_publication_lock_effective_base_price_v2($1,$2,$3)", [data.skuId, priceListId, approveId]);
          await db.query("RESET SESSION AUTHORIZATION");
          return result;
        };
        expect((await read()).rows).toEqual([{ id: expect.any(String), unit_price_minor: 120, amount_kind: "gross" }]);
        await db.query("SAVEPOINT missing_subscription");
        await db.query("UPDATE public.price_entries SET active=false WHERE variant_id=$1 AND mode='subscription'", [data.skuId]);
        await expect(read()).rejects.toMatchObject({ code: "23514", constraint: notReady });
        await db.query("ROLLBACK TO SAVEPOINT missing_subscription; RELEASE SAVEPOINT missing_subscription");
      });
    } finally { await store.close(); }
  });
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

function installedTokens(body: string, identity: string) {
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
  expect(comment, identity).toBe(0);
  return tokens;
}

function installedCalls(routine: InstalledRoutine, body: string, definitions: InstalledRoutine[]) {
  if (routine.language === "c" || routine.language === "internal") return [];
  // Strings and comments cannot masquerade as calls.
  const tokens = installedTokens(body, routine.identity);
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

function helperPolicySites(body: string, identity: string, ownerReasons: ReadonlySet<string>) {
  const tokens = installedTokens(body, identity);
  const replay: string[] = [];
  const refusals: string[] = [];
  for (const [index, token] of tokens.entries()) {
    const names = token.match(/[a-z_][a-z_0-9]*/gu) ?? [];
    const jsonLabel = tokens[index + 1] === "," && (tokens[index - 1] === "(" || tokens[index - 1] === ",");
    if (names.some(name => /replay|receipt[a-z_]*(?:observ|flag|status|state|lock|present|found|seen|exists|completed)|(?:observ|has|is|check)[a-z_]*receipt/iu.test(name))
      || (!jsonLabel && names.some(name => /^(?:p_|is_|already_)?(?:written|fresh|completed)$/u.test(name)))) {
      replay.push(tokens.slice(Math.max(0, index - 3), index + 4).join(" "));
    }
    if (token.startsWith("'") && names.some(name => ownerReasons.has(name))) {
      refusals.push(tokens.slice(Math.max(0, index - 1), index + 2).join(" "));
    }
  }
  return { replay, refusals };
}

type PolicySites = ReturnType<typeof helperPolicySites>;

function assertHelperPolicy(routine: InstalledRoutine, allowed: PolicySites, ownerReasons: ReadonlySet<string>) {
  const { identity } = routine;
  const actual = helperPolicySites(installedBody(routine), identity, ownerReasons);
  expect(actual.replay, `${identity} branches on replay or a receipt observation`).toEqual(allowed.replay);
  expect(actual.refusals, `${identity} selects or overrides an owner refusal`).toEqual(allowed.refusals);
}

function assertInstalledPriceGraph(definitions: InstalledRoutine[], predecessor: InstalledRoutine[]) {
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
  const ownerBody = installedBody(byIdentity.get(decisionIdentity)!);
  const ownerReasons = new Set(["price_operation_invalid", "expected_state_mismatch",
    ...Array.from(ownerBody.matchAll(/^\s*\('([a-z_]+)',/gmu), match => match[1]!)]);
  const predecessorByIdentity = new Map(predecessor.map(routine => [routine.identity, routine]));
  const claimedWriter = installedPriceEntries[3];
  const mutationIdentity = "public.catalog_price_setup_mutate_claimed(jsonb,timestamp with time zone,jsonb)";
  // Existing lanes retain their installed predecessors' behavior. The mutation
  // helper carries the standalone part of the former claimed writer.
  const helpers = [...graph.keys()].filter(identity => identity !== decisionIdentity
    && !installedPriceEntries.slice(0, 3).some(entry => identity === entry)).map(identity => {
    const routine = byIdentity.get(identity)!;
    const prior = predecessorByIdentity.get(identity === mutationIdentity ? claimedWriter : identity);
    return { routine, allowed: helperPolicySites(prior && identity !== claimedWriter ? installedBody(prior) : "", identity, ownerReasons) };
  });
  for (const { routine, allowed } of helpers) {
    assertHelperPolicy(routine, allowed, ownerReasons);
    if (routine.identity === landedIdentity) {
      expect([...graph].filter(([, node]) => node.calls.includes(routine.identity)).map(([caller]) => caller)).toEqual([decisionIdentity]);
    }
  }
  // Seal the reviewed code and its edges, including the decision owner and all
  // application helpers. An extra expression can change decisions without
  // changing any edge or reusing a known variable name.
  const reviewedGraph = [...graph].sort(([left], [right]) => left.localeCompare(right));
  expect(hash(JSON.stringify(reviewedGraph)), JSON.stringify(reviewedGraph)).toBe("a281543187a91e756a7251189379571d9e4aaad59f05158b7800fdf5e17ba12b");
  return { helpers, ownerReasons };
}

it("uses one installed builder and refusal selector across the publication price call graph", async () => {
  await withPriceUpgrade("bootstrap", recorderForward, "price-decision-structure", async (store, _fresh, upgrade) => {
      const predecessor = await installedRoutines(store.owner);
      await upgrade();
      const definitions = await installedRoutines(store.owner);
      const { helpers, ownerReasons } = assertInstalledPriceGraph(definitions, predecessor);
      await transaction(store.owner, async db => {
        for (const { routine, allowed } of helpers) {
          const { identity, definition, language } = routine;
          expect(["plpgsql", "sql"], identity).toContain(language);
          for (const [expression, violation] of [
            ["CASE WHEN ('{}'::jsonb->>'observeReplay')::boolean THEN 1 END", "branches on replay or a receipt observation"],
            ["CASE WHEN ('{}'::jsonb->>'receiptObservation')::boolean THEN 1 END", "branches on replay or a receipt observation"],
            ["CASE WHEN true THEN 'catalog_publication_price_changed' END", "selects or overrides an owner refusal"],
            ["jsonb_set('{}'::jsonb, '{reason}', to_jsonb('catalog_publication_price_changed'::text))", "selects or overrides an owner refusal"],
          ] as const) {
            const changed = language === "plpgsql"
              ? definition.replace(/^([ \t]*BEGIN)\b/imu, `$1\n  PERFORM ${expression};`)
              : definition.replace(/\nAS \$[a-z_0-9]*\$/iu, `$&\n  SELECT ${expression};`);
            expect(changed, identity).not.toBe(definition);
            await db.query("SAVEPOINT installed_helper_probe");
            await db.query(changed);
            const { rows: [installed] } = await db.query<{ definition: string }>(
              "SELECT pg_get_functiondef($1::regprocedure) AS definition", [identity]);
            expect(() => assertHelperPolicy({ ...routine, definition: installed!.definition }, allowed, ownerReasons), identity)
              .toThrow(violation);
            await db.query("ROLLBACK TO SAVEPOINT installed_helper_probe; RELEASE SAVEPOINT installed_helper_probe");
          }
        }
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
          expect(() => assertInstalledPriceGraph(mutated, predecessor), identity).toThrow();
          await db.query("ROLLBACK TO SAVEPOINT installed_decision_probe; RELEASE SAVEPOINT installed_decision_probe");
        }
      });
  });
}, postgresSetupTimeoutMs);

it.each(["legacy", "admin-managed", "bootstrap"] as const)("keeps the core SKU decision private across clean and upgraded %s installs", async profile => {
  const signatures = [decision, targetVerdict];
  await withPriceUpgrade(profile, coreModesForward, "core-price-authority", async (prior, fresh, upgrade) => {
    const assertAuthority = async (store: AccountMutationsStore) => {
      const { owner } = store;
      const { rows: [{ present }] } = await owner.query("SELECT to_regrole('openlup_catalog_publication') IS NOT NULL AS present");
      if (!present) await owner.query("CREATE ROLE openlup_catalog_publication LOGIN NOINHERIT");
      try {
        await assertDormant(store);
        expect((await owner.query(`SELECT r.rolname, signature FROM pg_catalog.pg_roles r
          CROSS JOIN unnest($1::text[]) f(signature)
          WHERE r.rolname IN ('openlup_catalog_publication','anon','authenticated','service_role')
            AND has_function_privilege(r.oid,signature::regprocedure,'EXECUTE')`, [signatures])).rows).toEqual([]);
        await transaction(owner, async db => {
          await db.query("SET LOCAL SESSION AUTHORIZATION openlup_catalog_publication");
          for (const sql of [
            "SELECT public.catalog_publication_decide_prices_v2(NULL,NULL,NULL,NULL,NULL,NULL)",
            "SELECT public.catalog_publication_target_price_verdict(NULL,NULL)",
          ]) {
            await db.query("SAVEPOINT private_price");
            await expect(db.query(sql)).rejects.toMatchObject({ code: "42501" });
            await db.query("ROLLBACK TO SAVEPOINT private_price; RELEASE SAVEPOINT private_price");
          }
        });
      } finally { if (!present) await owner.query("DROP ROLE openlup_catalog_publication"); }
    };
    for (const store of [prior, fresh]) await installPublicationActors(store.owner);
    const original = await routineAttributes(prior.owner, signatures);
    expect(original).toHaveLength(2);
    const contract = (all: InstalledRoutine[], identity: string) => {
      const routine = all.find(entry => entry.identity === identity)!;
      return { definition: routine.definition, calls: installedCalls(routine, installedBody(routine), all) };
    };
    const wrappers = [...installedPriceEntries, "public.catalog_price_setup_mutate_claimed(jsonb,timestamp with time zone,jsonb)"];
    const before = await installedRoutines(prior.owner);
    await assertAuthority(prior);
    await upgrade();
    for (const store of [prior, fresh]) {
      await assertAuthority(store);
      expect(await routineAttributes(store.owner, signatures)).toEqual(original);
      const after = await installedRoutines(store.owner);
      for (const identity of wrappers) expect(contract(after, identity)).toEqual(contract(before, identity));
      const owner = contract(after, decisionIdentity);
      expect(owner.calls).toContain(landedIdentity);
      expect(owner.definition).not.toBe(contract(before, decisionIdentity).definition);
      expect(contract(after, landedIdentity).definition).not.toBe(contract(before, landedIdentity).definition);
    }
  });
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
        [apply, applyV2, ...privateRoutines, targetVerdict, recorder, basisGate, validator])).toEqual([]);
      expect((await db.query("SELECT to_regclass('public.catalog_price_setup_receipts') AS receipts")).rows).toEqual([{ receipts: null }]);
    } finally { db.release(); }
  } finally { await closePostgres(managed, owner); }
}, postgresSetupTimeoutMs);
