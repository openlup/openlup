import type { MarketingPrelaunchReadPort } from "../../../../src/domains/marketing/prelaunch/ports.js";
import type { PrelaunchLeadSourceRef } from "../../../../src/domains/marketing/prelaunch/contracts.js";
import {
  buildPrelaunchLeadDetail,
  buildPrelaunchLeads,
  type PrelaunchClientRow,
  type PrelaunchFeedbackRow,
  type PrelaunchTesterRow,
  type PrelaunchWaitlistRow,
} from "../../../domains/marketing/prelaunch/readModel.js";

const MAX_SOURCE_ROWS = 1000;
const TESTER_COLUMNS = [
  "id,email,first_name,last_name,phone,status,created_at,delivered_at",
  "dog_name,dog_breed,dog_age,dog_weight_kg,cat_name,cat_breed,cat_age,cat_weight_kg,pet_type",
  "verification_consent,newsletter_consent,email_sequence_paused",
].join(",");
const WAITLIST_BASE_COLUMNS = "id,email,first_name,last_name,created_at,dog_name,dog_breed,dog_age,dog_weight_kg,marketing_launch_offer_consent";
const WAITLIST_COLUMNS = `${WAITLIST_BASE_COLUMNS},source,locale`;
const FEEDBACK_COLUMNS = "id,tester_id,submitted_at,section_b_submitted_at,section_c_submitted_at,overall_rating,nps_rating,photo_urls";
const CLIENT_COLUMNS = "id,email,lifecycle_stage";

type TableName = "testers" | "waitlist" | "feedback" | "clients";

export interface AdminPrelaunchSupabaseClient {
  from(table: TableName): PrelaunchQuery;
}

type PrelaunchQueryResult = {
  data: unknown[] | null;
  error: { message?: string } | null;
};

interface PrelaunchQuery extends PromiseLike<PrelaunchQueryResult> {
  select(columns: string): PrelaunchQuery;
  order(column: string, options: { ascending: boolean }): PrelaunchQuery;
  limit(count: number): PrelaunchQuery;
  in(column: string, values: readonly string[]): PrelaunchQuery;
  eq(column: string, value: string): PrelaunchQuery;
}

export function createSupabaseAdminPrelaunchLeadsPort(
  client: AdminPrelaunchSupabaseClient,
): MarketingPrelaunchReadPort {
  return {
    async listPrelaunchLeads(request) {
      const [testers, waitlist] = await Promise.all([
        readTesters(client),
        readWaitlist(client),
      ]);
      const feedback = await readFeedback(client, testers.map((row) => row.id));
      const clients = await readClients(client, emailsFrom(testers, waitlist));
      return buildPrelaunchLeads({ testers, waitlist, feedback, clients, request });
    },

    async getPrelaunchLead(request) {
      const [sourceTable, sourceId] = splitSourceRef(request.sourceRef);
      const sourceRows = sourceTable === "testers"
        ? { testers: await readTesterById(client, sourceId), waitlist: [] as PrelaunchWaitlistRow[] }
        : { testers: [] as PrelaunchTesterRow[], waitlist: await readWaitlistById(client, sourceId) };
      const sourceEmail = sourceRows.testers[0]?.email ?? sourceRows.waitlist[0]?.email;
      const [linkedTesters, linkedWaitlist] = sourceEmail
        ? await Promise.all([readTestersByEmail(client, sourceEmail), readWaitlistByEmail(client, sourceEmail)])
        : [sourceRows.testers, sourceRows.waitlist];
      const testers = mergeById(sourceRows.testers, linkedTesters);
      const waitlist = mergeById(sourceRows.waitlist, linkedWaitlist);
      const feedback = await readFeedback(client, testers.map((row) => row.id));
      const clients = await readClients(client, emailsFrom(testers, waitlist));
      return buildPrelaunchLeadDetail({ testers, waitlist, feedback, clients, sourceRef: request.sourceRef });
    },
  };
}

