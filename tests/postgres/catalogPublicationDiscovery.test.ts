import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { readPostgresCatalogActivationReadiness, readPostgresCatalogMembershipPage, type CatalogInstalledReadiness, type CatalogMembershipPageInput } from "@openlup/platform/catalog";
import { digestSubscriptionPricePolicy } from "@openlup/platform/pricing";
import { createPostgresCommercePriceAuthorityPort } from "../../server/adapters/postgres/pricingResolver.js";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";
import { documentRow, fixture, graph, hash, insertGraph, installPublicationActors, json, stageProductRows, transaction, type Graph } from "./catalogPublicationFixture.js";

const forward = "db/platform/migrations/20261123193000_catalog_publication_reads.sql";
const membershipSql = "SELECT public.catalog_offer_memberships_page($1,$2::jsonb,$3,$4) AS result";
const readinessSql = "SELECT public.catalog_publication_activation_readiness($1::text[],$2) AS result";
const filterOffer = "test:filter";
const emptyOffer = "test:known-empty";
const legacyCode = "legacy-only";
let container: PostgresContainer, pool: Pool;
const ownerLane = { run: <T>(work: (db: PoolClient) => Promise<T>) => transaction(pool, work) };

beforeAll(async () => {
  container = await runPostgresContainer({ name: `catalog-discovery-${process.pid}`, password: randomUUID() });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Catalogue discovery requires PostgreSQL");
  pool = new Pool({ connectionString: container.connectionString });
  await pool.query("CREATE ROLE service_role; CREATE ROLE unrelated");
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as { baseline: { file: string }; forward: { file: string }[] };
  const core = manifest.forward.findIndex(unit => unit.file === "db/platform/migrations/20261123190000_catalog_publication.sql");
  expect(core).toBeGreaterThanOrEqual(0);
  const prefix = [manifest.baseline, ...manifest.forward.slice(0, core + 1)];
  for (const { file } of prefix) await pool.query(readFileSync(file, "utf8"));
  await pool.query(readFileSync(forward, "utf8"));
  await installPublicationActors(pool);
  await pool.query(`INSERT INTO public.commerce_settings(key,value_text) VALUES ('settlement_region','ZZ'),('settlement_currency','XXX')
    ON CONFLICT (key) DO UPDATE SET value_text=excluded.value_text`);
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(container, pool), postgresTeardownTimeoutMs);

const fixedId = (index: number): ReturnType<typeof randomUUID> => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const byOffer = (offerVersion: string, mode: CatalogMembershipPageInput["mode"] = null) => ({ offerVersion, mode, limit: 1 });
async function headDigest(db = pool) {
  return (await db.query("SELECT public.catalog_publication_read_head() AS digest")).rows[0]!.digest as string;
}
async function page(input: CatalogMembershipPageInput, db: Pool | PoolClient = pool) {
  const value = await readPostgresCatalogMembershipPage(db, input);
  if ("outcome" in value) throw new Error(value.reason);
  return value;
}

async function seed(db: PoolClient, options: {
  code?: string; id?: ReturnType<typeof randomUUID>; offer?: string; admitted?: boolean; productActive?: boolean; skuActive?: boolean;
  oneTime?: boolean; subscription?: boolean; complete?: boolean; archived?: boolean;
} = {}) {
  const issue = await graph(db, { ...fixture(), ...(options.id ? { skuId: options.id } : {}), skuCode: options.code });
  issue.product.status = options.productActive === false ? "draft" : "active";
  issue.facts.status = options.archived ? "archived" : options.skuActive === false ? "draft" : "active";
  issue.facts.sellableStandalone = options.oneTime ?? true;
  issue.facts.sellableInSubscription = options.subscription ?? true;
  issue.facts.memberships = [{ offerVersion: options.offer ?? filterOffer, admitted: options.admitted ?? true }];
  if (options.complete) {
    issue.facts.grossMass = { ...issue.facts.netContent, unscaled: "120" };
    issue.facts.logisticsRef = "logistics:article";
    issue.facts.identifiers = [{ scheme: "gs1:gtin", value: "00012345600012", issuer: "gs1", packagingLevel: "unit", quantity: 1,
      isPrimary: true, label: null, sourceRef: null }];
    await db.query(`UPDATE public.catalog_skus SET gross_mass_dimension='mass',gross_mass_unit='openlup:g',gross_mass_unscaled=120,gross_mass_scale=0 WHERE id=$1`, [issue.skuId]);
  }
  await db.query("UPDATE public.catalog_products SET status=$2 WHERE id=$1", [issue.productId, issue.product.status]);
  await insertGraph(db, issue);
  return issue;
}

const binding: CatalogInstalledReadiness = db => ({
  registry: { resolve: ref => ({ ...ref, units: [{ code: "openlup:g", dimension: "mass", integral: true }],
    netContentUnits: ["openlup:g"], dimensions: [], validateContent: () => [] }) },
  channel: "D2C",
  prices: createPostgresCommercePriceAuthorityPort(db),
  assess: async () => ({ ready: true, reasons: [] }),
});
const readiness = (skuCodes: string[], expectedHeadDigest: string, bind = binding) =>
  readPostgresCatalogActivationReadiness(ownerLane, bind, { skuCodes, expectedHeadDigest });

it("distinguishes legacy, governed empty and unreadable authority, and refuses unknown offers and old heads", async () => {
  await transaction(pool, db => stageProductRows(db, fixture()));
  expect(await page(byOffer(emptyOffer))).toEqual({ protocol: "legacy", headDigest: null, items: [], nextCursor: null });
  expect(await readiness(["absent"], "f".repeat(64))).toMatchObject({ outcome: "unsupported", reason: "catalog_publication_not_adopted" });
  const denied = await transaction(pool, db => seed(db, { offer: emptyOffer, admitted: false }));
  expect(await page(byOffer(emptyOffer))).toEqual({ protocol: "governed", headDigest: await headDigest(), items: [], nextCursor: null });
  expect(await readPostgresCatalogMembershipPage(pool, byOffer("test:unknown"))).toMatchObject({ outcome: "validation_issue" });
  await transaction(pool, async db => {
    await db.query("SET LOCAL session_replication_role=replica");
    await db.query("DELETE FROM public.catalog_publication_heads WHERE product_id=$1", [denied.productId]);
    expect(await readPostgresCatalogMembershipPage(db, byOffer(emptyOffer))).toMatchObject({ outcome: "dependency_unavailable" });
    await db.query("ROLLBACK");
  });
  const staleOffer = "test:stale";
  await transaction(pool, async db => {
    await seed(db, { offer: staleOffer });
    await seed(db, { offer: staleOffer });
  });
  const previous = await page(byOffer(staleOffer));
  expect(previous.nextCursor).not.toBeNull();
  await transaction(pool, db => seed(db, { offer: "test:other-product" }));
  expect(await readPostgresCatalogMembershipPage(pool, { ...byOffer(staleOffer), cursor: previous.nextCursor }))
    .toMatchObject({ outcome: "conflict", reason: "catalog_publication_head_moved" });
});

it("commits prior caller work after a handled membership refusal", async () => {
  await transaction(pool, db => seed(db, { offer: "test:registered" }));
  await transaction(pool, async db => {
    await db.query("INSERT INTO public.commerce_settings(key,value_text) VALUES ('membership_caller_witness','retained')");
    expect(await readPostgresCatalogMembershipPage(db, byOffer("test:unknown"))).toMatchObject({ outcome: "validation_issue" });
  });
  expect((await pool.query("SELECT value_text FROM public.commerce_settings WHERE key='membership_caller_witness'")).rows)
    .toEqual([{ value_text: "retained" }]);
});

it("filters before limit for each mode and resolves evidence only for emitted rows", async () => {
  await transaction(pool, async db => {
    await seed(db, { id: fixedId(1), admitted: false });
    await seed(db, { id: fixedId(2), productActive: false });
    await seed(db, { id: fixedId(3), skuActive: false });
    await seed(db, { id: fixedId(4), oneTime: false });
    await seed(db, { id: fixedId(5), subscription: false });
    await seed(db, { id: fixedId(6) });
    await seed(db, { id: fixedId(7) });
  });
  await transaction(pool, async db => {
    await db.query("SET LOCAL track_functions='pl'");
    for (const [mode, first] of [["one_time", 5], ["subscription", 4], [null, 4]] as const) {
      const query = byOffer(filterOffer, mode);
      const firstPage = await page(query, db);
      expect(firstPage.items.map(item => item.skuId)).toEqual([fixedId(first)]);
      expect(firstPage.nextCursor).toMatchObject({ skuId: fixedId(first), offerVersion: filterOffer, mode });
      const rest = await page({ ...query, cursor: firstPage.nextCursor, limit: 2 }, db);
      expect(rest.items.map(item => item.skuId)).toEqual([fixedId(first === 4 && mode === null ? 5 : 6),
        fixedId(first === 4 && mode === null ? 6 : 7)]);
      expect(Boolean(rest.nextCursor)).toBe(mode === null);
    }
    const lookupCount = await db.query(`SELECT calls FROM pg_stat_xact_user_functions WHERE funcname='catalog_publication_selected_evidence'`);
    expect(lookupCount.rows.map(row => Number(row.calls))).toEqual([9]);
  });
});

it("rejects cross-offer and cross-mode cursors in adapter and SQL before authority", async () => {
  const cursorOffer = "test:cursor";
  const otherOffer = "test:cursor-other";
  await transaction(pool, async db => {
    await seed(db, { offer: cursorOffer });
    await seed(db, { offer: cursorOffer });
    await seed(db, { offer: otherOffer });
  });
  const original = await page(byOffer(cursorOffer, "one_time"));
  expect(original.nextCursor).not.toBeNull();
  for (const [offer, mode] of [[otherOffer, "one_time"], [cursorOffer, "subscription"]] as const) {
    const db = { query: vi.fn() };
    await expect(readPostgresCatalogMembershipPage(db, { ...byOffer(offer, mode), cursor: original.nextCursor })).resolves.toMatchObject({ outcome: "validation_issue" });
    expect(db.query).not.toHaveBeenCalled();
    await expect(pool.query(membershipSql, [offer, original.nextCursor, 1, mode])).rejects.toMatchObject({ code: "22023" });
  }
});

async function moveDocument(db: PoolClient, first: Graph) {
  const second = await graph(db, { productId: first.productId, skuId: first.skuId, draftId: first.draftId,
    skuCode: first.facts.code, documentId: randomUUID() }, first.head, false,
    { registerExisting: true, documentText: json({ label: "second document" }) });
  second.document.revisionNo = 2;
  second.product.status = first.product.status;
  const payload = (await db.query("SELECT payload FROM public.catalog_draft_revisions WHERE draft_id=$1 AND revision=2", [first.draftId])).rows[0]!.payload;
  payload.product.documentRevision = second.document;
  payload.publication.operations[0].revisionNo = 2;
  const fingerprint = hash(json(payload));
  second.source.fingerprint = fingerprint;
  second.candidateDigest = hash(json(["catalog-candidate", 1, payload, [{ ...second.product.type, definitionDigest: hash("synthetic installed definition") }], first.head]));
  second.decision.candidateDigest = second.candidateDigest;
  // The shared builder hardcodes document revision 1. Adapt only the saved
  // draft fixture before the unchanged Core-S issue admission runs.
  await db.query("SET LOCAL session_replication_role=replica");
  await db.query("UPDATE public.catalog_draft_revisions SET payload=$2,fingerprint=$3 WHERE draft_id=$1 AND revision=2", [first.draftId, payload, fingerprint]);
  await db.query("UPDATE public.catalog_draft_command_receipts SET fingerprint=$2 WHERE draft_id=$1 AND revision=2", [first.draftId, fingerprint]);
  await db.query("SET LOCAL session_replication_role=origin");
  await documentRow(db, second);
  const inherited = { skuId: first.skuId, revisionId: first.skuRevisionId, revision: 1, digest: hash(json(first.facts)) };
  await insertGraph(db, second, { inherit: inherited, existingDocument: true });
  return { second, inherited };
}

it("binds the new issue and document to the inherited SKU revision and refuses each damaged carrier", async () => {
  const ownOffer = "test:exact";
  const [first, { second, inherited }] = await transaction(pool, async db => {
    const first = await seed(db, { offer: ownOffer });
    return [first, await moveDocument(db, first)] as const;
  });
  expect((await page(byOffer(ownOffer))).items).toMatchObject([{ head: second.head, document: second.document, skuRevision: inherited }]);
  const expectedHead = await headDigest();
  const substituted = json({ ...first.facts, title: "Substituted article" });
  for (const [sql, args] of [
    ["UPDATE public.catalog_publications SET digest=repeat('1',64) WHERE id=$1", [second.issueId]],
    ["DELETE FROM public.catalog_operator_receipts WHERE publication_id=$1", [second.issueId]],
    ["UPDATE public.catalog_product_document_revisions SET document_payload='{}' WHERE id=$1", [second.documentId]],
    [`WITH replaced AS (UPDATE public.catalog_sku_revisions SET full_facts=$2,digest=$3 WHERE id=$1 RETURNING sku_id)
       UPDATE public.catalog_skus s SET publication_facts=$2::text::jsonb FROM replaced WHERE s.id=replaced.sku_id`,
    [first.skuRevisionId, substituted, hash(substituted)]],
  ] as const) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role=replica");
      await client.query(sql, [...args]);
      expect(await readPostgresCatalogMembershipPage(client, byOffer(ownOffer))).toMatchObject({ outcome: "dependency_unavailable" });
    } finally { await client.query("ROLLBACK"); client.release(); }
  }
  expect(await readiness([first.facts.code], expectedHead)).toMatchObject({ items: [{ evidence: { head: second.head, document: second.document, skuRevision: inherited } }] });
});

