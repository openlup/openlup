import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";

export interface CatalogPolicyOverlapConcurrencyOptions {
  connectionString: string;
  bundle: "managed" | "portable";
  runId?: string;
}

const policyInsert = `
  INSERT INTO public.subscription_price_policy_revisions (
    id,
    price_list_id,
    region_code,
    currency,
    channel,
    revision_no,
    discount_bps,
    rounding_quantum_minor,
    rounding_rule,
    digest,
    effective_from,
    effective_to
  ) VALUES ($1, $2, 'ZZ', 'ZZZ', 'concurrency-proof', $3, 1000, 10, 'FLOOR_TO_QUANTUM', $4, $5, NULL)
`;

const READ_COMMITTED = "read committed";
const REPEATABLE_READ = "repeatable read";

function digest(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function pgErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function pgErrorMessage(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message)
    : undefined;
}

/**
 * This proof deliberately uses two `pg` clients, not two queries borrowed from
 * one pool connection. Both transactions explicitly use READ COMMITTED. The
 * first commits its open interval before the second may leave the keyed
 * advisory lock, so the second writer must observe the committed range and
 * refuse rather than also commit.
 *
 * It leaves one committed policy. Call it only after replaying a disposable
 * managed or portable database; the caller owns dropping that database after
 * the proof.
 */
export async function runCatalogPolicyOverlapConcurrencyProof(
  options: CatalogPolicyOverlapConcurrencyOptions,
): Promise<void> {
  requireCondition(options.bundle === "managed" || options.bundle === "portable", "catalog_policy_overlap_unknown_bundle");
  const runId = options.runId ?? randomUUID();
  const setup = new Client({ connectionString: options.connectionString });
  const first = new Client({ connectionString: options.connectionString });
  const second = new Client({ connectionString: options.connectionString });
  const priceListId = randomUUID();
  const firstPolicyId = randomUUID();
  const secondPolicyId = randomUUID();

  try {
    await Promise.all([setup.connect(), first.connect(), second.connect()]);
    await setup.query(
      `INSERT INTO public.price_lists (id, name, region_code, currency, status)
       VALUES ($1, $2, 'ZZ', 'ZZZ', 'draft')`,
      [priceListId, `catalog-policy-concurrency-${runId}`],
    );

    const [{ rows: firstBackendRows }, { rows: secondBackendRows }] = await Promise.all([
      first.query<{ backend_pid: number }>("SELECT pg_backend_pid() AS backend_pid"),
      second.query<{ backend_pid: number }>("SELECT pg_backend_pid() AS backend_pid"),
    ]);
    const firstBackendPid = firstBackendRows[0]?.backend_pid;
    const secondBackendPid = secondBackendRows[0]?.backend_pid;
    requireCondition(typeof firstBackendPid === "number", "catalog_policy_overlap_missing_first_backend_pid");
    requireCondition(typeof secondBackendPid === "number", "catalog_policy_overlap_missing_second_backend_pid");
    requireCondition(firstBackendPid !== secondBackendPid, "catalog_policy_overlap_requires_two_distinct_clients");

    await Promise.all([
      beginAtIsolation(first, READ_COMMITTED),
      beginAtIsolation(second, READ_COMMITTED),
    ]);
    await first.query(policyInsert, [
      firstPolicyId,
      priceListId,
      1,
      digest(`${runId}:first`),
      "2040-01-01T00:00:00.000Z",
    ]);

    const blockedSecondInsert = second.query(policyInsert, [
      secondPolicyId,
      priceListId,
      2,
      digest(`${runId}:second`),
      "2040-01-15T00:00:00.000Z",
    ]).then(
      () => new Error("concurrent overlapping policy insert unexpectedly succeeded"),
      (error: unknown) => error,
    );

    await waitForAdvisoryLock(setup, secondBackendPid);

    await first.query("COMMIT");
    const secondError = await blockedSecondInsert;
    requireCondition(
      pgErrorCode(secondError) === "23P01",
      `catalog_policy_overlap_second_writer_expected_23P01_observed_${pgErrorCode(secondError) ?? "none"}`,
    );
    await second.query("ROLLBACK");
  } finally {
    await Promise.allSettled([
      first.query("ROLLBACK"),
      second.query("ROLLBACK"),
    ]);
    await Promise.allSettled([setup.end(), first.end(), second.end()]);
  }
}

/**
 * The advisory lock cannot repair a REPEATABLE READ snapshot: after waiting,
 * its query could still miss the first writer's committed interval. The trigger
 * must therefore refuse this transaction shape before taking the lock.
 */
export async function runCatalogPolicyOverlapIsolationRefusalProof(
  options: CatalogPolicyOverlapConcurrencyOptions,
): Promise<void> {
  requireCondition(options.bundle === "managed" || options.bundle === "portable", "catalog_policy_overlap_unknown_bundle");
  const runId = options.runId ?? randomUUID();
  const setup = new Client({ connectionString: options.connectionString });
  const writer = new Client({ connectionString: options.connectionString });
  const priceListId = randomUUID();
  const policyId = randomUUID();

  try {
    await Promise.all([setup.connect(), writer.connect()]);
    await setup.query(
      `INSERT INTO public.price_lists (id, name, region_code, currency, status)
       VALUES ($1, $2, 'ZZ', 'ZZZ', 'draft')`,
      [priceListId, `catalog-policy-isolation-${runId}`],
    );

    await beginAtIsolation(writer, REPEATABLE_READ);
    const refusal = await writer.query(policyInsert, [
      policyId,
      priceListId,
      1,
      digest(`${runId}:repeatable-read`),
      "2041-01-01T00:00:00.000Z",
    ]).then(
      () => new Error("repeatable-read policy insert unexpectedly succeeded"),
      (error: unknown) => error,
    );
    requireCondition(
      pgErrorCode(refusal) === "0A000"
        && pgErrorMessage(refusal) === "subscription_price_policy_revision_overlap_requires_read_committed",
      `catalog_policy_overlap_repeatable_read_expected_refusal_observed_${pgErrorCode(refusal) ?? "none"}`,
    );
    await writer.query("ROLLBACK");
  } finally {
    await writer.query("ROLLBACK").catch(() => {});
    await setup.query("DELETE FROM public.price_lists WHERE id = $1", [priceListId]).catch(() => {});
    await Promise.allSettled([setup.end(), writer.end()]);
  }
}

async function beginAtIsolation(client: Client, isolation: typeof READ_COMMITTED | typeof REPEATABLE_READ): Promise<void> {
  const clause = isolation === READ_COMMITTED ? "READ COMMITTED" : "REPEATABLE READ";
  await client.query(`BEGIN ISOLATION LEVEL ${clause}`);
  const result = await client.query<{ transaction_isolation: string }>("SHOW transaction_isolation");
  requireCondition(result.rows[0]?.transaction_isolation === isolation, `catalog_policy_overlap_isolation_expected_${isolation}`);
}

async function waitForAdvisoryLock(
  inspector: Client,
  backendPid: number,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const { rows } = await inspector.query<{
      wait_event_type: string | null;
      wait_event: string | null;
    }>(
      `SELECT wait_event_type, wait_event
         FROM pg_stat_activity
        WHERE pid = $1`,
      [backendPid],
    );
    const wait = rows[0];
    if (wait?.wait_event_type === "Lock" && wait.wait_event?.toLowerCase() === "advisory") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("catalog_policy_overlap_second_writer_never_waited_on_advisory_lock");
}
