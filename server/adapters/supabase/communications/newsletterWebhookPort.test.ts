import { describe, expect, it, vi } from "vitest";
import {
  createSupabaseNewsletterWebhookPort as createPort,
  type NewsletterWebhookRpcClient,
} from "./newsletterWebhookPort.js";
import type { NormalizedNewsletterWebhookEvent } from "../../../domains/communications/newsletterWebhookHandler.js";

type RpcResult = { data: unknown; error: { code?: string; message?: string } | null };

function rpcClient(result: RpcResult = { data: {}, error: null }) {
  const rpc = vi.fn(
    async (_functionName: string, _args: Record<string, unknown>): Promise<RpcResult> => result,
  );
  const client: NewsletterWebhookRpcClient = { rpc };
  return { client, rpc };
}

function providerEvent(
  overrides: Partial<NormalizedNewsletterWebhookEvent> = {},
): NormalizedNewsletterWebhookEvent & { state: null; processingStatus: "received" } {
  return {
    providerKind: "noop_newsletter",
    providerEventId: "provider-evt-1",
    eventType: "unsubscribe",
    email: "ala@example.com",
    remoteProfileId: "remote-1",
    remoteListId: "list-1",
    purpose: "marketing_newsletter",
    explicitOptInEvidence: true,
    doubleOptInStatus: "confirmed",
    occurredAt: "2026-08-15T10:00:00.000Z",
    rawPayload: {},
    ...overrides,
    state: null,
    processingStatus: "received",
  };
}

