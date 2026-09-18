import type { PartnersB2BInquiry } from "../../../src/domains/partners/contracts.js";
import type { PartnersB2BInquiryAdminPort } from "../../../src/domains/partners/ports.js";

const B2B_INQUIRIES_TABLE = "b2b_inquiries";
const B2B_SELECT = [
  "id",
  "created_at",
  "company",
  "website",
  "country",
  "company_type",
  "revenue_bucket",
  "first_name",
  "last_name",
  "business_email",
  "phone",
  "interests",
  "notes",
  "ip_hash",
  "pipedrive_deal_id",
  "status",
].join(",");

export interface AdminB2BInquiryDataClient {
  from(table: typeof B2B_INQUIRIES_TABLE): AdminB2BInquiryQuery;
}

interface AdminB2BInquiryQuery extends PromiseLike<AdminB2BInquiryQueryResult> {
  select(columns: string, options?: { count?: "exact"; head?: boolean }): AdminB2BInquiryQuery;
  order(column: string, options?: { ascending?: boolean }): AdminB2BInquiryQuery;
  range(from: number, to: number): AdminB2BInquiryQuery;
  eq(column: string, value: unknown): AdminB2BInquiryQuery;
  or(pattern: string): AdminB2BInquiryQuery;
  update(values: Record<string, unknown>): AdminB2BInquiryQuery;
}

interface AdminB2BInquiryQueryResult {
  data: unknown;
  count?: number | null;
  error: { message?: string } | null;
}

export function createAdminB2BInquiryPort(
  client: AdminB2BInquiryDataClient,
): PartnersB2BInquiryAdminPort {
  return {
    async listB2BInquiries({ status, search, page, pageSize }) {
      let rowsQuery = client
        .from(B2B_INQUIRIES_TABLE)
        .select(B2B_SELECT)
        .order("created_at", { ascending: false })
        .range(page * pageSize, (page + 1) * pageSize - 1);
      let countQuery = client
        .from(B2B_INQUIRIES_TABLE)
        .select("*", { count: "exact", head: true });

      if (status !== "all") {
        rowsQuery = rowsQuery.eq("status", status);
        countQuery = countQuery.eq("status", status);
      }
      if (search) {
        const pattern = `company.ilike.%${search}%,business_email.ilike.%${search}%,first_name.ilike.%${search}%,last_name.ilike.%${search}%`;
        rowsQuery = rowsQuery.or(pattern);
        countQuery = countQuery.or(pattern);
      }

      const [rows, total, newRows] = await Promise.all([
        rowsQuery,
        countQuery,
        client
          .from(B2B_INQUIRIES_TABLE)
          .select("*", { count: "exact", head: true })
          .eq("status", "new"),
      ]);

      if (rows.error) throw new Error(rows.error.message ?? "b2b_inquiries_query_failed");
      if (total.error) throw new Error(total.error.message ?? "b2b_inquiries_count_failed");
      if (newRows.error) throw new Error(newRows.error.message ?? "b2b_inquiries_new_count_failed");

      return {
        inquiries: (rows.data ?? []) as PartnersB2BInquiry[],
        totalCount: total.count ?? 0,
        newCount: newRows.count ?? 0,
      };
    },

    async updateB2BInquiryStatus({ id, status }) {
      const { error } = await client
        .from(B2B_INQUIRIES_TABLE)
        .update({ status })
        .eq("id", id);
      if (error) throw new Error(error.message ?? "b2b_inquiry_status_update_failed");

      return { updated: true };
    },
  };
}
