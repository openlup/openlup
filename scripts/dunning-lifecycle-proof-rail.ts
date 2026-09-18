// The proof's rail helpers: the fixtures it seeds, the rows it reads back, and
// the words it prints. Split from the journey so each file states one thing --
// the journey reads as the lifecycle, and this reads as the database it runs on.
import type { Pool } from "pg";

export const CLIENT = "11111111-1111-4111-8111-111111111111";
export const SUB_A = "22222222-2222-4222-8222-22222222222a";
export const SUB_B = "22222222-2222-4222-8222-22222222222b";
export const CYCLE_A = "33333333-3333-4333-8333-33333333333a";
export const CYCLE_B = "33333333-3333-4333-8333-33333333333b";
export const ORDER_A = "44444444-4444-4444-8444-44444444444a";
export const EMAIL = "portable-payer@example.invalid";
export const FAILED_TEMPLATE = "subscription-payment-failed-1";
export const EXPIRED_TEMPLATE = "subscription-payment-expired";
export const RECOVERED_TEMPLATE = "subscription-payment-recovered";
export const OCCURRED_AT = "2026-08-15T09:00:00.000Z";

export interface ProofRail {
  exec(sql: string, values?: unknown[]): Promise<void>;
  rows<T>(sql: string, values?: unknown[]): Promise<T[]>;
  one<T>(sql: string, values?: unknown[]): Promise<T>;
  count(table: string): Promise<number>;
  seed(): Promise<void>;
  assertNoticeError(id: string, expected: string): Promise<void>;
  assertCardinalities(): Promise<void>;
}

export function createProofRail(pool: Pool): ProofRail {
  const exec = async (sql: string, values: unknown[] = []) => { await pool.query(sql, values); };
  const rows = async <T>(sql: string, values: unknown[] = []) => (await pool.query(sql, values)).rows as T[];
  const one = async <T>(sql: string, values: unknown[] = []) => {
    const found = await rows<T>(sql, values);
    assert(found.length === 1, `expected exactly one row for ${sql}`);
    return found[0]!;
  };
  const count = async (table: string) => {
    const [row] = await rows<{ n: string }>(`SELECT count(*)::text AS n FROM public.${table}`);
    return Number(row!.n);
  };
  return {
    exec,
    rows,
    one,
    count,
    async seed() {
      await exec(
        "INSERT INTO public.clients (id, email, first_name, country) VALUES ($1, $2, $3, $4)",
        [CLIENT, EMAIL, "Ada", "XX"],
      );
      for (const [subscription, cycle] of [[SUB_A, CYCLE_A], [SUB_B, CYCLE_B]] as const) {
        await exec(
          "INSERT INTO public.subscriptions (id, client_id, cadence_days, next_cycle_at) VALUES ($1, $2, 28, now() + interval '3 days')",
          [subscription, CLIENT],
        );
        await exec(
          "INSERT INTO public.subscription_cycles (id, subscription_id, scheduled_at, status) VALUES ($1, $2, now(), 'payment_pending')",
          [cycle, subscription],
        );
      }
      await exec(
        "INSERT INTO public.commerce_orders (id, subscription_cycle_id, status) VALUES ($1, $2, 'pending_payment')",
        [ORDER_A, CYCLE_A],
      );
    },
    async assertNoticeError(id, expected) {
      const notice = await one<{ status: string; error: string }>(
        "SELECT status, error FROM public.subscription_dunning_notifications WHERE id = $1", [id],
      );
      assert(notice.status === "skipped", `expected a durable skip, got ${notice.status}`);
      assert(notice.error === expected, `expected ${expected}, got ${notice.error}`);
    },
    async assertCardinalities() {
      const cases = await count("subscription_dunning_cases");
      assert(cases === 2, `expected exactly two cases, found ${cases}`);
      const perKind = await rows<{ case_id: string; notification_kind: string; retry_attempt: number; n: string }>(
        `SELECT case_id, notification_kind, retry_attempt, count(*)::text AS n
           FROM public.subscription_dunning_notifications
          GROUP BY case_id, notification_kind, retry_attempt`,
      );
      for (const row of perKind) {
        assert(row.n === "1", `duplicate notice for ${row.case_id}/${row.notification_kind}/${row.retry_attempt}`);
      }
      const tokens = await count("commerce_checkout_recovery_tokens");
      assert(tokens === 1, `expected exactly one repair token, found ${tokens}`);
      report("cardinality", `cases=${cases} notices=${perKind.length} duplicates=0 tokens=${tokens}`);
    },
  };
}

/** Every SUPABASE_* variable, gone, before a single module can read one. */
export function deleteManagedEnvironment(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("SUPABASE_") || key.startsWith("VITE_SUPABASE_")) delete process.env[key];
  }
}

export function report(leg: string, detail: string): void {
  process.stdout.write(`DUNNING_LIFECYCLE_LEG ${leg}: ${detail}\n`);
}

export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
