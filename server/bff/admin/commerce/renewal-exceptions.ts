import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { sendBffError } from "../../../_lib/bff/response.js";
import type { ObservabilitySnapshot, RuntimeFlagName } from "../../../../src/domains/platform/observabilityContracts.js";
import type { AdminCommerceRenewalExceptionEvidenceSnapshot } from "../../../../src/domains/commerce/renewalExceptionContracts.js";
import { createAdminCommerceRenewalExceptionsHandler } from "../../../domains/commerce/commerceRenewalExceptionHandlers.js";
import {
  createSupabaseObservabilityEvidencePort,
  type SupabaseObservabilityClient,
} from "../../../adapters/supabase/platform/observabilityEvidencePort.js";
import {
  collectDunningRecoveryBaseline,
  createDunningRecoveryBaselineReader,
  type DunningRecoveryBaseline,
  type DunningRecoveryBaselineReader,
} from "../../../adapters/supabase/platform/dunningRecoveryBaseline.js";
import type { ObservabilityEvidenceClient } from "../../../adapters/supabase/platform/observabilityEvidenceQueries.js";
import { readOpenDeliveryAlignmentCases } from "../../../adapters/subscriptionDeliveryAlignmentGateway.js";
import {
  authorizeCommerceAdminWithUser,
  createAdminAuthClient,
  createServiceRoleClient,
  readBearerToken,
  readSupabaseAdminCommerceEnv,
} from "./shared.js";

const OBSERVABILITY_FLAGS: RuntimeFlagName[] = [
  "COMMERCE_PSP_OBSERVABILITY_ENABLED",
  "COMMERCE_SUBSCRIPTION_RENEWAL_RUNTIME_ENABLED",
  "COMMERCE_SUBSCRIPTION_DELIVERY_REMINDERS_ENABLED",
];

function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const env = readSupabaseAdminCommerceEnv();
  if (!env) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin commerce renewal exceptions are not configured");
    return Promise.resolve();
  }

  const accessToken = readBearerToken(req);
  const authClient = createAdminAuthClient(env, accessToken);
  const serviceClient = createServiceRoleClient(env);

  return createAdminCommerceRenewalExceptionsHandler({
    renewalExceptionPort: createRenewalExceptionEvidencePort(
      createSupabaseObservabilityEvidencePort(
        serviceClient as unknown as SupabaseObservabilityClient,
        readRuntimeFlags(),
        { readOpenDeliveryAlignmentCases: () => readOpenDeliveryAlignmentCases(serviceClient) },
      ),
      createDunningRecoveryBaselineReader(serviceClient as unknown as ObservabilityEvidenceClient),
    ),
    authorizeAdmin: () => authorizeCommerceAdminWithUser(authClient, accessToken),
  })(req, res);
}

export function createRenewalExceptionEvidencePort(
  port: { collectSnapshot(now: Date): Promise<ObservabilitySnapshot> },
  baselineReader: DunningRecoveryBaselineReader,
) {
  return {
    async collectEvidence(
      now: Date,
      options: { windowDays: number },
    ): Promise<AdminCommerceRenewalExceptionEvidenceSnapshot> {
      return {
        ...mapSnapshotToRenewalExceptionEvidence(await port.collectSnapshot(now)),
        dunningRecovery: await collectDunningRecoveryBaselineOrNothing(baselineReader, now, options.windowDays),
      };
    },
  };
}

/**
 * The baseline is a months-spanning read bolted onto a route whose real job is
 * the exception queue an operator triages from. It is allowed to fail and it is
 * NOT allowed to take the queue down with it: a throw here becomes an absent
 * baseline, never a failed response. Logged rather than swallowed silently, so a
 * baseline that is permanently absent is discoverable instead of merely quiet.
 */
async function collectDunningRecoveryBaselineOrNothing(
  reader: DunningRecoveryBaselineReader,
  now: Date,
  windowDays: number,
): Promise<DunningRecoveryBaseline | undefined> {
  try {
    return await collectDunningRecoveryBaseline(reader, { now, windowDays });
  } catch (error) {
    console.warn("[admin-commerce-renewal-exceptions] dunning recovery baseline unavailable", {
      windowDays,
      reason: error instanceof Error ? error.message : "unknown",
    });
    return undefined;
  }
}

export function mapSnapshotToRenewalExceptionEvidence(
  snapshot: ObservabilitySnapshot,
): AdminCommerceRenewalExceptionEvidenceSnapshot {
  return {
    checkedAt: snapshot.checkedAt,
    dueCycleWithoutOrderCount: snapshot.subscriptions.dueCycleWithoutOrderCount,
    dueCycleEvidence: (snapshot.subscriptions.evidence ?? [])
      .filter((row) => row.kind === "due_cycle_without_order")
      .map((row) => ({
        kind: "due_cycle_without_order" as const,
        subscriptionId: row.subscriptionId,
        nextCycleAt: row.nextCycleAt,
        ageSeconds: row.ageSeconds,
        observedAt: row.observedAt,
        triageContext: row.triageContext,
      })),
    paymentEvidence: snapshot.payments.evidence
      .filter((row) =>
        row.kind === "prepared_without_provider_ack" &&
        Boolean(row.subscriptionId?.trim()) &&
        Boolean(row.subscriptionCycleId?.trim()),
      )
      .map((row) => ({
        kind: "prepared_without_provider_ack" as const,
        provider: row.provider,
        paymentIntentId: row.paymentIntentId,
        paymentAttemptId: row.paymentAttemptId,
        orderId: row.orderId,
        subscriptionId: row.subscriptionId,
        subscriptionCycleId: row.subscriptionCycleId,
        ageSeconds: row.ageSeconds,
        observedAt: row.observedAt,
      })),
    fulfillmentEvidence: (snapshot.subscriptions.evidence ?? [])
      .filter((row) => row.kind === "paid_renewal_without_fulfillment")
      .map((row) => ({
        kind: "paid_renewal_without_fulfillment" as const,
        subscriptionId: row.subscriptionId,
        subscriptionCycleId: row.subscriptionCycleId,
        orderId: row.orderId,
        ageSeconds: row.ageSeconds,
        observedAt: row.observedAt,
        triageContext: row.triageContext,
      })),
  };
}

function readRuntimeFlags(): Partial<Record<RuntimeFlagName, boolean>> {
  return Object.fromEntries(OBSERVABILITY_FLAGS.map((flag) => [flag, process.env[flag] === "true"]));
}

export default withObservedRoute({
  route: "/api/bff/admin/commerce/renewal-exceptions",
  domain: "commerce",
  surface: "admin",
  risk: "read",
  featureFlags: OBSERVABILITY_FLAGS,
}, handler);
