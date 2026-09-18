import type {
  AdminEmailTemplate,
  UpdateAdminEmailTemplateActiveRequest,
  UpdateAdminEmailTemplateContentRequest,
} from "../../../src/domains/communications/contracts.js";
import type {
  CommunicationAdminTemplateActiveWritePort,
  CommunicationAdminTemplateContentWritePort,
  CommunicationAdminTemplatesReadPort,
} from "../../../src/domains/communications/ports.js";

const EMAIL_TEMPLATES_TABLE = "email_templates";
const ADMIN_TEMPLATE_COLUMNS =
  "id, active, body_html, body_text, name, sequence_order, slug, subject, trigger_type";

export interface AdminTemplatesSupabaseClient {
  from(table: typeof EMAIL_TEMPLATES_TABLE): AdminTemplatesQuery;
}

interface AdminTemplatesQuery extends PromiseLike<{
  data: unknown;
  error: { message?: string } | null;
}> {
  select(columns: string): AdminTemplatesQuery;
  order(column: string, options?: { ascending?: boolean }): AdminTemplatesQuery;
  update(values: Record<string, unknown>): AdminTemplatesQuery;
  eq(column: string, value: unknown): AdminTemplatesQuery;
}

export function createSupabaseAdminTemplatesPort(
  client: AdminTemplatesSupabaseClient,
): CommunicationAdminTemplatesReadPort &
  CommunicationAdminTemplateActiveWritePort &
  CommunicationAdminTemplateContentWritePort {
  return {
    async getAdminEmailTemplates() {
      const { data, error } = await client
        .from(EMAIL_TEMPLATES_TABLE)
        .select(ADMIN_TEMPLATE_COLUMNS)
        .order("sequence_order", { ascending: true });
      if (error) throw new Error(error.message ?? "admin_email_templates_query_failed");

      return {
        templates: ((Array.isArray(data) ? data : []) as AdminEmailTemplate[]).map((template) => ({
          ...template,
          active: template.active ?? false,
        })),
      };
    },

    async updateAdminEmailTemplateActive(request: UpdateAdminEmailTemplateActiveRequest) {
      const { error } = await client
        .from(EMAIL_TEMPLATES_TABLE)
        .update({ active: request.active, updated_at: new Date().toISOString() })
        .eq("id", request.templateId);
      if (error) throw new Error(error.message ?? "admin_email_template_active_update_failed");

      return { updated: true, templateId: request.templateId, active: request.active };
    },

    async updateAdminEmailTemplateContent(request: UpdateAdminEmailTemplateContentRequest) {
      const { error } = await client
        .from(EMAIL_TEMPLATES_TABLE)
        .update({
          name: request.name,
          subject: request.subject,
          body_html: request.bodyHtml,
          body_text: request.bodyText,
          updated_at: new Date().toISOString(),
        })
        .eq("id", request.templateId);
      if (error) throw new Error(error.message ?? "admin_email_template_content_update_failed");

      return { updated: true, templateId: request.templateId };
    },
  };
}
