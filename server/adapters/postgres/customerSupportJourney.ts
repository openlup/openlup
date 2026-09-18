import { createHash, randomBytes } from "node:crypto";

import { adminClientsPortableDetailResponseSchema, adminClientsPortableSearchResponseSchema, adminClientsPortableSummaryResponseSchema,
  type AdminClientsPortableDetailRequest, type AdminClientsPortableDetailResponse, type AdminClientsPortableSearchRequest,
  type AdminClientsPortableSearchResponse, type AdminClientsPortableSummaryRequest, type AdminClientsPortableSummaryResponse,
} from "../../../src/domains/clients/portableContracts.js";
import type { ClientsPortableAdminReadPort } from "../../../src/domains/clients/portablePorts.js";
import { SUPPORT_CUSTOMER_360_CONTRACT_VERSION, customer360SnapshotResponseSchema,
  type Customer360LookupRequest, type Customer360SearchResponse, type Customer360SnapshotResponse,
} from "../../../src/domains/support/customer360Contracts.js";
import type { CustomerRecoveryRefusalCode } from "../../../src/domains/support/customerSupportCommandContracts.js";
import {
  CustomerSupportCommandIdempotencyConflictError,
  CustomerSupportCommandInvalidError,
  OperatorSubscriptionAuthorityUnavailableError,
  type CustomerRecoveryAuthorityResult,
  type CustomerSupportOperatorCommandPort,
} from "../../domains/support/customerRecoveryCommand.js";
import { leadAbsorption, type OperatorLeadAbsorptionResult } from "../../domains/support/leadAbsorption.js";
import { CustomerSupportOperatorInactiveError } from "../../runtime/support/customerJourneyBinding.js";
import { createPostgresCustomerRecoveryTransactionLane, type PostgresDataGatewayEnv } from "./dataGateway.js";
import type { PgQueryExecutor } from "./queryBuilder.js";

const RECOVERY_TTL_MS = 24 * 60 * 60 * 1_000;
const REFUSALS = new Set<CustomerRecoveryRefusalCode>(["subject_not_found", "case_not_found",
  "lifecycle_not_eligible", "dunning_authority_unavailable", "case_not_open", "recoverable_order_unavailable"]);

export interface CustomerSupportJourneyReadPort {
  searchCustomerJourney(request: Customer360LookupRequest): Promise<Customer360SearchResponse>;
  getCustomerJourney(request: Customer360LookupRequest): Promise<Customer360SnapshotResponse | null>;
}

export type CustomerSupportJourneyPort = ClientsPortableAdminReadPort & CustomerSupportJourneyReadPort & CustomerSupportOperatorCommandPort;

export type CloseableCustomerSupportJourneyPort = CustomerSupportJourneyPort & { close(): Promise<void> };

