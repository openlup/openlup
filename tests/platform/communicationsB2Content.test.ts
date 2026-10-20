import { expect, it, vi } from "vitest";
import type { AccountingInvoiceEmailDeliveryPort } from "../../src/domains/accounting/invoiceDeliveryPorts.js";
import { createInMemoryEmailTransport, type EmailTransport } from "../../server/infra/email/emailTransport.js";
import { renderReferenceInvoice, renderReferenceRole, renderReferenceInquiry, renderOptOutPage } from "../../src/domains/communications/email/referenceContentBinding.js";
import { emailPresentation } from "#email-presentation";
import { CANON_PREVIEW_RENDERERS } from "../../src/pages/admin/email-canon-preview/index.js";
import { createUnsubscribeRouteHandler, type UnsubscribeClient } from "../../api/unsubscribe.js";
import { buildUnsubscribeToken } from "../../src/domains/communications/unsubscribeToken.js";

const adapters = import.meta.glob<{
  createAccountingInvoiceDeliveryPort: (input: {
    client: { rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: string | null; error: unknown }> };
    transport: EmailTransport; fromEmail: string; baseUrl: string; locale?: "pl" | "en";
  }) => AccountingInvoiceEmailDeliveryPort;
}>("../../server/adapters/*/accountingInvoiceDeliveryPort.ts", { eager: true });
const { createAccountingInvoiceDeliveryPort } = Object.values(adapters)[0];
const origin = "https://preview.example.test";
const invoiceCases = (["pl", "en"] as const).flatMap(locale => (["invoice", "correction"] as const).map(kind => ({ locale, kind })));
it.each(invoiceCases)("actual invoice bridge $locale/$kind preserves effects, fallback, PDF and key", async ({ locale, kind }) => {
  const effects: string[] = [], transport = createInMemoryEmailTransport();
  const captureSend = transport.send.bind(transport);
  const send = vi.spyOn(transport, "send").mockImplementation(async message => { effects.push("send"); const result = await captureSend(message); return { ...result, outcome: { ...result.outcome, resendId: "message-1" } }; });
  const rpc = vi.fn(async () => { effects.push("evidence"); return { data: "timeline-1", error: null }; });
  const port = createAccountingInvoiceDeliveryPort({ client: { rpc }, transport, fromEmail: "sender@example.test", baseUrl: origin, ...(locale === "en" ? { locale } : {}) });
  const delivery = { outboxId: "outbox-1", invoiceId: "invoice-1", orderId: "order-1", clientId: "client-1", orderRef: "ORDER-1", invoiceRef: "fallback-ref", providerInvoiceId: "doc-1", providerInvoiceNumber: null, recipientEmail: "recipient@example.test", deliverySource: kind === "correction" ? "correction_issued" : "invoice_issued", idempotencyKey: "invoice:doc-1", document: { filename: "document.pdf", content: Buffer.from("synthetic PDF") } };
  await expect(port.sendInvoiceDocument(delivery)).resolves.toEqual({ status: "sent", providerMessageId: "message-1" });
  const expected = renderReferenceInvoice(locale, { kind, orderRef: "ORDER-1", documentNumber: "fallback-ref", baseUrl: origin });
  expect(transport.sent[0]).toEqual({ from: "sender@example.test", to: "recipient@example.test", ...expected, idempotencyKey: "invoice:doc-1", attachments: [{ filename: "document.pdf", content: Buffer.from("synthetic PDF").toString("base64") }] });
  expect(expected.subject).toBe(`${locale === "pl" ? kind === "correction" ? "Korekta faktury do zamówienia" : "Faktura do zamówienia" : kind === "correction" ? "Invoice correction for order" : "Invoice for order"} ORDER-1`);
  expect(expected.html).toContain(`${origin}/${locale === "pl" ? "konto" : "account"}?sekcja=orders`);
  expect(expected.text).toContain("fallback-ref"); expect(effects).toEqual(["evidence", "send"]);
  rpc.mockRejectedValueOnce(new Error("required evidence unavailable"));
  await expect(port.sendInvoiceDocument(delivery)).rejects.toThrow(); expect(send).toHaveBeenCalledTimes(1);
  await port.sendInvoiceDocument({ ...delivery, providerInvoiceNumber: "" });
  expect(transport.sent[1].text).not.toContain("fallback-ref");
});