async function readTesters(client: AdminPrelaunchSupabaseClient): Promise<PrelaunchTesterRow[]> {
  const { data, error } = await client
    .from("testers")
    .select(TESTER_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(MAX_SOURCE_ROWS);
  if (error) throw new Error(error.message ?? "prelaunch_testers_query_failed");
  return (data ?? []) as PrelaunchTesterRow[];
}

async function readWaitlist(client: AdminPrelaunchSupabaseClient): Promise<PrelaunchWaitlistRow[]> {
  return readWaitlistRows(
    (columns) => client
      .from("waitlist")
      .select(columns)
      .order("created_at", { ascending: false })
      .limit(MAX_SOURCE_ROWS),
    "prelaunch_waitlist_query_failed",
  );
}

async function readTesterById(client: AdminPrelaunchSupabaseClient, id: string): Promise<PrelaunchTesterRow[]> {
  const { data, error } = await client.from("testers").select(TESTER_COLUMNS).eq("id", id).limit(1);
  if (error) throw new Error(error.message ?? "prelaunch_tester_detail_query_failed");
  return (data ?? []) as PrelaunchTesterRow[];
}

async function readWaitlistById(client: AdminPrelaunchSupabaseClient, id: string): Promise<PrelaunchWaitlistRow[]> {
  return readWaitlistRows(
    (columns) => client.from("waitlist").select(columns).eq("id", id).limit(1),
    "prelaunch_waitlist_detail_query_failed",
  );
}

async function readTestersByEmail(client: AdminPrelaunchSupabaseClient, email: string): Promise<PrelaunchTesterRow[]> {
  const { data, error } = await client.from("testers").select(TESTER_COLUMNS).eq("email", email).limit(5);
  if (error) throw new Error(error.message ?? "prelaunch_tester_email_query_failed");
  return (data ?? []) as PrelaunchTesterRow[];
}

async function readWaitlistByEmail(client: AdminPrelaunchSupabaseClient, email: string): Promise<PrelaunchWaitlistRow[]> {
  return readWaitlistRows(
    (columns) => client.from("waitlist").select(columns).eq("email", email).limit(5),
    "prelaunch_waitlist_email_query_failed",
  );
}

async function readWaitlistRows(
  query: (columns: string) => PrelaunchQuery,
  fallbackMessage: string,
): Promise<PrelaunchWaitlistRow[]> {
  const result = await query(WAITLIST_COLUMNS);
  if (!result.error) return normalizeWaitlistRows(result.data);
  if (!isMissingWaitlistAttributionColumn(result.error)) {
    throw new Error(result.error.message ?? fallbackMessage);
  }

  const fallback = await query(WAITLIST_BASE_COLUMNS);
  if (fallback.error) throw new Error(fallback.error.message ?? fallbackMessage);
  return normalizeWaitlistRows(fallback.data);
}

function normalizeWaitlistRows(data: unknown[] | null): PrelaunchWaitlistRow[] {
  return (data ?? []).map((row) => ({
    ...(row as PrelaunchWaitlistRow),
    source: typeof (row as { source?: unknown }).source === "string" ? (row as { source: string }).source : null,
    locale: (row as { locale?: unknown }).locale === "pl" || (row as { locale?: unknown }).locale === "en"
      ? (row as { locale: "pl" | "en" }).locale
      : null,
  }));
}

function isMissingWaitlistAttributionColumn(error: { message?: string } | null): boolean {
  return /\b(source|locale)\b/i.test(error?.message ?? "") && /column|schema cache|could not find/i.test(error?.message ?? "");
}

async function readFeedback(client: AdminPrelaunchSupabaseClient, testerIds: string[]): Promise<PrelaunchFeedbackRow[]> {
  if (testerIds.length === 0) return [];
  const { data, error } = await client.from("feedback").select(FEEDBACK_COLUMNS).in("tester_id", testerIds).limit(MAX_SOURCE_ROWS);
  if (error) throw new Error(error.message ?? "prelaunch_feedback_query_failed");
  return (data ?? []) as PrelaunchFeedbackRow[];
}

async function readClients(client: AdminPrelaunchSupabaseClient, emails: string[]): Promise<PrelaunchClientRow[]> {
  if (emails.length === 0) return [];
  const { data, error } = await client.from("clients").select(CLIENT_COLUMNS).in("email", emails).limit(MAX_SOURCE_ROWS);
  if (error) throw new Error(error.message ?? "prelaunch_clients_query_failed");
  return (data ?? []) as PrelaunchClientRow[];
}

function emailsFrom(testers: PrelaunchTesterRow[], waitlist: PrelaunchWaitlistRow[]): string[] {
  return [...new Set([...testers, ...waitlist].map((row) => row.email).filter(Boolean))];
}

function splitSourceRef(sourceRef: PrelaunchLeadSourceRef): ["testers" | "waitlist", string] {
  const [table, id] = sourceRef.split(":");
  return [table as "testers" | "waitlist", id];
}

function mergeById<T extends { id: string }>(left: T[], right: T[]): T[] {
  return [...new Map([...left, ...right].map((row) => [row.id, row])).values()];
}
