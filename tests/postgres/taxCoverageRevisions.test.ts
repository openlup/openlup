import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { canonicalCatalogDraftJson } from "@openlup/platform/catalog/contracts";
import { applyTaxCoverageRevision, bindTaxCoverageReader, describeTaxCoverageSetting, reconcileTaxCoverage } from "@openlup/platform/tax";
import { taxCoverageV1Schema, type TaxCoverageV1 } from "@openlup/platform/tax/contracts";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { captureStoreJourney, journeySelection, storeJourneyResources, type JourneyInstallation } from "../helpers/storeJourney.js";
import { coverageCorpus } from "./fixtures/taxCoverage/corpus.js";
import { showCoverageSetting } from "./fixtures/taxCoverage/settings.js";

const resources = storeJourneyResources();
const accountRef = "account-a", installationRef = "store-a", actorRef = "operator-a";
const scope = { accountRef, installationRef };
const appendSql = "SELECT * FROM public.tax_coverage_append_v1($1::jsonb)";
const readSql = "SELECT * FROM public.tax_coverage_read_v1($1,$2)";
const table = "public.tax_coverage_revisions";
const conflict = {
  kind: "refused", code: "tax_coverage_revision_conflict", field: "/expectedRevision",
  remedy: "Replay the original document or read the current head and submit a new revision.",
};
const invalid = (field: string) => ({ kind: "refused", code: "tax_invalid_input", field,
  remedy: "Supply the documented declaration or request shape." });
const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const proposal = (revision: string, expectedHead: string | null, declarations: TaxCoverageV1["declarations"] = [],
  selected = scope) => ({ expectedHead, document: { ...selected, actorRef,
    coverage: { schemaVersion: 1, accountRef: selected.accountRef, revision, declarations } as const } });

let source: JourneyInstallation, from: string, until: string;
beforeAll(async () => {
  source = await resources.installation("tax-coverage-source");
  const { rows } = await source.owner.query("SELECT date_trunc('milliseconds',now()) AS starts, date_trunc('milliseconds',now())+interval '1 day' AS ends");
  from = rows[0].starts.toISOString(); until = rows[0].ends.toISOString();
}, postgresSetupTimeoutMs);
afterAll(() => resources.close(), postgresTeardownTimeoutMs);

it("validates the same corpus and digest in TS and PostgreSQL", async () => {
  const [rule] = describeTaxCoverageSetting().rules;
  for (const [index, { value, field }] of coverageCorpus(from, until).entries()) {
    const parsed = taxCoverageV1Schema.safeParse(value);
    expect(rule.check(value), JSON.stringify(value)).toBe(field === undefined);
    const sql = source.owner.query("SELECT public.tax_coverage_validate($1) AS coverage", [JSON.stringify(value)]);
    if (field !== undefined) {
      expect(parsed).toMatchObject({ success: false, error: { code: rule.code, field } });
      await expect(sql).rejects.toMatchObject({ code: "22023", message: rule.code, detail: field });
    } else {
      expect(parsed).toMatchObject({ success: true, data: value });
      await expect(sql).resolves.toMatchObject({ rows: [{ coverage: value }] });
      if (!parsed.success) throw parsed.error;
      const coverage = parsed.data;
      const result = await applyTaxCoverageRevision(source.owner, { expectedHead: null,
        document: { installationRef: `corpus-${index}`, accountRef: coverage.accountRef, actorRef, coverage } });
      expect(result).toMatchObject({ coverage,
        coverage_digest: digest(canonicalCatalogDraftJson(["platform.tax.coverage-revision.v1", coverage])) });
    }
  }
});

async function race(left: ReturnType<typeof proposal>, right: ReturnType<typeof proposal>) {
  const blocker = await source.owner.connect(), a = await source.owner.connect(), b = await source.owner.connect();
  let results: Promise<PromiseSettledResult<Awaited<ReturnType<typeof applyTaxCoverageRevision>>>[]> | undefined;
  try {
    const pids = await Promise.all([a, b].map(async db => (await db.query("SELECT pg_backend_pid() AS pid")).rows[0].pid));
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array('openlup:tax-coverage:v1',$1::text,$2::text)::text,0))",
      [left.document.installationRef, left.document.accountRef]);
    results = Promise.allSettled([applyTaxCoverageRevision(a, left), applyTaxCoverageRevision(b, right)]);
    await expect.poll(async () => (await blocker.query(
      "SELECT count(*)::int AS waiting FROM pg_locks WHERE pid=ANY($1::integer[]) AND locktype='advisory' AND NOT granted",
      [pids])).rows[0].waiting).toBe(2);
  } finally {
    await blocker.query("ROLLBACK"); blocker.release();
    await results;
    a.release(); b.release();
  }
  return (await results!).map(result => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
}

