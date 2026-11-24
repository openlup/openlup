import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createCatalogDraftHandlerV4, createPostgresCatalogDraftStoreV4, canonicalCatalogDraftJson } from "@openlup/platform/catalog";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions } from "../../server/adapters/postgres/qualifiedInstall.js";
import { hash, installPublicationActors, transaction, actorId } from "./catalogPublicationFixture.js";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs,
  postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";

const corpus = JSON.parse(readFileSync(new URL("../../packages/platform/test/fixtures/catalogPriceSetupV2.json", import.meta.url), "utf8"));
const priceV2Vectors: readonly [string, object, string?][] = corpus.vectors;
const priceDraft = (change: object = {}) => {
  const draft = structuredClone(corpus.draft);
  const price = Object.assign(draft.payload.skus[0].priceOperations[0], change);
  const context = draft.payload.publication.evidence.priceContext;
  context.amountBasis = price.expectedListAmountBasis;
  if (price.expectedListAmountBasis === "tax_inclusive") context.tax = null;
  return draft;
};

let container: PostgresContainer, owner: Pool, installer: Pool, runtime: Pool;
beforeAll(async () => {
  container = await runPostgresContainer({ name: `catalog-price-v2-${process.pid}`, password: randomUUID() });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Price Save proof needs PostgreSQL");
  owner = new Pool({ connectionString: container.connectionString });
  const installation = { generation: "qualified-v2", roleMode: "installer-managed", bootstrapLogin: "postgres",
    migrationLogin: "postgres", runtimeLogin: "price_runtime", restoreLogin: "price_restore" } as const;
  const password = randomUUID();
  for (const login of [installation.runtimeLogin, installation.restoreLogin]) await owner.query(`CREATE ROLE ${login}
    LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
  installer = new Pool({ connectionString: container.connectionString, options: qualifiedPostgresStartupOptions(installation) });
  await createPostgresMigrationRunner({ connectionString: container.connectionString }, { installation, poolFactory: () => installer }).apply();
  const url = new URL(container.connectionString);
  url.username = installation.runtimeLogin;
  url.password = password;
  runtime = new Pool({ connectionString: url.toString() });
  expect((await runtime.query("SELECT current_user, pg_has_role(current_user,'service_role','USAGE') AS inherits")).rows)
    .toEqual([{ current_user: installation.runtimeLogin, inherits: true }]);
  await installPublicationActors(owner);
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(container, [runtime, installer, owner].filter(Boolean)), postgresTeardownTimeoutMs);

async function save(db: Pool | PoolClient, text: string, fingerprint = hash(text), actor = actorId) {
  return (await db.query("SELECT public.catalog_draft_apply($1,$2,$3) AS result", [text, fingerprint, actor])).rows[0].result;
}
const rollback = Symbol("rollback proof");
async function isolated(work: (db: PoolClient) => Promise<void>) {
  await transaction(runtime, async db => { await work(db); throw rollback; }).catch(error => { if (error !== rollback) throw error; });
}

it.each(priceV2Vectors)("Save JSONB under the runtime login checks %s", async (_label, change, reason) => isolated(async db => {
  const command = priceDraft(change);
  const text = JSON.stringify(command, null, 1).replace('"minQty": 1', '"minQty": 1.0');
  expect(await save(db, text)).toMatchObject(reason ? { outcome: "validation_issue", reason } : {
    outcome: "committed", record: { payload: command.payload },
  });
}));

it("rejects missing, malformed and mismatched context and saves a corrected request", async () => isolated(async db => {
  const command = priceDraft(), expected = command.payload.publication.evidence.priceContext!;
  for (const evidence of [{}, { priceContext: { ...expected, currency: "usd" } },
    { priceContext: { ...expected, priceListId: randomUUID() } }]) {
    const payload = { ...command.payload, publication: { ...command.payload.publication, evidence } };
    expect(await save(db, JSON.stringify({ ...command, payload }))).toMatchObject({
      outcome: "validation_issue", reason: "command_invalid",
    });
  }
  const sku = command.payload.skus[0]!;
  sku.priceOperations.push(sku.priceOperations[0]!);
  expect(await save(db, JSON.stringify(command))).toMatchObject({ reason: "catalog_publication_price_key_reused" });
  sku.priceOperations.pop();
  expect(await save(db, JSON.stringify(priceDraft({ unitPriceMinor: 0 })))).toMatchObject({ reason: "money_amount_out_of_range" });
  expect(await save(db, JSON.stringify(priceDraft({ minQty: 2 })))).toMatchObject({ reason: "price_operation_invalid" });
  sku.priceOperations.push({ ...sku.priceOperations[0], commandKey: "unused-price-edit" });
  await expect(save(db, JSON.stringify(command))).resolves.toMatchObject({ outcome: "committed" });
  console.info("Save recovery: command_invalid, duplicate price key, amount range, wrong quantity → corrected v4 request → committed");
}));

it("retains the byte and SKU guards in PostgreSQL Save", async () => isolated(async db => {
  const command = priceDraft(), text = JSON.stringify(command), cap = 1_048_576;
  const bounded = text.padEnd(cap, " ");
  expect(await save(db, bounded + " ")).toMatchObject({ reason: "command_fingerprint_invalid" });
  const skus = Array.from({ length: 10_001 }, () => ({}));
  expect(await save(db, JSON.stringify({ ...command, payload: { ...command.payload, skus } }))).toMatchObject({ reason: "payload_invalid" });
  expect(await save(db, bounded)).toMatchObject({ outcome: "committed" });
}));

it("leaves legacy price lists null and admits only the two explicit bases", async () => {
  const insert = "INSERT INTO public.price_lists(name,region_code,currency";
  for (const basis of ["tax_exclusive", "tax_inclusive", null]) {
    const { rows } = basis === null ? await owner.query(insert + ") VALUES('Legacy','US','USD') RETURNING amount_basis")
      : await owner.query(insert + ",amount_basis) VALUES('Explicit','US','USD',$1) RETURNING amount_basis", [basis]);
    expect(rows).toEqual([{ amount_basis: basis }]);
  }
  await expect(owner.query(insert + ",amount_basis) VALUES('Invalid','US','USD','net')"))
    .rejects.toMatchObject({ constraint: "price_lists_basis_check" });
});

it("persists context in candidate identity and replays a v1 draft after a v2 revision", async () => {
  const legacy = corpus.legacy, next = { ...priceDraft(), action: "revise", commandKey: "revise", expectedRevision: 1 };
  const first = canonicalCatalogDraftJson(legacy), second = canonicalCatalogDraftJson(next);
  expect(await save(runtime, first)).toMatchObject({ outcome: "committed", record: { payload: legacy.payload } });
  const store = createPostgresCatalogDraftStoreV4(runtime);
  expect(await store.apply({ canonicalCommand: second, fingerprint: hash(second), actorId })).toMatchObject({ outcome: "committed" });
  expect(await store.get({ draftId: next.draftId, revision: 2 }, actorId)).toMatchObject({ payload: next.payload });
  const ref = `v1:${next.draftId}@2/unpublished`, product = next.payload.product;
  const digest = (payload: unknown) => hash(`["catalog-candidate",1,${canonicalCatalogDraftJson(payload)},${canonicalCatalogDraftJson([
    { ...product.type, definitionDigest: hash("synthetic installed definition") },
  ])},null]`);
  const lookup = (fingerprint: string) => owner.query("SELECT public.catalog_publication_candidate_source($1,$2,$3) AS payload",
    [product.id, ref, fingerprint]);
  expect((await lookup(digest(next.payload))).rows).toEqual([{ payload: next.payload }]);
  const changed = structuredClone(next.payload);
  changed.publication.evidence.priceContext!.tax!.classMapDigest = "b".repeat(64);
  await expect(lookup(digest(changed))).rejects.toMatchObject({ message: "catalog_publication_candidate_invalid" });
  expect(await save(runtime, first)).toMatchObject({ outcome: "replayed", record: { payload: legacy.payload } });
  expect(await save(runtime, second, hash(first))).toMatchObject({ reason: "command_fingerprint_invalid" });
  expect(await save(runtime, second, hash(second), randomUUID())).toMatchObject({ reason: "operator_mismatch" });
  const invalid = { ...next, payload: priceDraft({ unitPriceMinor: 0 }).payload };
  const handler = createCatalogDraftHandlerV4({ store, registry: { resolve: () => undefined },
    authorizeOperator: async (actor: string) => ({ actorId: actor }) });
  expect(await handler.execute(invalid, actorId)).toEqual({ outcome: "conflict", reason: "draft_command_key_reused" });
  expect(await handler.execute(invalid, randomUUID())).toEqual({ outcome: "unauthorized", reason: "draft_command_actor_mismatch" });
});
