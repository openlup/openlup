import { Pool, type PoolClient } from "pg";

import {
  ACQUISITION_NEWSLETTER_VERSION,
  ACQUISITION_SURVEY_VERSION,
  acquisitionNewsletterConsentResponseSchema,
  acquisitionSurveyListResponseSchema,
  acquisitionSurveySubmitResponseSchema,
} from "../../../../src/domains/marketing/research/acquisitionEvidenceContracts.js";
import type {
  AcquisitionEvidenceFailure,
  AcquisitionEvidencePort,
  AcquisitionEvidenceResult,
} from "../../../domains/marketing/research/acquisitionEvidencePorts.js";

const ROLE = "SET LOCAL ROLE platform_acquisition_runtime";
const SUBMIT = "SELECT public.acquisition_survey_submit_v1($1::text,$2::text,$3::text,$4::jsonb,$5::timestamptz) AS response";
const LIST = "SELECT public.acquisition_survey_operator_list_v1($1::uuid,$2::text,$3::integer) AS response";
const CONSENT = "SELECT public.acquisition_newsletter_consent_v1($1::text,$2::text,$3::text,$4::text,$5::text,$6::boolean,$7::timestamptz,$8::timestamptz) AS response";

type Env = { connectionString: string };
type Options = { poolFactory?: (env: Env) => Pool | Promise<Pool> };
type Row = Record<string, unknown>;

export function createPostgresAcquisitionEvidencePort(env: Env, options: Options = {}): AcquisitionEvidencePort {
  if (!env.connectionString.trim()) throw new Error("acquisition_evidence_database_url_required");
  let poolPromise: Promise<Pool> | null = null;
  const pool = () => poolPromise ??= Promise.resolve(
    options.poolFactory ? options.poolFactory(env) : new Pool({ connectionString: env.connectionString }),
  );
  const call = async (sql: string, values: unknown[]): Promise<Row | null> => withRole(
    await pool(),
    async (client) => object(object((await client.query(sql, values)).rows[0])?.response),
  );

  return {
    async submitSurvey(input) {
      try {
        const response = await call(SUBMIT, [input.idempotencyKey, input.caseReference,
          input.surveyType, JSON.stringify(input.responseData), new Date().toISOString()]);
        const failure = outcomeFailure(response?.outcome);
        if (failure) return fail(failure);
        const parsed = acquisitionSurveySubmitResponseSchema.safeParse({
          contractVersion: ACQUISITION_SURVEY_VERSION,
          evidence: response?.evidence,
          replayed: response?.replayed === true,
        });
        return parsed.success ? { ok: true, value: parsed.data } : fail("unavailable");
      } catch (error) { return databaseFailure(error); }
    },
    async listSurveys(input) {
      try {
        const response = await call(LIST, [input.actorReference, input.surveyType ?? null, input.limit]);
        const parsed = acquisitionSurveyListResponseSchema.safeParse({
          contractVersion: ACQUISITION_SURVEY_VERSION,
          rows: response?.rows,
          totalCount: number(response?.totalCount),
        });
        return parsed.success ? { ok: true, value: parsed.data } : fail("unavailable");
      } catch (error) { return databaseFailure(error); }
    },
    async applyNewsletterConsent(input) {
      try {
        const response = await call(CONSENT, [input.caseReference,input.contactReference,
          input.eventReference,input.eventType,input.purpose,input.explicitOptInEvidence,
          input.occurredAt,new Date().toISOString()]);
        const failure = outcomeFailure(response?.outcome);
        if (failure) return fail(failure);
        const parsed = acquisitionNewsletterConsentResponseSchema.safeParse({
          contractVersion: ACQUISITION_NEWSLETTER_VERSION,
          eventReference: response?.eventReference,
          outcome: response?.outcome,
          consentState: response?.consentState ?? null,
          auditReference: response?.auditReference,
          replayed: response?.replayed === true,
        });
        return parsed.success ? { ok: true, value: parsed.data } : fail("unavailable");
      } catch (error) { return databaseFailure(error); }
    },
    async close() { if (poolPromise) await (await poolPromise).end(); },
  };
}

async function withRole<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN"); await client.query(ROLE);
    const value = await work(client); await client.query("COMMIT"); return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {}); throw error;
  } finally { client.release(); }
}

function outcomeFailure(outcome: unknown): AcquisitionEvidenceFailure | null {
  if (outcome === "not_found") return "not_found";
  if (outcome === "idempotency_conflict") return "conflict";
  if (["recorded","replayed","applied","ignored","stale"].includes(String(outcome))) return null;
  return "unavailable";
}
function databaseFailure<T>(error: unknown): AcquisitionEvidenceResult<T> {
  return fail(object(error)?.code === "22023" ? "invalid" : "unavailable");
}
function fail<T>(kind: AcquisitionEvidenceFailure): AcquisitionEvidenceResult<T> {
  return { ok: false, error: { kind } };
}
function object(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}
function number(value: unknown): number { return typeof value === "number" ? value : Number(value); }
