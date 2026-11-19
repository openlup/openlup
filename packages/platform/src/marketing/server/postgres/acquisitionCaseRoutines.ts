import { Buffer } from "node:buffer";
import type { Pool, PoolClient } from "pg";
import { attachPgErrorListener } from "./pgErrorListener.js";

import { ACQUISITION_CASE_CONTRACT_VERSION, acquisitionCaseListResponseSchema, acquisitionCaseProjectionSchema } from "../../acquisitionCaseSchemas.js";
import type { AcquisitionCaseProjection, AcquisitionCaseFailureKind, AcquisitionCaseListQuery, AcquisitionCaseResult } from "../../contracts/index.js";
import type {
  AcquisitionCasePort,
  AcquisitionCaseSubmitCommand,
  AcquisitionCaseTransitionCommand,
} from "../acquisitionCasePorts.js";

const ROLE = "SET LOCAL ROLE platform_acquisition_runtime";
const SUBMIT = `SELECT public.acquisition_case_submit_v1(
  $1::text,$2::text,$3::text,$4::text,$5::boolean,$6::text,$7::text,
  $8::text,$9::text,$10::text,$11::text,$12::text,$13::text,$14::timestamptz
) AS response`;
const LIST = "SELECT public.acquisition_case_operator_list_v1($1::uuid,$2::timestamptz,$3::uuid,$4::integer) AS response";
const GET = "SELECT public.acquisition_case_operator_get_v1($1::uuid,$2::text) AS response";
const TRANSITION = `SELECT public.acquisition_case_transition_v1(
  $1::uuid,$2::text,$3::bigint,$4::text,$5::text,$6::text,$7::timestamptz
) AS response`;
const ACTIVE_COUNT = "SELECT public.acquisition_case_active_count_v1() AS response";

type Env = { connectionString: string };
type Options = {
  pool?: Pool;
  poolFactory?: (env: Env) => Pool | Promise<Pool>;
  /** Optional sink for idle pg.Pool `'error'` events; defaults to a non-throwing stderr logger. */
  onPoolError?: (error: Error) => void;
};
type Row = Record<string, unknown>;

