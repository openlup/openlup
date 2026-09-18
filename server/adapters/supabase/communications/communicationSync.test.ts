import { describe, expect, it, vi } from "vitest";
import { createSupabaseCommunicationSyncStore } from "./communicationSync.js";

function store(reply: { data: unknown; error?: { code?: string; message?: string } | null }) {
  const rpc = vi.fn(async () => ({ data: reply.data, error: reply.error ?? null }));
  return { port: createSupabaseCommunicationSyncStore({ rpc }), rpc };
}

const claimedRow = {
  id: "evt-1",
  claim_token: "tok-1",
  contact_id: "contact-1",
  normalized_email: "k@example.com",
  event_type: "subscribed",
  purpose: "marketing_newsletter",
  payload: { source: "checkout" },
  attempt_count: 2,
  origin_provider_kind: " mailer ",
  origin_provider_event_id: "",
  remote_profile_id: null,
  remote_list_id: "list-9",
};

describe("communication sync store", () => {
  it("claims a batch with the caller's pacing and maps only intelligible rows", async () => {
    const { port, rpc } = store({ data: [claimedRow, { id: "evt-2" }, null, "not-a-row"] });

    const events = await port.claimBatch({
      providerKind: "newsletter",
      batchSize: 10,
      visibilitySeconds: 60,
      maxAttempts: 5,
    });

    expect(rpc).toHaveBeenCalledWith("communication_claim_sync_outbox", {
      p_provider_kind: "newsletter",
      p_batch_size: 10,
      p_visibility_seconds: 60,
      p_max_attempts: 5,
    });
    // A row missing any identity field is dropped rather than half-built: a
    // sync event with no claim token can never be acknowledged.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: "evt-1",
      claimToken: "tok-1",
      contactId: "contact-1",
      normalizedEmail: "k@example.com",
      attemptCount: 2,
      // Trimmed, and an empty string reads as absent rather than as a value.
      originProviderKind: "mailer",
      originProviderEventId: null,
      remoteProfileId: null,
      remoteListId: "list-9",
    });
  });

  it("returns an empty batch when the claim answers something that is not a list", async () => {
    const { port } = store({ data: { rows: [] } });
    expect(await port.claimBatch({
      providerKind: "newsletter", batchSize: 1, visibilitySeconds: 1, maxAttempts: 1,
    })).toEqual([]);
  });

  it("acknowledges a sent event under its claim token and reports the fence", async () => {
    const sent = store({ data: true });
    expect(await sent.port.markSent({
      eventId: "evt-1", claimToken: "tok-1", providerKind: "newsletter",
      remoteProfileId: "remote-1", responseSummary: { status: 200 },
    })).toBe(true);
    expect(sent.rpc).toHaveBeenCalledWith("communication_mark_sync_outbox_sent", {
      p_outbox_id: "evt-1",
      p_claim_token: "tok-1",
      p_provider_kind: "newsletter",
      p_remote_profile_id: "remote-1",
      p_response_summary: { status: 200 },
    });

    // Anything other than an explicit true means the row was NOT ours to close.
    const fenced = store({ data: false });
    expect(await fenced.port.markSent({
      eventId: "evt-1", claimToken: "stale", providerKind: "newsletter",
    })).toBe(false);
  });

  it("records a failure with its retry decision and backoff", async () => {
    const { port, rpc } = store({ data: true });
    expect(await port.markFailed({
      eventId: "evt-1", claimToken: "tok-1", providerKind: "newsletter",
      error: "upstream down", retry: true, backoffSeconds: 120,
    })).toBe(true);
    expect(rpc).toHaveBeenCalledWith("communication_mark_sync_outbox_failed", {
      p_outbox_id: "evt-1",
      p_claim_token: "tok-1",
      p_provider_kind: "newsletter",
      p_error: "upstream down",
      p_retry: true,
      p_backoff_seconds: 120,
    });
  });

  it("names the failing routine when the store refuses", async () => {
    const claim = store({ data: null, error: { message: "claim exploded" } });
    await expect(claim.port.claimBatch({
      providerKind: "newsletter", batchSize: 1, visibilitySeconds: 1, maxAttempts: 1,
    })).rejects.toThrow("communication_claim_sync_outbox_failed: claim exploded");

    // With no message the code carries the diagnosis instead of "unknown".
    const marked = store({ data: null, error: { code: "40001" } });
    await expect(marked.port.markSent({
      eventId: "evt-1", claimToken: "tok-1", providerKind: "newsletter",
    })).rejects.toThrow("communication_mark_sync_outbox_sent_failed: 40001");
  });
});
