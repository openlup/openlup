import { describe, expect, it, vi } from "vitest";
import { createManagedB2BInquirySubmit } from "./managedB2BInquirySubmit.js";

const request = {
  company: "Acme Foods", country: "US", firstName: "Jane", lastName: "Smith", email: "jane@acmepets.com",
  phone: "+1 555 123 4567", notes: "Private label retail range.",
};
const FREE_EMAIL_DOMAIN_FIXTURE = "gmail.com";

describe("managed B2B inquiry submit", () => {
  it("keeps invalid requests and honeypot submissions completely side-effect free", async () => {
    const deps = fixture();
    const submit = createManagedB2BInquirySubmit(deps);

    await expect(submit({ ...request, email: `b2b-free-domain@${FREE_EMAIL_DOMAIN_FIXTURE}` }, new Headers())).resolves.toMatchObject({ status: 400, error: "blocked_email_domain" });
    await expect(submit(request, new Headers(), true)).resolves.toEqual({ success: true, status: 200 });

    expect(deps.gateway.submit).not.toHaveBeenCalled();
    expect(deps.delivery.evaluatePolicy).not.toHaveBeenCalled();
    expect(deps.delivery.deliver).not.toHaveBeenCalled();
  });

  it("hashes the forwarded address and durably submits before policy or email", async () => {
    const events: string[] = [];
    const deps = fixture({ events });
    const submit = createManagedB2BInquirySubmit(deps);

    await expect(submit(request, new Headers({ "x-forwarded-for": "198.51.100.9, proxy" }))).resolves.toMatchObject({ success: true, id: "inq-1", status: 200 });

    expect(deps.gateway.submit).toHaveBeenCalledWith({ ipHash: "hash:198.51.100.9", request });
    expect(events).toEqual(["primary", "policy:transactional", "policy:admin_notification", "deliver", "deliver"]);
  });

  it.each([
    ["unavailable", { kind: "unavailable" as const }, 503, "rate_limit_unavailable"],
    ["limited", { kind: "rate_limited" as const }, 429, "rate_limit"],
  ])("does not send when the primary RPC is %s", async (_name, result, status, error) => {
    const deps = fixture({ submitResult: result });

    await expect(createManagedB2BInquirySubmit(deps)(request, new Headers())).resolves.toMatchObject({ status, error });
    expect(deps.delivery.evaluatePolicy).not.toHaveBeenCalled();
    expect(deps.delivery.deliver).not.toHaveBeenCalled();
  });

  it("preserves the primary success when both policy decisions deny delivery", async () => {
    const deps = fixture({ policyAllowed: false });

    await expect(createManagedB2BInquirySubmit(deps)(request, new Headers())).resolves.toEqual({
      success: true, id: "inq-1", skipped: "policy_blocked", status: 200,
    });
    expect(deps.presenter.present).not.toHaveBeenCalled();
    expect(deps.delivery.deliver).not.toHaveBeenCalled();
  });

  it("evaluates each admin recipient independently and preserves its decision evidence", async () => {
    const notificationTo = ["allow-one@example.com", "deny@example.com", "allow-two@example.com"];
    const deps = fixture({
      notificationTo,
      policyByEmail: {
        [request.email]: { allowed: true, reason: "external_allowed", decisionId: "external-1" },
        "allow-one@example.com": { allowed: true, reason: "admin_allowed_one", decisionId: "admin-1" },
        "deny@example.com": { allowed: false, reason: "admin_denied", decisionId: "admin-2" },
        "allow-two@example.com": { allowed: true, reason: "admin_allowed_two", decisionId: "admin-3" },
      },
    });

    await expect(createManagedB2BInquirySubmit(deps)(request, new Headers())).resolves.toMatchObject({ success: true, id: "inq-1" });

    expect(deps.delivery.evaluatePolicy).toHaveBeenCalledTimes(4);
    expect(deps.delivery.evaluatePolicy.mock.calls.map(([input]) => input.email)).toEqual([request.email, ...notificationTo]);
    expect(deps.delivery.deliver).toHaveBeenCalledTimes(3);
    expect(deps.delivery.deliver.mock.calls.map(([input]) => input.recipientEmail)).toEqual([request.email, "allow-one@example.com", "allow-two@example.com"]);
    expect(deps.delivery.deliver.mock.calls.slice(1).map(([input]) => input.policyDecisionId)).toEqual(["admin-1", "admin-3"]);
    expect(deps.delivery.deliver.mock.calls.slice(1).map(([input]) => input.metadata)).toEqual([
      { recipientCount: 3, inquiryId: "inq-1", policyReason: "admin_allowed_one" },
      { recipientCount: 3, inquiryId: "inq-1", policyReason: "admin_allowed_two" },
    ]);
    expect(deps.delivery.deliver).not.toHaveBeenCalledWith(expect.objectContaining({ recipientEmail: "deny@example.com" }));
  });

  it("keeps a durable inquiry successful when the neutral delivery result is non-sent", async () => {
    for (const deliveryResult of [
      { accepted: false, messageId: null, skip: "egress_suppressed", error: null },
      { accepted: false, messageId: null, skip: null, error: "address_rejected" },
      { accepted: false, messageId: null, skip: null, error: "provider_accepted_without_message_id" },
    ]) {
      const deps = fixture({ deliveryResult });
      await expect(createManagedB2BInquirySubmit(deps)(request, new Headers())).resolves.toMatchObject({ success: true, id: "inq-1", status: 200 });
      expect(deps.delivery.deliver).toHaveBeenCalledTimes(2);
    }
  });

  it("uses the neutral delivery port without provider result fields", async () => {
    const deps = fixture({
      deliveryResult: { accepted: false, messageId: null, skip: null, error: "provider_accepted_without_message_id" },
    });

    await expect(createManagedB2BInquirySubmit(deps)(request, new Headers())).resolves.toMatchObject({ success: true, id: "inq-1", status: 200 });

    expect(deps.delivery.deliver).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: "b2b_confirmation:inq-1",
      message: expect.objectContaining({ to: request.email, sender: "openlup <hello@example.com>" }),
    }));
  });

  it("keeps the legacy origin error after the primary write and before sends", async () => {
    const deps = fixture({ presentation: { ok: false as const, error: "untrusted_origin" } });

    await expect(createManagedB2BInquirySubmit(deps)(request, new Headers())).resolves.toMatchObject({
      success: false, status: 500, error: "untrusted_origin", code: "email_origin_error",
    });
    expect(deps.delivery.deliver).not.toHaveBeenCalled();
  });

});