export function createPostgresAcquisitionCasePort(
  env: Env,
  options: Options = {},
): AcquisitionCasePort {
  if (options.pool && options.poolFactory) {
    throw new Error("postgres_pool_and_factory_mutually_exclusive");
  }
  if (!options.pool && !env.connectionString.trim()) {
    throw new Error("acquisition_case_database_url_required");
  }
  const borrowedPool = options.pool ?? null;
  let ownedPoolPromise: Promise<Pool> | null = null;
  const pool = async (): Promise<Pool> => {
    if (borrowedPool) return borrowedPool;
    if (!ownedPoolPromise) {
      ownedPoolPromise = Promise.resolve()
        .then(() => (options.poolFactory ? options.poolFactory(env) : defaultPoolFactory(env)))
        .then(
          (resolved) => attachPgErrorListener(resolved, "acquisition-case", options.onPoolError),
          (error) => {
            ownedPoolPromise = null;
            throw error;
          },
        );
    }
    return ownedPoolPromise;
  };

  const call = async (sql: string, values: unknown[]): Promise<unknown> =>
    withRole(await pool(), async (client) => {
      const result = await client.query(sql, values);
      return object(result.rows[0])?.response ?? null;
    });

  return {
    async submit(command) {
      if (command.scope !== "public_tester_application" || command.sourceKind !== "tester_application") {
        return failure("invalid");
      }
      try {
        const request = command.request;
        const response = object(await call(SUBMIT, [
          command.idempotencyKey,
          command.requesterKey,
          request.contact.email.trim().toLowerCase(),
          null,
          request.consent.accepted,
          request.consent.consentVersion,
          request.consent.policyVersion,
          request.consent.locale,
          command.sourcePath,
          request.addressReference.source,
          request.addressReference.reference,
          request.addressReference.revision,
          request.addressReference.provenance,
          command.acceptedAt,
        ]));
        return projectionResult(response);
      } catch (error) {
        return databaseFailure(error);
      }
    },

    async list(query) {
      if (query.scope !== "public_tester_application") return failure("invalid");
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
        const parsed = acquisitionCaseListResponseSchema.safeParse({
          contractVersion: response.contractVersion ?? ACQUISITION_CASE_CONTRACT_VERSION,
          cases: response.cases,
          nextCursor: response.nextCursor === null ? null : encodeCursor(response.nextCursor),
        });
        return parsed.success ? { ok: true, value: parsed.data } : failure("unavailable");
      } catch (error) {
        return databaseFailure(error);
      }
    },

    async get(query) {
      if (query.scope !== "public_tester_application") return failure("invalid");
      try {
        const response = object(await call(GET, [query.actorRef, query.caseRef]));
        if (response?.outcome === "not_found") return failure("not_found");
        return projectionResult(response);
      } catch (error) {
        return databaseFailure(error);
      }
    },

    async transition(command) {
      if (command.scope !== "public_tester_application") return failure("invalid");
      const target = transitionTarget(command);
      try {
        const response = object(await call(TRANSITION, [
          command.actorRef,
          command.request.caseRef,
          command.request.expectedVersion,
          target,
          command.request.reason ?? null,
          command.idempotencyKey,
          new Date().toISOString(),
        ]));
        return projectionResult(response);
      } catch (error) {
        return databaseFailure(error);
      }
    },

    async activeCount(scope) {
      if (scope !== "public_tester_application") return failure("invalid");
      try {
        const raw = await call(ACTIVE_COUNT, []);
        const count = typeof raw === "number" ? raw : Number(raw);
        return Number.isSafeInteger(count) && count >= 0
          ? { ok: true, value: count }
          : failure("unavailable");
      } catch (error) {
        return databaseFailure(error);
      }
    },

    async close() {
      const pending = ownedPoolPromise;
      ownedPoolPromise = null;
      if (pending) await (await pending).end();
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

function projectionResult(response: Row | null): AcquisitionCaseResult<AcquisitionCaseProjection> {
  if (!response) return failure("unavailable");
  const outcome = response.outcome;
  if (outcome === "created" || outcome === "replayed" || outcome === "transitioned" || outcome === "found") {
    const parsed = acquisitionCaseProjectionSchema.safeParse(response.acquisitionCase);
    return parsed.success
      ? { ok: true, value: parsed.data, replayed: response.replayed === true }
      : failure("unavailable");
  }
  return failure(outcomeFailure(outcome));
}

function outcomeFailure(outcome: unknown): AcquisitionCaseFailureKind {
  if (outcome === "invalid_address") return "invalid";
  if (outcome === "rate_limited") return "rate_limited";
  if (outcome === "not_found") return "not_found";
  if (outcome === "idempotency_conflict" || outcome === "contact_conflict"
    || outcome === "version_conflict" || outcome === "transition_conflict") return "conflict";
  return "unavailable";
}

function databaseFailure(error: unknown): AcquisitionCaseResult<never> {
  if (error instanceof Error && error.message.startsWith("OPENLUP_E_PEER_MISSING:")) throw error;
  return failure(object(error)?.code === "22023" ? "invalid" : "unavailable");
}

async function defaultPoolFactory(env: Env): Promise<Pool> {
  const pg = await import("pg").catch(peerMissing);
  const PoolCtor = (pg.default?.Pool ?? pg.Pool) as typeof import("pg").Pool;
  return new PoolCtor({ connectionString: env.connectionString });
}

function peerMissing(cause: unknown): never {
  if (cause instanceof Error && "code" in cause
    && (cause.code === "ERR_MODULE_NOT_FOUND" || cause.code === "MODULE_NOT_FOUND")
    && /^Cannot find (?:package|module) ['"]pg['"]/.test(cause.message)) {
    throw new Error("OPENLUP_E_PEER_MISSING: pg is required by the Postgres acquisition case port; install it alongside @openlup/platform", { cause });
  }
  throw cause;
}

function failure<T>(kind: AcquisitionCaseFailureKind): AcquisitionCaseResult<T> {
  return { ok: false, error: { kind } };
}

function transitionTarget(command: AcquisitionCaseTransitionCommand): string {
  return ({ approve: "approved", activate: "active", reject: "rejected", withdraw: "withdrawn" } as const)[
    command.request.transition
  ];
}

function encodeCursor(value: unknown): string {
  const cursor = object(value);
  if (!cursor || typeof cursor.createdAt !== "string" || typeof cursor.id !== "string") {
    throw new Error("acquisition_case_cursor_invalid");
  }
  return Buffer.from(JSON.stringify({ createdAt: cursor.createdAt, id: cursor.id }), "utf8").toString("base64url");
}

function decodeCursor(value: AcquisitionCaseListQuery["cursor"]): { createdAt: string; id: string } | null | undefined {
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
