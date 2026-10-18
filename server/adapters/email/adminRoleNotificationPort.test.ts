import { describe, expect, it, vi } from "vitest";
import { createAdminRoleNotificationPort } from "./adminRoleNotificationPort.js";
import { createInMemoryEmailTransport } from "../../infra/email/emailTransport.js";

const invitation = {
  invitationId: "10000000-0000-4000-8000-000000000001",
  authUserId: "10000000-0000-4000-8000-000000000002",
  email: "invitee@example.com", role: "admin" as const,
  expiresAt: "2030-01-01T00:01:00.000Z",
};
function fixture(enabled = true) {
  const insert = vi.fn(async () => ({ error: null }));
  const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(async () => ({ data: { enabled }, error: null })), insert };
  query.select.mockReturnValue(query); query.eq.mockReturnValue(query);
  const rpc = vi.fn(async () => ({ data: "10000000-0000-4000-8000-000000000003", error: null }));
  const transport = createInMemoryEmailTransport();
  const send = vi.spyOn(transport, "send");
  const port = createAdminRoleNotificationPort({ client: { from: () => query, rpc }, transport,
    fromEmail: "Application <operator@example.com>", siteUrl: "https://app.example.com" });
  return { port, send, rpc, insert };
}
describe("operator invitation notification", () => {
  it.each([
    ["en", "Your operator membership is active.", "pending", "Access begins"],
    ["pl", "Twoje uprawnienia operatora są aktywne.", "Zaproszenie oczekuje na przyjęcie", "Dostęp rozpocznie"],
  ] as const)("renders active managed membership without a deadline in %s", async (locale, active, pending, activation) => {
    const { port, send, rpc } = fixture();
    const membership = { authUserId: invitation.authUserId, email: invitation.email, role: invitation.role, locale };
    await expect(port.sendRoleGranted(membership)).resolves.toMatchObject({ ok: true, skipped: false });
    const key = `admin-membership:${membership.authUserId}:${membership.role}`;
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      to: membership.email, idempotencyKey: key,
      text: expect.stringContaining(active), html: expect.stringContaining(active),
    }));
    const sent = send.mock.calls[0][0];
    for (const copy of [sent.text, sent.html]) {
      expect(copy).not.toContain(pending);
      expect(copy).not.toContain(activation);
      expect(copy).not.toContain(invitation.expiresAt);
      expect(copy).not.toContain("undefined");
    }
    expect(rpc).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ p_dedupe_key: key }));
    await port.sendRoleGranted(membership);
    expect(send.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([key, key]);
  });
  it.each([
    ["en", "Your invitation is pending until", "Access begins when you enter"],
    ["pl", "Zaproszenie oczekuje na przyjęcie do", "Dostęp rozpocznie się po wejściu"],
  ] as const)("renders neutral pending copy and deadline in %s", async (locale, pending, activation) => {
    const { port, send, rpc } = fixture();
    await expect(port.sendRoleGranted({ ...invitation, locale })).resolves.toMatchObject({ ok: true, skipped: false });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      to: invitation.email, idempotencyKey: invitation.invitationId,
      text: expect.stringContaining(`${pending} ${invitation.expiresAt}`),
      html: expect.stringContaining(invitation.expiresAt),
    }));
    expect(send.mock.calls[0][0].text).toContain(activation);
    expect(rpc).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ p_dedupe_key: invitation.invitationId }));
  });
  it("gives a reissued attempt its own delivery identity", async () => {
    const { port, send } = fixture();
    await port.sendRoleGranted({ ...invitation, locale: "en" });
    const nextId = "10000000-0000-4000-8000-000000000004";
    await port.sendRoleGranted({ ...invitation, invitationId: nextId, locale: "en" });
    expect(send.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([invitation.invitationId, nextId]);
  });
  it("retains operator notification suppression without a send or receipt", async () => {
    const { port, send, insert } = fixture(false);
    await expect(port.sendRoleGranted({ ...invitation, locale: "pl" })).resolves.toEqual({
      ok: true, providerMessageId: null, providerError: null, skipped: true, skipReason: "admin_disabled",
    });
    expect(send).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ resend_id: null, status: "skipped" }));
  });
});
