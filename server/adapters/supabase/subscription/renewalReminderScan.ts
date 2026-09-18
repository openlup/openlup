import type {
  DueSoonSubscription,
  RenewalReminderScanPort,
} from "../../../domains/subscription/subscriptionRenewalReminderPort.js";

interface RenewalScanQueryBuilder {
  select(columns: string): RenewalScanQueryBuilder;
  eq(column: string, value: unknown): RenewalScanQueryBuilder;
  gte(column: string, value: unknown): RenewalScanQueryBuilder;
  lte(column: string, value: unknown): RenewalScanQueryBuilder;
  order(column: string, opts: { ascending: boolean }): RenewalScanQueryBuilder;
  limit(count: number): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

export interface RenewalScanSupabaseClient {
  from(table: string): RenewalScanQueryBuilder;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function createSupabaseRenewalReminderScanPort(
  client: RenewalScanSupabaseClient,
  now: () => number,
): RenewalReminderScanPort {
  return {
    async scanDueSoon(minDays, maxDays, limit, _signal): Promise<DueSoonSubscription[]> {
      const base = now();
      const from = new Date(base + minDays * DAY_MS).toISOString();
      const to = new Date(base + maxDays * DAY_MS).toISOString();
      const result = await client
        .from("subscriptions")
        .select("id, client_id, next_cycle_at")
        .eq("status", "active")
        .gte("next_cycle_at", from)
        .lte("next_cycle_at", to)
        .order("next_cycle_at", { ascending: true })
        .limit(limit);
      if (result.error) {
        throw new Error(
          `renewal_reminder_scan_failed: ${result.error.message ?? result.error.code ?? "unknown"}`,
        );
      }
      const rows = Array.isArray(result.data) ? (result.data as Array<Record<string, unknown>>) : [];
      return rows
        .filter(
          (r) =>
            typeof r.id === "string" &&
            typeof r.client_id === "string" &&
            typeof r.next_cycle_at === "string",
        )
        .map((r) => ({
          subscriptionId: r.id as string,
          clientId: r.client_id as string,
          nextCycleAt: r.next_cycle_at as string,
        }));
    },
  };
}
