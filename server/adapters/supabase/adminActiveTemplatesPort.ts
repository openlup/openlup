import type { AdminActiveEmailTemplate } from "../../../src/domains/communications/contracts.js";
import type { CommunicationAdminTesterDetailReadPort } from "../../../src/domains/communications/ports.js";

const EMAIL_TEMPLATES_TABLE = "email_templates";
const ACTIVE_TEMPLATE_COLUMNS = "slug, name, sequence_order";

type ActiveTemplateRow = AdminActiveEmailTemplate;

type ActiveTemplatesQueryResult = PromiseLike<{
  data: ActiveTemplateRow[] | null;
  error: { message?: string } | null;
}>;

interface ActiveTemplatesQuery extends ActiveTemplatesQueryResult {
  select(columns: string): ActiveTemplatesQuery;
  eq(column: string, value: boolean): ActiveTemplatesQuery;
  order(column: string): ActiveTemplatesQuery;
}

export interface AdminActiveTemplatesSupabaseClient {
  from(table: typeof EMAIL_TEMPLATES_TABLE): ActiveTemplatesQuery;
}

export function createSupabaseAdminActiveTemplatesPort(
  client: AdminActiveTemplatesSupabaseClient,
): Pick<CommunicationAdminTesterDetailReadPort, "getActiveEmailTemplates"> {
  return {
    async getActiveEmailTemplates() {
      const { data, error } = await client
        .from(EMAIL_TEMPLATES_TABLE)
        .select(ACTIVE_TEMPLATE_COLUMNS)
        .eq("active", true)
        .order("sequence_order");
      if (error) throw new Error(error.message ?? "active_email_templates_query_failed");

      return { templates: data ?? [] };
    },
  };
}