it("preserves ordered present and absent subjects and validates bounded native batches", async () => {
  const a = await transaction(pool, db => seed(db, { code: "sample-200", offer: "test:ordered", productActive: false, skuActive: false, oneTime: false, subscription: false }));
  const z = await transaction(pool, db => seed(db, { code: "Z.sample-800", offer: "test:ordered", archived: true, oneTime: false, subscription: false }));
  await transaction(pool, db => stageProductRows(db, { ...fixture(), skuCode: legacyCode }));
  const expected = await headDigest();
  const missing = { skuCode: "Sample-200", skuId: null, logisticsRef: null, evidence: null, ready: false, reasons: ["sku_not_materialized"] };
  const instants: string[] = [];
  const result = await readiness([z.facts.code, missing.skuCode, a.facts.code, legacyCode], expected, db => ({ ...binding(db),
    assess: async (_, context) => {
      instants.push(context.atTime);
      return { ready: true, reasons: [] };
    },
  }));
  expect(result).toMatchObject({ headDigest: expected, items: [
    { skuCode: z.facts.code, skuId: z.skuId, reasons: expect.arrayContaining(["sku_archived"]) }, missing,
    { skuCode: a.facts.code, skuId: a.skuId }, { ...missing, skuCode: legacyCode },
  ] });
  expect(instants).toHaveLength(2);
  expect(instants[0]).toBe(instants[1]);
  const hundred = Array.from({ length: 100 }, (_, i) => `absent-${i}`);
  expect(await readiness([missing.skuCode], expected)).toEqual({ protocol: "governed", headDigest: expected, items: [missing] });
  expect(await readiness(hundred, expected)).toMatchObject({ items: hundred.map(skuCode => ({ ...missing, skuCode })) });
  for (const codes of [[], [...hundred, "extra"], ["dupe", "dupe"], ["invalid code"], [null], [["x", "y"]]]) {
    await expect(pool.query(readinessSql, [codes, expected])).rejects.toMatchObject({ code: "22023" });
    expect(await readiness(codes as string[], expected)).toMatchObject({ outcome: "validation_issue" });
  }
  await expect(pool.query(readinessSql, [["valid"], "A".repeat(64)])).rejects.toMatchObject({ code: "22023" });
});

