import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { admitPolicyEnforcedEmailTransport } from "@openlup/platform/communications";
import type { AccountingInvoiceEmailDeliveryPort } from "../../src/domains/accounting/invoiceDeliveryPorts.js";
import type { EmailTransport } from "../../server/infra/email/emailTransport.js";

// Select the actual reference adapter by responsibility; no vendor binding is
// added to the neutral package or changed in the frozen adapter directories.
const invoiceAdapters = import.meta.glob<{
  createAccountingInvoiceDeliveryPort: (input: {
    client: { rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: string | null; error: unknown }> };
    transport: EmailTransport; fromEmail: string; baseUrl: string;
  }) => AccountingInvoiceEmailDeliveryPort;
}>("../../server/adapters/*/accountingInvoiceDeliveryPort.ts", { eager: true });
expect(Object.keys(invoiceAdapters)).toHaveLength(1);
const { createAccountingInvoiceDeliveryPort } = Object.values(invoiceAdapters)[0];
import { createAdminRoleNotificationPort } from "../../server/adapters/email/adminRoleNotificationPort.js";
import { createPrivateLabelB2BInquiryPresenter } from "../../server/adapters/email/privateLabelB2BInquiryPresenter.js";
import { createInMemoryEmailTransport } from "../../server/infra/email/emailTransport.js";
import { createUnsubscribeRouteHandler, type UnsubscribeClient } from "../../api/unsubscribe.js";
import { buildUnsubscribeToken } from "../../src/domains/communications/unsubscribeToken.js";

// Complete output digests pin the current PUBLIC renderer, not adopter copy.
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const origin = "https://preview.example.test";
const accepted = { ok: true, resendId: "message-1", httpStatus: 200, providerError: null, aborted: false };

