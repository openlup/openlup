import { describe, expect, it, vi } from "vitest";

import { createSupabaseAdminPipelinePort } from "./adminPipelinePort.js";

describe("createSupabaseAdminPipelinePort", () => {
  it("reads tester, template, send count, and event rows", async () => {
    const order = vi.fn().mockResolvedValue({
      data: [{ id: "template-1", name: "Welcome", sequence_order: 1 }],
      error: null,
    });
    const client = {
      from: vi.fn((table: string) => {
        if (table === "testers") {
          return {
            select: vi.fn().mockResolvedValue({
              data: [{ id: "tester-1", status: "active", email_sequence_step: 1 }],
              error: null,
            }),
          };
        }
        if (table === "email_templates") {
          return {
            select: vi.fn(() => ({
              not: vi.fn(() => ({ order })),
            })),
          };
        }
        if (table === "email_sends") {
          return {
            select: vi.fn().mockResolvedValue({ data: null, error: null, count: 7 }),
          };
        }
        return {
          select: vi.fn().mockResolvedValue({
            data: [{ event_type: "delivered" }],
            error: null,
          }),
        };
      }),
    };

    await expect(createSupabaseAdminPipelinePort(client as never).readPipeline({})).resolves.toEqual({
      testers: [{ id: "tester-1", status: "active", email_sequence_step: 1 }],
      templates: [{ id: "template-1", name: "Welcome", sequence_order: 1 }],
      emailSendCount: 7,
      emailEvents: [{ event_type: "delivered" }],
    });
    expect(order).toHaveBeenCalledWith("sequence_order", { ascending: true });
  });
});