it("rolls back writes from a failed installed price observation", async () => {
  const subject = await transaction(pool, db => seed(db));
  const result = await readiness([subject.facts.code], await headDigest(), db => ({ ...binding(db),
    prices: { resolvePrice: async () => {
      await db.query("INSERT INTO public.commerce_settings(key,value_text) VALUES ('readiness_rollback_witness','discarded')");
      throw new Error("installed observation unavailable");
    } },
  }));
  expect(result).toMatchObject({ outcome: "dependency_unavailable" });
  expect((await pool.query("SELECT value_text FROM public.commerce_settings WHERE key='readiness_rollback_witness'")).rows).toEqual([]);
});

it("preserves a retryable serialization failure during installed assessment", async () => {
  const subject = await transaction(pool, db => seed(db));
  const result = await readiness([subject.facts.code], await headDigest(), db => ({ ...binding(db),
    assess: async () => {
      await db.query("DO $$ BEGIN RAISE EXCEPTION 'serialization witness' USING ERRCODE='40001'; END $$");
      return { ready: true, reasons: [] };
    },
  }));
  expect(result).toMatchObject({ outcome: "conflict", reason: "catalog_publication_transaction_conflict", retryable: true });
});

it("deduplicates repeated installed and intrinsic reasons in first-occurrence order", async () => {
  const subject = await transaction(pool, db => seed(db));
  const result = await readiness([subject.facts.code], await headDigest(), db => ({ ...binding(db),
    assess: async () => ({ ready: false, reasons: ["first_gate", "unit_gtin_missing", "first_gate", "second_gate"] }),
  }));
  expect(result).toMatchObject({ items: [{ ready: false, reasons: ["logistics_reference_missing", "unit_gtin_missing",
    "catalog_publication_gross_mass_required", "price_readiness_missing", "first_gate", "second_gate"] }] });
});

