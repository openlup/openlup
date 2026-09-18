import type { SupabaseClient } from "@supabase/supabase-js";
import type { CommunicationAdminEmailSendsReadPort } from "../../../src/domains/communications/ports.js";
import type { Database } from "../../../src/integrations/supabase/types.js";
import {
  enrichEmailSendsWithDeliveryEvidence,
  findMatchingEmailSendIds,
} from "./adminEmailSendsDeliveryEvidence.js";

export type Client = SupabaseClient<Database>;
type AdminEmailSendsStats = {
  totalSent: number;
  delivered: number;
  opened: number;
  clicked: number;
};
type AdminEmailSendsStatsRpcClient = {
  rpc(
    functionName:
      | "communication_admin_email_sends_stats"
      | "communication_admin_email_template_slugs",
    args: Record<string, never>,
  ): PromiseLike<{
    data: unknown;
    error: unknown | null;
  }>;
};
type EmailSendRow = Database["public"]["Tables"]["email_sends"]["Row"];
type EmailEventRow = Database["public"]["Tables"]["email_events"]["Row"];
type TesterIdentity = Pick<
  Database["public"]["Tables"]["testers"]["Row"],
  "first_name" | "last_name" | "email"
>;
export type EmailSendWithTesterRow = EmailSendRow & {
  testers: TesterIdentity | null;
  delivery_aggregate_id?: string | null;
  delivery_last_error_code?: string | null;
  delivery_order_number?: string | null;
  delivery_outbox_event_id?: string | null;
  delivery_status?: string | null;
  recipient_label?: string | null;
};

export function createAdminEmailSendsReadPort(
  client: Client,
): CommunicationAdminEmailSendsReadPort {
  return {
    async getAdminEmailSends(request) {
      const [stats, templateSlugs, sendIds] = await Promise.all([
        readStats(client),
        readTemplateSlugs(client),
        findMatchingEmailSendIds(client, request),
      ]);

      if (sendIds && sendIds.length === 0) {
        return {
          stats,
          templateSlugs,
          sends: [],
          totalCount: 0,
          eventsSummary: {},
        };
      }

      const [sends, totalCount] = await Promise.all([
        readSends(client, request, sendIds),
        readTotalCount(client, request, sendIds),
      ]);
      const enrichedSends = await enrichEmailSendsWithDeliveryEvidence(client, sends);

      return {
        stats,
        templateSlugs,
        sends: enrichedSends,
        totalCount,
        eventsSummary: await readEventsSummary(client, enrichedSends.map((send) => send.id)),
      };
    },

    async getAdminEmailSendEvents({ sendId }) {
      const { data, error } = await client
        .from("email_events")
        .select("*")
        .eq("send_id", sendId)
        .order("timestamp", { ascending: true });
      if (error) throw error;

      return { events: (data ?? []) as EmailEventRow[] };
    },
  };
}

async function readStats(client: Client): Promise<AdminEmailSendsStats> {
  const { data, error } = await (client as unknown as AdminEmailSendsStatsRpcClient)
    .rpc("communication_admin_email_sends_stats", {});
  if (error) throw error;
  if (!isAdminEmailSendsStats(data)) throw new Error("admin_email_sends_stats_invalid_response");
  return data;
}

function isAdminEmailSendsStats(value: unknown): value is AdminEmailSendsStats {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const stats = value as Record<string, unknown>;
  return ["totalSent", "delivered", "opened", "clicked"].every((key) =>
    typeof stats[key] === "number" && Number.isSafeInteger(stats[key]) && stats[key] >= 0
  );
}

async function readTemplateSlugs(client: Client): Promise<string[]> {
  const { data, error } = await (client as unknown as AdminEmailSendsStatsRpcClient)
    .rpc("communication_admin_email_template_slugs", {});
  if (error) throw error;
  if (!isAdminEmailTemplateSlugs(data)) {
    throw new Error("admin_email_template_slugs_invalid_response");
  }
  return [...data].sort();
}

function isAdminEmailTemplateSlugs(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every((slug) => typeof slug === "string" && slug.length > 0)
    && new Set(value).size === value.length;
}

async function readSends(
  client: Client,
  request: Parameters<CommunicationAdminEmailSendsReadPort["getAdminEmailSends"]>[0],
  sendIds: string[] | null,
): Promise<EmailSendWithTesterRow[]> {
  let query = client
    .from("email_sends")
    .select("*, testers!email_sends_tester_id_fkey(first_name, last_name, email)")
    .order("created_at", { ascending: false })
    .range(request.page * request.pageSize, (request.page + 1) * request.pageSize - 1);

  if (request.status !== "all") query = query.eq("status", request.status);
  if (request.template !== "all") query = query.eq("template_slug", request.template);
  if (sendIds) query = query.in("id", sendIds);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as EmailSendWithTesterRow[];
}

async function readTotalCount(
  client: Client,
  request: Parameters<CommunicationAdminEmailSendsReadPort["getAdminEmailSends"]>[0],
  sendIds: string[] | null,
): Promise<number> {
  let query = client.from("email_sends").select("*", { count: "exact", head: true });

  if (request.status !== "all") query = query.eq("status", request.status);
  if (request.template !== "all") query = query.eq("template_slug", request.template);
  if (sendIds) query = query.in("id", sendIds);

  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

async function readEventsSummary(client: Client, sendIds: string[]) {
  if (sendIds.length === 0) return {};

  const { data, error } = await client
    .from("email_events")
    .select("send_id, event_type")
    .in("send_id", sendIds);
  if (error) throw error;

  const map: Record<string, Set<string>> = {};
  for (const event of data ?? []) {
    if (!event.send_id) continue;
    if (!map[event.send_id]) map[event.send_id] = new Set();
    if (event.event_type) map[event.send_id].add(event.event_type);
  }

  return Object.fromEntries(Object.entries(map).map(([id, types]) => [id, [...types]]));
}