export interface PostgresCustomerSupportJourneyLane {
  run<T>(work: (executor: PgQueryExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface PostgresCustomerSupportJourneyEnv extends PostgresDataGatewayEnv {
  operatorId: string;
}

export interface PostgresCustomerSupportJourneyOptions {
  createLane?: (env: PostgresDataGatewayEnv) => PostgresCustomerSupportJourneyLane;
  now?: () => number;
  createOpaqueToken?: () => string;
  isMachineActor?: boolean;
}

/**
 * Named customer-support capability over the public PostgreSQL rail.
 *
 * Callers receive neutral read models and one delegated dunning action only;
 * the query executor and recovery credentials never leave this adapter.
 */
export function createPostgresCustomerSupportJourneyPort(env: PostgresCustomerSupportJourneyEnv, options: PostgresCustomerSupportJourneyOptions = {}): CloseableCustomerSupportJourneyPort {
  const connectionString = env.connectionString.trim();
  const operatorId = env.operatorId.trim();
  if (!connectionString) throw new Error("customer_support_database_url_required");
  if (!operatorId) throw new Error("customer_support_operator_required");

  const lane = (options.createLane ?? ((value) => createPostgresCustomerRecoveryTransactionLane(value)))({ connectionString }) as PostgresCustomerSupportJourneyLane;
  const now = options.now ?? Date.now;
  const createOpaqueToken = options.createOpaqueToken ?? (() => randomBytes(32).toString("base64url"));

  const call = async (sql: string, values: readonly unknown[]): Promise<unknown> => lane.run(async (executor) => {
    const { rows } = await executor.query(sql, [...values]);
    if (rows.length !== 1 || !("result" in rows[0]!)) throw new Error("customer_support_routine_response_invalid");
    return rows[0]!.result;
  });
  const audit = async (route: string, query: object, ids: string[]) => { if (!options.isMachineActor) return; try { await lane.run((executor) => executor.query("INSERT INTO public.customer_support_read_audit_events (operator_id,route,query,customer_ids) VALUES ($1,$2,$3::jsonb,$4)", [operatorId, route, JSON.stringify(query), ids])); } catch { /* Read audit is best effort, matching the managed governance lane. */ } };

  const searchPortableClients = async (request: AdminClientsPortableSearchRequest, route = "/api/bff/admin/clients/search"): Promise<AdminClientsPortableSearchResponse> => {
    const result = await readCall(() => call("SELECT public.customer_support_search($1,$2,$3,$4,$5) AS result",
      [operatorId, request.query, request.page, request.pageSize, request.lifecycleStage]));
    const parsed = adminClientsPortableSearchResponseSchema.parse(result); if (route) await audit(route, { ...request, query: "[redacted]" }, parsed.candidates.map((c) => c.subject.subjectId)); return parsed;
  };

  const searchCustomerJourney = async (request: Customer360LookupRequest): Promise<Customer360SearchResponse> => {
    const query = displayQuery(request);
    const portable = await searchPortableClients({ query, page: 0, pageSize: request.pageSize, lifecycleStage: "all" },
      "/api/bff/admin/support/customer-journey");
    const result = {
      contractVersion: SUPPORT_CUSTOMER_360_CONTRACT_VERSION,
      query,
      candidates: portable.candidates.map((candidate) => ({
        subjectId: candidate.subject.subjectId,
        displayName: candidate.subject.displayName,
        email: candidate.subject.email,
        lifecycleStage: candidate.subject.lifecycleStage,
        matchedBy: mapMatchedBy(candidate.matchedBy),
        confidence: candidate.confidence,
        lastActivityAt: candidate.subject.lastActivityAt,
        snapshotLookup: { subjectId: candidate.subject.subjectId },
      })),
      warnings: [],
    };
    return result;
  };

  return {
    async getPortableSummary(_request: AdminClientsPortableSummaryRequest): Promise<AdminClientsPortableSummaryResponse> {
      const result = await readCall(() => call("SELECT public.customer_support_summary($1) AS result", [operatorId]));
      const parsed = adminClientsPortableSummaryResponseSchema.parse(result); await audit("/api/bff/admin/clients/summary", {}, []); return parsed;
    },

    searchPortableClients,

    async getPortableClientDetail(request: AdminClientsPortableDetailRequest): Promise<AdminClientsPortableDetailResponse | null> {
      const result = await readCall(() => call("SELECT public.customer_support_detail($1,$2) AS result",
        [operatorId, request.subjectId]));
      const parsed = result === null ? null : adminClientsPortableDetailResponseSchema.parse(result); if (parsed) await audit("/api/bff/admin/clients/detail", { subjectId: request.subjectId }, [request.subjectId]); return parsed;
    },

    searchCustomerJourney,

    async getCustomerJourney(request) {
      let subjectId = request.subjectId?.trim() ?? "";
      if (!subjectId) {
        const found = await searchPortableClients({ query: displayQuery(request), page: 0, pageSize: request.pageSize, lifecycleStage: "all" }, "");
        if (found.candidates.length !== 1) return null;
        subjectId = found.candidates[0]!.subject.subjectId;
      }
      const result = await readCall(() => call("SELECT public.customer_support_journey($1,$2) AS result",
        [operatorId, subjectId]));
      const parsed = result === null ? null : customer360SnapshotResponseSchema.parse(result); if (parsed) await audit("/api/bff/admin/support/customer-journey", { subjectId }, [subjectId]); return parsed;
    },

    async issueRecovery(input) {
      if (input.operatorId !== operatorId) {
        throw new Error("customer_support_operator_scope_mismatch");
      }
      const token = createOpaqueToken();
      const tokenHash = digest(token);
      const fingerprint = digest(JSON.stringify({
        action: "issue_recovery",
        subjectId: input.subjectId,
        caseId: input.caseId,
      }));
      const expiresAt = new Date(now() + RECOVERY_TTL_MS).toISOString();
      const recoveryPath = `/konto/platnosc/napraw?token=${encodeURIComponent(token)}`;

      try {
        const result = await call("SELECT public.customer_support_issue_recovery($1,$2,$3,$4,$5,$6,$7,$8) AS result",
          [operatorId, input.subjectId, input.caseId, input.idempotencyKey, fingerprint, tokenHash, expiresAt, recoveryPath]);
        return parseRecoveryResult(result);
      } catch (error) {
        if (isIdempotencyConflict(error)) {
          return { outcome: "conflict", conflictCode: "idempotency_conflict" };
        }
        throw new Error("customer_support_recovery_failed");
      }
    },

    /**
     * The platform migration tree publishes no twin of
     * `customer_support_apply_subscription_action_v1`, so this composition holds
     * no operator subscription authority. It says so by name.
     *
     * The alternative — reaching for the subscriber's own self-service routine
     * with an operator's identity — would be an impersonation, and returning a
     * cheerful no-op would tell an operator a subscriber's cycle moved when
     * nothing did. Neither is available here; the refusal is.
     */
    async applySubscriptionAction() {
      throw new OperatorSubscriptionAuthorityUnavailableError();
    },

    /** Same absent authority as above for both contact corrections: no platform
     * twin exists, so a named refusal rather than a silent success. */
    async correctSubjectEmail() { throw new OperatorSubscriptionAuthorityUnavailableError(); },
    async correctSubjectPhone() { throw new OperatorSubscriptionAuthorityUnavailableError(); },

    /**
     * The one operator command this lane really runs.
     *
     * `customer_support_absorb_lead_v1` ships with a twin in `db/platform/migrations`,
     * so refusing here the way the three neighbours above must would be a lie about a
     * routine this deployment actually holds - and it is the routine that decides
     * whether an operator on the self-hosted runtime can free a squatted address at
     * all. Nothing in it is provider-specific: a lead carrying an identity is refused
     * rather than absorbed, so the routine never reaches an auth service, and the
     * referencing-table enumeration it fails closed on is stock `pg_constraint`.
     *
     * Argument order matches the managed call exactly, positionally rather than by
     * name, because that is the whole difference between the two lanes.
     */
    async absorbLead(input): Promise<OperatorLeadAbsorptionResult> {
      if (input.operatorId !== operatorId) throw new Error("customer_support_operator_scope_mismatch");
      let result: unknown;
      try {
        result = await call("SELECT public.customer_support_absorb_lead_v1($1,$2,$3,$4,$5,$6) AS result",
          [operatorId, input.customerId, input.leadId, input.expectedLeadEmail, input.idempotencyKey, new Date(now()).toISOString()]);
      } catch (error) {
        throw absorptionFailure(error);
      }
      // Deliberately outside the catch: an answer this lane cannot read is not an
      // upstream fault to be re-priced, and swallowing it here would turn a routine
      // that answered something unrecognized into an operator-inactive refusal.
      return leadAbsorption(result);
    },

    close: () => lane.close(),
  };
}

/**
 * The SQLSTATEs `customer_support_absorb_lead_v1` raises, priced for the route.
 *
 * Not the managed lane's `operatorCommandFailure`: that one also maps PostgREST's
 * PGRST202, a code no direct driver can ever receive, and it lives beside the
 * managed client. What this lane adds instead is 42883 - the twin migration is
 * absent from this deployment's tree - which is the honest name for a routine that
 * is missing rather than a command that was refused.
 */
function absorptionFailure(error: unknown): Error {
  const raw = (error ?? {}) as { code?: unknown; message?: unknown };
  const code = typeof raw.code === "string" ? raw.code : "";
  const message = typeof raw.message === "string" ? raw.message : "";
  if (code === "42501" || message.includes("communications_operator_inactive")) return new CustomerSupportOperatorInactiveError();
  if (code === "22023" || message.includes("customer_support_absorb_lead_invalid")) return new CustomerSupportCommandInvalidError();
  if (code === "23505" || message.includes("customer_support_idempotency_conflict")) return new CustomerSupportCommandIdempotencyConflictError();
  if (code === "42883" || /does not exist/i.test(message)) return new OperatorSubscriptionAuthorityUnavailableError();
  return new Error("customer_support_lead_absorption_failed");
}

async function readCall(work: () => Promise<unknown>): Promise<unknown> {
  try {
    return await work();
  } catch {
    throw new Error("customer_support_read_failed");
  }
}

function parseRecoveryResult(value: unknown): CustomerRecoveryAuthorityResult {
  if (!value || typeof value !== "object") throw new Error("customer_support_recovery_response_invalid");
  const row = value as Record<string, unknown>;
  const outcome = text(row.outcome);
  if (outcome === "issued" || outcome === "replayed") {
    const deliveryStatus = text(row.deliveryStatus ?? row.delivery_status);
    const auditEventId = text(row.auditEventId ?? row.audit_event_id);
    if (!deliveryStatus || !auditEventId) throw new Error("customer_support_recovery_response_invalid");
    return { outcome, deliveryStatus, auditEventId };
  }
  if (outcome === "refused") {
    const refusalCode = text(row.refusalCode ?? row.refusal_code);
    if (!refusalCode || !REFUSALS.has(refusalCode as CustomerRecoveryRefusalCode)) {
      throw new Error("customer_support_recovery_response_invalid");
    }
    return { outcome, refusalCode: refusalCode as CustomerRecoveryRefusalCode };
  }
  if (outcome === "conflict") {
    return { outcome, conflictCode: "idempotency_conflict" };
  }
  throw new Error("customer_support_recovery_response_invalid");
}

function displayQuery(request: Customer360LookupRequest): string {
  const query = request.query
    ?? request.subjectId
    ?? request.email
    ?? request.orderId
    ?? request.subscriptionId;
  if (!query) throw new Error("customer_support_lookup_required");
  return query;
}

function mapMatchedBy(
  value: AdminClientsPortableSearchResponse["candidates"][number]["matchedBy"],
): Customer360SearchResponse["candidates"][number]["matchedBy"] {
  if (value === "subject_id" || value === "email" || value === "text") return value;
  if (value === "order") return "order_id";
  if (value === "subscription") return "subscription_id";
  return "text";
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function isIdempotencyConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const row = error as { code?: unknown; message?: unknown };
  return row.code === "23505"
    || (typeof row.message === "string" && row.message.includes("idempotency_conflict"));
}
