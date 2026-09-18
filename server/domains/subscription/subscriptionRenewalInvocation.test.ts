import { describe, expect, it } from "vitest";
import type { VercelRequest } from "../../_lib/types/vercel.js";
import { resolveSubscriptionRenewalInvocation } from "./subscriptionRenewalInvocation.js";

function request(method: string, headers: Record<string, string> = {}): VercelRequest {
  return { method, headers } as VercelRequest;
}

describe("resolveSubscriptionRenewalInvocation", () => {
  it("attributes an unmarked GET to the native Vercel cron", () => {
    expect(resolveSubscriptionRenewalInvocation(request("GET"))).toEqual({
      invocationSource: "vercel_cron",
      invocationRunId: null,
    });
  });

  it("records manual smoke without accepting a run ID", () => {
    expect(resolveSubscriptionRenewalInvocation(request("POST", {
      "x-scheduler-source": "manual_smoke",
      "x-scheduler-run-id": "123",
    }))).toEqual({ invocationSource: "manual_smoke", invocationRunId: null });
  });

  it("records a scheduled Actions invocation with a bounded numeric run ID", () => {
    expect(resolveSubscriptionRenewalInvocation(request("POST", {
      "x-scheduler-source": "github_actions_schedule",
      "x-scheduler-run-id": "29967386974",
    }))).toEqual({
      invocationSource: "github_actions_schedule",
      invocationRunId: "29967386974",
    });
  });

  it.each(["", "0", "01", "123456789012345678901", "not-a-run"])(
    "rejects attributed POSTs with invalid run ID %j",
    (runId) => {
      expect(resolveSubscriptionRenewalInvocation(request("POST", {
        "x-scheduler-source": "github_actions_dispatch",
        "x-scheduler-run-id": runId,
      }))).toEqual({ invocationSource: "unattributed_post", invocationRunId: null });
    },
  );

  it("keeps unknown POST callers observable but ineligible for scheduler proof", () => {
    expect(resolveSubscriptionRenewalInvocation(request("POST", {
      "x-scheduler-source": "unknown",
      "x-scheduler-run-id": "123",
    }))).toEqual({ invocationSource: "unattributed_post", invocationRunId: null });
  });
});
