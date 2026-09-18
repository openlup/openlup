import {
  runLocalReferenceRenewalTickRequestSchema,
  runLocalReferenceRenewalTickResponseSchema,
  SUBSCRIPTION_RUNTIME_CONTRACT_VERSION,
  type RunLocalReferenceRenewalTickResponse,
} from "../../../src/domains/subscription/runtimeContracts.js";
import type { SubscriptionRuntimeClock } from "../../../src/domains/subscription/ports.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import { withObservedRoute } from "../../_lib/observability/route.js";
import type { HttpRequest, HttpResponse } from "../../_lib/types/http.js";
import {
  authorizeLocalReferenceAdmin,
  createLocalReferenceRenewalRuntimePorts,
  LOCAL_REFERENCE_RENEWAL_TICK_AT,
  localReferenceDemoProfileEnabled,
} from "../../adapters/localReferenceStoreAdapter.js";
import {
  claimJobRun,
  finishJobRun,
  type PlatformJobClient,
} from "../../adapters/supabase/platformJobRunLedger.js";
import { runSubscriptionRenewalBatch } from "../../domains/subscription/subscriptionRenewalInvocation.js";
import type { AdminAuthorization } from "../admin/commerce/shared.js";
import { readCommerceServiceDataGateway } from "../commerce/serviceDataGateway.js";

/**
 * `runSubscriptionRenewalBatch` deliberately keeps the platform-job lease in its
 * caller. This operator surface shares the *same* lease key as
 * `api/cron/subscription-renewal.ts` rather than minting a private one: a lease
 * only excludes work that shares its key, and both callers drive the identical
 * batch over the identical subscription rows. The two remain distinguishable in
 * `platform_job_runs` through `driver`, and `platform_claim_job_run` exempts
 * `manual_admin` from the active-driver check, so the operator tick cannot be
 * silenced by the control row's scheduler driver — while
 * `platform_job_controls.enabled = false` still stops it.
 */
export const LOCAL_REFERENCE_RENEWAL_TICK_JOB_NAME = "subscription-renewal-runtime";
export const LOCAL_REFERENCE_RENEWAL_TICK_DRIVER = "manual_admin" as const;
export const LOCAL_REFERENCE_RENEWAL_TICK_LEASE_SECONDS = 60;

interface RenewalTickHandlerDependencies {
  profileEnabled: () => boolean;
  authorizeAdmin: (req: HttpRequest) => Promise<AdminAuthorization>;
  runTick: () => Promise<RunLocalReferenceRenewalTickResponse>;
}

export function createLocalReferenceRenewalTickHandler(
  deps: RenewalTickHandlerDependencies,
) {
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
    // This gate intentionally precedes method, auth, env, and gateway work. The
    // operator surface must be indistinguishable from absent off the local profile.
    if (!deps.profileEnabled()) {
      sendBffError(res, "NOT_FOUND", "Reference renewal tick not found");
      return;
    }
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);

    let authorization: AdminAuthorization;
    try {
      authorization = await deps.authorizeAdmin(req);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization failed");
      return;
    }
    if (authorization.ok === false) {
      sendBffError(res, authorization.code, authorization.message);
      return;
    }

    const request = runLocalReferenceRenewalTickRequestSchema.safeParse(req.body === undefined ? {} : req.body);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid reference renewal tick request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const response = runLocalReferenceRenewalTickResponseSchema.safeParse(await deps.runTick());
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Reference renewal tick response invalid");
        return;
      }
      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Reference renewal tick failed");
    }
  };
}

export interface RenewalTickRunnerDependencies {
  readGateway: typeof readCommerceServiceDataGateway;
  claim: typeof claimJobRun;
  finish: typeof finishJobRun;
  runBatch: typeof runSubscriptionRenewalBatch;
}

export function createLocalReferenceRenewalTickRunner(
  overrides: Partial<RenewalTickRunnerDependencies> = {},
): () => Promise<RunLocalReferenceRenewalTickResponse> {
  const readGateway = overrides.readGateway ?? readCommerceServiceDataGateway;
  const claim = overrides.claim ?? claimJobRun;
  const finish = overrides.finish ?? finishJobRun;
  const runBatch = overrides.runBatch ?? runSubscriptionRenewalBatch;

  return async () => {
    const gateway = readGateway();
    if (!gateway) throw new Error("Service data gateway is not configured");

    return gateway.asService(async (client) => {
      const jobClient = client as unknown as PlatformJobClient;
      const lease = await claim(
        jobClient,
        LOCAL_REFERENCE_RENEWAL_TICK_JOB_NAME,
        LOCAL_REFERENCE_RENEWAL_TICK_DRIVER,
        LOCAL_REFERENCE_RENEWAL_TICK_LEASE_SECONDS,
      );
      // A concurrent tick is refused, not silently degraded into an empty run:
      // a zeroed result would be indistinguishable from "nothing was due".
      if (!lease.acquired || !lease.runId) {
        throw new Error(`Reference renewal tick lease unavailable (${lease.reason})`);
      }
      const runId = lease.runId;

      const clock: SubscriptionRuntimeClock = {
        now: () => new Date(LOCAL_REFERENCE_RENEWAL_TICK_AT),
      };
      const runtimePorts = createLocalReferenceRenewalRuntimePorts(client);
      try {
        const batch = await runBatch({
          ...runtimePorts,
          clock,
        });
        if (batch.kind === "due_list_failed") throw new Error(batch.reason);

        await finish(jobClient, LOCAL_REFERENCE_RENEWAL_TICK_JOB_NAME, runId, "success", {
          checked: batch.rows.length,
          updated: batch.startedRows,
          failures: batch.errors.length,
          skipped: false,
        });

        return {
          contractVersion: SUBSCRIPTION_RUNTIME_CONTRACT_VERSION,
          renewalTick: {
            asOf: LOCAL_REFERENCE_RENEWAL_TICK_AT,
            scanned: batch.rows.length,
            startedRows: batch.startedRows,
            deferredByBudget: batch.deferredByBudget,
            errors: batch.errors.length,
            results: batch.results.map((result) => ({
              subscriptionId: result.subscriptionId,
              outcome: result.outcome,
              cycleId: result.cycleId,
              orderId: result.orderId,
              paymentIntentId: result.paymentIntentId,
              reason: result.reason ?? null,
              dunningCaseId: result.dunningCaseId ?? null,
              retryAttempt: result.retryAttempt ?? null,
              replayed: result.replayed,
            })),
          },
        };
      } catch (failure) {
        // Release the lease before rethrowing so a failed tick cannot hold the
        // renewal job hostage for the whole lease window.
        await finish(jobClient, LOCAL_REFERENCE_RENEWAL_TICK_JOB_NAME, runId, "failed", {
          checked: 0,
          updated: 0,
          failures: 1,
          skipped: false,
          reason: failure instanceof Error ? failure.message.slice(0, 240) : String(failure),
        });
        throw failure;
      }
    });
  };
}

const handler = createLocalReferenceRenewalTickHandler({
  profileEnabled: localReferenceDemoProfileEnabled,
  authorizeAdmin: authorizeLocalReferenceAdmin,
  runTick: createLocalReferenceRenewalTickRunner(),
});

export default withObservedRoute({
  route: "/api/bff/subscriptions/renewal-ticks",
  domain: "subscription",
  surface: "admin",
  risk: "mutation",
  featureFlags: [],
}, handler);
