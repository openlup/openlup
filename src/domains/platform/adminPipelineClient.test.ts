import { describe, expect, it, vi } from "vitest";
import {
  getAdminPipeline,
  refreshAdminPipelineDhlTracking,
} from "./adminPipelineClient";

describe("admin pipeline client", () => {
  it("reads pipeline data with the admin bearer token", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      ok: true,
      data: pipelineResponse(),
    }));

    await getAdminPipeline("admin-token", { fetcher });

    const [path, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/bff/admin/platform/pipeline");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer admin-token");
  });

  it("refreshes DHL tracking with the admin bearer token", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      ok: true,
      data: { checked: 3, updated: 2 },
    }));

    await refreshAdminPipelineDhlTracking("admin-token", { fetcher });

    const [path, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/bff/admin/platform/pipeline/dhl-tracking-refresh");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer admin-token");
    expect(init.body).toBe(JSON.stringify({}));
  });
});

function jsonResponse(body: unknown): Response {
  return {
    status: 200,
    json: () => Promise.resolve(body),
  } as Response;
}

function pipelineResponse() {
  return {
    testers: [
      {
        id: "tester-1",
        status: "packing",
        email_sequence_step: 2,
        email_sequence_paused: false,
      },
    ],
    templates: [{ id: "tpl-1", name: "Reminder", sequence_order: 2 }],
    emailSendCount: 10,
    emailEvents: [{ event_type: "opened" }],
  };
}
