const MAX_DIAGNOSTIC_LENGTH = 240;

const REDACTION_PATTERNS: Array<[RegExp, string]> = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]"],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9_]+\b/g, "[redacted-key]"],
  [
    /\b(client_secret|payment_secret|secret|token|authorization|password|pass|apikey|api_key)\s*[:=]\s*["']?[^"',\s}]+/gi,
    "$1=[redacted]",
  ],
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[redacted-uuid]"],
  [/\b(?:intent|checkout|order|payment|subscription|idempotency)[-_a-z0-9]*[:=][A-Za-z0-9._:-]{12,}/gi, "[redacted-id]"],
  [/\+?\d[\d\s().-]{7,}\d/g, "[redacted-number]"],
];

export function safeCommerceDiagnosticValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let text = String(value);
  for (const [pattern, replacement] of REDACTION_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text.length > MAX_DIAGNOSTIC_LENGTH
    ? `${text.slice(0, MAX_DIAGNOSTIC_LENGTH - 3)}...`
    : text;
}

export function checkoutOrchestrationFailureDetails(reason: string | null): {
  feature: "checkout";
  stage: "orchestrate_order";
  diagnosticReason?: string;
} {
  return {
    feature: "checkout",
    stage: "orchestrate_order",
    ...(previewCheckoutDiagnosticsEnabled() && reason ? { diagnosticReason: reason } : {}),
  };
}

export function previewCheckoutDiagnosticsEnabled(): boolean {
  return (
    process.env.HIDDEN_SANDBOX_PREVIEW_ENABLED === "true" ||
    process.env.VERCEL_ENV === "preview"
  );
}