it("refuses a missing live code that the sealed head still selects", async () => {
  const subject = await transaction(pool, db => seed(db, { code: "sealed-code" }));
  const expected = await headDigest();
  await transaction(pool, async db => {
    await db.query("SET LOCAL session_replication_role=replica");
    await db.query("UPDATE public.catalog_skus SET sku='changed-live-code',publication_facts=NULL WHERE id=$1", [subject.skuId]);
  });
  expect(await headDigest()).toBe(expected);
  expect(await readiness([subject.facts.code], expected)).toMatchObject({ outcome: "dependency_unavailable" });
});

it("assesses stored and policy-derived prices and preserves installed reason order on one executor", async () => {
  const { skuId, facts } = await transaction(pool, db => seed(db, { offer: "test:priced", complete: true, subscription: false }));
  const list = randomUUID(), expected = await headDigest();
  const start = "2000-01-01T00:00:00.000Z";
  await pool.query("INSERT INTO public.price_lists(id,name,region_code,currency,valid_from) VALUES($1,'Discovery tests','ZZ','XXX',$2)", [list, start]);
  await pool.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,min_qty,unit_price_minor,amount_kind,valid_from)
    VALUES($1,$2,'one_time',1,1000,'gross',$3),($1,$2,'subscription',1,875,'gross',$3)`, [list, skuId, start]);
  const resolutions: { kind: string; unitPriceMinor: number }[] = [];
  const instants: string[] = [];
  const bind: CatalogInstalledReadiness = vi.fn(db => {
    const current = binding(db);
    return { ...current, prices: { resolvePrice: async query => {
      instants.push(query.atTime!);
      const result = await current.prices.resolvePrice(query);
      resolutions.push(result);
      return result;
    } }, assess: async (_, context) => {
      instants.push(context.atTime);
      expect((await db.query("SELECT current_setting('transaction_isolation') AS isolation")).rows).toEqual([{ isolation: "repeatable read" }]);
      return { ready: false, reasons: ["installed_gate", "second_gate"] };
    } };
  });
  expect(await readiness([facts.code], expected, bind)).toMatchObject({ items: [{ ready: false, reasons: ["installed_gate", "second_gate"] }] });
  expect(resolutions.at(-1)).toMatchObject({ kind: "subscription_legacy", unitPriceMinor: 875 });
  for (const overrides of [{ variantId: randomUUID() }, { priceListId: randomUUID() }, { resolvedAt: start }]) {
    const wrongSubject = await readiness([facts.code], expected, db => {
      const installed = binding(db);
      return { ...installed, prices: { resolvePrice: async query => {
        const money = await installed.prices.resolvePrice(query);
        return { ...money, base: { ...money.base, ...overrides } };
      } } };
    });
    expect(wrongSubject).toMatchObject({ outcome: "dependency_unavailable" });
  }
  const policy = { id: randomUUID(), revisionNo: 1, priceListId: list, regionCode: "ZZ", currency: "XXX", channel: "D2C",
    effectiveFrom: start, effectiveTo: null, discountBps: 1000, roundingQuantumMinor: 10, roundingRule: "FLOOR_TO_QUANTUM" as const };
  await pool.query(`INSERT INTO public.subscription_price_policy_revisions(id,revision_no,price_list_id,region_code,currency,channel,
    effective_from,discount_bps,rounding_quantum_minor,rounding_rule,digest) VALUES($1,1,$2,'ZZ','XXX','D2C',$3,1000,10,'FLOOR_TO_QUANTUM',$4)`,
  [policy.id, list, start, await digestSubscriptionPricePolicy(policy)]);
  expect(await readiness([facts.code], expected)).toMatchObject({ items: [{ ready: false, reasons: ["price_readiness_missing"] }] });
  expect(await readiness([facts.code], expected, bind)).toMatchObject({ items: [{ reasons: ["price_readiness_missing", "installed_gate", "second_gate"] }] });
  expect(resolutions.at(-1)).toMatchObject({ kind: "subscription_policy", unitPriceMinor: 900 });
  await pool.query("UPDATE public.price_entries SET active=false WHERE variant_id=$1 AND mode='subscription'", [skuId]);
  expect(await readiness([facts.code], expected)).toMatchObject({ items: [{ ready: true, reasons: [] }] });
  expect(instants[0]).toEqual(instants[1]);
  expect(instants[2]).toEqual(instants[3]);

  await pool.query(`UPDATE public.price_entries SET active=false WHERE variant_id=$1 AND mode='one_time'`, [skuId]);
  await pool.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,min_qty,unit_price_minor,amount_kind,valid_from)
    VALUES($1,$2,'any',2,1000,'net',$3)`, [list, skuId, start]);
  expect(await readiness([facts.code], expected)).toMatchObject({
    items: [{ ready: false, reasons: ["price_readiness_missing", "price_shape_invalid"] }],
  });
  const assess = vi.fn(async () => ({ ready: false, reasons: ["price_shape_invalid", "installed_gate"] }));
  expect(await readiness([facts.code], expected, db => ({ ...binding(db), assess }))).toMatchObject({
    items: [{ ready: false, reasons: ["price_readiness_missing", "price_shape_invalid", "installed_gate"] }],
  });
  for (const unavailable of [() => Promise.reject(new Error("offline")), async () => ({ ready: true, reasons: ["contradiction"] })]) {
    expect(await readiness([facts.code], expected, db => ({ ...binding(db), assess: unavailable }))).toMatchObject({ outcome: "dependency_unavailable" });
  }
});

