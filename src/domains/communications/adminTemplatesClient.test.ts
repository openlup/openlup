import { describe, expect, it, vi } from "vitest";
import { BffClientError } from "@/lib/bff/client";
import {
  getAdminEmailTemplates,
  updateAdminEmailTemplateActive,
  updateAdminEmailTemplateContent,
} from "./adminTemplatesClient";

describe("admin templates communications client", () => {
  it("reads email templates with the admin bearer token", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: () =>
        Promise.resolve({
          ok: true,
          data: { templates: [template()] },
        }),
    });

    await getAdminEmailTemplates("admin-token", { fetcher });

    const [path, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/bff/admin/communications/templates");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer admin-token");

    fetcher.mockResolvedValueOnce({
      status: 200,
      json: () =>
        Promise.resolve({
          ok: true,
          data: { updated: true, templateId: "tpl-1", active: false },
        }),
    });

    await updateAdminEmailTemplateActive(
      "admin-token",
      { templateId: "tpl-1", active: false },
      { fetcher },
    );

    const [activePath, activeInit] = fetcher.mock.calls[1] as [string, RequestInit];
    expect(activePath).toBe("/api/bff/admin/communications/templates/active");
    expect(activeInit.method).toBe("PATCH");
    expect(JSON.parse(activeInit.body as string)).toEqual({
      templateId: "tpl-1",
      active: false,
    });

    fetcher.mockResolvedValueOnce({
      status: 200,
      json: () =>
        Promise.resolve({
          ok: true,
          data: { updated: true, templateId: "tpl-1" },
        }),
    });

    await updateAdminEmailTemplateContent(
      "admin-token",
      {
        templateId: "tpl-1",
        name: "Updated",
        subject: "Subject",
        bodyHtml: "<p>Body</p>",
        bodyText: null,
      },
      { fetcher },
    );

    const [contentPath, contentInit] = fetcher.mock.calls[2] as [string, RequestInit];
    expect(contentPath).toBe("/api/bff/admin/communications/templates/content");
    expect(contentInit.method).toBe("PATCH");
    expect(JSON.parse(contentInit.body as string)).toEqual({
      templateId: "tpl-1",
      name: "Updated",
      subject: "Subject",
      bodyHtml: "<p>Body</p>",
      bodyText: null,
    });
  });

  it("throws typed BFF errors and rejects malformed envelopes", async () => {
    const errorFetcher = vi.fn().mockResolvedValue({
      status: 401,
      json: () =>
        Promise.resolve({
          ok: false,
          error: { code: "UNAUTHORIZED", message: "Admin session required" },
        }),
    });

    await expect(
      getAdminEmailTemplates("admin-token", { fetcher: errorFetcher }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });

    const malformedFetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: () => Promise.resolve({ ok: true, data: { templates: [{ slug: "x" }] } }),
    });

    await expect(
      getAdminEmailTemplates("admin-token", { fetcher: malformedFetcher }),
    ).rejects.toBeInstanceOf(BffClientError);
  });
});

function template() {
  return {
    id: "tpl-1",
    active: true,
    body_html: "<p>Hello</p>",
    body_text: null,
    name: "Approved",
    sequence_order: 1,
    slug: "approved",
    subject: "Approved",
    trigger_type: "status_change",
  };
}
