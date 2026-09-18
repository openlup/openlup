export function sanitizeObservedReason(value: string): string {
  const trimmed = value.trim();
  if (/^[a-z][a-z0-9_:-]{1,119}$/.test(trimmed)) return trimmed;
  return "redacted_unsafe_reason";
}

/** A closed-set reason field lifted off an error body, or nothing if absent. */
export function safeDetailReason(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? sanitizeObservedReason(value) : undefined;
}

/** A support code lifted off an error body, or nothing if absent. */
export function safeDetailSupportCode(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? sanitizeObservedSupportCode(value) : undefined;
}

export function sanitizeObservedSupportCode(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 120 && /[A-Za-z]/.test(trimmed) && /^[A-Za-z0-9_-]+$/.test(trimmed)) {
    return trimmed;
  }
  return "redacted_unsafe_support_code";
}
