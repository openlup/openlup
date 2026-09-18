import { formatCurrencyMinor } from "../../../../src/lib/currency/formatMinor.js";
import type { Locale } from "../../../../src/lib/i18n/resolveLocale.js";
import { starterPackMarkerSchema } from "../../../domains/subscription/starterPackCycle.js";
import type {
  StarterMoneyLabelFormatter,
  SubscriptionStarterPackPort,
} from "../../../domains/subscription/starterPackEmailFacts.js";

/**
 * Managed composition for the starter-pack lifecycle emails: the two Supabase
 * reads that answer the neutral `SubscriptionStarterPackPort`, plus the managed
 * money label the neutral fact builders format their amounts with.
 *
 * Both halves stay here so the domain states starter-pack facts without naming a
 * store, a currency or a locale.
 */

interface StarterStateRow {
  starter_pack?: unknown;
  template_version?: unknown;
  currency?: unknown;
}

interface StarterQuery<T> extends PromiseLike<{ data: T; error: unknown }> {
  select(columns: string): StarterQuery<T>;
  eq(column: string, value: unknown): StarterQuery<T>;
  order(column: string, options: { ascending: boolean }): StarterQuery<T>;
  limit(count: number): StarterQuery<T>;
}

export interface StarterPackEmailDbClient {
  from(table: string): StarterQuery<unknown>;
}

/**
 * Reads the marker for an email send. Two queries at most, and the second only
 * fires for a subscription that actually carries a marker — every ordinary
 * subscription costs exactly one extra `subscriptions` read per lifecycle email.
 */
export function createStarterPackContextPort(
  client: StarterPackEmailDbClient,
): SubscriptionStarterPackPort {
  return {
    async read(subscriptionId) {
      const state = await client
        .from("subscriptions")
        .select("starter_pack, template_version, currency")
        .eq("id", subscriptionId)
        .limit(1);
      if (state.error) return null;
      const row = firstRow(state.data) as StarterStateRow | null;
      if (!row || row.starter_pack === null || row.starter_pack === undefined) return null;
      const marker = starterPackMarkerSchema.safeParse(row.starter_pack);
      if (!marker.success) return null;

      const cycles = await client
        .from("subscription_cycles")
        .select("cycle_number")
        .eq("subscription_id", subscriptionId)
        .order("cycle_number", { ascending: false })
        .limit(1);
      if (cycles.error) return null;
      const latest = firstRow(cycles.data) as { cycle_number?: unknown } | null;
      const highest = Number(latest?.cycle_number ?? 0);
      return {
        marker: marker.data,
        templateVersion: Number(row.template_version ?? 0),
        upcomingCycleNumber: (Number.isFinite(highest) ? highest : 0) + 1,
        currency: typeof row.currency === "string" && row.currency.trim() ? row.currency.trim() : null,
      };
    },
  };
}

/**
 * The managed money label: the exact `PLN` / `pl-PL`|`en-GB` formatting the
 * starter-pack email facts carried inline before the split, so every rendered
 * amount stays byte-identical.
 */
export function createStarterPackMoneyLabel(locale: Locale): StarterMoneyLabelFormatter {
  return (amountMinor, currency) =>
    currency
      ? formatCurrencyMinor(amountMinor, {
          currency,
          locale: locale === "en" ? "en-GB" : "pl-PL",
        })
      : null;
}

function firstRow(data: unknown): unknown {
  if (Array.isArray(data)) return data[0] ?? null;
  return data ?? null;
}