it("reference role preserves pending semantics and the exact host URL join", () => {
  const rendered = renderReferenceRole("en", { siteUrl: `${origin}/`, role: "admin", expiresAt: "2030-01-01" });
  expect(rendered.subject).toBe("Operator invitation: admin");
  expect(rendered.text).toContain("Your invitation is pending until 2030-01-01.");
  expect(rendered.text).toContain("Access begins when you enter the operator panel with your verified account.");
  expect(rendered.html).toContain(`${origin}//admin`); expect(rendered.text).not.toContain("membership is active");
});
it("previews equal their selected Polish reference samples and leave unknown/no-send rows absent", () => {
  const baseUrl = emailPresentation.brand.siteOrigin;
  expect(CANON_PREVIEW_RENDERERS["commerce-invoice-document"]()).toEqual(renderReferenceInvoice("pl", { baseUrl, orderRef: "ORDER-EXAMPLE", documentNumber: "DOC/EXAMPLE", kind: "invoice" }));
  expect(CANON_PREVIEW_RENDERERS["admin-user-role-granted"]()).toEqual(renderReferenceRole("pl", { siteUrl: baseUrl, role: "admin" }));
  expect(CANON_PREVIEW_RENDERERS["unknown"]).toBeUndefined();
  expect(CANON_PREVIEW_RENDERERS["account-password-reset"]).toBeUndefined();
  expect(CANON_PREVIEW_RENDERERS["b2b-inquiry-confirmation"]).toBeUndefined();
});

