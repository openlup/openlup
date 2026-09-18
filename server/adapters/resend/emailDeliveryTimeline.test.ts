import { describe, expect, it, vi } from "vitest";
import {
  EmailDeliveryTimelineError,
  recordEmailDeliveryTimeline,
} from "./emailDeliveryTimeline.js";

const baseInput = {
  dedupeKey: "outbox:evt-1",
  templateSlug: "commerce-order-paid",
  purpose: "transactional" as const,
  triggerSource: "outbox-dispatch",
  triggerEvent: "outbox_dispatch_send",
  status: "processing" as const,
  recipientEmail: "anna@example.com",
  metadata: { adapter: "test" },
};

describe("recordEmailDeliveryTimeline", () => {
  it("returns the durable delivery id from the RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "delivery-1", error: null });

    await expect(recordEmailDeliveryTimeline({ rpc }, baseInput, { required: true }))
      .resolves.toBe("delivery-1");
    expect(rpc).toHaveBeenCalledWith("communication_record_email_delivery", expect.objectContaining({
      p_dedupe_key: "outbox:evt-1",
      p_template_slug: "commerce-order-paid",
      p_status: "processing",
      p_recipient_email: "anna@example.com",
      p_metadata: { adapter: "test" },
    }));
  });

  it("fails closed for required customer sends when the RPC is unavailable", async () => {
    await expect(recordEmailDeliveryTimeline({}, baseInput, {
      required: true,
      context: "outbox-dispatch:commerce-order-paid",
    })).rejects.toThrow(/email_delivery_timeline_rpc_missing:outbox-dispatch:commerce-order-paid/);
  });

  it("keeps best-effort callers non-blocking on RPC errors", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "down", code: "PGRST204" } });

    await expect(recordEmailDeliveryTimeline({ rpc }, baseInput)).resolves.toBeNull();
    // Was a bare single-argument assertion. The lost send is now identifiable:
    // on production this fires from the live payment webhook several times a
    // day and named nothing at all.
    expect(consoleError).toHaveBeenCalledWith(
      "[email-delivery-timeline] record RPC returned error",
      {
        context: null,
        templateSlug: "commerce-order-paid",
        purpose: "transactional",
        triggerSource: "outbox-dispatch",
        triggerEvent: "outbox_dispatch_send",
        status: "processing",
        aggregateType: null,
        aggregateId: null,
        outboxEventId: null,
        errorCode: "PGRST204",
      },
    );
  });

  it("names the caller and the row when a best-effort write throws", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const rpc = vi.fn().mockRejectedValue(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));

    await expect(recordEmailDeliveryTimeline({ rpc }, {
      ...baseInput,
      aggregateType: "commerce_order",
      aggregateId: "11111111-2222-3333-4444-555555555555",
      outboxEventId: "evt-1",
    }, { context: "outbox-dispatch:commerce-order-paid" })).resolves.toBeNull();

    expect(consoleError).toHaveBeenCalledWith(
      "[email-delivery-timeline] record RPC threw",
      expect.objectContaining({
        context: "outbox-dispatch:commerce-order-paid",
        aggregateType: "commerce_order",
        aggregateId: "11111111-2222-3333-4444-555555555555",
        outboxEventId: "evt-1",
        errorCode: "ECONNRESET",
      }),
    );
  });

  // The guardrail for this whole wave. Both log sites are on a live payment
  // webhook path, so a spread of `input` or of the raw error would replicate a
  // customer address into the log drain several times a day. Poison every
  // excluded channel at once and assert none of it survives serialization.
  it("never logs personal data, whichever channel it arrives through", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const address = "anna@example.com";
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: "23505",
        message: `duplicate key value violates unique constraint, email=${address}`,
        details: `Key (recipient_email)=(${address}) already exists.`,
        hint: address,
      },
    });

    await expect(recordEmailDeliveryTimeline({ rpc }, {
      ...baseInput,
      recipientEmail: address,
      dedupeKey: `outbox:${address}`,
      metadata: { operator: address },
    })).resolves.toBeNull();

    const [, context] = consoleError.mock.calls[0] ?? [];
    expect(JSON.stringify(context)).not.toContain(address);
    expect(JSON.stringify(context)).not.toContain("anna");
    // The code is the one thing lifted off the error, and it still gets through.
    expect(context).toMatchObject({ errorCode: "23505" });
  });

  it("throws a typed error when a required RPC does not return an id", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });

    await expect(recordEmailDeliveryTimeline({ rpc }, baseInput, { required: true }))
      .rejects.toBeInstanceOf(EmailDeliveryTimelineError);
  });

  // `p_platform_job_run_id` is a uuid column with a foreign key to the job-run
  // ledger. A dispatch label reached it from the payment webhook and failed the
  // cast before the function body ran, so the whole row was lost twice per mail.
  it("keeps a run id that is not uuid-shaped out of the column and inside the metadata", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "delivery-1", error: null });

    await expect(recordEmailDeliveryTimeline({ rpc }, {
      ...baseInput,
      platformJobRunId: "immediate-paid-email-dispatch",
    }, { required: true })).resolves.toBe("delivery-1");

    expect(rpc).toHaveBeenCalledWith("communication_record_email_delivery", expect.objectContaining({
      p_platform_job_run_id: null,
      p_metadata: { adapter: "test", platformJobRunId: "immediate-paid-email-dispatch" },
    }));
  });

  it("passes a uuid-shaped run id through and leaves the metadata untouched", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "delivery-1", error: null });

    await expect(recordEmailDeliveryTimeline({ rpc }, {
      ...baseInput,
      platformJobRunId: "3F2A1B4C-5D6E-4F70-8A9B-0C1D2E3F4A5B",
    }, { required: true })).resolves.toBe("delivery-1");

    expect(rpc).toHaveBeenCalledWith("communication_record_email_delivery", expect.objectContaining({
      p_platform_job_run_id: "3F2A1B4C-5D6E-4F70-8A9B-0C1D2E3F4A5B",
      p_metadata: { adapter: "test" },
    }));
  });

  it("keeps the production shape as is: the same label in the input and in the port's origin metadata", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "delivery-1", error: null });

    await expect(recordEmailDeliveryTimeline({ rpc }, {
      ...baseInput,
      platformJobRunId: "immediate-paid-email-dispatch",
      metadata: { adapter: "test", platformJobRunId: "immediate-paid-email-dispatch" },
    }, { required: true })).resolves.toBe("delivery-1");

    expect(rpc).toHaveBeenCalledWith("communication_record_email_delivery", expect.objectContaining({
      p_platform_job_run_id: null,
      p_metadata: { adapter: "test", platformJobRunId: "immediate-paid-email-dispatch" },
    }));
  });

  it("never overwrites a run id the caller already carries in its own metadata", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "delivery-1", error: null });

    await expect(recordEmailDeliveryTimeline({ rpc }, {
      ...baseInput,
      platformJobRunId: "immediate-paid-email-dispatch",
      metadata: { adapter: "test", platformJobRunId: "caller-owned-label" },
    }, { required: true })).resolves.toBe("delivery-1");

    expect(rpc).toHaveBeenCalledWith("communication_record_email_delivery", expect.objectContaining({
      p_platform_job_run_id: null,
      p_metadata: { adapter: "test", platformJobRunId: "caller-owned-label" },
    }));
  });
});