it("admits only the service and owner calls and keeps helpers and the ledger owner-only", async () => {
  const roleOffer = "test:grants";
  const admitted = await transaction(pool, db => seed(db, { offer: roleOffer }));
  const expected = await headDigest();
  const lookup = [
    [membershipSql, [roleOffer, null, 1, null]],
    [readinessSql, [[admitted.facts.code], expected]],
  ] as const;
  for (const role of ["unrelated", "anon", "authenticated", "service_role", "postgres"]) {
    for (const [sql, args] of lookup) {
      const run = transaction(pool, async db => {
        await db.query(`SET LOCAL ROLE ${role}`);
        return db.query(sql, [...args]);
      });
      if (role === "service_role" || role === "postgres") await expect(run).resolves.toMatchObject({ rowCount: 1 });
      else await expect(run).rejects.toMatchObject({ code: "42501" });
    }
    if (role !== "postgres") for (const [name, args] of [
      ["catalog_publication_read_head", []], ["catalog_publication_selected_evidence", [admitted.productId, admitted.skuId]],
    ] as const) await expect(transaction(pool, async db => {
      await db.query(`SET LOCAL ROLE ${role}`);
      await db.query(`SELECT public.${name}(${args.length ? "$1,$2" : ""})`, [...args]);
    })).rejects.toMatchObject({ code: "42501", message: `permission denied for function ${name}` });
    if (role !== "postgres") for (const sql of [
      "SELECT * FROM public.catalog_publications LIMIT 1",
      "SELECT * FROM public.catalog_publication_heads LIMIT 1",
      "SELECT * FROM public.catalog_sku_revisions LIMIT 1",
      "SELECT * FROM public.catalog_operator_receipts LIMIT 1",
    ]) await expect(transaction(pool, async db => {
      await db.query(`SET LOCAL ROLE ${role}`);
      await db.query(sql);
    })).rejects.toMatchObject({ code: "42501" });
  }
});

