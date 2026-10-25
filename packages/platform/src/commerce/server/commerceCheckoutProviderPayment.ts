import type { HttpRequest } from "../../http/index.js";
export interface CheckoutPaymentExecution { provider: string; flow?: string }
export function createCheckoutClientAction<Embedded extends string>(embeddedProvider: Embedded, redirectProvider: string) {
function checkoutClientAction(input: {
  provider: string;
  status: "paid" | "processing" | "failed";
  providerClientSecret: string | null;
  providerRedirectUrl: string | null;
}) {
  if (input.status !== "processing") return { kind: "none" as const };
  if (input.provider === embeddedProvider) {
    return {
      kind: "provider_embedded" as const,
      provider: embeddedProvider,
      ...(input.providerClientSecret ? { clientSecret: input.providerClientSecret } : {}),
    };
  }
  if (input.provider === redirectProvider && input.providerRedirectUrl) {
    return { kind: "redirect" as const, url: input.providerRedirectUrl };
  }
  return { kind: "none" as const };
}

return checkoutClientAction;
}

export function providerPayerFromRequest(req: HttpRequest, intent: { contact: { email: string; firstName: string; lastName: string } }) {
  return {
    email: intent.contact.email,
    name: `${intent.contact.firstName} ${intent.contact.lastName}`.trim(),
    ip: firstHeader(req.headers["x-forwarded-for"])?.split(",")[0]?.trim() ??
      firstHeader(req.headers["x-real-ip"]) ??
      null,
    userAgent: firstHeader(req.headers["user-agent"]) ?? null,
  };
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const first = value.find((entry) => entry.trim());
    return first?.trim() ?? null;
  }
  return null;
}
