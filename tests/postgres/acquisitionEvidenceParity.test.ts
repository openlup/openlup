import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresAcquisitionCasePort, createPostgresAcquisitionEvidencePort } from "@openlup/platform/marketing/server";
import type { AcquisitionCasePort } from "@openlup/platform/marketing/server";
import type { AcquisitionEvidencePort } from "@openlup/platform/marketing/contracts";
import type { AcquisitionNewsletterConsentEvent } from "@openlup/platform/marketing/contracts";
import {
  dockerAvailable, runPostgresContainer, waitForPostgresTcpReady,
  closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer,
} from "../helpers/postgresContainer.js";

// This witness characterizes the shipped public PG rail, not retired signup routing or
// admin membership. The host binding owns operator authorization; these SQL
// routines require an actor UUID but do not establish that actor's membership.
const EVIDENCE_MIGRATION = "db/platform/migrations/20260817130000_acquisition_survey_newsletter_evidence.sql";
const ACTOR = "10000000-0000-4000-8000-000000000001";
const AT = "2026-01-15T12:00:00.000Z";
const SCOPE = "public_tester_application" as const;
const SURVEY_SIGNATURE = "public.acquisition_survey_submit_v1(text,text,text,jsonb,timestamptz)";
type Fixture = { id: string; caseRef: string; contactRef: string; email: string };

let container: PostgresContainer | undefined;
let admin: Pool;
let runtime: Pool;
let cases: AcquisitionCasePort;
let evidence: AcquisitionEvidencePort;
let nextId = 1;
function fixtureId() { return `20000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`; }
let addressId: string;
const fixtures: Fixture[] = [];
const historical: Fixture[] = [];
let partner: Fixture;
let surveyCase: Fixture;
let withdrawnCase: Fixture;
let redactedCase: Fixture;
let consentCase: Fixture;
let externalConsentCase: Fixture;
let consentWithdrawnCase: Fixture;
let consentRedactedCase: Fixture;
let appendOnlyCase: Fixture;