describe("createPort", () => {
  describe("recordProviderEvent", () => {
    it("forwards the canonical RPC name and full p_* argument shape", async () => {
      const { client, rpc } = rpcClient({
        data: { providerEventId: "evt-row", contactId: "contact-1", inserted: true },
        error: null,
      });

      const result = await createPort(client)
        .recordProviderEvent({ ...providerEvent(), state: "suppressed" });

      expect(rpc).toHaveBeenCalledWith("communication_record_provider_event", {
        p_provider_kind: "noop_newsletter",
        p_provider_event_id: "provider-evt-1",
        p_event_type: "unsubscribe",
        p_email: "ala@example.com",
        p_remote_profile_id: "remote-1",
        p_purpose: "marketing_newsletter",
        p_state: "suppressed",
        p_payload: {},
        p_metadata: {
          occurredAt: "2026-08-15T10:00:00.000Z",
          explicitOptInEvidence: true,
          doubleOptInStatus: "confirmed",
          remoteListId: "list-1",
          processingStatus: "received",
        },
        p_processing_status: "received",
      });
      expect(result).toEqual({
        providerEventId: "evt-row",
        contactId: "contact-1",
        inserted: true,
      });
    });

    it("keeps the audit metadata aligned with the processing status the caller passed", async () => {
      const { client, rpc } = rpcClient({ data: {}, error: null });

      await createPort(client).recordProviderEvent({
        ...providerEvent(),
        processingStatus: "ignored",
      });

      const args = rpc.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(args.p_processing_status).toBe("ignored");
      expect(args.p_metadata).toMatchObject({ processingStatus: "ignored" });
    });

    // Secret material can ride in on a provider payload; the adapter is the
    // last place that can keep it out of the audit row.
    it("strips credential-shaped keys from the persisted payload", async () => {
      const { client, rpc } = rpcClient();
      const rawPayload = {
        apiKey: "ak_live_leak",
        token: "tok_leak",
        secret: "shh",
        email: "ala@example.com",
        nested: { token: "kept-because-shallow" },
      };

      await createPort(client)
        .recordProviderEvent({ ...providerEvent({ rawPayload }) });

      const args = rpc.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(args.p_payload).toEqual({
        email: "ala@example.com",
        nested: { token: "kept-because-shallow" },
      });
      // Sanitisation copies; the caller's object must survive intact so the
      // handler can still read what the provider actually sent.
      expect(rawPayload).toHaveProperty("apiKey", "ak_live_leak");
    });

    it("treats inserted as strictly boolean true", async () => {
      for (const inserted of ["true", 1, {}, null, undefined]) {
        const { client } = rpcClient({
          data: { providerEventId: "evt-row", contactId: "contact-1", inserted },
          error: null,
        });

        const result = await createPort(client)
          .recordProviderEvent(providerEvent());

        expect(result.inserted).toBe(false);
      }
    });

    it("trims returned identifiers and maps blank or non-string values to null", async () => {
      const { client } = rpcClient({
        data: { providerEventId: "  evt-row  ", contactId: "   ", inserted: true },
        error: null,
      });

      const result = await createPort(client)
        .recordProviderEvent(providerEvent());

      expect(result).toEqual({
        providerEventId: "evt-row",
        contactId: null,
        inserted: true,
      });
    });

    it("degrades a non-record RPC result to empty identifiers instead of throwing", async () => {
      for (const data of [null, "evt-row", 42, ["evt-row"]]) {
        const { client } = rpcClient({ data, error: null });

        const result = await createPort(client)
          .recordProviderEvent(providerEvent());

        expect(result).toEqual({ providerEventId: "", contactId: null, inserted: false });
      }
    });

    it("throws a namespaced failure when the RPC errors", async () => {
      const { client } = rpcClient({ data: null, error: { message: "duplicate key" } });

      await expect(createPort(client)
        .recordProviderEvent(providerEvent()))
        .rejects.toThrow("communication_record_provider_event_failed: duplicate key");
    });
  });

  describe("recordPermission", () => {
    const input = {
      contactId: "contact-1",
      providerKind: "noop_newsletter",
      providerEventId: "provider-evt-1",
      purpose: "marketing_newsletter" as const,
      state: "suppressed" as const,
      reason: "provider_unsubscribe",
      metadata: { listId: "list-1" },
    };

    it("stamps provider-webhook provenance and requests a sync event", async () => {
      const { client, rpc } = rpcClient({ data: null, error: null });

      await createPort(client).recordPermission(input);

      const [name, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
      expect(name).toBe("communication_record_permission_event");
      expect(args).toMatchObject({
        p_contact_id: "contact-1",
        p_purpose: "marketing_newsletter",
        p_state: "suppressed",
        p_source: "newsletter_provider_webhook",
        p_source_ref: {
          providerKind: "noop_newsletter",
          providerEventId: "provider-evt-1",
        },
        p_reason: "provider_unsubscribe",
        p_metadata: {
          listId: "list-1",
          actorType: "provider_webhook",
          captureMethod: "newsletter_webhook",
          originProviderKind: "noop_newsletter",
          originProviderEventId: "provider-evt-1",
        },
        p_create_sync_event: true,
      });
      expect(args.p_captured_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    // Provenance is the point of this call: a caller must not be able to
    // relabel a provider webhook as a first-party capture.
    it("does not let caller metadata override the provenance keys", async () => {
      const { client, rpc } = rpcClient({ data: null, error: null });

      await createPort(client).recordPermission({
        ...input,
        metadata: { actorType: "customer", captureMethod: "checkout_form" },
      });

      const args = rpc.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(args.p_metadata).toMatchObject({
        actorType: "provider_webhook",
        captureMethod: "newsletter_webhook",
      });
    });

    it("throws a namespaced failure when the RPC errors", async () => {
      const { client } = rpcClient({ data: null, error: { message: "contact missing" } });

      await expect(createPort(client).recordPermission(input))
        .rejects.toThrow("communication_record_permission_event_failed: contact missing");
    });
  });

  describe("markProviderEvent", () => {
    const input = {
      providerEventId: "evt-row",
      status: "processed" as const,
      metadata: { reason: "granted" },
    };

    it("forwards the status and metadata unchanged", async () => {
      const { client, rpc } = rpcClient({ data: null, error: null });

      await createPort(client).markProviderEvent(input);

      expect(rpc).toHaveBeenCalledWith("communication_mark_provider_event_processed", {
        p_provider_event_id: "evt-row",
        p_processing_status: "processed",
        p_metadata: { reason: "granted" },
      });
    });

    it("throws a namespaced failure when the RPC errors", async () => {
      const { client } = rpcClient({ data: null, error: { message: "unknown event" } });

      await expect(createPort(client).markProviderEvent(input))
        .rejects.toThrow("communication_mark_provider_event_processed_failed: unknown event");
    });
  });

  describe("failure message construction", () => {
    it("prefers the provider message, then the code, then an unknown marker", async () => {
      const cases: Array<[{ code?: string; message?: string }, string]> = [
        [{ message: "duplicate key", code: "23505" }, "duplicate key"],
        [{ code: "23505" }, "23505"],
        [{}, "unknown"],
      ];

      for (const [error, expected] of cases) {
        const { client } = rpcClient({ data: null, error });

        await expect(createPort(client)
          .markProviderEvent({ providerEventId: "evt-row", status: "failed", metadata: {} }))
          .rejects.toThrow(`communication_mark_provider_event_processed_failed: ${expected}`);
      }
    });
  });
});