function fixture(options: {
  events?: string[];
  submitResult?: { kind: "accepted"; id: string } | { kind: "rate_limited" } | { kind: "unavailable" };
  policyAllowed?: boolean;
  notificationTo?: string[];
  policyByEmail?: Record<string, { allowed: boolean; reason: string; decisionId: string | null }>;
  deliveryResult?: { accepted: boolean; messageId: string | null; skip: string | null; error: string | null };
  presentation?: { ok: true; confirmation: { sender: string; subject: string; html: string; text: string; replyTo?: string }; notification: { sender: string; subject: string; html: string; text: string } } | { ok: false; error: string };
} = {}) {
  const events = options.events ?? [];
  const deliveryResult = options.deliveryResult ?? { accepted: true, messageId: "mail-1", skip: null, error: null };
  return {
    gateway: {
      submit: vi.fn(async () => {
        events.push("primary");
        return options.submitResult ?? { kind: "accepted" as const, id: "inq-1" };
      }),
    },
    delivery: {
      evaluatePolicy: vi.fn(async (input: { purpose?: string; email?: string | null }) => {
        events.push(`policy:${input.purpose}`);
        return options.policyByEmail?.[input.email ?? ""] ?? { allowed: options.policyAllowed ?? true, reason: "policy_blocked", decisionId: "decision-1" };
      }),
      deliver: vi.fn(async (_input: { recipientEmail?: string; policyDecisionId?: string | null; metadata?: Record<string, unknown> }) => {
        events.push("deliver");
        return deliveryResult;
      }),
    },
    notificationTo: options.notificationTo ?? ["ops@example.com"],
    presenter: {
      present: vi.fn(() => options.presentation ?? {
        ok: true as const,
        confirmation: { sender: "openlup <hello@example.com>", subject: "Confirmation", html: "<p>Confirmation</p>", text: "Confirmation", replyTo: "ops@example.com" },
        notification: { sender: "openlup <hello@example.com>", subject: "Notification", html: "<p>Notification</p>", text: "Notification" },
      }),
    },
    hashIp: vi.fn(async (value: string) => `hash:${value}`),
  };
}
