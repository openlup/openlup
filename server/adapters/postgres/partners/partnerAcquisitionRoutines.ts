import { Pool, type PoolClient } from "pg";
import {
  PARTNER_ACQUISITION_CONTRACT_VERSION,
  partnerAcquisitionCaseSchema,
  partnerAcquisitionListResponseSchema,
  type PartnerAcquisitionCase,
  type PartnerAcquisitionListRequest,
} from "../../../../src/domains/partners/contracts.js";
import type {
  PartnerAcquisitionFailureKind,
  PartnerAcquisitionPort,
  PartnerAcquisitionResult,
} from "../../../../src/domains/partners/ports.js";

const ROLE = "SET LOCAL ROLE platform_acquisition_runtime";
const SUBMIT = `SELECT public.partner_acquisition_submit_v1(
  $1::text,$2::text,$3::text,$4::text,$5::text,$6::text,
  $7::text,$8::text,$9::text,$10::text,$11::text,$12::timestamptz
) AS response`;
const LIST = "SELECT public.partner_acquisition_operator_list_v1($1::uuid,$2::timestamptz,$3::uuid,$4::integer) AS response";
const TRANSITION = `SELECT public.partner_acquisition_transition_v1(
  $1::uuid,$2::text,$3::bigint,$4::text,$5::text,$6::timestamptz
) AS response`;

type Env = { connectionString: string };
type Options = { poolFactory?: (env: Env) => Pool | Promise<Pool> };
type Row = Record<string, unknown>;

export function createPostgresPartnerAcquisitionPort(
  env: Env,
  options: Options = {},
): PartnerAcquisitionPort {
  if (!env.connectionString.trim()) throw new Error("partner_acquisition_database_url_required");
  let poolPromise: Promise<Pool> | null = null;
  const pool = () => poolPromise ??= Promise.resolve(
    options.poolFactory ? options.poolFactory(env) : new Pool({ connectionString: env.connectionString }),
  );
  const call = async (sql: string, values: unknown[]): Promise<unknown> =>
    withRole(await pool(), async (client) => {
      const result = await client.query(sql, values);
      return object(result.rows[0])?.response ?? null;
    });

  return {
    async submit(command) {
      try {
        const request = command.request;
        const response = object(await call(SUBMIT, [
          command.idempotencyKey,
          command.requesterKey,
          normalizeText(request.company),
          request.country.trim().toUpperCase(),
          normalizeText(request.firstName),
          normalizeText(request.lastName),
          request.email.trim().toLowerCase(),
          normalizePhone(request.phone),
          normalizeOptional(request.notes),
          command.policyVersion,
          command.sourcePath,
          command.acceptedAt,
        ]));
        return projectionResult(response);
      } catch (error) {
        return databaseFailure(error);
      }
    },

    async list(query) {
      const cursor = decodeCursor(query.cursor);
      if (cursor === undefined) return failure("invalid");
      try {
        const response = object(await call(LIST, [
          query.actorRef,
          cursor?.createdAt ?? null,
          cursor?.id ?? null,
          query.limit,
        ]));
        if (!response || !Array.isArray(response.cases)) return failure("unavailable");
        const parsed = partnerAcquisitionListResponseSchema.safeParse({
          contractVersion: response.contractVersion ?? PARTNER_ACQUISITION_CONTRACT_VERSION,
          cases: response.cases,
          nextCursor: response.nextCursor === null ? null : encodeCursor(response.nextCursor),
        });
        return parsed.success ? { ok: true, value: parsed.data } : failure("unavailable");
      } catch (error) {
        return databaseFailure(error);
      }
    },

    async transition(command) {
      try {
        const response = object(await call(TRANSITION, [
          command.actorRef,
          command.request.id,
          command.request.expectedVersion,
          command.request.status,
          command.idempotencyKey,
          new Date().toISOString(),
        ]));
        return projectionResult(response);
      } catch (error) {
        return databaseFailure(error);
      }
    },

    async close() {
      if (poolPromise) await (await poolPromise).end();
    },
  };
}

async function withRole<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(ROLE);
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function projectionResult(response: Row | null): PartnerAcquisitionResult<PartnerAcquisitionCase> {
  if (!response) return failure("unavailable");
  if (["created", "replayed", "transitioned"].includes(String(response.outcome))) {
    const parsed = partnerAcquisitionCaseSchema.safeParse(response.acquisitionCase);
    return parsed.success
      ? { ok: true, value: parsed.data, replayed: response.replayed === true }
      : failure("unavailable");
  }
  return failure(outcomeFailure(response.outcome));
}

function outcomeFailure(outcome: unknown): PartnerAcquisitionFailureKind {
  if (outcome === "rate_limited") return "rate_limited";
  if (outcome === "not_found") return "not_found";
  if (["idempotency_conflict", "contact_conflict", "version_conflict", "transition_conflict"].includes(String(outcome))) {
    return "conflict";
  }
  return outcome === "invalid" ? "invalid" : "unavailable";
}

function databaseFailure(error: unknown): PartnerAcquisitionResult<never> {
  return failure(object(error)?.code === "22023" ? "invalid" : "unavailable");
}

function failure<T>(kind: PartnerAcquisitionFailureKind): PartnerAcquisitionResult<T> {
  return { ok: false, error: { kind } };
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeOptional(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/\s+/g, " ") ?? "";
  return normalized || null;
}

function normalizePhone(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  if (!normalized) return null;
  const digits = normalized.replace(/\D/g, "");
  return digits ? `+${digits}` : null;
}

function encodeCursor(value: unknown): string {
  const cursor = object(value);
  if (!cursor || typeof cursor.createdAt !== "string" || typeof cursor.id !== "string") {
    throw new Error("partner_acquisition_cursor_invalid");
  }
  return Buffer.from(JSON.stringify({ createdAt: cursor.createdAt, id: cursor.id }), "utf8").toString("base64url");
}

function decodeCursor(value: PartnerAcquisitionListRequest["cursor"]): { createdAt: string; id: string } | null | undefined {
  if (value === undefined) return null;
  try {
    const parsed = object(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    return parsed && typeof parsed.createdAt === "string" && typeof parsed.id === "string"
      ? { createdAt: parsed.createdAt, id: parsed.id }
      : undefined;
  } catch {
    return undefined;
  }
}

function object(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}
