import { describe, expect, it, vi } from "vitest";
import type { AuthEmailPersistencePort } from "../../domains/auth/ports.js";
import {
  createSupabaseAuthEmailPersistencePort,
  type SupabaseAuthEmailPersistenceClient,
} from "./authEmailPersistencePort.js";

const fixtureAuthUserId = ["c79fba0e", "02f9", "4c70", "901d", "f12a2a539f96"].join("-");

function send(overrides: Partial<Parameters<AuthEmailPersistencePort["recordSend"]>[0]> = {}) {
  return {
    templateSlug: "auth-magiclink",
    recipientEmail: "person@example.test",
    authUserId: fixtureAuthUserId,
    aggregateId: fixtureAuthUserId,
    dedupeKey: "auth-send-email:magiclink:attempt-1",
    providerKind: "email-provider",
    outcome: { ok: true, messageId: "message-1", providerError: null },
    providerResponse: { id: "message-1" },
    metadata: { triggerSource: "auth-send-email", sendAttemptId: "attempt-1" },
    ...overrides,
  };
}

function clientFixture(options: { enabled?: boolean; insertId?: string | null } = {}) {
  const rows: Record<string, unknown>[] = [];
  const rpc = vi.fn().mockResolvedValue({ data: "timeline-1", error: null });
  const controls = {
    select: vi.fn(), eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data: options.enabled === false ? { enabled: false } : null, error: null }),
  };
  controls.select.mockReturnValue(controls);
  controls.eq.mockReturnValue(controls);
  const client = {
    rpc,
    from: vi.fn((table: string) => {
      if (table === "comms_notification_controls") return controls;
      return { insert: (row: Record<string, unknown>) => {
        rows.push(row);
        return { select: () => ({ maybeSingle: async () => ({ data: options.insertId ? { id: options.insertId } : null, error: null }) }) };
      } };
    }),
  } as unknown as SupabaseAuthEmailPersistenceClient;
  return { client, controls, rows, rpc };
}

describe("createSupabaseAuthEmailPersistencePort", () => {
  it("reuses one composition-root client for control, timeline, and legacy-ledger projections", async () => {
    const fixture = clientFixture({ insertId: "email-send-1" });
    const createClient = vi.fn(() => fixture.client);
    const persistence = createSupabaseAuthEmailPersistencePort({
      createClient,
      now: () => new Date("2026-08-23T12:00:00.000Z"),
    });

    await expect(persistence.isTemplateEnabled("auth-magiclink", new AbortController().signal)).resolves.toBe(true);
    await persistence.recordSend(send());

    expect(createClient).toHaveBeenCalledOnce();
    expect(fixture.controls.select).toHaveBeenCalledWith("enabled");
    expect(fixture.rows).toEqual([expect.objectContaining({
      template_slug: "auth-magiclink",
      source: "auth-send-email",
      resend_id: "message-1",
      status: "sent",
      sent_at: "2026-08-23T12:00:00.000Z",
      provider_error: null,
      provider_response: { id: "message-1", triggerSource: "auth-send-email", sendAttemptId: "timeline-1" },
    })]);
    expect(fixture.rpc).toHaveBeenNthCalledWith(1, "communication_record_email_delivery", expect.objectContaining({
      p_dedupe_key: "auth-send-email:magiclink:attempt-1",
      p_template_slug: "auth-magiclink",
      p_status: "sent",
      p_recipient_email: "person@example.test",
      p_provider_kind: "email-provider",
      p_provider_message_id: "message-1",
      p_email_send_id: null,
    }));
    expect(fixture.rpc).toHaveBeenNthCalledWith(2, "communication_record_email_delivery", expect.objectContaining({
      p_email_send_id: "email-send-1",
    }));
  });

  it("projects an explicit disabled control into skipped timeline and ledger evidence without provider data", async () => {
    const fixture = clientFixture({ enabled: false });
    const persistence = createSupabaseAuthEmailPersistencePort({ createClient: () => fixture.client });

    await expect(persistence.isTemplateEnabled("auth-magiclink", new AbortController().signal)).resolves.toBe(false);
    await persistence.recordSend(send({
      outcome: { ok: true, messageId: null, providerError: null, skipReason: "admin_disabled" },
      providerResponse: { skipped: "admin_disabled" },
    }));

    expect(fixture.rows[0]).toMatchObject({
      resend_id: null, status: "skipped", sent_at: null, provider_response: expect.objectContaining({ skipped: "admin_disabled" }),
    });
    expect(fixture.rpc).toHaveBeenCalledWith("communication_record_email_delivery", expect.objectContaining({
      p_status: "skipped", p_provider_message_id: null, p_last_error_code: "admin_disabled",
      p_metadata: expect.objectContaining({ skipped: "admin_disabled" }),
    }));
  });

  it("retains a failed transport as failed evidence and does not put recipient data in the ledger response", async () => {
    const fixture = clientFixture();
    const persistence = createSupabaseAuthEmailPersistencePort({ createClient: () => fixture.client });

    await persistence.recordSend(send({
      outcome: { ok: false, messageId: null, providerError: "provider unavailable" },
      providerResponse: { error: "provider unavailable" },
    }));

    expect(fixture.rows[0]).toMatchObject({ status: "failed", sent_at: null, provider_error: "provider unavailable" });
    expect(fixture.rpc).toHaveBeenCalledWith("communication_record_email_delivery", expect.objectContaining({
      p_status: "failed", p_last_error_code: "provider_unavailable",
    }));
    expect(JSON.stringify(fixture.rows[0]?.provider_response)).not.toContain("person@example.test");
  });
});
