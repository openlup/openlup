import { createHash, createHmac } from "node:crypto";

export function riskSubjectHash(kind: string, value: string, secret?: string | null): string {
  const normalized = `${kind}:${value.trim().toLowerCase()}`;
  if (secret && secret.length >= 16) {
    return createHmac("sha256", secret).update(normalized).digest("hex");
  }
  return createHash("sha256").update(normalized).digest("hex");
}

export function safeRiskString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
