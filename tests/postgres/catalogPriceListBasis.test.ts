import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createCatalogDraftHandlerV4, canonicalCatalogDraftJson } from "@openlup/platform/catalog";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions } from "../../server/adapters/postgres/qualifiedInstall.js";
import { hash, installPublicationActors, actorId } from "./catalogPublicationFixture.js";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs,
  postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";

const sku = "10000000-0000-4000-8000-000000000001", product = "10000000-0000-4000-8000-000000000004";
const priceListId = "10000000-0000-4000-8000-000000000002";
const grossOperation = { schemaVersion: 1, commandKey: "legacy-price", variantId: sku, priceListId, mode: "one_time",
  minQty: 1, amountKind: "gross", unitPriceMinor: 1, expected: { entryId: null, unitPriceMinor: null } };
const basisOperation = { ...grossOperation, schemaVersion: 2, commandKey: "price-edit", amountKind: "net",
  expectedListAmountBasis: "tax_exclusive", expected: { entryId: null, unitPriceMinor: null, amountKind: null } };
const priceContext = { priceListId, regionCode: "US", currency: "USD", amountBasis: "tax_exclusive",
  tax: { market: "US", taxClassKey: "example:standard", classMapRevision: "1", classMapDigest: "a".repeat(64) } };
const draft = (draftId: string, operation: object = grossOperation, evidence: object = {}) => ({
  schemaVersion: 4, action: "create", draftId, commandKey: "save", expectedRevision: 0,
  payload: {
    schemaVersion: 4,
    product: { id: product, type: { key: "example:article", version: 1 }, dimensions: [], sharedContent: {
      schemaVersion: 1, catalogAction: "create", presentation: {}, offerMemberships: [], requestedModes: [], publicationSkus: [] } },
    skus: [{ id: sku, productId: product, options: {}, priceOperations: [operation] }],
    publication: { kind: "release", operations: [], evidence },
  },
});

let container: PostgresContainer, owner: Pool, installer: Pool, runtime: Pool;
beforeAll(async () => {
  container = await runPostgresContainer({ name: `catalog-price-basis-${process.pid}`, password: randomUUID() });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Price basis proof needs PostgreSQL");
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

async function save(command: object) {
  const text = canonicalCatalogDraftJson(command);
  return (await runtime.query("SELECT public.catalog_draft_apply($1,$2,$3) AS result", [text, hash(text), actorId])).rows[0].result;
}
const draftRows = async (draftId: string) => (await owner.query(`SELECT
  (SELECT count(*) FROM public.catalog_draft_heads WHERE draft_id=$1)::int AS heads,
  (SELECT count(*) FROM public.catalog_draft_revisions WHERE draft_id=$1)::int AS revisions,
  (SELECT count(*) FROM public.catalog_draft_command_receipts WHERE draft_id=$1)::int AS receipts`, [draftId])).rows[0];

it("adds a nullable list basis without a default and admits only the two explicit bases", async () => {
  expect((await owner.query(`SELECT data_type, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema='public' AND table_name='price_lists' AND column_name='amount_basis'`)).rows)
    .toEqual([{ data_type: "text", is_nullable: "YES", column_default: null }]);
  const insert = "INSERT INTO public.price_lists(name,region_code,currency";
  for (const basis of ["tax_exclusive", "tax_inclusive", null]) {
    const { rows } = basis === null ? await owner.query(insert + ") VALUES('Legacy','US','USD') RETURNING amount_basis")
      : await owner.query(insert + ",amount_basis) VALUES('Explicit','US','USD',$1) RETURNING amount_basis", [basis]);
    expect(rows).toEqual([{ amount_basis: basis }]);
  }
  await expect(owner.query(insert + ",amount_basis) VALUES('Invalid','US','USD','net')"))
    .rejects.toMatchObject({ constraint: "price_lists_basis_check" });
});

it("keeps refusing basis-aware price operations in PostgreSQL Save and leaves no draft state", async () => {
  const draftId = randomUUID();
  const { expectedListAmountBasis } = basisOperation;
  for (const [command, reason] of [
    [draft(draftId, basisOperation), "price_operation_invalid"],
    [draft(draftId, { ...grossOperation, expectedListAmountBasis }), "price_operation_invalid"],
    [draft(draftId, grossOperation, { priceContext }), "publication_inputs_invalid"],
  ] as const) {
    expect(await save(command)).toEqual({ outcome: "validation_issue", reason });
    expect(await draftRows(draftId)).toEqual({ heads: 0, revisions: 0, receipts: 0 });
  }
  const legacy = draft(draftId);
  expect(await save(legacy)).toMatchObject({ outcome: "committed", record: { payload: legacy.payload } });
  expect(await draftRows(draftId)).toEqual({ heads: 1, revisions: 1, receipts: 1 });
});

it("keeps refusing basis-aware price operations in TypeScript Save before the store", async () => {
  const touched: string[] = [];
  const store = new Proxy({}, { get: (_target, name) => () => { touched.push(String(name)); throw new Error("store reached"); } });
  const handler = createCatalogDraftHandlerV4({ store: store as never, registry: { resolve: () => undefined },
    authorizeOperator: async (actor: string) => ({ actorId: actor }) });
  expect(await handler.execute(draft(randomUUID(), basisOperation), actorId))
    .toEqual({ outcome: "validation_issue", reason: "draft_input_invalid" });
  expect(touched).toEqual([]);
});
