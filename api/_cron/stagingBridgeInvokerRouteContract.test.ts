import { describe, expect, it } from "vitest";
import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import { runOmnipackStockSyncCron } from "./omnipackStockSyncJob.js";
import { runOmnipackReconciliationCron } from "./omnipackReconciliationJob.js";
import { runPromotionClaimSweepCron } from "../cron/promotion-claim-sweep.js";
// Concrete route requests exercise current authorization and driver mapping.
// They do not claim a database scheduler or historical bridge is installed.

const CRON_SECRET = "bridge-cron-secret";

/** Env with no staging marker of any kind: the production-shaped runtime. */
const NON_STAGING_ENV = {
  CRON_SECRET,
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  COMMERCE_PROMOTION_CLAIM_SWEEP_ENABLED: "true",
  COMMERCE_OMNIPACK_STOCK_SYNC_ENABLED: "true",
  COMMERCE_OMNIPACK_RECONCILIATION_ENABLED: "true",
};

// The staging project ref is one of the four markers every driver reader accepts,
// and any single one of them lifts the staging fence.
const STAGING_ENV = { ...NON_STAGING_ENV, STAGING_SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst" };

type BridgeCase = {
  name: string;
  /**
   * Runs the real route and reports the driver it resolved from the request, or
   * the refusal it produced instead. Each job exposes the resolved driver at a
   * different seam, so the adapter is per job rather than shared.
   */
  unconfigured(request: VercelRequest, env: Record<string, string | undefined>): Promise<{ status: number; body: Record<string, unknown> }>;
  unconfiguredError: string;
  drive(request: VercelRequest, env: Record<string, string | undefined>): Promise<{
    status: number;
    error?: unknown;
    driver?: string;
  }>;
};

const BRIDGES: BridgeCase[] = [
  {
    name: "promotion-claim-sweep",
    unconfigured: (request, env) => runPromotionClaimSweepCron(request, env),
    unconfiguredError: "supabase_env_required",
    // The sweep passes the driver as the ledger invocation source.
    async drive(request, env) {
      let seen: string | undefined;
      const resolveBinding = () => ({
        binding: {
          run: (work: (ports: unknown) => unknown) => work({
            sweepPort: {},
            jobRunLedger: {
              claimJobRun: (_job: string, invocation: { invocationSource?: string }) => {
                seen = invocation.invocationSource;
                return Promise.resolve({ acquired: false, reason: "driver_captured" });
              },
            },
          }),
        },
      });
      const result = await runPromotionClaimSweepCron(request, env as never, resolveBinding as never);
      return { status: result.status, error: result.body.error, driver: seen };
    },
  },
  {
    name: "omnipack-stock-sync",
    unconfigured: (request, env) => runOmnipackStockSyncCron(request, env),
    unconfiguredError: "omnipack_provider_not_configured",
    async drive(request, env) {
      const captured = capturingOmnipackGateway();
      const result = await runOmnipackStockSyncCron(
        request,
        env as never,
        captured.factory as never,
        (() => ({})) as never,
      );
      return { status: result.status, error: result.body.error, driver: captured.driver() };
    },
  },
  {
    name: "omnipack-reconciliation",
    unconfigured: (request, env) => runOmnipackReconciliationCron(request, env),
    unconfiguredError: "omnipack_provider_not_configured",
    async drive(request, env) {
      const captured = capturingOmnipackGateway();
      const result = await runOmnipackReconciliationCron(
        request,
        env as never,
        captured.factory as never,
        (() => ({})) as never,
      );
      return { status: result.status, error: result.body.error, driver: captured.driver() };
    },
  },
];

describe("cron route request authorization and driver mapping", () => {
  for (const bridge of BRIDGES) {
    describe(bridge.name, () => {
      it("refuses unsupported methods before authentication", async () => {
        expect(await bridge.drive(request("DELETE"), {})).toMatchObject({
          status: 405, error: "method_not_allowed",
        });
      });

      for (const method of ["GET", "POST"]) {
        it(`authenticates ${method} before running the job`, async () => {
          expect(await bridge.drive(request(method, "not-the-secret"), NON_STAGING_ENV)).toMatchObject({
            status: 401, error: "unauthorized", driver: undefined,
          });
        });

        it(`refuses the ${method} pg_cron driver in production`, async () => {
          expect(await bridge.drive(request(method), NON_STAGING_ENV)).toMatchObject({
            status: 403, error: "pg_cron_driver_requires_staging", driver: undefined,
          });
        });

        it(`passes the ${method} pg_cron driver to an explicitly configured staging claim`, async () => {
          expect(await bridge.drive(request(method), STAGING_ENV)).toMatchObject({
            status: 200, driver: "pg_cron",
          });
        });
      }

      it("keeps an unconfigured staging runtime refused by its real default binding", async () => {
        const result = await bridge.unconfigured(request("POST"), {
          ...STAGING_ENV,
          PLATFORM_BUNDLE: "vercel-supabase",
          SUPABASE_URL: undefined,
          SUPABASE_SERVICE_ROLE_KEY: undefined,
        });
        expect(result).toMatchObject({ status: 503, body: { error: bridge.unconfiguredError } });
      });
    });
  }
});

function request(method: string, token = CRON_SECRET): VercelRequest {
  return {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "x-openlup-scheduler-driver": "pg_cron",
    },
    query: {},
  } as VercelRequest;
}

/**
 * An omnipack cron gateway that records the driver it was asked to claim with and
 * then refuses the lease, so no provider or worker code runs.
 */
function capturingOmnipackGateway() {
  let driver: string | undefined;
  return {
    driver: () => driver,
    factory: () => ({
      async readLatestTerminalRunMetadata() {
        return null;
      },
      async runJob(input: { driver?: string }) {
        driver = input.driver;
        return { acquired: false as const, reason: "driver_captured" };
      },
    }),
  };
}
