import { describe, expect, it } from "vitest";
import {
  adminEmailTemplatesResponseSchema,
  updateAdminEmailTemplateActiveRequestSchema,
  updateAdminEmailTemplateActiveResponseSchema,
  updateAdminEmailTemplateContentRequestSchema,
  updateAdminEmailTemplateContentResponseSchema,
} from "./contracts";

describe("admin email templates contract", () => {
  it("validates the full admin template read model", () => {
    expect(() =>
      adminEmailTemplatesResponseSchema.parse({
        templates: [
          {
            id: "tpl-1",
            active: true,
            body_html: "<p>Hello</p>",
            body_text: null,
            name: "Approved",
            sequence_order: 1,
            slug: "approved",
            subject: "Approved",
            trigger_type: "status_change",
          },
        ],
      }),
    ).not.toThrow();
  });

  it("validates active toggle request and response contracts", () => {
    expect(
      updateAdminEmailTemplateActiveRequestSchema.parse({
        templateId: "tpl-1",
        active: false,
      }),
    ).toEqual({ templateId: "tpl-1", active: false });

    expect(
      updateAdminEmailTemplateActiveResponseSchema.parse({
        updated: true,
        templateId: "tpl-1",
        active: false,
      }),
    ).toEqual({ updated: true, templateId: "tpl-1", active: false });
  });

  it("validates content update request and response contracts", () => {
    expect(
      updateAdminEmailTemplateContentRequestSchema.parse({
        templateId: "tpl-1",
        name: "Updated",
        subject: "Subject",
        bodyHtml: "<p>Body</p>",
        bodyText: null,
      }),
    ).toEqual({
      templateId: "tpl-1",
      name: "Updated",
      subject: "Subject",
      bodyHtml: "<p>Body</p>",
      bodyText: null,
    });

    expect(
      updateAdminEmailTemplateContentResponseSchema.parse({
        updated: true,
        templateId: "tpl-1",
      }),
    ).toEqual({ updated: true, templateId: "tpl-1" });
  });
});
