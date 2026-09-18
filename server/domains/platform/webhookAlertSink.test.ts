import { describe, expect, it, vi } from "vitest";
import type { AlertDecision, OpenAlert } from "../../../src/domains/platform/observabilityContracts.js";
import { createPlatformAlertSink } from "../../adapters/platform/platformAlertSink.js";
import { createWebhookAlertSink } from "./webhookAlertSink.js";

describe("webhook alert sink", () => {
  it("sends native ntfy headers + text body for an ntfy URL", async () => {
    const requests: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const sink = createPlatformAlertSink({
      fetchImpl,
      webhookUrl: "https://ntfy.sh/openlup-prod-alerts",
      webhookSecret: "secret",
      environment: " Staging\n Preview ",
    });

    const outcome = await sink.send(decision(), alert());

    expect(outcome).toMatchObject({ status: "sent" });
    expect(fetchImpl).toHaveBeenCalledWith("https://ntfy.sh/openlup-prod-alerts", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        "Content-Type": "text/plain; charset=utf-8",
        Title: "[P2] Scheduled job missed",
        Priority: "3",
        Tags: "openlup,p2,fulfillment_tracking_stalled",
        "x-openlup-alert-secret": "secret",
      }),
    }));
    expect((requests[0]?.headers as Record<string, string>).Click).toBeUndefined();

    // Body is the human-readable text, not a JSON blob.
    const body = String(requests[0]?.body);
    expect(() => JSON.parse(body)).toThrow();
    expect(body).toContain("Srodowisko: staging preview");
    expect(body).not.toContain("secret");
    expect(body).toContain("Klasa awarii: fulfillment_tracking_stalled");
    expect(body).toContain("Co sie zepsulo: check-dhl-tracking last succeeded 8388 minutes ago.");
    expect(body).toContain("Pierwszy krok: Check platform_job_runs");
  });

  it("forces JSON envelope for an ntfy URL when wireFormat=json", async () => {
    const requests: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const sink = createWebhookAlertSink({
      fetchImpl,
      webhookUrl: "https://ntfy.sh/openlup-prod-alerts",
      options: { defaultTag: "openlup", wireFormat: "json" },
    });

    await sink.send(decision(), alert());

    const init = requests[0] as RequestInit;
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ dedupeKey: "job_missed:check-dhl-tracking", tags: ["openlup", "p2", "fulfillment_tracking_stalled"] });
  });

  it("forces ntfy headers for a non-ntfy URL when wireFormat=ntfy", async () => {
    const requests: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const sink = createWebhookAlertSink({
      fetchImpl,
      webhookUrl: "https://alerts.example.test",
      options: { wireFormat: "ntfy" },
    });

    await sink.send(decision(), alert());
    const headers = (requests[0] as RequestInit).headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("text/plain; charset=utf-8");
    expect(headers.Priority).toBe("3");
  });

  it("defaults to neutral webhook JSON metadata for a non-ntfy URL", async () => {
    const requests: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const sink = createWebhookAlertSink({
      fetchImpl,
      webhookUrl: "https://alerts.example.test",
      webhookSecret: "secret",
    });

    await sink.send(decision(), alert());

    expect(fetchImpl).toHaveBeenCalledWith("https://alerts.example.test", expect.objectContaining({
      headers: expect.objectContaining({
        "x-app-alert-secret": "secret",
      }),
    }));
    const body = JSON.parse(String(requests[0]?.body)) as Record<string, unknown>;
    expect(body.tags).toEqual(["app", "p2", "fulfillment_tracking_stalled"]);
    expect(body.click).toBeUndefined();
    expect(body.message).toContain("Runbook: /docs/platform/RUNTIME_AND_SELF_HOSTING.md");
  });

  it("uses the canonical openlup JSON payload for relay webhooks", async () => {
    const requests: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const sink = createPlatformAlertSink({
      fetchImpl,
      webhookUrl: "https://alerts.example.test",
      webhookSecret: "secret",
      wireFormat: "json",
      environment: " Production\n ",
    });

    await sink.send(decision(), alert());

    const request = requests[0] as RequestInit;
    expect(request.headers).toMatchObject({
      "Content-Type": "application/json",
      "x-openlup-alert-secret": "secret",
    });
    const body = JSON.parse(String(request.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      alertId: "alert-1",
      dedupeKey: "job_missed:check-dhl-tracking",
      severity: "p2",
      environment: "production",
      owner: "platform/fulfillment",
      runbookUrl: "/docs/platform/RUNTIME_AND_SELF_HOSTING.md",
      priority: 4,
      tags: ["openlup", "p2", "fulfillment_tracking_stalled"],
      payload: { jobName: "check-dhl-tracking", reason: "job_missed" },
    });
    expect(body.click).toBeUndefined();
    expect(String(request.body)).not.toContain("secret");
  });

  it("returns a failed outcome when the webhook transport throws", async () => {
    const sink = createPlatformAlertSink({
      fetchImpl: vi.fn().mockRejectedValue(new Error("connection refused")) as unknown as typeof fetch,
      webhookUrl: "https://ntfy.sh/openlup-prod-alerts",
      environment: "production",
    });

    await expect(sink.send(decision(), alert())).resolves.toMatchObject({
      status: "failed",
      provider: "webhook",
      error: "connection refused",
    });
  });

  it("never persists an untrusted receiver response body", async () => {
    const sink = createWebhookAlertSink({
      fetchImpl: vi.fn(async () => new Response(
        "buyer@example.com token=secret provider payload",
        { status: 502, statusText: "Bad Gateway" },
      )) as unknown as typeof fetch,
      webhookUrl: "https://alerts.example.test",
    });

    const outcome = await sink.send(decision(), alert());

    expect(outcome).toMatchObject({
      status: "failed",
      providerResponse: { status: 502 },
      error: "webhook_http_502",
    });
    expect(JSON.stringify(outcome)).not.toContain("buyer@example.com");
    expect(JSON.stringify(outcome)).not.toContain("token=secret");
  });

  it("aborts a stalled webhook request at the configured timeout", async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    ) as unknown as typeof fetch;
    const sink = createWebhookAlertSink({
      fetchImpl,
      webhookUrl: "https://alerts.example.test",
      options: { timeoutMs: 100 },
    });

    await expect(sink.send(decision(), alert())).resolves.toMatchObject({
      status: "failed",
      provider: "webhook",
      error: "webhook_request_timed_out_after_100ms",
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://alerts.example.test", expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
  });
});