it("coverage_revision_append_and_restore", async () => {
  const read = bindTaxCoverageReader(source.runtime, scope);
  const show = async () => (await showCoverageSetting(source.runtimeUrl, read)).body;
  const base = proposal("absence-control", null).document.coverage;
  const absent = await read();
  expect(absent).toEqual({ present: false });
  expect(await show()).toMatchObject({ observation: { state: "absent" } });
  const registered = { jurisdiction: "district-a", taxKind: "sale", status: "registered", actorRef, recordedAt: from, effective: { from } } as const;
  const virginScope = { ...scope, installationRef: "virgin-race" };
  const virgin = await race(proposal("virgin-a", null, [], virginScope), proposal("virgin-b", null, [], virginScope));
  expect(virgin.filter(result => "revision" in result)).toHaveLength(1);
  expect(virgin.filter(result => "code" in result)).toEqual([conflict]);
  const first = proposal("first", null, [registered]);
  const [a, b] = await race(first, first);
  expect(a).toMatchObject({ revision: "first", sequence_no: 1, actor_ref: actorRef, previous_revision: null });
  expect(b).toEqual(a);
  expect(await show()).toMatchObject({ observation: { state: "override", revision: "first", value: first.document.coverage } });
  expect(await applyTaxCoverageRevision(source.owner, proposal("different-first", null))).toEqual(conflict);
  expect(await applyTaxCoverageRevision(source.owner, proposal("revision", "unknown"))).toEqual(conflict);
  expect(await applyTaxCoverageRevision(source.owner, proposal("first", "first"))).toEqual(invalid("/coverage/revision"));
  expect(await applyTaxCoverageRevision(source.owner, proposal("overlap", "first", [registered, registered])))
    .toEqual(invalid("/coverage/declarations/1/effective"));
  const missingAck = { ...registered, status: "not_registered_acknowledged" } as TaxCoverageV1["declarations"][number];
  expect(await applyTaxCoverageRevision(source.owner, proposal("missing-ack", "first", [missingAck])))
    .toEqual(invalid("/coverage/declarations/0/acknowledgementRef"));

  const contenders = [proposal("second-a", "first"), proposal("second-b", "first")];
  const outcomes = await race(contenders[0], contenders[1]);
  const accepted = outcomes.findIndex(result => "revision" in result);
  expect(accepted).toBeGreaterThanOrEqual(0);
  expect(outcomes[1 - accepted]).toEqual(conflict);
  const head = contenders[accepted].document.coverage.revision;
  const prior = proposal("restore-prior", head, first.document.coverage.declarations);
  const empty = proposal("restore-undeclared", "restore-prior");
  const [rollback, sameRollback] = await race(prior, prior);
  expect(rollback).toMatchObject({ coverage: prior.document.coverage, sequence_no: 3 });
  expect(sameRollback).toEqual(rollback);
  expect(await applyTaxCoverageRevision(source.owner, empty)).toMatchObject({ coverage: empty.document.coverage, sequence_no: 4 });
  const restoredAbsence = await read();
  expect(restoredAbsence).toEqual({ present: true, revision: "restore-undeclared", value: empty.document.coverage });
  const reconcile = (coverage: TaxCoverageV1) => reconcileTaxCoverage({
    coverage, scope: { accountRef, adapter: "fixture-adapter", adapterVersion: "1", mode: "test" }, taxDate: from,
    required: [{ target: { kind: "line", key: "one" }, jurisdiction: "district-a", taxKind: "sale", level: "district", sourcing: "destination" }],
    observations: [],
  });
  expect(reconcile(absent.present ? absent.value : base)).toEqual(reconcile(restoredAbsence.present ? restoredAbsence.value : base));
  expect(reconcile(empty.document.coverage)).toMatchObject({
    code: "tax_coverage_undeclared", field: "/coverage/declarations", vector: [{ decision: "undeclared" }],
  });

  const freshSession = new Pool({ ...source.owner.options, max: 1 });
  try {
    expect(await applyTaxCoverageRevision(freshSession, first)).toEqual(a);
    const repeated = await applyTaxCoverageRevision(freshSession, contenders[accepted]);
    expect(repeated).toEqual(outcomes[accepted]);
  } finally { await freshSession.end(); }
  await expect(source.runtime.query(appendSql, ["{}"])).rejects.toMatchObject({ code: "42501" });
  await expect(source.runtime.query("SELECT public.tax_coverage_validate('{}')")).rejects.toMatchObject({ code: "42501" });
  await expect(source.runtime.query(`UPDATE ${table} SET actor_ref='operator-b'`)).rejects.toMatchObject({ code: "42501" });
  await expect(source.runtime.query(`SELECT * FROM ${table}`)).rejects.toMatchObject({ code: "42501" });
  expect(await bindTaxCoverageReader(source.runtime, { ...scope, accountRef: "other" })()).toEqual({ present: false });
  expect(await bindTaxCoverageReader(source.runtime, { ...scope, installationRef: "other" })()).toEqual({ present: false });
  const history = (await source.runtime.query(readSql, [installationRef, accountRef])).rows;
  expect(history.map(row => row.revision)).toEqual(["first", head, "restore-prior", "restore-undeclared"]);

  const target = await (await resources.targetTemplate("tax-coverage-target")).nextTarget();
  const [packet, freshTarget] = await Promise.all([
    captureStoreJourney(source.owner, "coverage-source"), captureStoreJourney(target.owner, "coverage-target"),
  ]);
  const restore = (captured = packet) => restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet: captured, freshTarget });
  const { sha256: _hash, ...body } = packet;
  const malformed = { ...body, owned: body.owned.filter(row => row.table !== "tax_coverage_revisions") };
  await expect(restore({ ...malformed, sha256: digest(JSON.stringify(malformed)) })).rejects.toMatchObject({ code: "invalid_input" });
  expect(await restore()).toMatchObject({ replayed: false });
  expect(await restore()).toMatchObject({ replayed: true });
  expect((await target.runtime.query(readSql, [installationRef, accountRef])).rows).toEqual(history);
  expect(await applyTaxCoverageRevision(target.owner, first)).toEqual(a);
  const targetPacket = await captureStoreJourney(target.owner, "coverage-target-populated");
  expect(targetPacket.owned.find(row => row.table === "tax_coverage_revisions"))
    .toEqual(packet.owned.find(row => row.table === "tax_coverage_revisions"));
}, postgresSetupTimeoutMs);

