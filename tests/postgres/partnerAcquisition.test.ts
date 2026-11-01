import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PartnerAcquisitionCase, PartnerAcquisitionPort, PartnerAcquisitionResult } from "@openlup/platform/marketing/contracts";
import { assertConsumerIsolation, platformConsumerInstallArgs } from "../../scripts/packages/platform-cold-consumer.js";
import { evaluateSelectedPlatformMigrationManifest, readPlatformMigrationManifest, readPlatformMigrations, selectPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { readSelectedCatalogProjection, selectedCatalogProjectionPayload } from "../../server/adapters/postgres/selectedCatalogProjection.js";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

// Frozen R1 behavior witness. R2 keeps these expectations unchanged. These are
// synthetic public cases authored here, without an adopter fixture or SQL copy.
// The host establishes administrator membership; an actor UUID alone does not.
const ACTOR = "10000000-0000-4000-8000-000000000018";
const OTHER_ACTOR = "10000000-0000-4000-8000-000000000019";
const AT = "2026-01-12T10:00:00.000Z";
const SUBMIT_SIGNATURE = "public.partner_acquisition_submit_v1(text,text,text,text,text,text,text,text,text,text,text,timestamptz)";
const LIST_SIGNATURE = "public.partner_acquisition_operator_list_v1(uuid,timestamptz,uuid,integer)";
const TRANSITION_SIGNATURE = "public.partner_acquisition_transition_v1(uuid,text,bigint,text,text,timestamptz)";
let container: PostgresContainer | undefined, admin: Pool, runtime: Pool, port: PartnerAcquisitionPort;
let scratch: string, consumer: string, connectionString: string;
let adapters: typeof import("@openlup/platform/marketing/server/postgres");
const owned: PartnerAcquisitionPort[] = [];
let sequence = 0;
const npm = (args: string[], cwd: string) => execFileSync("npm", args, { cwd, stdio: "pipe", timeout: 120_000 }).toString();
function freshPort() {
  const value = adapters.createPostgresPartnerAcquisitionPort({ connectionString });
  owned.push(value); return value;
}
function command(label: string, delta: Partial<Parameters<PartnerAcquisitionPort["submit"]>[0]> = {}) {
  const unique = `${label}-${++sequence}`;
  return { idempotencyKey: `partner-${unique}`, requesterKey: `requester-${unique}`, policyVersion: "privacy-v1",
    sourcePath: "/partners/b2b-inquiries" as const, acceptedAt: AT,
    request: { company: " North \n Studio ", country: " gb ", firstName: " Ada ", lastName: " Vale ",
      email: `${unique}@studio.example`, phone: "+44 (20) 1234-5678", notes: " Distinct\n sample note " }, ...delta };
}
function value<T>(result: PartnerAcquisitionResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`partner proof failed: ${result.error.kind}`);
  return result.value;
}
async function capture(label: string) { const input = command(label); return { input, row: value(await port.submit(input)) }; }
function transition(row: PartnerAcquisitionCase, status: Parameters<PartnerAcquisitionPort["transition"]>[0]["request"]["status"], key = `partner-transition-${++sequence}`) {
  return { actorRef: ACTOR, idempotencyKey: key, request: { id: row.caseRef, expectedVersion: row.version, status } };
}
async function counts(caseRef?: string) {
  return (await admin.query(`SELECT
    (SELECT count(*)::int FROM acquisition_private.cases WHERE ($1::text IS NULL OR case_reference=$1)) cases,
    (SELECT count(*)::int FROM acquisition_private.contacts x JOIN acquisition_private.cases c ON c.id=x.case_id WHERE ($1::text IS NULL OR c.case_reference=$1)) contacts,
    (SELECT count(*)::int FROM acquisition_private.partner_details x JOIN acquisition_private.cases c ON c.id=x.case_id WHERE ($1::text IS NULL OR c.case_reference=$1)) details,
    (SELECT count(*)::int FROM acquisition_private.commands x JOIN acquisition_private.cases c ON c.id=x.case_id WHERE ($1::text IS NULL OR c.case_reference=$1)) commands,
    (SELECT count(*)::int FROM acquisition_private.audit x JOIN acquisition_private.cases c ON c.id=x.case_id WHERE ($1::text IS NULL OR c.case_reference=$1)) audit`, [caseRef ?? null])).rows[0];
}
async function asRuntime(sql: string, args: unknown[] = []) {
  const db = await runtime.connect();
  try { await db.query("BEGIN"); await db.query("SET LOCAL ROLE platform_acquisition_runtime"); const result = await db.query(sql, args); await db.query("COMMIT"); return result.rows; }
  catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
}

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("partner acquisition: Docker unavailable; mandatory PostgreSQL proof missing");
  scratch = mkdtempSync(join(tmpdir(), "partner-packed-"));
  const tarballs = ["packages/core", "packages/platform", "node_modules/zod"].map(directory => {
    const packed = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", scratch], resolve(directory)));
    return join(scratch, packed[0].filename);
  });
  consumer = join(scratch, "consumer"); mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), '{"type":"module","private":true}');
  npm(platformConsumerInstallArgs(tarballs), consumer);
  assertConsumerIsolation(consumer, process.cwd());
  // Missing-driver refusal and CSP-safe cold parsing are already shared cold
  // consumer bodies. Select only the existing pg peer for the real DB phase.
  const peerArgs = ["pg", "@types/pg", "@types/node"].map(name => {
    const metadata = JSON.parse(readFileSync(`node_modules/${name}/package.json`, "utf8")); return `${name}@${metadata.version}`;
  });
  npm(platformConsumerInstallArgs(peerArgs, true), consumer);
  assertConsumerIsolation(consumer, process.cwd(), false);
  const installedResolve = createRequire(join(consumer, "package.json")).resolve;
  adapters = await import(pathToFileURL(installedResolve("@openlup/platform/marketing/server/postgres")).href);
  const migrations = await import(pathToFileURL(installedResolve("@openlup/platform/migrations")).href) as typeof import("@openlup/platform/migrations");
  container = await runPostgresContainer({ name: `partner-acquisition-${process.pid}`, password: "partner-synthetic-proof" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("partner PostgreSQL TCP readiness deadline exceeded");
  admin = new Pool({ connectionString: container.connectionString });
  const raw = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest;
  const manifest = selectPlatformMigrationManifest(raw, "legacy"), catalog = readPlatformMigrations(process.cwd());
  const selected = [manifest.baseline, ...manifest.forward], selectedPaths = new Set(selected.map(unit => unit.file));
  const runner = migrations.createPostgresMigrationRunner({ connectionString: container.connectionString }, {
    lockName: "openlup:public-platform-migrations:v1", poolFactory: () => admin,
    source: { readManifest: () => manifest,
      readMigrations: () => ({ errors: catalog.errors, migrations: catalog.migrations.filter(unit => selectedPaths.has(unit.file)) }),
      evaluate: input => evaluateSelectedPlatformMigrationManifest(input, "legacy") },
    catalogProjectionPayload: async db => selectedCatalogProjectionPayload(await readSelectedCatalogProjection(db)),
  });
  expect((await runner.apply()).applied).toEqual(selected.map(unit => unit.file));
  expect(await runner.status()).toEqual({ applied: selected.map(unit => unit.file), pending: [] });
  expect(selected.filter(unit => /partner_acquisition/.test(unit.file))).toHaveLength(4);
  await admin.query(`CREATE ROLE partner_test_login LOGIN PASSWORD 'partner-synthetic-proof'
    NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT platform_acquisition_runtime TO partner_test_login WITH INHERIT FALSE, SET TRUE, ADMIN FALSE`);
  const url = new URL(container.connectionString); url.username = "partner_test_login";
  connectionString = url.toString(); runtime = new Pool({ connectionString }); port = freshPort();
}, postgresSetupTimeoutMs);

