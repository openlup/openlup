import { describe, expect, it, vi } from "vitest";
import {
  createSupabaseAdminActiveTemplatesPort,
  type AdminActiveTemplatesSupabaseClient,
} from "./adminActiveTemplatesPort.js";

describe("supabase admin active templates port", () => {
  it("reads active email templates through the canonical ordered query", async () => {
    const client = createClient({
      data: [
        { slug: "welcome", name: "Welcome", sequence_order: 1 },
        { slug: "follow-up", name: "Follow-up", sequence_order: 2 },
      ],
      error: null,
    });

    await expect(
      createSupabaseAdminActiveTemplatesPort(client).getActiveEmailTemplates(),
    ).resolves.toEqual({
      templates: [
        { slug: "welcome", name: "Welcome", sequence_order: 1 },
        { slug: "follow-up", name: "Follow-up", sequence_order: 2 },
      ],
    });

    expect(client.from).toHaveBeenCalledWith("email_templates");
    expect(client.select).toHaveBeenCalledWith("slug, name, sequence_order");
    expect(client.eq).toHaveBeenCalledWith("active", true);
    expect(client.order).toHaveBeenCalledWith("sequence_order");
  });

  it("throws on upstream query errors", async () => {
    const client = createClient({
      data: null,
      error: { message: "permission denied" },
    });

    await expect(
      createSupabaseAdminActiveTemplatesPort(client).getActiveEmailTemplates(),
    ).rejects.toThrow("permission denied");
  });

  it("maps a null provider result to an empty list and uses the stable fallback error", async () => {
    const emptyClient = createClient({ data: null, error: null });
    await expect(
      createSupabaseAdminActiveTemplatesPort(emptyClient).getActiveEmailTemplates(),
    ).resolves.toEqual({ templates: [] });

    const failedClient = createClient({ data: null, error: {} });
    await expect(
      createSupabaseAdminActiveTemplatesPort(failedClient).getActiveEmailTemplates(),
    ).rejects.toThrow("active_email_templates_query_failed");
  });
});

type ActiveTemplateRow = {
  slug: string;
  name: string;
  sequence_order: number | null;
};

function createClient(result: {
  data: ActiveTemplateRow[] | null;
  error: { message?: string } | null;
}) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    order: vi.fn(() => builder),
    then: (resolve: (value: typeof result) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return {
    from: vi.fn((table: "email_templates") => {
      expect(table).toBe("email_templates");
      return builder;
    }),
    select: builder.select,
    eq: builder.eq,
    order: builder.order,
  } as unknown as AdminActiveTemplatesSupabaseClient & {
    from: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
    eq: ReturnType<typeof vi.fn>;
    order: ReturnType<typeof vi.fn>;
  };
}
