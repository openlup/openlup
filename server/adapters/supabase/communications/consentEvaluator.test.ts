import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsentEvaluationUnavailableError } from "../../../domains/commerce/marketingEmailPorts.js";
import {
  createSupabaseConsentEvaluator,
  type ConsentEvaluatorClient,
} from "./consentEvaluator.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function clientReturning(data: unknown, error: { message?: string } | null = null): {
  client: ConsentEvaluatorClient;
  rpc: ReturnType<typeof vi.fn>;
} {
  const rpc = vi.fn(async () => ({ data, error }));
  return { client: { rpc }, rpc };
}

describe("createSupabaseConsentEvaluator", () => {
  it("maps an allowed RPC result and passes the canonical params", async () => {
    const { client, rpc } = clientReturning({
      allowed: true,
      reason: "consent_granted",
      decisionId: "dec-1",
    });
    const port = createSupabaseConsentEvaluator(client);
    const out = await port.evaluate({
      email: "a@b.com",
      purpose: "marketing_newsletter",
      sourceTable: "clients",
      sourceId: "c-1",
    });
    expect(out).toEqual({ allowed: true, reason: "consent_granted", decisionId: "dec-1" });
    expect(rpc).toHaveBeenCalledWith("communication_evaluate_email_policy", {
      p_email: "a@b.com",
      p_purpose: "marketing_newsletter",
      p_source: "marketing_cron",
      p_recipient_kind: "customer",
      p_source_table: "clients",
      p_source_id: "c-1",
      p_metadata: {},
    });
  });

  it("maps a blocked RPC result", async () => {
    const { client } = clientReturning({
      allowed: false,
      reason: "suppressed",
      decisionId: "dec-2",
    });
    const port = createSupabaseConsentEvaluator(client);
    const out = await port.evaluate({ email: "x@y.com", purpose: "marketing_newsletter" });
    expect(out).toEqual({ allowed: false, reason: "suppressed", decisionId: "dec-2" });
  });

  it("fails CLOSED (throws, never allows) on RPC error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { client } = clientReturning(null, { message: "boom" });
    const port = createSupabaseConsentEvaluator(client);
    await expect(
      port.evaluate({ email: "x@y.com", purpose: "marketing_newsletter" }),
    ).rejects.toBeInstanceOf(ConsentEvaluationUnavailableError);
    expect(warn).toHaveBeenCalled();
  });

  it("fails CLOSED (throws) when the RPC throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const rpc = vi.fn(async () => {
      throw new Error("network down");
    });
    const port = createSupabaseConsentEvaluator({ rpc });
    await expect(
      port.evaluate({ email: "x@y.com", purpose: "marketing_newsletter" }),
    ).rejects.toThrow(/policy_rpc_threw/);
  });

  it("fails CLOSED (throws) when the RPC returns an unintelligible shape", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { client } = clientReturning(["not", "a", "record"]);
    const port = createSupabaseConsentEvaluator(client);
    await expect(
      port.evaluate({ email: "x@y.com", purpose: "marketing_newsletter" }),
    ).rejects.toThrow(/policy_response_unparseable/);
  });
});