beforeAll(async () => {
  if (!(await dockerAvailable())) {
    throw new Error("acquisition-evidence-parity: Docker unavailable; missing PostgreSQL proof");
  }
  container = await runPostgresContainer({
    name: `acquisition-evidence-${process.pid}`,
    password: "acquisition-test", database: "acquisition_test",
  });
  if (!(await waitForPostgresTcpReady(container.connectionString))) {
    throw new Error("acquisition PostgreSQL TCP readiness deadline exceeded");
  }
  admin = new Pool({ connectionString: container.connectionString });

  // Apply the actual ordered prefix, including actor roles, communications
  // consent state and shared acquisition schema additions. This
  // deliberately neither seals nor executes unrelated later module forwards.
  const manifest = JSON.parse(await readFile("config/platform-migration-manifest.json", "utf8")) as {
    baseline: { file: string; sha256: string };
    forward: Array<{ file: string; sha256: string }>;
  };
  const end = manifest.forward.findIndex(({ file }) => file === EVIDENCE_MIGRATION);
  expect(end).toBeGreaterThanOrEqual(0);
  const prefix = [manifest.baseline, ...manifest.forward.slice(0, end + 1)];
  for (const [position, entry] of prefix.entries()) {
    const source = await readFile(entry.file, "utf8");
    expect(createHash("sha256").update(source).digest("hex"), entry.file).toBe(entry.sha256);
    const client = await admin.connect();
    try {
      await client.query("BEGIN");
      await client.query(source);
      await client.query(`INSERT INTO public.platform_schema_migrations(catalog_path,sha256,position)
        VALUES($1,$2,$3)`, [entry.file, entry.sha256, position]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
  expect((await admin.query("SELECT catalog_path FROM public.platform_schema_migrations ORDER BY position"))
    .rows.map((row) => row.catalog_path)).toEqual(prefix.map(({ file }) => file));

  // Migration bootstrap requires a superuser. Adapter proof uses a separate
  // non-superuser login with only SET permission on the actual runtime role.
  await admin.query(`CREATE ROLE acquisition_test_login LOGIN PASSWORD 'acquisition-test'
    NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT platform_acquisition_runtime TO acquisition_test_login
      WITH INHERIT FALSE, SET TRUE, ADMIN FALSE`);
  const runtimeUrl = new URL(container.connectionString);
  runtimeUrl.username = "acquisition_test_login";
  runtime = new Pool({ connectionString: runtimeUrl.toString() });
  cases = createPostgresAcquisitionCasePort({ connectionString: runtimeUrl.toString() });
  evidence = createPostgresAcquisitionEvidencePort({ connectionString: runtimeUrl.toString() });

  addressId = fixtureId();
  await admin.query(`INSERT INTO acquisition_private.address_references
    (id,source,reference,revision,provenance) VALUES($1,'fixture','address:historical','v1','fixture')`, [addressId]);
  for (const lifecycle of ["submitted", "approved", "active", "rejected", "withdrawn"]) {
    historical.push(await seedHistorical(lifecycle));
  }
  partner = await seedHistorical("new", true);
  surveyCase = await seedHistorical();
  withdrawnCase = await seedHistorical();
  redactedCase = await seedHistorical();
  consentCase = await seedHistorical();
  externalConsentCase = await seedHistorical();
  consentWithdrawnCase = await seedHistorical();
  consentRedactedCase = await seedHistorical();
  appendOnlyCase = await seedHistorical();
}, postgresSetupTimeoutMs);


afterAll(async () => {
  await closePostgres(container, [runtime, admin], [() => cases?.close(), () => evidence?.close()]);
}, postgresTeardownTimeoutMs);

describe("acquisition/evidence preservation on real PostgreSQL", () => {
  it("executes as a restricted login/runtime role and denies private tables and browser functions", async () => {
    expect(await asRuntime(`SELECT current_user, session_user,
      (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser,
      (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypassrls`)).toEqual([{
      current_user: "platform_acquisition_runtime", session_user: "acquisition_test_login",
      superuser: false, bypassrls: false,
    }]);
    for (const sql of [
      "SELECT * FROM acquisition_private.cases",
      "SELECT * FROM acquisition_private.installation_key",
      "INSERT INTO acquisition_private.survey_evidence DEFAULT VALUES",
      "DELETE FROM acquisition_private.newsletter_consent_events",
      "SELECT * FROM public.communication_recipient_consents",
    ]) await expect(asRuntime(sql)).rejects.toMatchObject({ code: "42501" });
    const grants = await admin.query(`SELECT role_name,
      has_function_privilege(role_name,$1,'EXECUTE') AS execute
      FROM (VALUES ('anon'),('authenticated'),('platform_acquisition_runtime')) roles(role_name)`, [SURVEY_SIGNATURE]);
    expect(grants.rows).toEqual([
      { role_name: "anon", execute: false }, { role_name: "authenticated", execute: false },
      { role_name: "platform_acquisition_runtime", execute: true },
    ]);
    // PostgreSQL checks the role on each call, rather than this merely reading
    // GRANT text. Revoke is a local negative control; restore even on failure.
    await admin.query(`REVOKE EXECUTE ON FUNCTION ${SURVEY_SIGNATURE} FROM platform_acquisition_runtime`);
    try {
      const before = await evidenceState(surveyCase);
      expect(await evidence.submitSurvey(surveyInput(surveyCase, "grant-control"))).toEqual({ ok: false, error: { kind: "unavailable" } });
      expect(await evidenceState(surveyCase)).toEqual(before);
    } finally {
      await admin.query(`GRANT EXECUTE ON FUNCTION ${SURVEY_SIGNATURE} TO platform_acquisition_runtime`);
    }
    expect(await evidence.submitSurvey(surveyInput(historical[4]!, "grant-restored")))
      .toEqual({ ok: false, error: { kind: "not_found" } });
  });

  it("reads historical list/detail/count with stable pagination and excludes the shared partner case", async () => {
    const expected = fixtures.filter(({ id }) => id !== partner.id).reverse().map(({ caseRef }) => caseRef);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await cases.list({ actorRef: ACTOR, scope: SCOPE, limit: 3, ...(cursor ? { cursor } : {}) });
      expect(page.ok).toBe(true);
      if (!page.ok) throw new Error("historical list unavailable");
      seen.push(...page.value.cases.map(({ caseRef }) => caseRef));
      cursor = page.value.nextCursor ?? undefined;
      expect(seen.length).toBeLessThanOrEqual(expected.length);
    } while (cursor);
    expect(seen).toEqual(expected);
    expect(await cases.activeCount(SCOPE)).toEqual({ ok: true, value: 2 });
    for (const [index, fixture] of historical.entries()) {
      const detail = await cases.get({ actorRef: ACTOR, scope: SCOPE, caseRef: fixture.caseRef });
      expect(detail).toMatchObject({ ok: true, value: {
        caseRef: fixture.caseRef, contactRef: fixture.contactRef,
        state: ["submitted", "approved", "active", "rejected", "withdrawn"][index],
        version: 1, sourceKind: "tester_application",
      } });
      if (!detail.ok) throw new Error("historical detail unavailable");
      expect(Object.keys(detail.value).sort()).toEqual([
        "addressReference", "caseRef", "consent", "contactRef", "contractVersion",
        "createdAt", "sourceKind", "state", "updatedAt", "version",
      ]);
      expect(JSON.stringify(detail.value)).not.toContain(fixture.email);
      expect(detail.value.addressReference === null).toBe(index === 4);
    }
    expect(await cases.get({ actorRef: ACTOR, scope: SCOPE, caseRef: partner.caseRef })).toEqual({ ok: false, error: { kind: "not_found" } });
    expect(await cases.list({ actorRef: ACTOR, scope: SCOPE, cursor: "invalid-cursor", limit: 3 })).toEqual({ ok: false, error: { kind: "invalid" } });
    await expect(asRuntime("SELECT public.acquisition_case_operator_list_v1(NULL,NULL,NULL,3)")).rejects.toMatchObject({ code: "22023" });
    await expect(asRuntime("SELECT public.acquisition_case_operator_get_v1(NULL,$1)", [historical[0]!.caseRef])).rejects.toMatchObject({ code: "22023" });
    // Fixture imports never exercised signup, transitions or their limiter.
    expect((await admin.query(`SELECT (SELECT count(*)::integer FROM acquisition_private.commands) commands,
      (SELECT count(*)::integer FROM acquisition_private.audit) audit,
      (SELECT count(*)::integer FROM acquisition_private.rate_limit_windows) limiter`)).rows[0])
      .toEqual({ commands: 0, audit: 0, limiter: 0 });
  });

  it("stores content-free survey evidence, replays equivalent JSON exactly and refuses changed commands", async () => {
    const input = surveyInput(surveyCase, "survey-exact");
    const first = await evidence.submitSurvey(input);
    expect(first).toMatchObject({ ok: true, value: { replayed: false, evidence: {
      caseReference: surveyCase.caseRef, contactReference: surveyCase.contactRef,
      surveyType: "consumer", answerCount: 2, responseDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    } } });
    if (!first.ok) throw new Error("survey capture unavailable");
    const before = await evidenceState(surveyCase);
    expect(await evidence.submitSurvey({ ...input, responseData: { second: false, first: "synthetic-answer" } }))
      .toEqual({ ok: true, value: { ...first.value, replayed: true } });
    for (const changed of [
      { ...input, responseData: { first: "changed", second: false } },
      { ...input, caseReference: consentCase.caseRef },
      { ...input, surveyType: "producer" as const },
    ]) expect(await evidence.submitSurvey(changed)).toEqual({ ok: false, error: { kind: "conflict" } });
    expect(await evidenceState(surveyCase)).toEqual(before);
    const stored = await admin.query("SELECT to_jsonb(e) AS evidence FROM acquisition_private.survey_evidence e WHERE idempotency_key=$1", [input.idempotencyKey]);
    expect(Object.keys(stored.rows[0].evidence).sort()).toEqual([
      "answer_count", "case_id", "command_fingerprint", "contact_id", "evidence_reference",
      "id", "idempotency_key", "recorded_at", "response_digest", "survey_type",
    ]);
    expect(JSON.stringify(stored.rows[0])).not.toContain("synthetic-answer");
    const listed = await evidence.listSurveys({ view: "acquisition_survey_v1", actorReference: ACTOR, surveyType: "consumer", limit: 1 });
    expect(listed).toMatchObject({ ok: true, value: { rows: [first.value.evidence], totalCount: 1 } });
    expect(await evidence.listSurveys({ view: "acquisition_survey_v1", actorReference: ACTOR, surveyType: "producer", limit: 1 }))
      .toMatchObject({ ok: true, value: { rows: [], totalCount: 0 } });
  });

  for (const privacyState of ["withdrawn", "redacted"] as const) {
    it(`replays a stored survey after ${privacyState} but refuses a fresh command without writes`, async () => {
      const fixture = privacyState === "withdrawn" ? withdrawnCase : redactedCase;
      const input = surveyInput(fixture, `survey-${privacyState}`);
      const first = await evidence.submitSurvey(input);
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error("survey capture unavailable");
      await setPrivacyState(fixture, privacyState);
      const before = await evidenceState(fixture);
      expect(await evidence.submitSurvey(input)).toEqual({ ok: true, value: { ...first.value, replayed: true } });
      expect(await evidence.submitSurvey({ ...input, idempotencyKey: `${input.idempotencyKey}-new` }))
        .toEqual({ ok: false, error: { kind: "not_found" } });
      expect(await evidenceState(fixture)).toEqual(before);
    });
  }

  it("rejects newsletter case/contact mismatch before any evidence or consent write", async () => {
    const before = await evidenceState(consentCase);
    for (const input of [
      { ...consentInput(consentCase, "wrong-contact"), contactReference: surveyCase.contactRef },
      { ...consentInput(consentCase, "wrong-case"), caseReference: surveyCase.caseRef },
    ]) expect(await evidence.applyNewsletterConsent(input)).toEqual({ ok: false, error: { kind: "not_found" } });
    expect(await evidenceState(consentCase)).toEqual(before);
  });

  it("ignores unproved subscribe/update, grants explicit opt-in, and orders suppression and stale replay", async () => {
    for (const [suffix, eventType] of [["unproved", "subscribe"], ["update", "update"]] as const) {
      expect(await evidence.applyNewsletterConsent({ ...consentInput(consentCase, `consent-${suffix}`), eventType, explicitOptInEvidence: false }))
        .toMatchObject({ ok: true, value: { outcome: "ignored", consentState: null, replayed: false } });
    }
    expect(await consentState(consentCase)).toEqual([]);
    const grant = consentInput(consentCase, "consent-granted");
    const granted = await evidence.applyNewsletterConsent(grant);
    expect(granted).toMatchObject({ ok: true, value: { outcome: "applied", consentState: "granted" } });
    expect(await consentState(consentCase)).toMatchObject([{ state: "granted", updated_at: new Date(AT) }]);
    const suppression = { ...consentInput(consentCase, "consent-suppressed"), eventType: "suppress" as const, explicitOptInEvidence: false, occurredAt: "2026-01-15T12:02:00.000Z" };
    const applied = await evidence.applyNewsletterConsent(suppression);
    expect(applied).toMatchObject({ ok: true, value: { outcome: "applied", consentState: "suppressed", replayed: false } });
    const stale = { ...consentInput(consentCase, "consent-stale"), occurredAt: "2026-01-15T12:01:00.000Z" };
    const staleResult = await evidence.applyNewsletterConsent(stale);
    expect(staleResult).toMatchObject({ ok: true, value: { outcome: "stale", consentState: null, replayed: false } });
    expect(await consentState(consentCase)).toMatchObject([{ state: "suppressed", updated_at: new Date(suppression.occurredAt) }]);
    if (!granted.ok || !applied.ok || !staleResult.ok) throw new Error("consent ordering unavailable");
    const before = await evidenceState(consentCase);
    expect(await evidence.applyNewsletterConsent(grant)).toEqual({ ok: true, value: { ...granted.value, replayed: true } });
    expect(await evidence.applyNewsletterConsent(suppression)).toEqual({ ok: true, value: { ...applied.value, replayed: true } });
    expect(await evidence.applyNewsletterConsent(stale)).toEqual({ ok: true, value: { ...staleResult.value, replayed: true } });
    expect(await evidence.applyNewsletterConsent({ ...suppression, eventType: "subscribe", explicitOptInEvidence: true }))
      .toEqual({ ok: false, error: { kind: "conflict" } });
    expect(await evidenceState(consentCase)).toEqual(before);
  });

  it("respects newer shared consent state even when no acquisition event supplies the watermark", async () => {
    await admin.query(`INSERT INTO public.communication_recipient_consents
      (recipient_fingerprint,purpose,state,captured_at,updated_at)
      VALUES(encode(sha256(convert_to($1,'UTF8')),'hex'),'marketing_newsletter','suppressed',$2,$2)`,
    [externalConsentCase.email, "2026-01-15T12:03:00.000Z"]);
    const current = await consentState(externalConsentCase);
    expect(await evidence.applyNewsletterConsent(consentInput(externalConsentCase, "external-watermark")))
      .toMatchObject({ ok: true, value: { outcome: "stale", consentState: null } });
    expect(await consentState(externalConsentCase)).toEqual(current);
  });

  for (const privacyState of ["withdrawn", "redacted"] as const) {
    it(`replays a stored consent receipt after ${privacyState} but refuses a new event without writes`, async () => {
      const fixture = privacyState === "withdrawn" ? consentWithdrawnCase : consentRedactedCase;
      const input = consentInput(fixture, `consent-${privacyState}`);
      const first = await evidence.applyNewsletterConsent(input);
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error("consent capture unavailable");
      await setPrivacyState(fixture, privacyState);
      const before = await evidenceState(fixture);
      expect(await evidence.applyNewsletterConsent(input)).toEqual({ ok: true, value: { ...first.value, replayed: true } });
      expect(await evidence.applyNewsletterConsent({ ...input, eventReference: `${input.eventReference}-new` }))
        .toEqual({ ok: false, error: { kind: "not_found" } });
      expect(await evidenceState(fixture)).toEqual(before);
    });
  }

  it("refuses append-only survey and consent mutation through the runtime role", async () => {
    expect(await evidence.submitSurvey(surveyInput(appendOnlyCase, "append-only-survey"))).toMatchObject({ ok: true });
    expect(await evidence.applyNewsletterConsent(consentInput(appendOnlyCase, "append-only-consent"))).toMatchObject({ ok: true });
    for (const sql of [
      "UPDATE acquisition_private.survey_evidence SET answer_count=answer_count",
      "DELETE FROM acquisition_private.newsletter_consent_events",
      "TRUNCATE acquisition_private.survey_evidence",
    ]) await expect(asRuntime(sql)).rejects.toMatchObject({ code: "42501" });
  });
});

async function seedHistorical(lifecycle = "submitted", isPartner = false): Promise<Fixture> {
  const id = fixtureId();
  const fixture = { id, caseRef: `acquisition-case:${id}`, contactRef: `acquisition-contact:${fixtureId()}`, email: `fixture-${id}@example.invalid` };
  const createdAt = new Date(Date.parse(AT) - (100 - fixtures.length) * 60_000).toISOString();
  // Import historical records directly; never call retired signup/activation.
  await admin.query(`INSERT INTO acquisition_private.cases
    (id,case_reference,source_kind,dedupe_fingerprint,address_reference_id,lifecycle,
     consent_version,policy_version,consent_accepted_at,locale,source_path,withdrawn_at,created_at,updated_at)
    VALUES($1::uuid,$2,$3,sha256(convert_to($1::text,'UTF8')),$4,$5,'fixture-v1','fixture-v1',$6,
      CASE WHEN $3='partner_inquiry' THEN 'und' ELSE 'en' END,$7,
      CASE WHEN $5='withdrawn' THEN $6::timestamptz END,$6,$6)`,
  [id, fixture.caseRef, isPartner ? "partner_inquiry" : "tester_application",
    isPartner || lifecycle === "withdrawn" ? null : addressId, lifecycle, createdAt,
    isPartner ? "/partners/b2b-inquiries" : "/tester-application"]);
  await admin.query(`INSERT INTO acquisition_private.contacts
    (case_id,contact_reference,normalized_email,redacted_at,created_at,updated_at)
    VALUES($1,$2,$3,CASE WHEN $3::text IS NULL THEN $4::timestamptz END,$4,$4)`,
  [id, fixture.contactRef, lifecycle === "withdrawn" ? null : fixture.email, createdAt]);
  fixtures.push(fixture);
  return fixture;
}

function surveyInput(fixture: Fixture, key: string) {
  return { view: "acquisition_survey_v1" as const, caseReference: fixture.caseRef,
    surveyType: "consumer" as const, responseData: { first: "synthetic-answer", second: false }, idempotencyKey: key };
}

function consentInput(fixture: Fixture, key: string): AcquisitionNewsletterConsentEvent {
  return { contractVersion: "acquisition_newsletter_consent_v1", caseReference: fixture.caseRef,
    contactReference: fixture.contactRef, eventReference: key, eventType: "subscribe",
    purpose: "marketing_newsletter", explicitOptInEvidence: true, occurredAt: AT };
}

async function setPrivacyState(fixture: Fixture, state: "withdrawn" | "redacted") {
  if (state === "withdrawn") await admin.query(`UPDATE acquisition_private.cases
    SET lifecycle='withdrawn', withdrawn_at=$2, updated_at=$2, address_reference_id=NULL WHERE id=$1`, [fixture.id, AT]);
  await admin.query(`UPDATE acquisition_private.contacts SET normalized_email=NULL,
    normalized_phone=NULL, redacted_at=$2, updated_at=$2 WHERE case_id=$1`, [fixture.id, AT]);
}

async function consentState(fixture: Fixture) {
  return (await admin.query(`SELECT state,captured_at,updated_at,xmin::text AS row_version
    FROM public.communication_recipient_consents
    WHERE recipient_fingerprint=encode(sha256(convert_to($1,'UTF8')),'hex') AND purpose='marketing_newsletter'`, [fixture.email])).rows;
}

async function evidenceState(fixture: Fixture) {
  const rows = await admin.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM acquisition_private.survey_evidence e WHERE case_id=$1) surveys,
    (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM acquisition_private.newsletter_consent_events e WHERE case_id=$1) events,
    (SELECT to_jsonb(c) FROM acquisition_private.cases c WHERE id=$1) acquisition_case,
    (SELECT to_jsonb(c) FROM acquisition_private.contacts c WHERE case_id=$1) contact`, [fixture.id]);
  return { ...rows.rows[0], consents: await consentState(fixture) };
}

async function asRuntime(sql: string, values: unknown[] = []) {
  const client = await runtime.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE platform_acquisition_runtime");
    const result = await client.query(sql, values);
    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
