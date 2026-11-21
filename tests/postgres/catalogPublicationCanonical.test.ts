import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { nativeCatalogPublication, type CatalogPublicationManifestV2 } from "@openlup/platform/catalog";
import { publicationWireVectors } from "@openlup/platform/catalog/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer,
  waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";
import { authoredPublicationDocument, fixture, graph, installPublicationActors, publicationDocumentAtDraftDepth,
  publicationDocuments, publicationManifestText, publishMaximumRoster, transaction } from "./catalogPublicationFixture.js";
import { installAccountMutations } from "./customerAccountMutations.fixture.js";

const original = "db/platform/migrations/20261123190000_catalog_publication.sql";
const forward = "db/platform/migrations/20261124160000_catalog_canonical_ascii_order.sql";
const perfForward = "db/platform/migrations/20261124170000_catalog_publication_commit_perf.sql";
const canonical = "public.catalog_publication_canonical";
const originalCanonical = "public.catalog_publication_canonical_before_ascii";
const pinnedPath = ["search_path=pg_catalog, public, pg_temp"];
const settingsSql = `SELECT session_user, proconfig FROM pg_catalog.pg_proc
  WHERE oid = '${canonical}(jsonb,integer)'::pg_catalog.regprocedure`;
let container: PostgresContainer;
let pool: Pool;