describe("W4 current public communications", () => {
  it.each(["invoice_issued", "correction_issued"])("pins invoice output and required evidence: %s", async deliverySource => {
    const effects: string[] = [];
    const send = vi.fn(async (_message: Parameters<import("../../server/infra/email/emailTransport.js").EmailTransport["send"]>[0]) => { effects.push("send"); return { outcome: accepted, providerResponse: {} }; });
    const rpc = vi.fn(async () => { effects.push("evidence"); return { data: "timeline-1", error: null }; });
    const port = createAccountingInvoiceDeliveryPort({ client: { rpc }, transport: admitPolicyEnforcedEmailTransport({ providerKind: "capture", send }), fromEmail: "sender@example.test", baseUrl: origin });
    const delivery = {
      outboxId: "outbox-1", invoiceId: "invoice-1", orderId: "order-1", clientId: "client-1",
      orderRef: "ORDER-1", invoiceRef: "ORDER-1:base", providerInvoiceId: "document-1", providerInvoiceNumber: "DOC/1",
      recipientEmail: "recipient@example.test", deliverySource, idempotencyKey: "invoice:document-1",
      document: { filename: "document.pdf", content: Buffer.from("synthetic document") },
    };
    await expect(port.sendInvoiceDocument(delivery)).resolves.toEqual({ status: "sent", providerMessageId: "message-1" });
    expect(effects).toEqual(["evidence", "send"]);
    const message = send.mock.calls[0]?.[0];
    expect(message).toMatchObject({ subject: `${deliverySource === "correction_issued" ? "Korekta faktury" : "Faktura"} do zamówienia ORDER-1`, idempotencyKey: "invoice:document-1", attachments: [{ filename: "document.pdf", content: Buffer.from("synthetic document").toString("base64") }] });
    expect(JSON.stringify(message)).toContain(`${origin}/konto?sekcja=orders`);
    expect(digest(message)).toMatchSnapshot();
    effects.length = 0;
    rpc.mockRejectedValueOnce(new Error("required evidence unavailable"));
    await expect(port.sendInvoiceDocument(delivery)).rejects.toThrow();
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(effects).not.toContain("send");
  });

  for (const role of ["admin", "distributor"] as const) for (const locale of ["pl", "en"] as const) {
    it.each([false, true])(`pins ${role}/${locale} active or pending: %s`, async pending => {
      const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: async () => ({ data: { enabled: true }, error: null }), insert: async () => ({ error: null }) };
      query.select.mockReturnValue(query); query.eq.mockReturnValue(query);
      const transport = createInMemoryEmailTransport();
      const rpc = vi.fn(async (_name: string) => ({ data: "timeline-1", error: null }));
      const port = createAdminRoleNotificationPort({ client: { from: () => query, rpc }, transport, fromEmail: "sender@example.test", siteUrl: origin });
      const notification = { role, locale, authUserId: "principal-1", email: "recipient@example.test", ...(pending ? { invitationId: "invitation-1", expiresAt: "2030-01-01T00:00:00Z" } : {}) };
      await port.sendRoleGranted(notification);
      const message = transport.sent[0];
      expect(message.subject).toBe(`${locale === "pl" ? pending ? "Zaproszenie operatora" : "Uprawnienia operatora" : pending ? "Operator invitation" : "Operator membership"}: ${role}`);
      expect(message.html).toContain(`${origin}/admin`);
      expect(message.text?.includes("2030-01-01T00:00:00Z")).toBe(pending);
      expect(message.idempotencyKey).toBe(pending ? "invitation-1" : `admin-membership:principal-1:${role}`);
      expect(digest(message)).toMatchSnapshot();
      expect(rpc.mock.calls.every(([name]) => name === "communication_record_email_delivery")).toBe(true);
    });
  }

  it("pins inquiry confirmation, operator copy, region, reply target and origin refusal", () => {
    const input = { request: { company: "Example Company", country: "CZ", firstName: "Alex", lastName: "Example", email: "alex@example.test", phone: "+123456789", notes: "Synthetic enquiry" }, sourceId: "inquiry-1", notificationTo: ["operator@example.test"] };
    const result = createPrivateLabelB2BInquiryPresenter({ APP_BASE_URL: origin, FROM_EMAIL: "sender@example.test" }).present(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("presentation refused");
    expect(result.confirmation.subject).toBe("We've received your enquiry, Alex");
    expect(result.confirmation.replyTo).toBe("operator@example.test");
    expect(result.notification.subject).toBe("🤝 New B2B inquiry: Example Company (Czech Republic (CZ))");
    expect(result.notification.html).toContain(`${origin}/admin/b2b-inquiries/inquiry-1`);
    expect(digest(result)).toMatchSnapshot();
    expect(createPrivateLabelB2BInquiryPresenter({ EMAIL_ENVIRONMENT: "hidden_preview" }).present(input)).toEqual({ ok: false, error: "hidden_preview_origin_required" });
  });

  it.each(["applied", "already_suppressed"] as const)("pins legacy unsubscribe Polish success/replay: %s", async status => {
    const result = await unsubscribe(status);
    expect(result.status).toBe(200);
    expect(result.body).toContain('<html lang="pl">');
    expect(result.body).toContain(status === "applied" ? "Zapisalismy Twoja rezygnacje" : "Twoja rezygnacja z wiadomosci marketingowych i dla testerow jest juz zapisana.");
    expect(result.headers["Cache-Control"]).toBe("no-store");
    expect(result.headers["Referrer-Policy"]).toBe("no-referrer");
    expect(digest(result)).toMatchSnapshot();
  });

  it("pins signed EN unsubscribe with its existing Polish document language", async () => {
    const token = await buildUnsubscribeToken({ email: "recipient@example.test", purpose: "marketing_newsletter" }, "synthetic-token-secret-0123456789");
    const result = await unsubscribe("applied", `/api/unsubscribe?lang=en&token=${encodeURIComponent(token)}`);
    expect(result.body).toContain('<html lang="pl">');
    expect(result.body).toContain("You're unsubscribed");
    expect(digest(result)).toMatchSnapshot();
  });
});

async function unsubscribe(status: "applied" | "already_suppressed", url = "/api/unsubscribe?id=contact-1&email=recipient@example.test&lang=en") {
  const effects: string[] = [];
  const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: { id: "contact-1", email: "recipient@example.test" }, error: null }) };
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => { effects.push(name); const count = (args.p_purposes as unknown[]).length; return { data: { status, durablySuppressed: true, requestedPurposeCount: count, suppressedPurposeCount: count }, error: null }; });
  const handler = createUnsubscribeRouteHandler({ createClient: () => ({ from: () => query, rpc }) as unknown as UnsubscribeClient, tokenSecret: "synthetic-token-secret-0123456789" });
  const result = { status: 0, body: "", headers: {} as Record<string, string>, effects };
  const response = { setHeader: (key: string, value: string) => { result.headers[key] = value; }, status: (value: number) => { result.status = value; return response; }, send: (value: string) => { result.body = value; return response; } };
  await handler({ method: "GET", url } as Parameters<typeof handler>[0], response as unknown as Parameters<typeof handler>[1]);
  expect(effects).toEqual(["communication_apply_unsubscribe"]);
  expect(rpc).toHaveBeenCalledWith("communication_apply_unsubscribe", expect.objectContaining({ p_email: "recipient@example.test" }));
  return result;
}