it("takes the owner snapshot after a synthetic publisher releases the writer fence", async () => {
  const expected = await headDigest();
  const writer = await pool.connect();
  const binder = vi.fn(binding);
  let reader: ReturnType<typeof readiness> | undefined;
  try {
    await writer.query("BEGIN");
    await writer.query("LOCK TABLE public.catalog_products IN SHARE ROW EXCLUSIVE MODE");
    const issued = await seed(writer, { offer: "test:fence", code: "test-waiting-sku" });
    let readerPid = 0;
    reader = readPostgresCatalogActivationReadiness({ run: work => transaction(pool, db => {
      readerPid = (db as PoolClient & { processID: number }).processID;
      return work(db);
    }) }, binder, { skuCodes: [issued.facts.code], expectedHeadDigest: expected });
    await expect.poll(async () => (await pool.query(`SELECT granted FROM pg_catalog.pg_locks
      WHERE pid=$1 AND relation='public.catalog_products'::regclass AND mode='ShareLock'`, [readerPid])).rows,
    { timeout: 3000 }).toEqual([{ granted: false }]);
    await writer.query("COMMIT");
    expect(await reader).toMatchObject({ outcome: "conflict", reason: "catalog_publication_head_moved" });
    expect(binder).not.toHaveBeenCalled();
  } finally { await writer.query("ROLLBACK"); writer.release(); await reader; }
});