afterAll(async () => {
  await closePostgres(container, [runtime, admin], owned.map(value => () => value.close()));
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}, postgresTeardownTimeoutMs);

describe("partner acquisition: installed default factory, current native catalogue", () => {
  it("01: compiles supported exports in NodeNext/Bundler and enforces restricted runtime/browser authority", async () => {
    const program = `import { partnerAcquisitionListRequestSchema, partnersB2BInquirySubmitRequestSchema } from "@openlup/platform/marketing";
import type { PartnerAcquisitionPort, PartnerAcquisitionListRequest, PartnersB2BInquirySubmitRequest } from "@openlup/platform/marketing/contracts";
import { createPostgresPartnerAcquisitionPort } from "@openlup/platform/marketing/server/postgres";
const request: PartnersB2BInquirySubmitRequest = partnersB2BInquirySubmitRequestSchema.parse({company:"North Studio",country:"GB",firstName:"Ada",lastName:"Vale",email:"ada@studio.example"});
const list: PartnerAcquisitionListRequest = partnerAcquisitionListRequestSchema.parse({view:"partner_acquisition_v1"});
const factory: (env: {connectionString: string}) => PartnerAcquisitionPort = createPostgresPartnerAcquisitionPort;
export {request,list,factory};`;
    writeFileSync(join(consumer, "consumer.mts"), program);
    const compiler = createRequire(import.meta.url).resolve("typescript/bin/tsc");
    for (const mode of ["NodeNext", "Bundler"]) {
      const config = join(consumer, `tsconfig.${mode}.json`);
      writeFileSync(config, JSON.stringify({ compilerOptions: { target: "ES2022", module: mode === "NodeNext" ? "NodeNext" : "ESNext", moduleResolution: mode,
        strict: true, skipLibCheck: false, noEmit: true, types: ["node"], typeRoots: [join(consumer, "node_modules/@types")] }, files: ["consumer.mts"] }));
      execFileSync(process.execPath, [compiler, "--project", config], { cwd: consumer, stdio: "pipe", timeout: 120_000 });
    }
    expect(await asRuntime(`SELECT current_user,session_user,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) superuser,
      (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) bypassrls`)).toEqual([{ current_user: "platform_acquisition_runtime", session_user: "partner_test_login", superuser: false, bypassrls: false }]);
    for (const sql of ["SELECT * FROM acquisition_private.cases", "SELECT * FROM acquisition_private.contacts", "SELECT * FROM acquisition_private.partner_details", "SELECT * FROM acquisition_private.installation_key", "SELECT * FROM acquisition_private.commands", "SELECT * FROM acquisition_private.audit", "DELETE FROM acquisition_private.audit"])
      await expect(asRuntime(sql)).rejects.toMatchObject({ code: "42501" });
    for (const signature of [SUBMIT_SIGNATURE, LIST_SIGNATURE, TRANSITION_SIGNATURE]) {
      expect((await admin.query(`SELECT has_function_privilege('anon',$1,'EXECUTE') anon,
        has_function_privilege('authenticated',$1,'EXECUTE') authenticated,has_function_privilege('platform_acquisition_runtime',$1,'EXECUTE') runtime`, [signature])).rows)
        .toEqual([{ anon: false, authenticated: false, runtime: true }]);
    }
    for (const role of ["anon", "authenticated"]) {
      for (const sql of ["SELECT public.partner_acquisition_submit_v1(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)",
        "SELECT public.partner_acquisition_operator_list_v1(NULL,NULL,NULL,NULL)",
        "SELECT public.partner_acquisition_transition_v1(NULL,NULL,NULL,NULL,NULL,NULL)"]) {
        const browser = await admin.connect();
        try { await browser.query("BEGIN"); await browser.query(`SET LOCAL ROLE ${role}`);
          await expect(browser.query(sql)).rejects.toMatchObject({ code: "42501" });
        } finally { await browser.query("ROLLBACK"); browser.release(); }
      }
    }
    const input = command("revoked"), before = await counts();
    await admin.query(`REVOKE EXECUTE ON FUNCTION ${SUBMIT_SIGNATURE} FROM platform_acquisition_runtime`);
    try { expect(await port.submit(input)).toEqual({ ok: false, error: { kind: "unavailable" } }); expect(await counts()).toEqual(before); }
    finally { await admin.query(`GRANT EXECUTE ON FUNCTION ${SUBMIT_SIGNATURE} TO platform_acquisition_runtime`); }
    expect(value(await port.submit(input)).status).toBe("new");
  }, 300_000);

  it("02: preserves distinct fields, exact joins, immutable receipt and one audit/command per accepted capture", async () => {
    const { input, row } = await capture("fidelity");
    expect(row).toEqual({ contractVersion: "partner_acquisition_v1", caseRef: expect.stringMatching(/^acquisition-case:/), contactRef: expect.stringMatching(/^acquisition-contact:/),
      organization: { name: "North Studio", country: "GB" }, contact: { firstName: "Ada", lastName: "Vale", email: input.request.email, phone: "+442012345678" },
      notes: "Distinct sample note", status: "new", version: 1, createdAt: expect.any(String), updatedAt: expect.any(String) });
    expect(Date.parse(row.createdAt)).toBe(Date.parse(AT)); expect(row.updatedAt).toBe(row.createdAt);
    expect(await counts(row.caseRef)).toEqual({ cases: 1, contacts: 1, details: 1, commands: 1, audit: 1 });
    const stored = (await admin.query(`SELECT c.source_kind,c.locale,c.consent_version,c.policy_version,c.source_path,c.address_reference_id,
      contact.contact_reference,contact.normalized_email,contact.normalized_phone,d.organization_name,d.country_code,d.first_name,d.last_name,d.notes,
      cmd.scope,cmd.result_projection,a.action,a.actor_id,octet_length(cmd.command_fingerprint) fingerprint_bytes
      FROM acquisition_private.cases c JOIN acquisition_private.contacts contact ON contact.case_id=c.id
      JOIN acquisition_private.partner_details d ON d.case_id=c.id JOIN acquisition_private.commands cmd ON cmd.case_id=c.id
      JOIN acquisition_private.audit a ON a.case_id=c.id WHERE c.case_reference=$1`, [row.caseRef])).rows[0];
    expect(stored).toEqual({ source_kind: "partner_inquiry", locale: "und", consent_version: "not-applicable", policy_version: "privacy-v1", source_path: "/partners/b2b-inquiries", address_reference_id: null,
      contact_reference: row.contactRef, normalized_email: input.request.email, normalized_phone: "+442012345678", organization_name: "North Studio", country_code: "GB", first_name: "Ada", last_name: "Vale", notes: "Distinct sample note",
      scope: "partner_submit", result_projection: row, action: "submitted", actor_id: null, fingerprint_bytes: 32 });
    const blank = command("nullable"); blank.request.phone = " "; blank.request.notes = " ";
    expect(value(await port.submit(blank))).toMatchObject({ contact: { phone: null }, notes: null });
  });

  it("03: replays the original submit before quota/dedupe/current state, including across a fresh port", async () => {
    const { input, row } = await capture("receipt");
    const later = value(await port.transition(transition(row, "contacted")));
    expect(later.version).toBe(2);
    const before = await counts(row.caseRef);
    const limits = (await admin.query("SELECT sum(attempts)::int attempts FROM acquisition_private.rate_limit_windows")).rows;
    await port.close(); owned.splice(owned.indexOf(port), 1); port = freshPort();
    expect(await port.submit({ ...input, requesterKey: "different-requester", acceptedAt: "2026-01-13T10:00:00Z" })).toEqual({ ok: true, value: row, replayed: true });
    for (const request of [{ ...input.request, company: "Changed Studio" }, { ...input.request, email: "changed@studio.example" }])
      expect(await port.submit({ ...input, request })).toEqual({ ok: false, error: { kind: "conflict" } });
    expect(await port.submit({ ...input, policyVersion: "privacy-v2" })).toEqual({ ok: false, error: { kind: "conflict" } });
    expect(await counts(row.caseRef)).toEqual(before);
    expect((await admin.query("SELECT sum(attempts)::int attempts FROM acquisition_private.rate_limit_windows")).rows).toEqual(limits);
  });

  it("04: preserves email/requester quotas, duplicate-attempt effects and inclusive hour reset after reopening", async () => {
    const { input, row } = await capture("email-quota");
    for (let n = 2; n <= 3; n++) expect(await port.submit({ ...input, idempotencyKey: `${input.idempotencyKey}-${n}` })).toEqual({ ok: false, error: { kind: "conflict" } });
    expect(await port.submit({ ...input, idempotencyKey: `${input.idempotencyKey}-4` })).toEqual({ ok: false, error: { kind: "rate_limited" } });
    expect(await counts(row.caseRef)).toEqual({ cases: 1, contacts: 1, details: 1, commands: 1, audit: 1 });
    const requester = `requester-quota-${++sequence}`;
    const attempts = Array.from({ length: 6 }, (_, n) => command(`requester-${n}`, { requesterKey: requester }));
    for (const attempt of attempts.slice(0, 5)) expect((await port.submit(attempt)).ok).toBe(true);
    expect(await port.submit(attempts[5]!)).toEqual({ ok: false, error: { kind: "rate_limited" } });
    const reopened = freshPort();
    expect(await reopened.submit({ ...attempts[5]!, idempotencyKey: "partner-before-reset", acceptedAt: "2026-01-12T10:59:59.999Z" })).toEqual({ ok: false, error: { kind: "rate_limited" } });
    expect((await reopened.submit({ ...attempts[5]!, idempotencyKey: "partner-hour-reset", acceptedAt: "2026-01-12T11:00:00.000Z" })).ok).toBe(true);
    // Email reset still reaches the existing contact refusal, after resetting both windows.
    expect(await reopened.submit({ ...input, idempotencyKey: `${input.idempotencyKey}-reset`, acceptedAt: "2026-01-12T11:00:00.000Z" })).toEqual({ ok: false, error: { kind: "conflict" } });
    const windows = (await admin.query(`SELECT key_kind,attempts,window_started_at FROM acquisition_private.rate_limit_windows
      WHERE key_fingerprint IN (acquisition_private.keyed_digest('partner-inquiry-requester-limit',jsonb_build_object('requester',$1::text)),
      acquisition_private.keyed_digest('partner-inquiry-email-limit',jsonb_build_object('email',$2::text))) ORDER BY key_kind`, [input.requesterKey, input.request.email])).rows;
    expect(windows).toEqual([{ key_kind: "email", attempts: 1, window_started_at: new Date("2026-01-12T11:00:00Z") }, { key_kind: "requester", attempts: 1, window_started_at: new Date("2026-01-12T11:00:00Z") }]);
  });

  it("05: serializes exact-key and same-contact submit races with one durable accepted effect", async () => {
    const input = command("same-key-race"), other = freshPort();
    const results = await Promise.all([port.submit(input), other.submit(input)]);
    const row = value(results[0]!); expect(results.every(result => result.ok)).toBe(true);
    expect(results.map(result => result.ok && result.replayed).sort()).toEqual([false, true]);
    expect(value(results[1]!)).toEqual(row); expect(await counts(row.caseRef)).toEqual({ cases: 1, contacts: 1, details: 1, commands: 1, audit: 1 });
    const contact = command("same-contact-race");
    const duplicates = await Promise.all([port.submit(contact), other.submit({ ...contact, idempotencyKey: `${contact.idempotencyKey}-other` })]);
    expect(duplicates.filter(result => result.ok)).toHaveLength(1);
    expect(duplicates.find(result => !result.ok)).toEqual({ ok: false, error: { kind: "conflict" } });
  });

  it("06: paginates by descending timestamp/UUID tuple, excludes tester kind and retains invalid cursor refusal", async () => {
    for (let n = 0; n < 3; n++) await capture(`pagination-${n}`);
    const address = "20000000-0000-4000-8000-000000000018";
    await admin.query(`INSERT INTO acquisition_private.address_references(id,source,reference,revision,provenance) VALUES($1,'fixture','address:partner-isolation','v1','fixture')`, [address]);
    const testerPort = adapters.createPostgresAcquisitionCasePort({ connectionString });
    let testerRef: string;
    try {
      const tester = await testerPort.submit({ scope: "public_tester_application", sourceKind: "tester_application", idempotencyKey: "partner-tester-isolation", requesterKey: "tester-isolation", acceptedAt: AT, sourcePath: "/tester-application",
        request: { contact: { email: "tester-isolation@studio.example" }, consent: { accepted: true, consentVersion: "consent-v1", policyVersion: "privacy-v1", locale: "en" },
          addressReference: { source: "fixture", reference: "address:partner-isolation", revision: "v1", provenance: "fixture" } } });
      testerRef = value(tester).caseRef;
    } finally { await testerPort.close(); }
    const expected = (await admin.query("SELECT case_reference FROM acquisition_private.cases WHERE source_kind='partner_inquiry' ORDER BY created_at DESC,id DESC")).rows.map(row => row.case_reference);
    const seen: string[] = []; let cursor: string | undefined;
    do {
      const page = value(await port.list({ actorRef: ACTOR, view: "partner_acquisition_v1", limit: 3, ...(cursor ? { cursor } : {}) }));
      seen.push(...page.cases.map(row => row.caseRef)); cursor = page.nextCursor ?? undefined;
      expect(seen.length).toBeLessThanOrEqual(expected.length);
    } while (cursor);
    expect(seen).toEqual(expected); expect(seen).not.toContain(testerRef!);
    expect(await port.list({ actorRef: ACTOR, view: "partner_acquisition_v1", limit: 3, cursor: "invalid-cursor" })).toEqual({ ok: false, error: { kind: "invalid" } });
    expect(await port.transition({ actorRef: ACTOR, idempotencyKey: "partner-tester-transition", request: { id: testerRef!, expectedVersion: 1, status: "contacted" } })).toEqual({ ok: false, error: { kind: "not_found" } });
    await expect(asRuntime("SELECT public.partner_acquisition_operator_list_v1(NULL,NULL,NULL,3)")).rejects.toMatchObject({ code: "22023" });
    expect(await port.list({ actorRef: ACTOR, view: "partner_acquisition_v1", limit: 101 })).toEqual({ ok: false, error: { kind: "invalid" } });
  });

  it("07: preserves every allowed edge, terminal refusal, invalid jump and stale-version boundary", async () => {
    const paths = [["disqualified"], ["contacted", "disqualified"], ["contacted", "closed_lost"],
      ["contacted", "qualified", "closed_won"], ["contacted", "qualified", "closed_lost"], ["contacted", "qualified", "disqualified"]] as const;
    for (const path of paths) {
      let { row } = await capture(`path-${path.join("-")}`);
      expect(await port.transition(transition(row, "closed_won"))).toEqual({ ok: false, error: { kind: "conflict" } });
      for (const status of path) {
        const previous = row; row = value(await port.transition(transition(row, status)));
        expect(row).toMatchObject({ status, version: previous.version + 1 });
        expect(await port.transition(transition(previous, status))).toEqual({ ok: false, error: { kind: "conflict" } });
      }
      const before = await counts(row.caseRef);
      expect(await port.transition(transition(row, "contacted"))).toEqual({ ok: false, error: { kind: "conflict" } });
      expect(await counts(row.caseRef)).toEqual(before);
      expect(before).toEqual({ cases: 1, contacts: 1, details: 1, commands: path.length + 1, audit: path.length + 1 });
    }
  });

  it("08: replays transition's original projection after later state with actor/payload conflict and missing-case refusal", async () => {
    const { row, input: submitInput } = await capture("transition-receipt"), input = transition(row, "contacted", submitInput.idempotencyKey);
    const contacted = value(await port.transition(input));
    const qualified = value(await port.transition(transition(contacted, "qualified")));
    value(await port.transition(transition(qualified, "closed_won")));
    const before = await counts(row.caseRef), reopened = freshPort();
    expect(await reopened.transition(input)).toEqual({ ok: true, value: contacted, replayed: true });
    expect(await reopened.transition({ ...input, actorRef: OTHER_ACTOR })).toEqual({ ok: false, error: { kind: "conflict" } });
    expect(await reopened.transition({ ...input, request: { ...input.request, status: "disqualified" } })).toEqual({ ok: false, error: { kind: "conflict" } });
    expect(await reopened.transition({ ...input, idempotencyKey: "partner-missing-case", request: { ...input.request, id: "acquisition-case:99999999-9999-4999-8999-999999999999" } })).toEqual({ ok: false, error: { kind: "not_found" } });
    expect(await counts(row.caseRef)).toEqual(before);
    const audit = (await admin.query(`SELECT a.from_lifecycle,a.to_lifecycle,a.from_version::int,a.to_version::int,a.actor_id
      FROM acquisition_private.audit a JOIN acquisition_private.cases c ON c.id=a.case_id WHERE c.case_reference=$1 ORDER BY a.to_version`, [row.caseRef])).rows;
    expect(audit).toEqual([{ from_lifecycle: null, to_lifecycle: "new", from_version: null, to_version: 1, actor_id: null },
      { from_lifecycle: "new", to_lifecycle: "contacted", from_version: 1, to_version: 2, actor_id: ACTOR },
      { from_lifecycle: "contacted", to_lifecycle: "qualified", from_version: 2, to_version: 3, actor_id: ACTOR },
      { from_lifecycle: "qualified", to_lifecycle: "closed_won", from_version: 3, to_version: 4, actor_id: ACTOR }]);
  });

  it("09: locks expected-version races across independent factories without an extra receipt or audit", async () => {
    const { row } = await capture("version-race"), other = freshPort();
    const results = await Promise.all([port.transition(transition(row, "contacted")), other.transition(transition(row, "disqualified"))]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.find(result => !result.ok)).toEqual({ ok: false, error: { kind: "conflict" } });
    expect(await counts(row.caseRef)).toEqual({ cases: 1, contacts: 1, details: 1, commands: 2, audit: 2 });
  });

  it("10: retains SQL refusal before writes, rollback recovery and append-only evidence protection", async () => {
    const before = await counts(), limiter = (await admin.query("SELECT sum(attempts)::int attempts FROM acquisition_private.rate_limit_windows")).rows;
    for (const change of [{ country: "OTHER" }, { phone: "0123456789" }, { email: "invalid" }, { company: "x" }]) {
      const input = command("invalid-input");
      expect(await port.submit({ ...input, request: { ...input.request, ...change } })).toEqual({ ok: false, error: { kind: "invalid" } });
    }
    expect(await counts()).toEqual(before);
    expect((await admin.query("SELECT sum(attempts)::int attempts FROM acquisition_private.rate_limit_windows")).rows).toEqual(limiter);
    const { row } = await capture("rollback-recovery");
    for (const sql of ["UPDATE acquisition_private.commands SET result_version=result_version", "DELETE FROM acquisition_private.audit", "TRUNCATE acquisition_private.commands"])
      await expect(admin.query(sql)).rejects.toMatchObject({ code: "42501" });
    expect(await counts(row.caseRef)).toEqual({ cases: 1, contacts: 1, details: 1, commands: 1, audit: 1 });
    expect(value(await freshPort().list({ actorRef: ACTOR, view: "partner_acquisition_v1", limit: 100 })).cases.find(item => item.caseRef === row.caseRef)).toEqual(row);
  });
});
