import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSupabaseAdminTemplatesPort,
  type AdminTemplatesSupabaseClient,
} from "./adminTemplatesPort.js";

describe("createSupabaseAdminTemplatesPort", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T12:34:56.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the complete ordered template projection and preserves rows while defaulting null active", async () => {
    const { client, calls } = createClient([{
      data: [
        {
          id: "template-2",
          active: true,
          body_html: "<p>Second</p>",
          body_text: null,
          name: "Second",
          sequence_order: 2,
          slug: "second",
          subject: "Subject 2",
          trigger_type: null,
        },
        {
          id: "template-1",
          active: null,
          body_html: null,
          body_text: "First",
          name: "First",
          sequence_order: null,
          slug: "first",
          subject: "Subject 1",
          trigger_type: "manual",
        },
      ],
      error: null,
    }]);

    await expect(createSupabaseAdminTemplatesPort(client).getAdminEmailTemplates()).resolves.toEqual({
      templates: [
        expect.objectContaining({ id: "template-2", active: true, body_text: null, sequence_order: 2 }),
        expect.objectContaining({ id: "template-1", active: false, body_html: null, sequence_order: null }),
      ],
    });
    expect(calls).toEqual([{
      table: "email_templates",
      operations: [
        ["select", "id, active, body_html, body_text, name, sequence_order, slug, subject, trigger_type"],
        ["order", "sequence_order", { ascending: true }],
      ],
    }]);
  });

  it("writes active and content changes with the current timestamp and exact acknowledgements", async () => {
    const { client, calls } = createClient([
      { data: null, error: null },
      { data: null, error: null },
    ]);
    const port = createSupabaseAdminTemplatesPort(client);

    await expect(port.updateAdminEmailTemplateActive({
      templateId: "template-1",
      active: false,
    })).resolves.toEqual({ updated: true, templateId: "template-1", active: false });
    await expect(port.updateAdminEmailTemplateContent({
      templateId: "template-2",
      name: "Updated",
      subject: "New subject",
      bodyHtml: null,
      bodyText: "Plain text",
    } as never)).resolves.toEqual({ updated: true, templateId: "template-2" });

    expect(calls).toEqual([
      {
        table: "email_templates",
        operations: [
          ["update", { active: false, updated_at: "2026-07-01T12:34:56.000Z" }],
          ["eq", "id", "template-1"],
        ],
      },
      {
        table: "email_templates",
        operations: [
          ["update", {
            name: "Updated",
            subject: "New subject",
            body_html: null,
            body_text: "Plain text",
            updated_at: "2026-07-01T12:34:56.000Z",
          }],
          ["eq", "id", "template-2"],
        ],
      },
    ]);
  });

  it("preserves upstream messages and stable fallbacks for every operation", async () => {
    const { client } = createClient([
      { data: null, error: { message: "read denied" } },
      { data: null, error: {} },
      { data: null, error: {} },
    ]);
    const port = createSupabaseAdminTemplatesPort(client);

    await expect(port.getAdminEmailTemplates()).rejects.toThrow("read denied");
    await expect(port.updateAdminEmailTemplateActive({
      templateId: "template-1",
      active: true,
    })).rejects.toThrow("admin_email_template_active_update_failed");
    await expect(port.updateAdminEmailTemplateContent({
      templateId: "template-1",
      name: "Name",
      subject: "Subject",
      bodyHtml: null,
      bodyText: null,
    } as never)).rejects.toThrow("admin_email_template_content_update_failed");
  });
});

type Result = { data: unknown; error: { message?: string } | null };
type Call = { table: string; operations: unknown[][] };

function createClient(results: Result[]) {
  const calls: Call[] = [];
  const client: AdminTemplatesSupabaseClient = {
    from(table) {
      const call: Call = { table, operations: [] };
      calls.push(call);
      const query = {
        select(...args: unknown[]) { call.operations.push(["select", ...args]); return query; },
        order(...args: unknown[]) { call.operations.push(["order", ...args]); return query; },
        update(...args: unknown[]) { call.operations.push(["update", ...args]); return query; },
        eq(...args: unknown[]) { call.operations.push(["eq", ...args]); return query; },
        then<TResult1 = Result, TResult2 = never>(
          resolve?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
          reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) {
          return Promise.resolve(results.shift() ?? { data: null, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  return { client, calls };
}
