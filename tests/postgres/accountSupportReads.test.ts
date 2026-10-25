import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { createM12SupportReadBinding } from "../../server/runtime/public-reference/m12SupportReadBinding.js";
import {
  resolveCustomerDiagnosticHistoryBinding,
  closeCustomerDiagnosticRuntimeLanes
} from "../../server/runtime/observability/customerDiagnosticHistoryBinding.js";
import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import {
  closePostgres,
  dockerAvailable,
  runPostgresContainer,
  waitForPostgresTcpReady,
  postgresSetupTimeoutMs,
  postgresTeardownTimeoutMs,
  type PostgresContainer
} from "../helpers/postgresContainer.js";

const subject = "d2000000-0000-4000-8000-000000000001",
  other = "d2000000-0000-4000-8000-000000000002";
const operator = "d2000000-0000-4000-8000-000000000003",
  denied = "d2000000-0000-4000-8000-000000000004";
let pool: Pool | undefined, container: PostgresContainer | undefined;
let binding: ReturnType<typeof createM12SupportReadBinding>;
const business = async () => (await pool!.query("SELECT id,principal_id,email,lifecycle_stage FROM public.clients ORDER BY id")).rows;
let before: unknown;
beforeAll(
  async () => {
    if (!await dockerAvailable()) throw new Error(
      "R2 PostgreSQL acceptance proof unavailable: Docker daemon unreachable; this is missing proof, never a skip-pass"
    );
    container = await runPostgresContainer({ name: `m12-r2-${process.pid}`, password: "synthetic-read-proof" });
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("R2 PostgreSQL TCP unavailable");
    pool = new Pool({ connectionString: container.connectionString });
    await createPostgresMigrationRunner({ connectionString: container.connectionString }, { poolFactory: () => pool! }).apply();
    await pool.query(
      "INSERT INTO public.clients(id,principal_id,email,lifecycle_stage) VALUES ($1,$1,'read-a@example.invalid','customer'),($2,$2,'read-b@example.invalid','customer')",
      [subject, other]
    );
    await pool.query(
      "INSERT INTO public.platform_communication_operators(principal_id,active) VALUES ($1,true)",
      [operator]
    );
    const env = {
      PLATFORM_BUNDLE: "node-postgres",
      DATABASE_URL: container.connectionString,
      COMMERCE_CUSTOMER_DIAGNOSTIC_HISTORY_ENABLED: "true",
      CUSTOMER_DIAGNOSTIC_RETENTION_DAYS: "30"
    };
    const diagnostics = resolveCustomerDiagnosticHistoryBinding({ headers: {} } as VercelRequest, env);
    binding = createM12SupportReadBinding({
      enabled: true,
      graph: "native",
      authorize: async () => ({ operatorId: operator, isMachineActor: false }),
      native: { connectionString: container.connectionString },
      diagnostics
    });
    before = await business();
  },
  postgresSetupTimeoutMs
);
afterAll(
  async () => {
    await closeCustomerDiagnosticRuntimeLanes();
    await closePostgres(container, pool);
  },
  postgresTeardownTimeoutMs
);
it.each(["search", "summary", "snapshot"] as const)(
  "reads authorized native %s through the complete catalogue without business changes", async method => {
    if (method === "search") {
      const result = await binding.searchCustomerJourney({ query: "read-", pageSize: 1 });
      expect(result).toHaveProperty("candidates");
      if (!("candidates" in result)) throw new Error("native_search_refused");
      expect(result.candidates).toHaveLength(1);
    } else if (method === "summary") {
      expect(await binding.getPortableSummary({})).toMatchObject({ summary: { totalSubjects: 2 } });
    } else {
      expect(await binding.getCustomerJourney({ subjectId: subject, pageSize: 10 })).toMatchObject({ subject: { subjectId: subject } });
    }
    expect(await business()).toEqual(before);
  }
);
it("refuses an actual inactive native operator without business changes", async () => {
  const inactive = createM12SupportReadBinding({ enabled: true, graph: "native",
    authorize: async () => ({ operatorId: denied, isMachineActor: false }),
    native: { connectionString: container!.connectionString }
  });
  // The native read adapter translates SQL refusals to this public error.
  await expect(inactive.getCustomerJourney({ subjectId: other, pageSize: 10 })).rejects.toThrow(/^customer_support_read_failed$/);
  expect(await business()).toEqual(before);
});
it("retains the independent native diagnostic read without business changes", async () => {
  expect(await binding.history({ contractVersion: "customer-diagnostic-history.v2",
    segmentId: "d2000000-0000-4000-8000-000000000099", pageSize: 10 })).toBeNull();
  expect(await business()).toEqual(before);
});
