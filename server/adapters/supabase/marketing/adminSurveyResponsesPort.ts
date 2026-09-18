import type { AdminSurveyResponseRow } from "../../../../src/domains/marketing/research/contracts.js";
import type { MarketingResearchSurveyResponsesReadPort } from "../../../../src/domains/marketing/research/ports.js";

const PRODUCER_SURVEY_TABLE = "survey_responses_producer";
const CONSUMER_SURVEY_TABLE = "survey_responses_consumer";
const SURVEY_COLUMNS = "id, created_at, response_data";

export interface AdminSurveyResponsesSupabaseClient {
  from(table: typeof PRODUCER_SURVEY_TABLE | typeof CONSUMER_SURVEY_TABLE): SurveyResponsesQuery;
}

interface SurveyResponsesQuery extends PromiseLike<{
  data: unknown[] | null;
  count: number | null;
  error: { message?: string } | null;
}> {
  select(columns: string, options?: { count?: "exact" }): SurveyResponsesQuery;
  order(column: string, options?: { ascending?: boolean }): SurveyResponsesQuery;
  range(from: number, to: number): SurveyResponsesQuery;
}

export function createSupabaseAdminSurveyResponsesPort(
  client: AdminSurveyResponsesSupabaseClient,
): MarketingResearchSurveyResponsesReadPort {
  return {
    async getAdminSurveyResponses(request) {
      const table =
        request.surveyType === "producer" ? PRODUCER_SURVEY_TABLE : CONSUMER_SURVEY_TABLE;
      const from = request.page * request.pageSize;
      const to = from + request.pageSize - 1;
      const { data, error, count } = await client
        .from(table)
        .select(SURVEY_COLUMNS, { count: "exact" })
        .order("created_at", { ascending: false })
        .range(from, to);
      if (error) throw new Error(error.message ?? "survey_responses_query_failed");

      return {
        rows: (data ?? []) as AdminSurveyResponseRow[],
        totalCount: count ?? 0,
        page: request.page,
        pageSize: request.pageSize,
      };
    },
  };
}