beforeAll(async () => {
  container = await runPostgresContainer({ name: `catalog-canonical-${process.pid}`, password: randomUUID() });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Canonical parity requires PostgreSQL");
  pool = new Pool({ connectionString: container.connectionString });
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as {
    baseline: { file: string }; forward: { file: string }[];
  };
  for (const { file } of [manifest.baseline, ...manifest.forward.filter(unit => unit.file < forward)]) {
    await pool.query(readFileSync(file, "utf8"));
  }
  const sql = readFileSync(original, "utf8");
  const start = sql.indexOf(`CREATE FUNCTION ${canonical}(`);
  const end = sql.indexOf("\n$$;", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  // Keep every byte of the original definition except the name and recursive calls.
  await pool.query(sql.slice(start, end + "\n$$;".length).replaceAll(`${canonical}(`, `${originalCanonical}(`));
  expect((await pool.query(settingsSql)).rows).toEqual([{ session_user: "postgres", proconfig: ["search_path=pg_catalog, public"] }]);
  await pool.query(readFileSync(forward, "utf8"));
  await pool.query(readFileSync(perfForward, "utf8"));
  await installPublicationActors(pool);
}, postgresSetupTimeoutMs);

afterAll(() => closePostgres(container, pool), postgresTeardownTimeoutMs);

async function expectByteParity(name: string, input: string, depth = 0) {
  const { rows: [row] } = await pool.query<{ actual: Buffer; original: Buffer }>(`SELECT
    pg_catalog.convert_to(${canonical}($1::jsonb, $2), 'UTF8') AS actual,
    pg_catalog.convert_to(${originalCanonical}($1::jsonb, $2), 'UTF8') AS original`, [input, depth]);
  expect(row?.actual.equals(row.original), name).toBe(true);
}

it("matches the original bytes for all publication document fixtures", async () => {
  const productSlugs = [
    ...Array.from({ length: 27 }, (_, index) => `article-${index + 1}`), "article-40",
    ...Array.from({ length: 5 }, (_, index) => `writer-${index + 1}`),
  ];
  const documents = {
    ...publicationDocuments,
    empty: {},
    presentation: { title: "Sample" },
    "draft depth 48": publicationDocumentAtDraftDepth(48),
    "draft depth 49": publicationDocumentAtDraftDepth(49),
    ...Object.fromEntries(productSlugs.map(slug => [slug, authoredPublicationDocument(slug)])),
  };
  for (const [name, document] of Object.entries(documents)) await expectByteParity(name, JSON.stringify(document));
});

it("matches the original bytes or refusal for every shared publication wire vector", async () => {
  const issue = await transaction(pool, db => graph(db, fixture()));
  const { SKU_PAGE_DEPTH: depth } = nativeCatalogPublication;
  const refusals = new Map([
    ["container at page depth 49", "22023"],
    ["NUL", "22P05"],
    ["unpaired surrogate", "22P02"],
  ]);
  for (const vector of publicationWireVectors) {
    const input = JSON.stringify(vector.apply(issue.facts));
    const refusal = refusals.get(vector.name);
    if (refusal) {
      for (const fn of [canonical, originalCanonical]) {
        await expect(pool.query(`SELECT ${fn}($1::jsonb, $2)`, [input, depth]), vector.name)
          .rejects.toMatchObject({ code: refusal });
      }
    } else {
      await expectByteParity(vector.name, vector.sqlNormalizesZero ? input.replace('"zero":0', '"zero":-0') : input, depth);
    }
  }
});

const asciiKeys = ["4294967295", "4294967294", "01", "10", "0", "z", "AA", "A", "a", "a!", "aa", "", "\n", '"', "\\", "\u007f"];
const unicodeKeys = ["é", "éa", "ß", "中", "😀", "😀a", "𝄞", "\uE000"];
const keyObject = (keys: readonly string[]) => Object.fromEntries(keys.map((key, index) => [key, index]));

it("matches the original bytes for ordering boundaries and 512 seeded random objects", async () => {
  const ascii = keyObject(asciiKeys);
  const unicode = keyObject(unicodeKeys);
  const mixed = { ...ascii, ...unicode };
  const deep = Array.from({ length: 47 }).reduce<unknown>((value, _, index) => index % 2 ? { é: value } : { a: value }, mixed);
  const examples = [{}, ascii, unicode, mixed, { "": [ascii, unicode], a: { é: ascii } }, deep];
  for (const [index, value] of examples.entries()) await expectByteParity(`ordering example ${index}`, JSON.stringify(value));

  let state = 0x4f70656e;
  const random = (limit: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor(state / 0x100000000 * limit);
  };
  for (let index = 0; index < 512; index++) {
    const keys = index % 2 ? [...asciiKeys, ...unicodeKeys] : asciiKeys;
    const value = Object.fromEntries(Array.from({ length: random(24) + 1 }, () => [
      keys[random(keys.length)]! + keys[random(keys.length)]!,
      [random(1000), { a: "é", aA: random(2) === 0 }],
    ]));
    await expectByteParity(`seeded object ${index}`, JSON.stringify(value));
  }
});

it("matches the original bytes for the sealed 10,000-SKU stress roster", async () => {
  const { latest } = await publishMaximumRoster(pool);
  const text = await publicationManifestText(pool, latest.head);
  expect((JSON.parse(text) as CatalogPublicationManifestV2).skus).toHaveLength(10_000);
  await expectByteParity("maximum inherited roster", text);
}, 600_000);

it("pins the legacy function's search path after applying the forward", async () => {
  expect((await pool.query(settingsSql)).rows).toEqual([{ session_user: "postgres", proconfig: pinnedPath }]);
});

it("keeps pg_temp last through the qualified-v2 publication login", async () => {
  const { owner, close } = await installAccountMutations("bootstrap", false, "catalog-canonical");
  const password = randomUUID();
  const url = new URL(owner.options.connectionString!);
  url.username = "openlup_catalog_publication";
  url.password = password;
  const publisher = new Pool({ connectionString: url.href, max: 1 });
  try {
    await owner.query(`ALTER ROLE openlup_catalog_publication PASSWORD '${password}'`);
    expect((await publisher.query(settingsSql)).rows).toEqual([{ session_user: "openlup_catalog_publication", proconfig: pinnedPath }]);
    expect((await publisher.query(`SELECT ${canonical}('{"b":2,"a":1}'::jsonb, 0) AS value`)).rows)
      .toEqual([{ value: '{"a":1,"b":2}' }]);
  } finally {
    try { await publisher.end(); } finally { await close(); }
  }
}, postgresSetupTimeoutMs);
