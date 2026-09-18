import { z } from "../../lib/validation/zod.js";

const CUSTOMER_ACCOUNT_PATH_PREFIXES = ["/konto", "/account"] as const;
const PAYMENT_RECOVERY_PATHS = new Set([
  "/konto/platnosc/napraw",
  "/account/payment/recover",
]);
const PAYMENT_RECOVERY_SENSITIVE_PARAMS = [
  "token",
  "setup_intent_client_secret",
  "payment_intent_client_secret",
  "setup_intent",
  "redirect_status",
] as const;

export function normalizeCustomerReturnTo(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate || candidate.length > 2048) return null;
  if (!candidate.startsWith("/") || candidate.startsWith("//")) return null;
  if (
    candidate.includes("\\") ||
    Array.from(candidate).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) return null;

  try {
    const parsed = new URL(candidate, "https://customer-return.invalid");
    if (parsed.origin !== "https://customer-return.invalid") return null;
    const accountPath = CUSTOMER_ACCOUNT_PATH_PREFIXES.some(
      (prefix) => parsed.pathname === prefix || parsed.pathname.startsWith(`${prefix}/`),
    );
    if (!accountPath) return null;
    if (PAYMENT_RECOVERY_PATHS.has(parsed.pathname)) {
      for (const param of PAYMENT_RECOVERY_SENSITIVE_PARAMS) parsed.searchParams.delete(param);
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

export const customerReturnToSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .transform((value, ctx) => {
    const normalized = normalizeCustomerReturnTo(value);
    if (normalized) return normalized;
    ctx.addIssue({ code: "custom", message: "Invalid customer return target" });
    return z.NEVER;
  });
