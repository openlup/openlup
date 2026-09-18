import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import { runOmnipackStockSyncCron } from "./omnipackStockSyncJob.js";
import { runOmnipackReconciliationCron } from "./omnipackReconciliationJob.js";
import { runPromotionClaimSweepCron } from "../cron/promotion-claim-sweep.js";
import {
  buildInvokerRequest,
  readInvokerRequest,
} from "../../src/lib/testSupport/stagingBridgeInvokerRequest.js";

// The cross-layer contract for the staging pg_cron bridges: what each invoker
// builds must be what the route it targets accepts. Why that needed saying at all
// is documented on the reader this drives - `stagingBridgeInvokerRequest.ts`.
//
// The fourth bridge, `outbox-dispatch`, is asserted the same way in
// `outboxDispatchJob.test.ts`. It lives there rather than here because that whole
// family is withheld from the public split, and a published file may not name a
// withheld one.

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
  /** `private.invoke_<function>_scheduler()` as written in the migrations. */
  invoker: string;
  /** The route file the invoker's path segment must name. */
  routeFile: string;
  /**
   * Runs the real route and reports the driver it resolved from the request, or
   * the refusal it produced instead. Each job exposes the resolved driver at a
   * different seam, so the adapter is per job rather than shared.
   */
  drive(request: VercelRequest, env: Record<string, string | undefined>): Promise<{
    status: number;
    error?: unknown;
    driver?: string;
  }>;
};

const BRIDGES: BridgeCase[] = [
  {
    invoker: "invoke_promotion_claim_sweep_scheduler",
    routeFile: "api/cron/promotion-claim-sweep.ts",
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
    invoker: "invoke_omnipack_stock_sync_scheduler",
    routeFile: "api/cron/omnipack-stock-sync.ts",
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
    invoker: "invoke_omnipack_reconciliation_scheduler",
    routeFile: "api/cron/omnipack-reconciliation.ts",
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

describe("staging bridge invokers and the cron routes they call", () => {
  for (const bridge of BRIDGES) {
    describe(bridge.invoker, () => {
      const sent = readInvokerRequest(bridge.invoker, CRON_SECRET);

      it("posts at a path that names a real cron route", () => {
        expect(sent.path).toBe(`/${routeSlug(bridge.routeFile)}`);
        expect(existsSync(bridge.routeFile)).toBe(true);
        // The migration name comes from the directory listing the reader walked,
        // so naming it here records which file the assertions above were read
        // from rather than re-checking that it exists.
        expect(sent.migration).toMatch(/^\d{14}_.+\.sql$/);
      });

      it("uses a method the route does not refuse", async () => {
        // A wrong bearer is the cheapest observation that the method got past the
        // method check: 401 can only be reached below it. 405 here is the exact
        // shape of the sweep's live failure.
        const refusal = await bridge.drive(
          buildInvokerRequest(sent, { Authorization: "Bearer not-the-secret" }) as never,
          NON_STAGING_ENV,
        );
        expect({ invoker: bridge.invoker, ...refusal }).toMatchObject({ status: 401 });
      });

      it("sends a driver the route reads, and the staging fence still refuses it in production", async () => {
        // One assertion, two properties. The route can only answer
        // `pg_cron_driver_requires_staging` if it read `pg_cron` out of the
        // headers this invoker builds - so a missing or misspelled header fails
        // here - and answering it at all is the production fence holding.
        const refused = await bridge.drive(buildInvokerRequest(sent) as never, NON_STAGING_ENV);
        expect({ invoker: bridge.invoker, ...refused }).toMatchObject({
          status: 403,
          error: "pg_cron_driver_requires_staging",
        });
      });

      it("reaches the job claim as pg_cron on a staging runtime", async () => {
        const accepted = await bridge.drive(buildInvokerRequest(sent) as never, STAGING_ENV);
        expect({ invoker: bridge.invoker, ...accepted }).toMatchObject({ driver: "pg_cron" });
        expect(accepted.status).not.toBe(405);
        expect(accepted.status).not.toBe(403);
      });
    });
  }
});

function routeSlug(routeFile: string): string {
  return routeFile.replace(/^.*\//, "").replace(/\.ts$/, "");
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