const secret = ["synthetic", "b2", "unsubscribe", "fixture"].join("-");
async function page(url: string, mode: "applied" | "already_suppressed" | "failed" | "absent" = "applied") {
  const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: mode === "absent" ? null : { id: "contact-1", email: "recipient@example.test" } }) };
  const rpc = vi.fn(async (_name: string, args: Record<string, unknown>) => {
    const count = (args.p_purposes as unknown[]).length;
    return { data: { status: mode, durablySuppressed: mode !== "failed", requestedPurposeCount: count, suppressedPurposeCount: count } };
  });
  const handler = createUnsubscribeRouteHandler({ createClient: () => ({ from: () => query, rpc }) as UnsubscribeClient, tokenSecret: secret });
  const result = { status: 0, body: "", headers: {} as Record<string, string> };
  const response = { setHeader: (key: string, value: string) => { result.headers[key] = value; }, status: (status: number) => { result.status = status; return response; }, send: (body: string) => { result.body = body; return response; } };
  await handler({ method: "GET", url } as Parameters<typeof handler>[0], response as unknown as Parameters<typeof handler>[1]);
  expect(result.headers).toEqual({ "Content-Type": "text/html; charset=utf-8", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "x-email-presentation": emailPresentation.id });
  return { ...result, rpc };
}
it.each(["pl", "en"] as const)("actual opt-out %s missing/not-found/errors preserve status and durable refusal", async locale => {
  const missing = await page(`/api/unsubscribe?lang=${locale}`);
  expect(missing.status).toBe(400); expect(missing.body).toContain(`<html lang="${locale}">`);
  expect(missing.body).toContain(locale === "pl" ? "<h1>Brakuje danych</h1>" : "<h1>Missing information</h1>");
  expect(missing.body).toContain(locale === "pl" ? "<p>Nieprawidłowy link do wypisania.</p>" : "<p>This unsubscribe link is incomplete.</p>"); expect(missing.rpc).not.toHaveBeenCalled();
  const absent = await page(`/api/unsubscribe?id=contact-1&email=recipient@example.test&lang=${locale}`, "absent");
  expect(absent.status).toBe(404); expect(absent.body).toContain(locale === "pl" ? "<p>Nie znaleziono takiego zgłoszenia.</p>" : "<p>We couldn&#39;t find this request.</p>"); expect(absent.rpc).not.toHaveBeenCalled();
  const failed = await page(`/api/unsubscribe?id=contact-1&email=recipient@example.test&lang=${locale}`, "failed");
  expect(failed.status).toBe(500); expect(failed.body).toContain(`<html lang="${locale}">`);
  expect(failed.body).toContain(locale === "pl" ? "<h1>Błąd</h1>" : "<h1>Error</h1>");
  expect(failed.body).toContain(locale === "pl" ? "<p>Coś poszło nie tak. Spróbuj ponownie później.</p>" : "<p>Something went wrong. Try again later.</p>");
  expect(failed.body).not.toContain(locale === "pl" ? "<h1>Wypisano</h1>" : "unsubscribed");
});
it("signed and legacy EN outcomes keep full neutral text, replay and protocol boundaries", async () => {
  const token = await buildUnsubscribeToken({ email: "recipient@example.test", purpose: "marketing_newsletter" }, secret);
  for (const mode of ["applied", "already_suppressed"] as const) {
    const signed = await page(`/api/unsubscribe?lang=en&token=${encodeURIComponent(token)}`, mode);
    expect(signed.status).toBe(200); expect(signed.body).toContain('<html lang="en">');
    expect(signed.body).toContain("<p>You won&#39;t receive these marketing emails anymore. Messages needed to manage your account, orders, payments and subscriptions may still arrive.</p>");
    expect(signed.rpc).toHaveBeenCalledWith("communication_apply_unsubscribe", expect.objectContaining({ p_purposes: ["marketing_newsletter"], p_source_table: null, p_source_id: null }));
    const legacy = await page("/api/unsubscribe?lang=en&id=contact-1&email=recipient@example.test", mode);
    expect(legacy.status).toBe(200); expect(legacy.body).toContain('<html lang="en">');
    expect(legacy.body).toContain(mode === "applied" ? "<p>We&#39;ve recorded your opt-out from the selected messages. Messages needed to manage your account, orders, payments and subscriptions may still arrive.</p>" : "<p>Your opt-out from the selected messages is already recorded. Messages needed to manage your account, orders, payments and subscriptions may still arrive.</p>");
  }
  const invalid = await page("/api/unsubscribe?lang=en&token=invalid.fixture");
  expect(invalid.status).toBe(400); expect(invalid.rpc).not.toHaveBeenCalled();
  expect(invalid.body).toContain("<p>We couldn&#39;t process this request. Copy the full link from the email or email support@example.test.</p>");
  expect((await page("/api/unsubscribe?lang=EN")).body).toContain('<html lang="pl">');
});
it("escapes every opt-out display position while retaining the layout", () => {
  const rendered = renderOptOutPage('<Title> & "quote" \'single\'', '<Body> & "quote" \'single\'', "en", '<Brand> & "quote" \'single\'');
  expect(rendered).toContain('<html lang="en">');
  expect(rendered).toContain("<title>&lt;Title&gt; &amp; &quot;quote&quot; &#39;single&#39; - &lt;Brand&gt; &amp; &quot;quote&quot; &#39;single&#39;</title>");
  expect(rendered).toContain("<h1>&lt;Title&gt; &amp; &quot;quote&quot; &#39;single&#39;</h1>");
  expect(rendered).toContain("<p>&lt;Body&gt; &amp; &quot;quote&quot; &#39;single&#39;</p>");
  expect(rendered).not.toContain("<Brand>"); expect(rendered).not.toContain("<Body>");
});

it.each(["pl", "en"] as const)("pure generic inquiry reference %s uses caller details, brand and URL", locale => {
  const brand = { ...emailPresentation.brand.email, theme: { ...emailPresentation.brand.email.theme, logoText: "Synthetic Host" } };
  const result = renderReferenceInquiry(locale, { displayName: "Alex Example", contact: "alex@example.test", details: [{ label: "Region", value: "Synthetic region" }], operatorUrl: "https://example.test/inquiries/1" }, "Synthetic team", brand);
  expect(result.receipt.subject).toBe(locale === "pl" ? "Otrzymaliśmy Twoje zapytanie" : "We've received your inquiry");
  expect(result.notice.subject).toBe(locale === "pl" ? "Nowe zapytanie" : "New inquiry");
  expect(result.receipt.text).toContain(locale === "pl" ? "Potwierdzamy otrzymanie Twojego zapytania." : "We confirm receipt of your inquiry.");
  expect(result.notice.html).toContain('href="https://example.test/inquiries/1"');
  expect(result.notice.text).toContain("Region: Synthetic region");
  for (const rendered of [result.receipt, result.notice]) { expect(rendered.html).toContain("Synthetic Host"); expect(rendered.text).toContain("Synthetic team"); expect(rendered.text).not.toMatch(/private.label|business.day|discovery.call/i); }
});