it("shows an installed setting through the CLI binding and refuses an unbound connected read", async () => {
  const exec = promisify(execFile);
  const scratch = join(process.cwd(), ".context", "scratch");
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, "coverage-settings-"));
  try {
    const app = join(directory, "settings.mjs");
    await writeFile(app, `import { bindTaxCoverageReader } from "@openlup/platform/tax";
export function createSettingsBindings({ db }) {
  return { readers: { "tax.coverage": bindTaxCoverageReader(db, { installationRef: "cli", accountRef: "account-a" }) } };
}
`);
    const cli = async (...args: string[]) => {
      try {
        const result = await exec(process.execPath, ["packages/platform/src/lifecycle/openlup.mjs", "settings", "show", "tax.coverage", "--json", ...args]);
        return { status: 0, body: JSON.parse(result.stdout) };
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === 74 && "stdout" in error && typeof error.stdout === "string")
          return { status: 74, body: JSON.parse(error.stdout) };
        throw new Error("Settings CLI could not run the synthetic coverage witness.");
      }
    };
    expect(await cli()).toMatchObject({ status: 0, body: { observation: { state: "offline" } } });
    const db = ["--database-url", source.runtimeUrl], bound = [...db, "--app", app];
    expect(await cli(...db)).toMatchObject({ status: 74, body: { refusal: { code: "commerce_setting_read_unavailable",
      remediation: { action: expect.stringContaining("Use a qualified native PostgreSQL installation") } } } });
    expect(await cli(...bound)).toMatchObject({ status: 0, body: { observation: { state: "absent" } } });
    await applyTaxCoverageRevision(source.owner, proposal("cli-first", null, [], { installationRef: "cli", accountRef }));
    expect(await cli(...bound)).toMatchObject({ status: 0, body: { observation: { state: "override", revision: "cli-first" } } });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