function expectCanonicalRunbookUrl(value: unknown): void {
  expect(typeof value).toBe("string");
  const parsed = new URL(String(value));
  expect(parsed.protocol).toBe("https:");
  expect(parsed.search).toBe("");
  expect(`${parsed.pathname}${parsed.hash}`).toMatch(
    /\/docs\/platform\/RUNTIME_AND_SELF_HOSTING\.md$/,
  );
}

function decision(): AlertDecision {
  return {
    dedupeKey: "job_missed:check-dhl-tracking",
    severity: "p2",
    owner: "platform/fulfillment",
    runbookUrl: "/docs/platform/RUNTIME_AND_SELF_HOSTING.md",
    title: "Scheduled job missed",
    message: "check-dhl-tracking last succeeded 8388 minutes ago.",
    humanContext: {
      incidentClass: "fulfillment_tracking_stalled",
      impact: "DHL tracking refresh is stale; operators may see outdated shipment states.",
      firstAction: "Check platform_job_runs for check-dhl-tracking, then inspect Vercel logs for /api/cron/dhl-tracking.",
      urgency: "P2: investigate during the current ops window; degraded automation or stale evidence is likely.",
    },
    channels: ["webhook"],
    payload: {
      jobName: "check-dhl-tracking",
      reason: "job_missed",
      ageSeconds: 503280,
      lastSuccessAt: "2026-07-02T15:00:23.498766+00:00",
    },
  };
}

function alert(): OpenAlert {
  return {
    id: "alert-1",
    dedupeKey: "job_missed:check-dhl-tracking",
    status: "open",
    severity: "p2",
    lastNotifiedAt: null,
  };
}
