import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CUSTOMER_SUBSCRIPTION_CONTROL_CONTRACT_VERSION,
  type CustomerSubscriptionControlResponse,
} from "../../../src/domains/customers/subscriptionControlContracts.js";
import type { CustomerSubscriptionControlPort } from "../../domains/customers/ports.js";

type Row = Record<string, unknown>;

export function createSupabaseCustomerSubscriptionControlPort({
  customerClient,
  serviceClient,
}: {
  customerClient: SupabaseClient;
  serviceClient: SupabaseClient;
}): CustomerSubscriptionControlPort {
  return {
    async getSnapshot(userId) {
      const clientId = await readClientId(customerClient, userId);
      if (!clientId) return null;
      const { data, error } = await customerClient
        .from("subscriptions")
        .select("id, status, cadence_days, next_cycle_at, edit_window_hours, template_version")
        .eq("client_id", clientId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      const subscriptions = (data ?? []) as Row[];
      const lines = await readLines(
        serviceClient,
        subscriptions.map((row) => text(row.id)),
      );
      return {
        contractVersion: CUSTOMER_SUBSCRIPTION_CONTROL_CONTRACT_VERSION,
        subscriptions: subscriptions.map((row) => {
          const subscriptionLines = lines.get(text(row.id)) ?? [];
          return {
            subscriptionId: text(row.id),
            status: text(row.status) as CustomerSubscriptionControlResponse["subscriptions"][number]["status"],
            cadenceDays: Number(row.cadence_days),
            nextCycleAt: nullableText(row.next_cycle_at),
            editCutoffAt: editCutoff(
              nullableText(row.next_cycle_at),
              Number(row.edit_window_hours ?? 72),
            ),
            templateVersion: Number(row.template_version),
            recurringTotal: recurringTotal(subscriptionLines),
            lines: subscriptionLines.map((line) => ({
              variantId: text(line.variant_id),
              quantity: Number(line.qty),
              isAddon: Boolean(line.is_addon),
              sortOrder: Number(line.sort_order),
            })),
          };
        }),
      };
    },
  };
}

async function readClientId(client: SupabaseClient, userId: string) {
  const { data, error } = await client
    .from("clients")
    .select("id")
    .eq("auth_user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return typeof data?.id === "string" ? data.id : null;
}

async function readLines(client: SupabaseClient, subscriptionIds: string[]) {
  const grouped = new Map<string, Row[]>();
  if (subscriptionIds.length === 0) return grouped;
  const { data, error } = await client
    .from("subscription_lines")
    .select("subscription_id, variant_id, qty, sort_order, is_addon, frozen_quote_line")
    .in("subscription_id", subscriptionIds)
    .order("sort_order", { ascending: true });
  if (error) throw error;
  for (const row of (data ?? []) as Row[]) {
    const subscriptionId = text(row.subscription_id);
    grouped.set(subscriptionId, [...(grouped.get(subscriptionId) ?? []), row]);
  }
  return grouped;
}

function recurringTotal(lines: Row[]) {
  let currency: string | null = null;
  let amountMinor = 0;
  for (const line of lines) {
    const frozen = record(line.frozen_quote_line);
    const unit = record(frozen?.unitPrice);
    const lineCurrency = nullableText(unit?.currency);
    const lineAmount = Number(unit?.amountMinor);
    if (!lineCurrency || !Number.isInteger(lineAmount) || lineAmount < 0) return null;
    if (currency && currency !== lineCurrency) return null;
    currency = lineCurrency;
    amountMinor += lineAmount * Number(line.qty);
  }
  return currency ? { amountMinor, currency } : null;
}

function editCutoff(nextCycleAt: string | null, hours: number) {
  if (!nextCycleAt) return null;
  return new Date(Date.parse(nextCycleAt) - hours * 3_600_000).toISOString();
}

function record(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : null;
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown) {
  return typeof value === "string" ? value : null;
}
